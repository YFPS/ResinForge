/* ================================================================
   模型载入：setGeometry / loadDemo（4 个内置 demo）/ loadSTLBuffer(s) / mergeGeoms /
   updateRaft / 参数辅助（raiseH / raftOn / raftMargin）。
   多个模型文件（STL / OBJ / 3MF）进同一块板：每个零件保留自己的局部几何（底面 y=0、XZ 居中），
   摆放是 ox/oy/oz 加绕自身中心的四元数 q；显示与分析用的 state.mesh 是按这个变换拼起来的一份。
   与旧 main.js 的差异仅两类：参数读 params.*，DOM 赋值改发 bus 事件。
================================================================ */
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { modelKind, objPositions, threeMfPositions } from './meshio.js';
import { state, params, bus, log, toast, setProgress } from '../store.js';
import { historyReplaying, pushHistory, clearHistory } from './history.js';
import { isBinarySTL, frameOf, applyFrame, bakeSource, smoothSoupNormals, blueprintRatio, SIMPLIFY_MIN_BYTES } from './simplify.js';
import { decimate } from './decimate.js';
import { scene, modelGroup, modelMat, prevScene, prev, framePart, frameParts, updateBuildVolume, syncFocusRing } from './scene.js';

/* 包围盒八个角变换时复用，不外传 */
const _corner = new THREE.Vector3();
import { computeFaceDataFull } from './slicer.js';
import { clearSupports, updateSupStats } from './support.js';
import { buildBVH, raycast as bvhRaycast } from './collide.js';
import { hideInspector } from './inspect.js';

/* 打印工艺参数：世界系 = 打印系（平台顶面 y=0，模型底面抬高 raiseH，筏层厚 RAFT_T） */
export const RAFT_T = 1.2;    // 筏层厚度（mm），固定
let raftMesh = null;          // 筏层显示 Mesh
export const raiseH = () => Math.max(0, params.raiseH || 0);   // 模型抬高（mm），默认 4
export const raftOn = () => params.raftOn;
export const raftMargin = () => params.raftMargin || 3;

const ARRANGE_MARGIN = 3;   // 排版距板边（mm）

let partSeq = 1;

/* 视口轴画在板面最小角。切片坐标里这里是 X、Y 的负向角：机器 Y = 世界 z − 这里的 z，负 Y 在板外。
   高度是切片 Z（世界 +Y）。scene.js 的体积框用同一个原点。 */
export function plateAxisOrigin() {
  const px = Math.max(20, params.plateX || 150);
  const pz = Math.max(20, params.plateZ || 85);
  return { x: -px / 2, y: 0, z: -pz / 2, px, pz };
}

export function activePart() {
  return state.parts.find(p => p.id === state.activePartId) || state.parts[0] || null;
}

/* 世界 XZ 落在哪个零件的底面上（点在底面外时取最近的一个） */
export function partAtWorld(x, z) {
  let best = null, bd = Infinity;
  for (const p of state.parts) {
    const dx = Math.max(Math.abs(x - p.ox) - p.size.x / 2, 0);
    const dz = Math.max(Math.abs(z - p.oz) - p.size.z / 2, 0);
    const d = Math.hypot(dx, dz);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/* 合并网格上的三角面 → 零件局部面索引（保护面按零件记，重拼网格时不会串） */
export function localFaceOf(fi) {
  for (let i = state.parts.length - 1; i >= 0; i--) {
    const p = state.parts[i];
    if (fi >= (p.faceStart || 0)) return { part: p, local: fi - (p.faceStart || 0) };
  }
  return null;
}

function measureGeom(geom) {
  const bb = geom.boundingBox;
  return {
    x: bb.max.x - bb.min.x,
    y: bb.max.y - bb.min.y,
    z: bb.max.z - bb.min.z,
    nf: geom.attributes.position.count / 3,
  };
}

/* 非索引、重算法线、底面落到 y=0、XZ 居中，并备好顶点色 */
function normalizeGeom(geom) {
  if (geom.index) geom = geom.toNonIndexed();
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
  geom.translate(-cx, -bb.min.y, -cz);
  geom.computeBoundingBox();
  const n = geom.attributes.position.count;
  if (!geom.getAttribute('color') || geom.getAttribute('color').count !== n) {
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  }
  return geom;
}

function makePart(geom, name, demo) {
  const size = measureGeom(geom);
  return {
    id: partSeq++, name, demo: !!demo, geom,
    size: { x: size.x, y: size.y, z: size.z },
    base: { x: size.x, y: size.y, z: size.z },   // 未旋转的几何尺寸；q 绕它的中心转
    born: { x: size.x, y: size.y, z: size.z },   // 100% 的基准。载入时记下，旋转烤进几何后改成烤平后的尺寸
    nf: size.nf,
    ox: 0, oy: 0, oz: 0,
    q: new THREE.Quaternion(),
    faceStart: 0, protected: new Set(),
  };
}

function disposeParts() {
  clearHistory();
  for (const p of state.parts) p.geom.dispose();
  state.parts = [];
  state.activePartId = null;
  state.focusId = null;
  state.selectedIds = [];
  state.transformTool = null;
}

function quatIsIdentity(q) {
  return !!q && Math.abs(q.x) < 1e-8 && Math.abs(q.y) < 1e-8 && Math.abs(q.z) < 1e-8 && Math.abs(Math.abs(q.w) - 1) < 1e-8;
}

/* 局部几何（底面 y=0、XZ 居中）绕中心 q 旋转，再平移到 (ox, oy, oz)。oy 是相对抬高之外的额外抬升。 */
function xformCorner(part, x, y, z, out) {
  const cy = part.base.y / 2;
  out.set(x, y - cy, z);
  if (part.q) out.applyQuaternion(part.q);
  out.x += part.ox;
  out.y += cy + (part.oy || 0);
  out.z += part.oz;
  return out;
}

/** 零件在网格局部系（尚未加 raiseH）里的轴对齐包围盒 */
export function partBounds(part) {
  const hx = part.base.x / 2, hy = part.base.y, hz = part.base.z / 2;
  const pts = [
    [-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz],
    [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const [x, y, z] of pts) {
    xformCorner(part, x, y, z, _corner);
    if (_corner.x < minX) minX = _corner.x;
    if (_corner.y < minY) minY = _corner.y;
    if (_corner.z < minZ) minZ = _corner.z;
    if (_corner.x > maxX) maxX = _corner.x;
    if (_corner.y > maxY) maxY = _corner.y;
    if (_corner.z > maxZ) maxZ = _corner.z;
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

/**
 * 切片坐标 Z 是高度（世界 y 再加 raiseH）。
 * 整组一起抬，使包围盒底面不低于平台，也就是 Z 不为负。
 * 返回实际补上的 oy。
 */
export function clampPartsToPrintZ(parts) {
  if (!parts || !parts.length) return 0;
  const floor = -raiseH();
  let minY = Infinity;
  for (const p of parts) {
    const b = partBounds(p);
    if (b.min.y < minY) minY = b.min.y;
  }
  const fix = minY < floor - 1e-4 ? floor - minY : 0;
  if (fix > 1e-4) for (const p of parts) p.oy = (p.oy || 0) + fix;
  return fix;
}

/** 单件版本：底面不低于平台（切片 Z 不为负）。 */
export function liftPartOntoPlate(part) {
  clampPartsToPrintZ([part]);
}

/** 整组一起挪，使最靠外的那个模型也不进入机器负 Y（世界 z 的板外一侧）。返回实际补回的距离。 */
export function clampPartsAboveZ(parts) {
  const minZ = plateAxisOrigin().z;
  let fix = 0;
  for (const p of parts) {
    const b = partBounds(p);
    if (b.min.z < minZ - 1e-4) fix = Math.max(fix, minZ - b.min.z);
  }
  if (fix > 0) for (const p of parts) p.oz += fix;
  return fix;
}

/* 把交互旋转烤进局部几何，世界位置不变，q 回到单位四元数。朝向优化读的是局部几何。 */
export function bakePartRotation(part) {
  if (!part || quatIsIdentity(part.q)) return false;
  const geom = part.geom;
  const cy = part.base.y / 2;
  geom.translate(0, -cy, 0);
  geom.applyQuaternion(part.q);
  geom.translate(0, cy, 0);
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  const minY = bb.min.y;
  geom.translate(-cx, -minY, -cz);
  part.ox += cx;
  part.oz += cz;
  part.oy += minY;
  if (part.source) bakeSource(part.source, part.q, cy, cx, minY, cz);
  part.q.identity();
  if (part.smooth) geom.setAttribute('normal', new THREE.BufferAttribute(smoothSoupNormals(geom.attributes.position.array), 3));
  else geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  const size = measureGeom(geom);
  part.base = { x: size.x, y: size.y, z: size.z };
  part.size = { x: size.x, y: size.y, z: size.z };
  part.nf = size.nf;
  // 旋转已写进顶点，之后的 100% 以这个朝向的尺寸为准，避免按载入时的包围盒把模型压扁
  part.born = { x: size.x, y: size.y, z: size.z };
  return true;
}

/* 比例下限只为了不翻面；实际尺寸再抬到 DIM_MIN。上限防止一次拖成天文数字。 */
const SCALE_MAX = 40;
const DIM_MIN = 0.2;

function clampScale(f, base) {
  if (!Number.isFinite(f)) return 1;
  let c = f < 1e-4 ? 1e-4 : f;
  if (c > SCALE_MAX) c = SCALE_MAX;
  const b = Math.max(base, 1e-6);
  if (b * c < DIM_MIN) c = DIM_MIN / b;
  if (c > SCALE_MAX) c = SCALE_MAX;
  return c;
}

/* 等比时三轴用同一个比例。下限取最紧的那条轴，避免一条先碰到 0.2mm 后比例被拆开。 */
export function uniformScaleFactor(factor, base) {
  if (!Number.isFinite(factor) || !base) return 1;
  const lo = Math.max(
    DIM_MIN / Math.max(base.x, 1e-6),
    DIM_MIN / Math.max(base.y, 1e-6),
    DIM_MIN / Math.max(base.z, 1e-6),
  );
  let c = factor < lo ? lo : factor;
  if (c > SCALE_MAX) c = SCALE_MAX;
  return c;
}

function scaleSource(part, fx, fy, fz, srcSource, geomArr) {
  const s = part.source;
  if (!s || s === geomArr) return;
  const from = srcSource && srcSource.length === s.length ? srcSource : null;
  if (from) {
    for (let i = 0; i < s.length; i += 3) {
      s[i] = from[i] * fx;
      s[i + 1] = from[i + 1] * fy;
      s[i + 2] = from[i + 2] * fz;
    }
  } else if (!srcSource) {
    for (let i = 0; i < s.length; i += 3) {
      s[i] *= fx;
      s[i + 1] *= fy;
      s[i + 2] *= fz;
    }
  }
}

/**
 * 按快照重写局部顶点。src 必须是独立拷贝，不能就是当前 position 数组。
 * 切片 X → 局部 x × fx，切片 Y → 局部 z × fz，切片 Z（高度）→ 局部 y × fy。
 * 局部几何底面 y=0、XZ 已居中，所以从原点乘：底面不动，占地绕中心扩。
 * base 是快照尺寸，用来钳制，避免拖动中 part.base 已被写成上一帧的结果。
 * srcSource 是导出用原始顶点的快照。拖动每帧从它重写；单次缩放不传，则就地乘。
 * 自测：fy=2 且 fx=fz=1 时 size.y 加倍，size.x 与 size.z 不变，包围盒 min.y 仍是 0。
 */
export function applyPartScale(part, fx, fy, fz, src, base, srcSource) {
  if (!part || !src) return null;
  const pos = part.geom.attributes.position;
  const arr = pos.array;
  if (src === arr || src.length !== arr.length) return null;
  const b = base || part.base;
  fx = clampScale(fx, b.x);
  fy = clampScale(fy, b.y);
  fz = clampScale(fz, b.z);
  for (let i = 0; i < arr.length; i += 3) {
    arr[i] = src[i] * fx;
    arr[i + 1] = src[i + 1] * fy;
    arr[i + 2] = src[i + 2] * fz;
  }
  pos.needsUpdate = true;
  scaleSource(part, fx, fy, fz, srcSource, arr);
  part.geom.computeBoundingBox();
  part.geom.computeBoundingSphere();
  const size = measureGeom(part.geom);
  part.base = { x: size.x, y: size.y, z: size.z };
  part.size = { x: size.x, y: size.y, z: size.z };
  part.nf = size.nf;
  return { fx, fy, fz };
}

/** 松手后重算法线。拖动中不必每帧算。 */
export function finishPartScale(part) {
  if (!part) return;
  if (part.smooth) part.geom.setAttribute('normal', new THREE.BufferAttribute(smoothSoupNormals(part.geom.attributes.position.array), 3));
  else part.geom.computeVertexNormals();
  part.geom.computeBoundingBox();
  part.geom.computeBoundingSphere();
  const size = measureGeom(part.geom);
  part.base = { x: size.x, y: size.y, z: size.z };
  part.size = { x: size.x, y: size.y, z: size.z };
  part.nf = size.nf;
}

/** 几何变了：朝向候选作废。有分析或支撑时一并清掉，保护面索引还有效，保留。 */
export function discardStaleWork(msg) {
  if (state.orientResult) {
    state.orientResult = null;
    bus.emit('orientResults', null);
  }
  const dirty = !!(state.analysis || (state.supportPoints && state.supportPoints.length) || (state.supports && state.supports.length));
  if (!dirty) return;
  clearSupports(false);
  state.analysis = null;
  hideInspector();
  bus.emit('sliceStats', null);
  updateSupStats();
  log(msg || '模型尺寸已变，分析结果与支撑已清除，请重新分析', 'warn');
}

function wantDim(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 把一件模型缩到切片坐标下的目标毫米。
 * target.x 板面 X（局部 x），target.y 板面 Y（局部 z），target.z 高度（局部 y）。
 * uniform 时以 changed（'x'|'y'|'z'）那一轴的比例带动另外两轴。
 * space 为 world 时先烤平旋转，使局部轴与切片轴重合；object 时沿模型自己的轴乘，不烤平。
 * 底面和占地中心是缩放原点。
 */
export function scalePartTo(part, target = {}, { uniform = false, changed = null, space = 'world', history = true, label = '缩放模型' } = {}) {
  if (!part) return null;
  const before = history && !historyReplaying() ? capturePartSnaps([part]) : null;
  const baked = space === 'object' ? false : bakePartRotation(part);
  const bx = Math.max(part.base.x, 1e-6);
  const by = Math.max(part.base.y, 1e-6);
  const bz = Math.max(part.base.z, 1e-6);
  const wantX = wantDim(target.x, bx);
  const wantY = wantDim(target.y, bz);
  const wantZ = wantDim(target.z, by);
  const base = { x: part.base.x, y: part.base.y, z: part.base.z };
  let fx, fy, fz;
  if (uniform) {
    const ratio = changed === 'y' ? wantY / bz : changed === 'z' ? wantZ / by : wantX / bx;
    fx = fy = fz = uniformScaleFactor(ratio, base);
  } else {
    fx = clampScale(wantX / bx, base.x);
    fz = clampScale(wantY / bz, base.z);
    fy = clampScale(wantZ / by, base.y);
  }
  const near = Math.abs(fx - 1) < 1e-4 && Math.abs(fy - 1) < 1e-4 && Math.abs(fz - 1) < 1e-4;
  if (near && !baked) {
    releaseSnaps(before);
    return { x: part.size.x, y: part.size.z, z: part.size.y, fx: 1, fy: 1, fz: 1 };
  }
  if (!near) {
    const src = new Float32Array(part.geom.attributes.position.array);
    applyPartScale(part, fx, fy, fz, src, base);
    finishPartScale(part);
    clampPartsToPrintZ([part]);
    discardStaleWork('模型尺寸已变，分析结果与支撑已清除，请重新分析');
  } else if (state.orientResult) {
    state.orientResult = null;
    bus.emit('orientResults', null);
  }
  commitPartEdit(false);
  if (before) commitGeomHistory(label, before);
  return { x: part.size.x, y: part.size.z, z: part.size.y, fx, fy, fz };
}

/** axis 为切片轴 x / y / z，z 是高度，value 是目标毫米。space 同 scalePartTo。 */
export function scalePartAxis(part, axis, value, uniform, space = 'world') {
  if (!part || (axis !== 'x' && axis !== 'y' && axis !== 'z')) return null;
  const target = { x: part.size.x, y: part.size.z, z: part.size.y };
  target[axis] = value;
  return scalePartTo(part, target, { uniform: !!uniform, changed: axis, space });
}

/** 比例回到 born。切片 Y 是局部 z，高度 Z 是局部 y。 */
export function resetPartScale(part, space = 'world') {
  if (!part) return null;
  const b = part.born || part.size;
  return scalePartTo(part, { x: b.x, y: b.z, z: b.y }, { uniform: false, space, label: '还原大小' });
}

/* 缩完若还伸出板外，只平移占地，把包围盒收回板内。比板还大时只贴住一边。 */
function tuckPartOntoPlate(part) {
  const px = params.plateX || 150;
  const pz = params.plateZ || 85;
  let moved = false;
  for (let guard = 0; guard < 3; guard++) {
    const b = partBounds(part);
    let dx = 0;
    let dz = 0;
    if (b.min.x < -px / 2) dx = -px / 2 - b.min.x;
    else if (b.max.x > px / 2) dx = px / 2 - b.max.x;
    if (b.min.z < -pz / 2) dz = -pz / 2 - b.min.z;
    else if (b.max.z > pz / 2) dz = pz / 2 - b.max.z;
    if (Math.abs(dx) < 1e-3 && Math.abs(dz) < 1e-3) break;
    part.ox += dx;
    part.oz += dz;
    moved = true;
  }
  return moved;
}

/**
 * 等比缩到当前机型的打印体积里，每边留 2mm。
 * 限制取世界包围盒：板面 X、板面 Y（世界 Z）、高度（打印高度减去抬高）。
 * 自测：环面结默认约 64×31×66，板 150×85、高度 175、抬高 4，限制应落在板面 X。
 */
export function scalePartToFit(part) {
  if (!part) return null;
  const before = historyReplaying() ? null : capturePartSnaps([part]);
  bakePartRotation(part);
  const b = partBounds(part);
  const sx = Math.max(b.max.x - b.min.x, 1e-6);
  const sy = Math.max(b.max.y - b.min.y, 1e-6);
  const sz = Math.max(b.max.z - b.min.z, 1e-6);
  const fitX = Math.max((params.plateX || 150) - 2, DIM_MIN);
  const fitZ = Math.max((params.plateZ || 85) - 2, DIM_MIN);
  const fitY = Math.max((params.plateY || 175) - raiseH() - 2, DIM_MIN);
  let factor = Math.min(fitX / sx, fitZ / sz, fitY / sy);
  const lo = Math.max(
    DIM_MIN / Math.max(part.base.x, 1e-6),
    DIM_MIN / Math.max(part.base.y, 1e-6),
    DIM_MIN / Math.max(part.base.z, 1e-6),
  );
  if (factor < lo) factor = lo;
  if (factor > SCALE_MAX) factor = SCALE_MAX;
  const out = scalePartTo(part, {
    x: part.size.x * factor,
    y: part.size.z * factor,
    z: part.size.y * factor,
  }, { uniform: true, changed: 'x', space: 'world', history: false });
  if (tuckPartOntoPlate(part)) commitPartEdit(false);
  if (before) commitGeomHistory('缩放到适合机型', before);
  return out;
}

/** 只选中一件，或板上只有一件时，这件可以改尺寸。多选不缩放。 */
export function scaleTargetPart() {
  const parts = state.parts;
  if (!parts.length) return null;
  const ids = state.selectedIds || [];
  if (ids.length === 1) return parts.find(p => p.id === ids[0]) || null;
  if (ids.length > 1) return null;
  if (parts.length === 1) return parts[0];
  return null;
}

function syncPreview(part) {
  if (prev.mesh) {
    prevScene.remove(prev.mesh);
    if (prev.mesh.material && prev.mesh.material.dispose) prev.mesh.material.dispose();
    prev.mesh = null;
  }
  if (!part) return;
  prev.mesh = new THREE.Mesh(part.geom, new THREE.MeshStandardMaterial({ color: 0xb9c2cf, roughness: 0.55, metalness: 0.15 }));
  prevScene.add(prev.mesh);
}

function resetWork() {
  clearSupports(false);
  state.protectedFaces.clear();
  for (const p of state.parts) p.protected.clear();
  state.analysis = null;
  state.orientResult = null;
  bus.emit('orientResults', null);
  bus.emit('sliceStats', null);
  bus.emit('supStats', null);
  hideInspector();
}

/* 货架排版：底面积从大到小，沿 X 成行，放不下就沿 Z 换行；间距至少 4mm 且不小于底座直径，边距 3mm，整组再居中到板面 */
export function arrangeParts(parts) {
  const plateX = params.plateX || 150, plateZ = params.plateZ || 85;
  const gap = Math.max(4, params.baseD || 3);
  const margin = ARRANGE_MARGIN;
  const items = parts.map(p => ({ p, w: p.size.x, d: p.size.z }));
  items.sort((a, b) => (b.w * b.d) - (a.w * a.d) || b.w - a.w);
  const left = -plateX / 2 + margin;
  const right = plateX / 2 - margin;
  let x = left;
  let z = -plateZ / 2 + margin;
  let rowD = 0;
  for (const it of items) {
    if (x > left + 1e-3 && x + it.w > right + 1e-3) {
      x = left;
      z += rowD + gap;
      rowD = 0;
    }
    it.p.ox = x + it.w / 2;
    it.p.oz = z + it.d / 2;
    x += it.w + gap;
    rowD = Math.max(rowD, it.d);
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of parts) {
    minX = Math.min(minX, p.ox - p.size.x / 2);
    maxX = Math.max(maxX, p.ox + p.size.x / 2);
    minZ = Math.min(minZ, p.oz - p.size.z / 2);
    maxZ = Math.max(maxZ, p.oz + p.size.z / 2);
  }
  const dx = -((minX + maxX) / 2);
  const dz = -((minZ + maxZ) / 2);
  for (const p of parts) { p.ox += dx; p.oz += dz; }
  let overflow = false;
  for (const p of parts) {
    if (Math.abs(p.ox) + p.size.x / 2 > plateX / 2 + 0.6) overflow = true;
    if (Math.abs(p.oz) + p.size.z / 2 > plateZ / 2 + 0.6) overflow = true;
  }
  return { gap, margin, overflow };
}

function rotVec(q, x, y, z) {
  if (!q || quatIsIdentity(q)) return [x, y, z];
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

function rebuildMergedMesh(faces = true) {
  let count = 0;
  for (const p of state.parts) count += p.geom.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  let off = 0;
  let face = 0;
  state.protectedFaces = new Set();
  for (const p of state.parts) {
    const src = p.geom.attributes.position.array;
    const sc = p.geom.attributes.color.array;
    const na = p.geom.attributes.normal ? p.geom.attributes.normal.array : null;
    p.faceStart = face;
    for (let i = 0; i < src.length; i += 9) {
      for (let k = 0; k < 9; k += 3) {
        xformCorner(p, src[i + k], src[i + k + 1], src[i + k + 2], _corner);
        pos[off + i + k] = _corner.x;
        pos[off + i + k + 1] = _corner.y;
        pos[off + i + k + 2] = _corner.z;
        col[off + i + k] = sc[i + k];
        col[off + i + k + 1] = sc[i + k + 1];
        col[off + i + k + 2] = sc[i + k + 2];
        if (na) {
          const rn = rotVec(p.q, na[i + k], na[i + k + 1], na[i + k + 2]);
          nrm[off + i + k] = rn[0];
          nrm[off + i + k + 1] = rn[1];
          nrm[off + i + k + 2] = rn[2];
        }
      }
      if (!na) {
        const ax = pos[off + i], ay = pos[off + i + 1], az = pos[off + i + 2];
        const bx = pos[off + i + 3], by = pos[off + i + 4], bz = pos[off + i + 5];
        const cx = pos[off + i + 6], cy = pos[off + i + 7], cz = pos[off + i + 8];
        let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
        let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        for (let k = 0; k < 9; k += 3) {
          nrm[off + i + k] = nx;
          nrm[off + i + k + 1] = ny;
          nrm[off + i + k + 2] = nz;
        }
      }
    }
    for (const f of p.protected) state.protectedFaces.add(f + face);
    face += src.length / 9;
    off += src.length;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  if (state.mesh) { modelGroup.remove(state.mesh); state.mesh.geometry.dispose(); }
  state.mesh = new THREE.Mesh(geom, modelMat);
  state.mesh.position.set(0, raiseH(), 0);
  state.mesh.quaternion.identity();
  state.mesh.scale.set(1, 1, 1);
  state.mesh.matrixAutoUpdate = true;
  state.mesh.updateMatrix();
  const only = state.parts.length === 1 ? state.parts[0] : null;
  state.mesh.userData.pose = only ? {
    ox: only.ox, oy: only.oy || 0, oz: only.oz,
    q: only.q.clone(), cy: (only.base?.y || only.size.y) / 2,
  } : null;
  modelGroup.add(state.mesh);
  scheduleMeshBVH();
  // 拖动中每帧都重拼网格，面数据等松手再算
  if (faces) state.faces = computeFaceDataFull(pos);
}

/* 拾取用的 BVH。大模型不在鼠标移动时逐三角形扫描。网格一换就作废，空闲时重建。 */
let meshBVH = null;
let meshBVHGeom = null;
let meshBVHPending = null;

export function scheduleMeshBVH() {
  const geom = state.mesh && state.mesh.geometry;
  if (!geom || meshBVHGeom === geom || meshBVHPending === geom) return;
  const token = geom;
  meshBVHPending = token;
  const pos = geom.attributes.position.array;
  setTimeout(() => {
    if (meshBVHPending === token) meshBVHPending = null;
    if (!state.mesh || state.mesh.geometry !== token) return;
    meshBVH = buildBVH(pos);
    meshBVHGeom = token;
  }, 0);
}

const _pickM = new THREE.Matrix4();
const _pickO = new THREE.Vector3();
const _pickD = new THREE.Vector3();

/** 世界射线拾取合并网格。BVH 还没好时返回 null，调用方不要退回全三角形扫描。
    拖动后顶点仍停在按下时的位置，显示靠矩阵，射线要先变回几何空间。 */
export function meshPick(ray) {
  if (!state.mesh || !meshBVH || meshBVHGeom !== state.mesh.geometry) return null;
  if (_pickM.copy(state.mesh.matrix).invert().determinant() === 0) return null;
  _pickO.copy(ray.origin).applyMatrix4(_pickM);
  _pickD.copy(ray.direction).transformDirection(_pickM);
  const hit = bvhRaycast(meshBVH, _pickO.x, _pickO.y, _pickO.z, _pickD.x, _pickD.y, _pickD.z);
  if (!hit) return null;
  return {
    face: hit.f,
    point: ray.origin.clone().addScaledVector(ray.direction, hit.t),
  };
}

const _previewM = new THREE.Matrix4();
const _previewT = new THREE.Matrix4();
const _previewP = new THREE.Vector3();
const _previewQ = new THREE.Quaternion();
const _previewS = new THREE.Vector3(1, 1, 1);

/**
 * 单模型拖动时只改矩阵，不重写几百万顶点。几何里仍是按下时的位置。
 * 多模型返回 false，调用方再重拼网格。
 */
export function previewPartPose() {
  const pose = state.mesh && state.mesh.userData.pose;
  const p = state.parts.length === 1 ? state.parts[0] : null;
  if (!pose || !p || !state.mesh) return false;
  const qDelta = _previewQ.copy(p.q).multiply(pose.q.clone().invert());
  _previewP.set(p.ox, pose.cy + (p.oy || 0) + (state.mesh.position.y || 0), p.oz);
  _previewM.compose(_previewP, qDelta, _previewS);
  _previewT.makeTranslation(-pose.ox, -(pose.cy + pose.oy), -pose.oz);
  _previewM.multiply(_previewT);
  state.mesh.matrixAutoUpdate = false;
  state.mesh.matrix.copy(_previewM);
  // 父级是单位矩阵，本地矩阵就是世界矩阵。当场写上，射线不必等下一帧渲染。
  state.mesh.matrixWorld.copy(_previewM);
  state.mesh.matrixWorldNeedsUpdate = false;
  return true;
}

/** 显示矩阵还停在拖动预览上，顶点没按新位置重写。 */
export function displayPosePending() {
  return !!(state.mesh && state.mesh.matrixAutoUpdate === false && state.mesh.userData.pose);
}

/** 分析、热力图等要读烘焙后的顶点时再重拼。移动松手不走这里。 */
export function ensureBakedDisplay() {
  if (!displayPosePending()) return;
  syncPlateMesh({ faces: true });
}

/** 按当前 ox/oy/oz/q 重拼显示网格。拖动中关掉面数据，松手再打开。 */
export function syncPlateMesh({ faces = true } = {}) {
  if (!state.parts.length) return;
  rebuildMergedMesh(faces);
  updateRaft();
}

export function emitModelInfo() {
  const parts = state.parts;
  if (!parts.length || !state.mesh) { bus.emit('modelInfo', null); return; }
  const bb = state.mesh.geometry.boundingBox;
  const size = bb.max.clone().sub(bb.min);
  const nf = parts.reduce((s, p) => s + p.nf, 0);
  const nfFull = parts.reduce((s, p) => s + (p.nfFull || p.nf), 0);
  const name = parts.length === 1 ? parts[0].name : `${parts.length} 个模型`;
  bus.emit('modelInfo', {
    name,
    sizeText: `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`,
    nf,
    nfFull,
    activeId: state.activePartId,
    focusId: state.focusId,
    parts: parts.map(p => ({
      id: p.id, name: p.name, demo: p.demo, nf: p.nf,
      sx: p.size.x, sy: p.size.y, sz: p.size.z, ox: p.ox, oy: p.oy || 0, oz: p.oz,
    })),
    selectedIds: (state.selectedIds || []).slice(),
    tool: state.transformTool || null,
  });
}

/** 视口选中。primary 不传时用最后一件，朝向优化跟着它，不推动摄影机。 */
export function setSelection(ids) {
  const valid = [];
  for (const id of ids || []) {
    if (state.parts.some(p => p.id === id) && !valid.includes(id)) valid.push(id);
  }
  const prev = state.selectedIds || [];
  const same = valid.length === prev.length && valid.every((id, i) => id === prev[i]);
  state.selectedIds = valid;
  if (!same || valid.length !== 1) state.transformTool = null;
  const primary = valid.length ? state.parts.find(p => p.id === valid[valid.length - 1]) : null;
  if (primary && primary.id !== state.activePartId) {
    state.activePartId = primary.id;
    syncPreview(primary);
    state.orientResult = null;
    bus.emit('orientResults', null);
  }
  if (primary) state.focusId = primary.id;
  emitModelInfo();
  bus.emit('selection', { ids: valid.slice(), tool: state.transformTool });
}

/* 板上一个模型都不剩时拆掉合并网格和底板。零件几何由调用方先 dispose。 */
function dropMergedMesh() {
  if (state.mesh) {
    modelGroup.remove(state.mesh);
    state.mesh.geometry.dispose();
    state.mesh = null;
  }
  state.faces = null;
  updateRaft();
}

/* ---------- 撤回快照 ----------
   平移只记 ox/oy/oz 和 q。旋转、缩放会把结果烤进局部顶点，必须连位置数组一起拷走。
   删除时几何马上 dispose，快照留着自己的一份，撤回时再造一个零件。 */

function poseOf(part) {
  return {
    id: part.id,
    ox: part.ox,
    oy: part.oy || 0,
    oz: part.oz,
    q: [part.q.x, part.q.y, part.q.z, part.q.w],
  };
}

function poseChanged(a, b) {
  if (Math.abs(a.ox - b.ox) > 0.02 || Math.abs(a.oy - b.oy) > 0.02 || Math.abs(a.oz - b.oz) > 0.02) return true;
  const dot = Math.abs(a.q[0] * b.q[0] + a.q[1] * b.q[1] + a.q[2] * b.q[2] + a.q[3] * b.q[3]);
  return dot < Math.cos(0.002);
}

export function capturePoses(parts) {
  return parts.map(poseOf);
}

function captureOne(part) {
  const pos = part.geom.attributes.position.array;
  const shared = part.source === pos;
  return {
    id: part.id,
    index: state.parts.indexOf(part),
    name: part.name,
    demo: !!part.demo,
    ox: part.ox,
    oy: part.oy || 0,
    oz: part.oz,
    q: [part.q.x, part.q.y, part.q.z, part.q.w],
    base: { x: part.base.x, y: part.base.y, z: part.base.z },
    size: { x: part.size.x, y: part.size.y, z: part.size.z },
    born: part.born ? { x: part.born.x, y: part.born.y, z: part.born.z } : null,
    nf: part.nf,
    nfFull: part.nfFull,
    smooth: !!part.smooth,
    protected: [...(part.protected || [])],
    position: new Float32Array(pos),
    source: !part.source || shared ? null : new Float32Array(part.source),
    sourceShared: !!shared,
  };
}

export function capturePartSnaps(parts) {
  return parts.map(captureOne);
}

export function releaseSnaps(snaps) {
  if (!snaps) return;
  for (const s of snaps) {
    if (!s) continue;
    s.position = null;
    s.source = null;
  }
}

function geomDiffers(snap, part) {
  if (!part || !snap.position) return true;
  if (poseChanged(snap, poseOf(part))) return true;
  const pos = part.geom.attributes.position.array;
  if (pos.length !== snap.position.length) return true;
  for (let i = 0; i < pos.length; i++) {
    if (pos[i] !== snap.position[i]) return true;
  }
  return false;
}

function captureSel() {
  return {
    ids: (state.selectedIds || []).slice(),
    active: state.activePartId,
    focus: state.focusId,
    tool: state.transformTool || null,
  };
}

function restoreSel(sel) {
  if (!sel) return;
  setSelection(sel.ids || []);
  if (sel.active && state.parts.some(p => p.id === sel.active)) {
    state.activePartId = sel.active;
    syncPreview(state.parts.find(p => p.id === sel.active));
  }
  if (sel.focus && state.parts.some(p => p.id === sel.focus)) state.focusId = sel.focus;
  if (sel.tool && (state.selectedIds || []).length === 1) state.transformTool = sel.tool;
  emitModelInfo();
  bus.emit('selection', { ids: (state.selectedIds || []).slice(), tool: state.transformTool });
}

function ensureGeomColor(geom, count) {
  const col = geom.getAttribute('color');
  if (!col || col.count !== count) {
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3));
  }
}

function rewriteNormals(part) {
  const pos = part.geom.attributes.position.array;
  if (part.smooth) part.geom.setAttribute('normal', new THREE.BufferAttribute(smoothSoupNormals(pos), 3));
  else part.geom.computeVertexNormals();
  part.geom.computeBoundingBox();
  part.geom.computeBoundingSphere();
}

function writeSnap(part, snap) {
  part.ox = snap.ox;
  part.oy = snap.oy;
  part.oz = snap.oz;
  part.q.set(snap.q[0], snap.q[1], snap.q[2], snap.q[3]);
  const attr = part.geom.attributes.position;
  if (attr.array.length !== snap.position.length) {
    part.geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(snap.position), 3));
  } else {
    attr.array.set(snap.position);
    attr.needsUpdate = true;
  }
  ensureGeomColor(part.geom, snap.position.length / 3);
  if (snap.source) {
    if (!part.source || part.source.length !== snap.source.length) part.source = new Float32Array(snap.source);
    else part.source.set(snap.source);
  } else if (snap.sourceShared) part.source = part.geom.attributes.position.array;
  else part.source = null;
  part.base = { x: snap.base.x, y: snap.base.y, z: snap.base.z };
  part.size = { x: snap.size.x, y: snap.size.y, z: snap.size.z };
  part.born = snap.born ? { x: snap.born.x, y: snap.born.y, z: snap.born.z } : { x: snap.size.x, y: snap.size.y, z: snap.size.z };
  part.nf = snap.nf;
  if (snap.nfFull != null) part.nfFull = snap.nfFull;
  part.smooth = !!snap.smooth;
  part.protected = new Set(snap.protected);
  rewriteNormals(part);
}

function reviveSnap(snap) {
  const geom = positionsToGeom(new Float32Array(snap.position), null);
  const part = {
    id: snap.id,
    name: snap.name,
    demo: !!snap.demo,
    geom,
    size: { x: snap.size.x, y: snap.size.y, z: snap.size.z },
    base: { x: snap.base.x, y: snap.base.y, z: snap.base.z },
    born: snap.born ? { x: snap.born.x, y: snap.born.y, z: snap.born.z } : { x: snap.size.x, y: snap.size.y, z: snap.size.z },
    nf: snap.nf,
    nfFull: snap.nfFull,
    ox: snap.ox,
    oy: snap.oy,
    oz: snap.oz,
    q: new THREE.Quaternion(snap.q[0], snap.q[1], snap.q[2], snap.q[3]),
    faceStart: 0,
    protected: new Set(snap.protected),
    smooth: !!snap.smooth,
    source: snap.source ? new Float32Array(snap.source) : null,
  };
  if (snap.smooth) rewriteNormals(part);
  if (snap.sourceShared) part.source = part.geom.attributes.position.array;
  return part;
}

/* 把快照写回板上。零件还在就改它的几何；已经被删掉的按原位置插回去。 */
function applyPartSnaps(snaps, sel) {
  const missing = [];
  for (const snap of snaps) {
    if (!snap || !snap.position) continue;
    const part = state.parts.find(p => p.id === snap.id);
    if (part) writeSnap(part, snap);
    else missing.push(snap);
  }
  missing.sort((a, b) => a.index - b.index);
  for (const snap of missing) {
    const part = reviveSnap(snap);
    const at = Math.max(0, Math.min(snap.index, state.parts.length));
    state.parts.splice(at, 0, part);
  }
  if (!state.parts.length) {
    state.activePartId = null;
    state.focusId = null;
    dropMergedMesh();
    syncPreview(null);
  } else {
    if (!state.parts.some(p => p.id === state.activePartId)) state.activePartId = state.parts[state.parts.length - 1].id;
    if (state.focusId && !state.parts.some(p => p.id === state.focusId)) state.focusId = state.activePartId;
    syncPreview(activePart());
    syncPlateMesh({ faces: true });
  }
  updateBuildVolume();
  discardStaleWork('模型已改动，分析结果与支撑已清除，请重新分析');
  if (sel) restoreSel(sel);
  else emitModelInfo();
  syncFocusRing();
}

function applyPoses(poses) {
  let any = false;
  for (const s of poses) {
    const part = state.parts.find(p => p.id === s.id);
    if (!part) continue;
    part.ox = s.ox;
    part.oy = s.oy;
    part.oz = s.oz;
    part.q.set(s.q[0], s.q[1], s.q[2], s.q[3]);
    any = true;
  }
  if (!any || !state.parts.length) return;
  syncPlateMesh({ faces: true });
  updateBuildVolume();
  discardStaleWork('模型已改动，分析结果与支撑已清除，请重新分析');
  const part = activePart();
  if (part) syncPreview(part);
  emitModelInfo();
  syncFocusRing();
}

/** 平移松手后调用。终点和起点一样就不入栈。 */
export function commitPoseHistory(label, before) {
  if (!before || !before.length || historyReplaying()) return false;
  const after = [];
  let changed = false;
  for (const s of before) {
    const part = state.parts.find(p => p.id === s.id);
    if (!part) { changed = true; continue; }
    const now = poseOf(part);
    after.push(now);
    if (poseChanged(s, now)) changed = true;
  }
  if (!changed) return false;
  pushHistory({
    label,
    undo: () => applyPoses(before),
    redo: () => applyPoses(after),
  });
  return true;
}

/** 几何变过的操作。没变就丢掉快照。sel 只在需要连选中一起恢复时传入。 */
export function commitGeomHistory(label, before, sel) {
  if (!before || !before.length || historyReplaying()) {
    releaseSnaps(before);
    return false;
  }
  let changed = false;
  for (const snap of before) {
    const part = state.parts.find(p => p.id === snap.id);
    if (geomDiffers(snap, part)) { changed = true; break; }
  }
  if (!changed) {
    releaseSnaps(before);
    return false;
  }
  const after = [];
  for (const snap of before) {
    const part = state.parts.find(p => p.id === snap.id);
    if (part) after.push(captureOne(part));
  }
  pushHistory({
    label,
    undo: () => applyPartSnaps(before, sel ? sel.before : null),
    redo: () => applyPartSnaps(after, sel ? sel.after : null),
    dispose: () => { releaseSnaps(before); releaseSnaps(after); },
  });
  return true;
}

/** 删掉这些零件。选中框、分析、支撑一起清掉，剩下的模型留在原来的位置。 */
export function removeParts(ids, opts = {}) {
  const record = opts.record !== false;
  const quiet = !!opts.quiet;
  const want = new Set(ids || []);
  const gone = state.parts.filter(p => want.has(p.id));
  if (!gone.length) return 0;
  const snaps = record && !historyReplaying() ? capturePartSnaps(gone) : null;
  const selBefore = snaps ? captureSel() : null;
  for (const p of gone) p.geom.dispose();
  state.parts = state.parts.filter(p => !want.has(p.id));
  state.selectedIds = [];
  state.transformTool = null;
  const label = gone.length === 1 ? gone[0].name : `${gone.length} 个模型`;

  if (!state.parts.length) {
    state.activePartId = null;
    state.focusId = null;
    state.protectedFaces.clear();
    dropMergedMesh();
    syncPreview(null);
  } else {
    if (!state.parts.some(p => p.id === state.activePartId)) state.activePartId = state.parts[state.parts.length - 1].id;
    if (state.focusId && !state.parts.some(p => p.id === state.focusId)) state.focusId = state.activePartId;
    syncPreview(activePart());
  }
  discardStaleWork('模型已删除，分析结果与支撑已清除，请重新分析');
  if (state.parts.length) syncPlateMesh({ faces: true });
  updateBuildVolume();
  emitModelInfo();
  bus.emit('selection', { ids: [], tool: null });
  syncFocusRing();
  if (snaps) {
    const ids = snaps.map(s => s.id);
    const histLabel = gone.length === 1 ? `删除${gone[0].name}` : `删除 ${gone.length} 个模型`;
    const selAfter = captureSel();
    pushHistory({
      label: histLabel,
      undo: () => applyPartSnaps(snaps, selBefore),
      redo: () => {
        removeParts(ids, { record: false, quiet: true });
        restoreSel(selAfter);
      },
      dispose: () => releaseSnaps(snaps),
    });
  }
  if (!quiet) {
    log(`已删除 ${label}`, 'ok');
    toast(`已删除 ${label}`);
  }
  return gone.length;
}

/** 松手：旋转烤进几何并重拼。平移已经在拖动时用矩阵显示，这里不再复制几百万顶点。 */
export function commitPartEdit(rotated) {
  if (rotated) {
    for (const p of state.parts) bakePartRotation(p);
    state.orientResult = null;
    bus.emit('orientResults', null);
    syncPlateMesh({ faces: true });
  } else if (!displayPosePending()) {
    syncPlateMesh({ faces: true });
  } else {
    updateRaft();
  }
  const part = activePart();
  if (part) syncPreview(part);
  emitModelInfo();
  syncFocusRing();
}

/* arrange：多模型时按规则重排。frame：'all' 看整板，'active' 看当前零件，false 不动相机。quiet：朝向写回时不再重复打「已载入」 */
function commitPlate({ arrange, frame, quiet }) {
  if (!state.parts.length) return;
  // 单件也保留用户拖过的位置。新载入的零件本来就在原点。
  if (state.parts.length > 1 && arrange) {
    for (const p of state.parts) bakePartRotation(p);
    const pack = arrangeParts(state.parts);
    log(`已排版 ${state.parts.length} 个模型：按底面积从大到小沿 X 成行、沿 Z 换行，间距 ${pack.gap}mm，边距 ${pack.margin}mm，整组居中`, 'ok');
    if (pack.overflow) log('⚠ 排版后仍有模型超出当前板面，可换更大的打印机或减少模型', 'warn');
  }
  syncPlateMesh();
  updateBuildVolume();
  const bb = state.mesh.geometry.boundingBox;
  const size = bb.max.clone().sub(bb.min);
  const nf = state.parts.reduce((s, p) => s + p.nf, 0);
  if (!quiet) {
    const label = state.parts.length === 1 ? state.parts[0].name : state.parts.map(p => p.name).join('、');
    log(`模型已载入：${label}（${nf.toLocaleString()} 面，最高 ${size.y.toFixed(1)}mm，离平台 ${raiseH()}mm）`, 'ok');
    if (nf > 120000) log('⚠ 面数较大，分析可能较慢', 'warn');
    const pX = params.plateX || 150, pZ = params.plateZ || 85, pY = params.plateY || 175;
    if (size.x > pX + 0.6 || size.z > pZ + 0.6) log(`⚠ 占地 ${size.x.toFixed(0)}×${size.z.toFixed(0)}mm 超出板面 ${pX}×${pZ}mm`, 'warn');
    if (size.y + raiseH() > pY + 0.6) log(`⚠ 模型加抬高后高 ${(size.y + raiseH()).toFixed(0)}mm，超过打印高度 ${pY}mm`, 'warn');
  }
  emitModelInfo();
  if (frame === 'active') {
    const p = activePart();
    if (p) framePart(p, { animate: false });
  } else if (frame === 'all') {
    frameParts(state.parts, { animate: false });
  }
  syncFocusRing();
}

export function setGeometry(geom, name) {
  resetWork();
  disposeParts();
  const g = normalizeGeom(geom);
  const part = makePart(g, name, /\(演示\)$/.test(name || ''));
  state.parts = [part];
  state.activePartId = part.id;
  syncPreview(part);
  commitPlate({ arrange: false, frame: 'all' });
}

/** 选中一个零件：朝向优化跟着它，摄影机也跳过去 */
export function setActivePart(id) {
  const p = state.parts.find(x => x.id === id);
  if (!p) return;
  const changed = state.activePartId !== p.id;
  state.activePartId = p.id;
  syncPreview(p);
  if (changed) {
    state.orientResult = null;
    bus.emit('orientResults', null);
  }
  framePart(p);
  emitModelInfo();
}

/* 加点时若点到另一件模型，由场景调用：切到该零件并跳转视角 */
export function focusPartFromHit(part) {
  if (!part || state.focusId === part.id) return;
  const changed = state.activePartId !== part.id;
  state.activePartId = part.id;
  if (changed) syncPreview(part);
  framePart(part);
  emitModelInfo();
}

/* 朝向写回当前零件的局部几何之后调用：尺寸变了就重新排版 */
export function bakeActiveLayout() {
  const part = activePart();
  if (!part) return;
  part.q.identity();
  part.geom.computeBoundingBox();
  part.geom.computeBoundingSphere();
  const size = measureGeom(part.geom);
  part.size = { x: size.x, y: size.y, z: size.z };
  part.base = { x: size.x, y: size.y, z: size.z };
  part.nf = size.nf;
  commitPlate({ arrange: state.parts.length > 1, frame: 'active', quiet: true });
}

/** 合并网格包围盒中心。底板跟着模型走，模型被拖离原点后筏层仍垫在下面。 */
const _anchor = new THREE.Vector3();
export function raftAnchor() {
  if (!state.mesh || !state.mesh.geometry.boundingBox) return { x: 0, z: 0 };
  const bb = state.mesh.geometry.boundingBox;
  _anchor.set((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2);
  if (state.mesh.matrixAutoUpdate === false) _anchor.applyMatrix4(state.mesh.matrix);
  return { x: _anchor.x, z: _anchor.z };
}

/* 筏层/网格底板显示：模型 XZ 外接圆半径 + 边距。实心筏层厚 RAFT_T；网格底板为 X/Z 交叉梁格（e-Stage 风格多孔板）。
   支撑落点高度统一走 baseY()（网格板顶 / 筏层顶 / 平台 0）。 */
export const baseY = () => (params.gridRaftOn ? (params.gridT || 0.8) : (raftOn() ? RAFT_T : 0));

/* 网格底板几何：外接圆内 X/Z 双向梁格，梁在圆边界处截弦（多孔排水，e-Stage 风格） */
export function buildGridRaftGeom() {
  const bb = state.mesh.geometry.boundingBox;
  const R = Math.hypot(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2 + raftMargin();
  const t = params.gridT || 0.8, bar = Math.max(0.2, params.gridBar || 0.8), step = Math.max(bar + 0.4, params.gridStep || 3);
  const parts = [];
  for (let z = -R + step / 2; z <= R - step / 4; z += step) {
    const hx = Math.sqrt(Math.max(0.25, R * R - z * z));
    parts.push({ g: new THREE.BoxGeometry(hx * 2, t, bar), x: 0, y: t / 2, z });
  }
  for (let x = -R + step / 2; x <= R - step / 4; x += step) {
    const hz = Math.sqrt(Math.max(0.25, R * R - x * x));
    parts.push({ g: new THREE.BoxGeometry(bar, t, hz * 2), x, y: t / 2, z: 0 });
  }
  return mergeGeoms(parts);
}

export function updateRaft() {
  if (raftMesh) { scene.remove(raftMesh); raftMesh.geometry.dispose(); raftMesh = null; }
  if (!state.mesh || (!raftOn() && !params.gridRaftOn)) return;
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a3444, roughness: 0.9, metalness: 0.05, transparent: true, opacity: 0.85 });
  const anchor = raftAnchor();
  if (params.gridRaftOn) {
    raftMesh = new THREE.Mesh(buildGridRaftGeom(), mat);
    raftMesh.position.set(anchor.x, 0, anchor.z);
  } else {
    const bb = state.mesh.geometry.boundingBox;
    const r = Math.hypot(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2 + raftMargin();
    raftMesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, RAFT_T, 64), mat);
    raftMesh.position.set(anchor.x, RAFT_T / 2, anchor.z);
  }
  raftMesh.raycast = () => {};
  scene.add(raftMesh);
}

/* 参数变更副作用（复刻旧 main.js 的 change 监听；React 组件 onChange 调用） */
export function handleRaftOnChange() { updateRaft(); toast('底板设置已变更，请重新生成支撑'); }
export function handleRaftMarginChange() { updateRaft(); }
export function handleRaiseHChange() {
  const h = raiseH();
  if (state.mesh) {
    state.mesh.position.y = h;
    if (state.mesh.matrixAutoUpdate) state.mesh.updateMatrix();
    else previewPartPose();
  }
  clearSupports(false); updateSupStats();
  state.analysis = null;
  hideInspector();
  bus.emit('sliceStats', null);
  syncFocusRing();
  log(`抬高已改为 ${h}mm（模型底面离平台），请重新运行逐层分析`, 'warn');
}

/** 板面或打印高度变了：只更新体积框，不挪已排好的模型 */
export function onPlateChanged() { updateBuildVolume(); }

/* 内置演示模型 */
export function mergeGeoms(parts) {
  const geoms = parts.map(pt => {
    let g = pt.g; if (g.index) g = g.toNonIndexed();
    g.applyMatrix4(new THREE.Matrix4().makeTranslation(pt.x || 0, pt.y || 0, pt.z || 0));
    return g;
  });
  let total = 0;
  geoms.forEach(g => total += g.attributes.position.count * 3);
  const arr = new Float32Array(total);
  let off = 0;
  geoms.forEach(g => { arr.set(g.attributes.position.array, off); off += g.attributes.position.array.length; });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  out.computeVertexNormals();
  return out;
}
export function loadDemo(kind) {
  let g;
  if (kind === 'knot') {
    g = new THREE.TorusKnotGeometry(13, 3.8, 200, 30);
    g.scale(1.5, 1.5, 1.5);
  } else if (kind === 'mushroom') {
    g = mergeGeoms([
      { g: new THREE.CylinderGeometry(3.5, 5.5, 22, 28), y: 11 },
      (() => { // 伞盖做成 1.2mm 封闭薄壳：开口的零厚度半球会被切片按实心圆盘填充，与真实几何不符
        const pts = [];
        for (let i = 0; i <= 24; i++) { const th = i / 24 * Math.PI / 2; pts.push(new THREE.Vector2(15.8 * Math.sin(th), 22 + 15.8 * Math.cos(th))); } // 内球面：顶→赤道
        for (let i = 24; i >= 0; i--) { const th = i / 24 * Math.PI / 2; pts.push(new THREE.Vector2(17.0 * Math.sin(th), 22 + 17.0 * Math.cos(th))); } // 外球面：赤道→顶
        return { g: new THREE.LatheGeometry(pts, 48), y: 0 };
      })(),
    ]);
  } else if (kind === 'tier') {
    g = mergeGeoms([
      { g: new THREE.CylinderGeometry(3, 4, 20, 24), y: 10 },         // 立柱
      { g: new THREE.CylinderGeometry(13, 13, 3, 32), y: 21.5 },      // 下层平台
      { g: new THREE.CylinderGeometry(10, 10, 3, 32), y: 26.5 },       // 上层平台（悬空 2mm）
    ]);
  } else {
    g = mergeGeoms([
      { g: new THREE.BoxGeometry(30, 5, 30), y: 2.5 },
      { g: new THREE.CylinderGeometry(7, 10, 30, 24), y: 20 },
      { g: new THREE.SphereGeometry(8, 24, 16), y: 50 },
      { g: new THREE.BoxGeometry(30, 2.5, 2.5), y: 40 },
      { g: new THREE.BoxGeometry(1.5, 28, 2.5), x: 14, y: 54 },
    ]);
  }
  setGeometry(g, { knot: '环面结(演示)', mushroom: '蘑菇(演示)', tier: '双层平台(演示)', statue: '悬臂雕像(演示)' }[kind]);
}

/* 把局部顶点变到和显示网格一样的位置（不含 raiseH），给导出用。 */
export function placeVertex(part, x, y, z, out) {
  xformCorner(part, x, y, z, _corner);
  out[0] = _corner.x;
  out[1] = _corner.y;
  out[2] = _corner.z;
}

/* 模型载入（STL / OBJ / 3MF）。不到 1GB 不减面。达到 1GB 先询问，同意后按文件大小保留 50% / 40% / 30% 的三角形。
   二进制 STL 仍在后台线程读。OBJ、3MF 与 ASCII STL 一样在当前线程收尾。 */
const stlLoader = new STLLoader();
let loadChain = Promise.resolve();

function positionsToGeom(pos, normals) {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (normals) geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  else geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 3).fill(1), 3));
  return geom;
}

/* ASCII 或后台失败时在当前线程收尾。ratio < 1 才减面。 */
function finishPositions(pos, ratio) {
  const nfIn = pos.length / 9;
  let positions = pos;
  let normals = null;
  if (ratio < 1 && nfIn > 8) {
    const out = decimate(pos, { mode: 'ratio', ratio });
    positions = out.positions;
    normals = smoothSoupNormals(positions);
  }
  const frame = frameOf(positions);
  applyFrame(positions, frame);
  return { positions, normals, nfIn, nfOut: positions.length / 9 };
}

function asciiPositions(buf) {
  let g = stlLoader.parse(buf);
  g.rotateX(-Math.PI / 2);
  if (g.index) g = g.toNonIndexed();
  const pos = new Float32Array(g.attributes.position.array);
  g.dispose();
  return pos;
}

function openSimplifyWorker() {
  return new Worker(new URL('./simplify.worker.js', import.meta.url), { type: 'module' });
}

function waitWorker(w, onProgress) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { w.terminate(); reject(new Error('简化超时')); }, 180000);
    w.onmessage = (ev) => {
      const data = ev.data || {};
      if (data.progress != null && !data.positions) {
        if (onProgress) onProgress(data.progress);
        return;
      }
      clearTimeout(timer);
      w.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    w.onerror = () => {
      clearTimeout(timer);
      w.terminate();
      reject(new Error('后台线程启动失败'));
    };
  });
}

function workerJob(buffer, ratio) {
  const w = openSimplifyWorker();
  const done = waitWorker(w, (p) => setProgress(0.15 + p * 0.7, '简化大模型…'));
  w.postMessage({ buffer, ratio }, [buffer]);
  return done;
}

function decimateJob(positions, opts) {
  const w = openSimplifyWorker();
  const copy = positions.slice();
  const done = waitWorker(w, (p) => setProgress(0.1 + p * 0.8, '简化模型…'));
  w.postMessage({ kind: 'decimate', positions: copy, mode: opts.mode, ratio: opts.ratio, fidelity: opts.fidelity }, [copy.buffer]);
  return done;
}

/** 简化选中的模型。没选中时用当前这一个。简化结果替换原网格。 */
export async function simplifySelection(opts) {
  const ids = (state.selectedIds && state.selectedIds.length)
    ? state.selectedIds.slice()
    : (activePart() ? [activePart().id] : []);
  if (!ids.length) { toast('请先载入模型'); return; }
  const targets = state.parts.filter(p => ids.includes(p.id));
  const before = historyReplaying() ? null : capturePartSnaps(targets);
  setProgress(0.05, '简化模型…');
  try {
    for (const id of ids) {
      const part = state.parts.find(p => p.id === id);
      if (!part) continue;
      const before = part.geom.attributes.position.count / 3;
      const parsed = await decimateJob(part.geom.attributes.position.array, opts);
      if (!parsed || !parsed.positions || parsed.positions.length < 9) {
        log(`${part.name} 简化失败`, 'warn');
        continue;
      }
      part.geom.dispose();
      part.geom = positionsToGeom(parsed.positions, parsed.normals);
      part.smooth = true;
      part.source = null;
      part.nfFull = parsed.nfIn;
      part.protected = new Set();
      const size = measureGeom(part.geom);
      part.size = { x: size.x, y: size.y, z: size.z };
      part.base = { x: size.x, y: size.y, z: size.z };
      part.nf = size.nf;
      const how = opts.mode === 'fidelity'
        ? `保真度 ${Number(opts.fidelity).toFixed(2)}`
        : `保留 ${Math.round((opts.ratio || 0.5) * 100)}%`;
      log(`${part.name}：${how}，${before.toLocaleString()} → ${part.nf.toLocaleString()} 面`, 'ok');
    }
    state.protectedFaces.clear();
    state.analysis = null;
    clearSupports(false);
    updateSupStats();
    hideInspector();
    bus.emit('sliceStats', null);
    bus.emit('orientResults', null);
    state.orientResult = null;
    if (activePart()) syncPreview(activePart());
    syncPlateMesh({ faces: true });
    emitModelInfo();
    syncFocusRing();
  } finally {
    setProgress(null);
    if (before) commitGeomHistory('简化模型', before);
  }
}

function adoptParsed(parsed, name, ratio) {
  if (!parsed || !parsed.positions || parsed.positions.length < 9) return null;
  const part = makePart(positionsToGeom(parsed.positions, parsed.normals), name, false);
  if (ratio < 1 && parsed.nfIn > parsed.nfOut) {
    part.smooth = true;
    part.nfFull = parsed.nfIn;
    log(`${name}：文件超过 1GB，已按 ${Math.round(ratio * 100)}% 保留三角形（${parsed.nfIn.toLocaleString()} → ${parsed.nfOut.toLocaleString()} 面）`, 'ok');
  }
  return part;
}

function askSimplify(names) {
  const list = names.join('、');
  return window.confirm(`检测到超大模型（${list}）。\n文件很大，可能让软件变慢或卡住。\n\n建议简化模型。简化后仍能满足绝大多数打印需求。\n\n确定：简化后导入\n取消：按原模型导入`);
}

/* 扩展名决定格式。没写名字时仍按 STL，方便原来的 loadSTLBuffer(buf)。 */
function prepareImport(items) {
  const list = [];
  let skipped = 0;
  for (const it of items || []) {
    if (!it || !it.buf) { skipped++; continue; }
    const name = it.name || '未命名.stl';
    const kind = modelKind(name);
    if (!kind) { skipped++; continue; }
    list.push({ buf: it.buf, name, kind });
  }
  return { list, skipped };
}

function positionsFor(it) {
  if (it.kind === 'obj') return objPositions(it.buf);
  if (it.kind === '3mf') return threeMfPositions(it.buf);
  return asciiPositions(it.buf);
}

async function ingestSTL(items, { append = false } = {}) {
  const { list, skipped } = prepareImport(items);
  if (!list.length) {
    if (items && items.length) toast('请选择 .stl、.obj 或 .3mf 文件');
    return;
  }
  if (skipped) log(`已跳过 ${skipped} 个不支持的文件`, 'warn');
  setProgress(0.05, `读取 ${list[0].name}…`);
  resetWork();
  clearHistory();
  if (!append) disposeParts();
  else {
    const drop = state.parts.filter(p => p.demo);
    for (const p of drop) p.geom.dispose();
    state.parts = state.parts.filter(p => !p.demo);
  }
  const huge = list.filter(it => it.buf.byteLength >= SIMPLIFY_MIN_BYTES);
  const agree = huge.length > 0 && askSimplify(huge.map(it => it.name));
  try {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const ratio = agree ? blueprintRatio(it.buf.byteLength) : 1;
      setProgress(0.08 + 0.84 * (i / list.length), ratio < 1 ? `简化 ${it.name}…` : `读取 ${it.name}…`);
      try {
        const parsed = it.kind === 'stl' && isBinarySTL(it.buf)
          ? await workerJob(it.buf, ratio)
          : finishPositions(positionsFor(it), ratio);
        const part = adoptParsed(parsed, it.name, ratio);
        if (part) state.parts.push(part);
        else log(`文件里没有三角面（${it.name}）`, 'warn');
      } catch (e) {
        log(`解析失败（${it.name}）：${e.message || e}`, 'warn');
      }
    }
  } finally {
    setProgress(null);
  }
  if (!state.parts.length) {
    toast('没有载入成功的模型');
    if (state.mesh) { modelGroup.remove(state.mesh); state.mesh.geometry.dispose(); state.mesh = null; }
    state.faces = null;
    emitModelInfo();
    return;
  }
  if (!state.parts.some(p => p.id === state.activePartId)) state.activePartId = state.parts[0].id;
  syncPreview(activePart());
  commitPlate({ arrange: state.parts.length > 1, frame: 'all' });
  log('已将 Z-up 转为 Y-up，如需调整可运行朝向优化');
}

export function loadSTLBuffer(buf, name) {
  return loadSTLBuffers([{ buf, name }], { append: false });
}
export function loadSTLBuffers(items, opts) {
  const run = loadChain.then(() => ingestSTL(items, opts));
  loadChain = run.catch(() => {});
  return run;
}
