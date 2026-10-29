/* ================================================================
   模型载入：setGeometry / loadDemo（5 个内置 demo）/ loadSTLBuffer(s) / mergeGeoms /
   updateRaft / 参数辅助（raiseH）。
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
import { scene, modelGroup, modelMat, prevScene, prev, framePart, frameParts, updateBuildVolume, syncFocusRing, bindClip } from './scene.js';
import { autoPlateSpec, plateFingerprint } from './basePlate.js';
import { autoPlateAsync, cutAsync } from './geomClient.js';
import { fitPlane, describeRepair } from './cutKit.js';
import { nestPlate } from './nest.js';
import { clearNestRulers, showNestRulers } from './nestRuler.js';

/* 包围盒八个角变换时复用，不外传 */
const _corner = new THREE.Vector3();
import { computeFaceDataFull } from './slicer.js';
import { autoPlateThickness } from './joinPlate.js';
import { clearSupports, shiftSupports, updateSupStats, cloneSupportsOnto, cloneSupportVisuals, dropSupportsOf, supportPointsOf, dropSupportMeshesOf, refreshSupportsForPlate, tagSupportOwners, stampSupportPartIds, relocateSupports, relocateSupportsInverse } from './support.js';
import { confirmAction } from './confirm.js';
import { buildBVH, raycast as bvhRaycast } from './collide.js';
import { hideInspector } from './inspect.js';

/* 打印工艺参数：世界系 = 打印系（平台顶面 y=0，模型底面抬高 raiseH） */
let raftMesh = null;          // 自动底板显示 Mesh
// 模型抬高（mm）= 已生效的用户抬高（默认 4，但要进过支撑步骤才生效，此前为 0、底面贴平台）
//   + 底板额外抬高（连接底板的板高，或自动底板的板厚，见 joinPlate.js）。
// 额外抬高取「已提交」的值 state.joinLift：只在生成 / 重建支撑（或切换底板类型 / 改板厚 / 结构 / 模板）时由 support.js 的 syncModelLift 更新，
// 改了格宽等参数但还没重建时，模型、分析与已有支撑仍在同一高度上，导出不会错位
export const baseRaiseH = () => Math.max(0, params.raiseH || 0);   // 用户设的抬高（不含连接底板，未进支撑步骤时还不作用到模型上）
export const raiseH = () => (state.supportLiftOn ? baseRaiseH() : 0) + (state.joinLift || 0);

const _yawAxis = new THREE.Vector3(0, 1, 0);

function inversePoseMoves(moves) {
  return (moves || []).map(m => ({
    id: m.id,
    ox0: m.ox1, oy0: m.oy1, oz0: m.oz1,
    ox1: m.ox0, oy1: m.oy0, oz1: m.oz0,
    yaw: -(m.yaw || 0),
  }));
}

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

/* 朝向预览仍跟着当前这一件。分析、热力图和支撑的范围用 supportScopeIds。 */
export function supportTargetPart() {
  if (state.manualPartId) {
    const locked = state.parts.find(p => p.id === state.manualPartId);
    if (locked) return locked;
  }
  const ids = state.selectedIds || [];
  if (ids.length) {
    const id = ids.includes(state.activePartId) ? state.activePartId : ids[ids.length - 1];
    return state.parts.find(p => p.id === id) || null;
  }
  if (state.parts.length <= 1) return state.parts[0] || null;
  return null;
}

/** 分析、热力图、自动支撑和手动加点的作用范围。
 *  板上只有一个模型时返回 null，表示不过滤。
 *  多个模型时返回视口选中的 id；一个都没选中则返回空集合，调用方提示、不整盘处理。 */
export function supportScopeIds() {
  if ((state.parts || []).length <= 1) return null;
  const set = new Set();
  for (const id of state.selectedIds || []) {
    if (state.parts.some(p => p.id === id)) set.add(id);
  }
  return set;
}

/** 日志里的范围说明。没有过滤时返回空串。verb 例如「只分析」「只给」。 */
export function supportScopeNote(verb) {
  const scope = supportScopeIds();
  if (!scope || !scope.size) return '';
  const names = [];
  for (const p of state.parts) if (scope.has(p.id)) names.push(`「${p.name}」`);
  return names.length ? `（${verb}${names.join('、')}）` : '';
}

/** 手动加点 / 多线段：点到的面必须落在当前范围内。不通过时提示并返回 false。 */
export function acceptSupportFace(faceIndex) {
  const scope = supportScopeIds();
  if (!scope) return true;
  if (!scope.size) { toast('先选中模型，再添加支撑'); return false; }
  const loc = localFaceOf(faceIndex);
  if (!loc || !scope.has(loc.part.id)) { toast('只能给选中的模型添加支撑'); return false; }
  return true;
}

/* 热力图开着时顶点色归热力图，这里不盖。heat.js 在关掉热力图之后会再调一次。 */
let heatActive = () => false;
export function setHeatActiveReader(fn) { heatActive = fn; }
/* 选中且热力图关闭时，把选中模型涂成热力图的蓝色（仍受光）。 */
let paintSelected = null;
export function setSelectedPainter(fn) { paintSelected = fn; }

/* 零件几何保持白。选中色如果写进这里，重拼网格会盖掉热力图。 */
function clearBakedTint() {
  for (const p of state.parts) {
    const ca = p.geom.attributes.color;
    if (!ca) continue;
    ca.array.fill(1);
    for (const f of p.protected) {
      const v = f * 3;
      ca.setXYZ(v, 1, 0.38, 0.38);
      ca.setXYZ(v + 1, 1, 0.38, 0.38);
      ca.setXYZ(v + 2, 1, 0.38, 0.38);
    }
    ca.needsUpdate = true;
  }
}

function paintNeutralMesh() {
  if (!state.mesh) return;
  bus.emit('restoreLitModel');
  if (state.mesh.material !== modelMat) state.mesh.material = modelMat;
  const ca = state.mesh.geometry.attributes.color;
  if (!ca) return;
  ca.array.fill(1);
  for (const f of state.protectedFaces) {
    const v = f * 9;
    for (let k = 0; k < 3; k++) {
      ca.array[v + k * 3] = 1;
      ca.array[v + k * 3 + 1] = 0.38;
      ca.array[v + k * 3 + 2] = 0.38;
    }
  }
  ca.needsUpdate = true;
}

/** 热力图开着时不改。关掉时：有选中就用热力图的蓝，否则回到带光照的灰。 */
export function syncPartTint() {
  clearBakedTint();
  if (heatActive() || !state.mesh) return;
  if ((state.selectedIds || []).length && paintSelected && paintSelected()) return;
  paintNeutralMesh();
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

/* 合并网格上的三角面 → 零件局部面索引（保护面按零件记，重拼网格时不会串）。
   范围必须唯一。faceStart 都是 0 时，从后往前「fi >= faceStart」会把全部面判给最后一件，
   选中最后一件就会给没选中的模型也布支撑。重叠或对不上就返回 null，让调用方按占地判断。 */
export function localFaceOf(fi) {
  const hits = [];
  for (const p of state.parts) {
    const start = p.faceStart || 0;
    const n = p.geom && p.geom.attributes.position
      ? p.geom.attributes.position.count / 3
      : (p.nf || 0);
    if (n > 0 && fi >= start && fi < start + n) hits.push(p);
  }
  if (hits.length === 1) return { part: hits[0], local: fi - (hits[0].faceStart || 0) };
  if (hits.length > 1) {
    hits.sort((a, b) => (b.faceStart || 0) - (a.faceStart || 0));
    if ((hits[0].faceStart || 0) !== (hits[1].faceStart || 0)) {
      return { part: hits[0], local: fi - (hits[0].faceStart || 0) };
    }
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
  clearNestRulers();
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

/** 零件第 local 个三角形的三个顶点，按当前姿态摆进网格局部系（不含 raiseH），写进 out（9 个数）。序号越界返回 null */
export function partTriangle(part, local, out) {
  const attr = part && part.geom && part.geom.attributes.position;
  if (!attr || local < 0 || local * 3 + 2 >= attr.count) return null;
  const src = attr.array;
  for (let k = 0; k < 3; k++) {
    const i = local * 9 + k * 3;
    xformCorner(part, src[i], src[i + 1], src[i + 2], _corner);
    out[k * 3] = _corner.x;
    out[k * 3 + 1] = _corner.y;
    out[k * 3 + 2] = _corner.z;
  }
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

/** 每件模型的最低点落到平台上（世界 y = 0）。悬空的落下去，扎进平台的抬上来。
 *  用真实顶点，不用外接盒的八个角：转过之后角会比曲面更低，按角来放会让模型还悬着。 */
export function seatPartsOnPlate(parts) {
  if (!parts || !parts.length) return;
  const floor = -raiseH();
  for (const p of parts) {
    const src = p.geom.attributes.position.array;
    let minY = Infinity;
    for (let i = 0; i < src.length; i += 3) {
      xformCorner(p, src[i], src[i + 1], src[i + 2], _corner);
      if (_corner.y < minY) minY = _corner.y;
    }
    if (minY === Infinity) continue;
    const dy = floor - minY;
    if (Math.abs(dy) > 1e-4) p.oy = (p.oy || 0) + dy;
  }
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

/* ---------- 按面放置（对照黑格 Blueprint Studio「选择面」） ----------
   点一个面，把它转到朝下（或朝上），再让整件模型的最低点落到平台，水平位置不动。
   与黑格一致：只作用于点中的那一件；旋转取最短弧，正好反向时绕 X 转 180°；
   落板的是整件的最低点，不是点中的那个面（点中的面在凹处时，贴板的是整件最低处）；
   这一件已有支撑时先问一声（requestLayOnFace），同意才放置并移除这一件的支撑，别的模型的支撑不动。
   有意不同：点中的只是倒角上一小片三角时，把同一平面上法线相近的三角并成用户看到的那一块再定向
   （黑格直接取这一个三角形的法线）。 */
const _layN = new THREE.Vector3();
const _layDown = new THREE.Vector3(0, -1, 0);
const _layUp = new THREE.Vector3(0, 1, 0);
const _layX = new THREE.Vector3(1, 0, 0);
const _layQ = new THREE.Quaternion();
const _layQi = new THREE.Quaternion();
const _layA = new THREE.Vector3();
const _layB = new THREE.Vector3();
const _layC = new THREE.Vector3();
const _layT = new THREE.Vector3();
/* 已经朝向目标、也已落板的判据：法线偏差小于 0.1°，最低点离板小于 0.01mm */
const LAY_COS_SAME = Math.cos(0.1 * Math.PI / 180);
const LAY_FLUSH = 0.01;

function triNormal(attr, fi, out) {
  _layA.fromBufferAttribute(attr, fi * 3);
  _layB.fromBufferAttribute(attr, fi * 3 + 1);
  _layC.fromBufferAttribute(attr, fi * 3 + 2);
  return out.subVectors(_layB, _layA).cross(_layT.subVectors(_layC, _layA));
}

/* 点中的三角可能只是倒角上的一小片。把同一平面上、法线接近的三角并成一个面，才是用户看到的那一块。
   attr 必须是这一件自己的顶点：合并网格里别的零件的三角形不能参与，否则会把法线拉偏。 */
function regionNormal(attr, seed, hint) {
  const n0 = triNormal(attr, seed, _layN);
  if (n0.lengthSq() < 1e-12) {
    if (!hint || hint.lengthSq() < 1e-12) return null;
    return hint.clone().normalize();
  }
  n0.normalize();
  if (hint && hint.lengthSq() > 1e-8) {
    const h = hint.clone().normalize();
    if (n0.dot(h) < 0) n0.negate();
    // 射线打中的法线才是屏幕上那一面。索引算出来的法线若对不上，以射线为准。
    if (n0.dot(h) < 0.985) n0.copy(h);
  }
  const planeD = n0.dot(_layA.fromBufferAttribute(attr, seed * 3));
  const acc = new THREE.Vector3();
  const cos = Math.cos(10 * Math.PI / 180);
  const nf = (attr.count / 3) | 0;
  for (let f = 0; f < nf; f++) {
    const n2 = triNormal(attr, f, _layT);
    const len = n2.length();
    if (len < 1e-8) continue;
    n2.multiplyScalar(1 / len);
    if (n0.dot(n2) < cos) continue;
    _layB.fromBufferAttribute(attr, f * 3);
    if (Math.abs(n0.dot(_layB) - planeD) > 0.25) continue;
    acc.addScaledVector(n2, len);
  }
  if (acc.lengthSq() < 1e-12) return n0.clone();
  return acc.normalize();
}

/* 外接盒是否与别的模型重叠。只用来提醒，不阻止：外接盒重叠不等于模型真的相碰 */
function boxOverlapsOthers(part) {
  const a = partBounds(part);
  for (const o of state.parts) {
    if (o === part) continue;
    const b = partBounds(o);
    if (a.min.x < b.max.x && a.max.x > b.min.x
      && a.min.y < b.max.y && a.max.y > b.min.y
      && a.min.z < b.max.z && a.max.z > b.min.z) return true;
  }
  return false;
}

/* 只算不改：点中的面属于哪一件、这一块的法线（世界系）、整件最低点、是不是已经满足。
   dir 缺省读 params.layFace（down 朝下 / up 朝上）。 */
function planLay(faceIndex, worldNormal, dirOpt) {
  const dir = dirOpt === 'up' || dirOpt === 'down' ? dirOpt : (params.layFace === 'up' ? 'up' : 'down');
  const loc = localFaceOf(faceIndex);
  if (!loc || !state.mesh) return { err: '点到模型上的面，才能按这个面放置' };
  const part = loc.part;
  const attr = part.geom && part.geom.attributes.position;
  if (!attr || loc.local * 3 + 2 >= attr.count) return { err: '这个面没法用来定向' };
  const turned = !quatIsIdentity(part.q);
  // 射线给的是世界法线，换回这一件的局部系再并区域（局部系 = 世界系绕中心转回 part.q）
  let hint = null;
  if (worldNormal && worldNormal.lengthSq() > 1e-8) {
    hint = worldNormal.clone().normalize();
    if (turned) hint.applyQuaternion(_layQi.copy(part.q).invert());
  }
  const n = regionNormal(attr, loc.local, hint);
  if (!n) return { err: '这个面太小，没法用来定向', part };
  if (turned) n.applyQuaternion(part.q);
  // 整件的最低点：用真实顶点，不用外接盒的八个角
  const src = attr.array;
  let minY = Infinity;
  for (let i = 0; i < src.length; i += 3) {
    xformCorner(part, src[i], src[i + 1], src[i + 2], _corner);
    if (_corner.y < minY) minY = _corner.y;
  }
  const T = dir === 'up' ? _layUp : _layDown;
  return { dir, part, n, T, minY, satisfied: n.dot(T) >= LAY_COS_SAME && Math.abs(minY) < LAY_FLUSH };
}

/**
 * 点一个面，把这个面转到朝下（opts.dir 为 'up' 时朝上），再把整件的最低点落到平台，XZ 不动。
 * 这个面已经朝向目标、整件也已落板时什么都不改，返回 false。
 * 这一件的支撑会被移除（几何变了就对不上）；要先征求同意用 requestLayOnFace。
 */
export function layPartOnFace(faceIndex, worldNormal, opts = {}) {
  ensureBakedDisplay();
  const plan = planLay(faceIndex, worldNormal, opts.dir);
  if (plan.err) {
    if (plan.part) setSelection([plan.part.id]);   // 点中了这件模型，只是这一面没法定向：照样选中它
    toast(plan.err);
    return false;
  }
  const { part, dir, n, T } = plan;
  const dirText = dir === 'up' ? '朝上' : '朝下';
  if (plan.satisfied) {
    setSelection([part.id]);
    toast(`这个面已经${dirText}，模型也已落在平台上`);
    return false;
  }
  const before = capturePartSnaps([part]);
  // 几何一动就认不出支撑点归谁，先摘
  const removed = dropSupportsOf([part.id]);
  bakePartRotation(part);
  const geom = part.geom;
  const cy = part.base.y / 2;
  const dot = n.dot(T);
  let turn = true;
  if (dot > 1 - 1e-9) { _layQ.identity(); turn = false; }
  else if (dot < -1 + 1e-9) _layQ.setFromAxisAngle(_layX, Math.PI);   // 正好反向：绕 X 转 180°，与黑格一致
  else _layQ.setFromUnitVectors(n, T);
  if (turn) {
    geom.translate(0, -cy, 0);
    geom.applyQuaternion(_layQ);   // 法线跟着转，不必重算
    geom.translate(0, cy, 0);
  }
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  const low = bb.min.y;
  // 局部几何回到「底面 y=0、XZ 居中」，位置补进 ox / oz。oy 清零 = 整件最低点落在板面
  geom.translate(-cx, -low, -cz);
  part.ox += cx;
  part.oz += cz;
  part.oy = 0;
  if (part.source && part.source !== geom.attributes.position.array) bakeSource(part.source, _layQ, cy, cx, low, cz);
  part.q.identity();
  if (!geom.attributes.normal) {
    if (part.smooth) geom.setAttribute('normal', new THREE.BufferAttribute(smoothSoupNormals(geom.attributes.position.array), 3));
    else geom.computeVertexNormals();
  }
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  const size = measureGeom(geom);
  part.base = { x: size.x, y: size.y, z: size.z };
  part.size = { x: size.x, y: size.y, z: size.z };
  part.nf = size.nf;
  part.born = { x: size.x, y: size.y, z: size.z };
  dropAnalysis();
  syncPlateMesh({ faces: true });
  updateBuildVolume();
  setSelection([part.id]);
  syncPreview(part);
  syncFocusRing();
  // 别的模型的支撑点还在，按剩下的点重做分析和结构（没有点就清掉网格）
  if (removed.length) refreshSupportsForPlate();
  const removedNote = removed.length ? `，这一件的 ${removed.length} 个支撑点已移除` : '';
  log(`已按点选的面放置「${part.name}」：这个面${dirText}，整件最低点落在平台${removedNote}。请重新分析`, 'ok');
  toast(removed.length ? `这个面已${dirText}，并移除了该模型的支撑` : `这个面已${dirText}并落在平台上`);
  if (cellLeavesPlate([part], 0, 0, 0)) log('⚠ 放置后模型超出当前板面或打印高度，请检查位置', 'warn');
  if (boxOverlapsOthers(part)) log('⚠ 放置后与其他模型的外接盒重叠，请检查位置', 'warn');
  commitGeomHistory('按面放置', before, null, {
    keepSupports: true,
    onUndo: () => { if (removed.length) { putSupportsBack(removed); refreshSupportsForPlate(); } },
    onRedo: () => { if (removed.length) { dropSupportsOf([part.id]); refreshSupportsForPlate(); } },
  });
  return true;
}

/**
 * 交互入口：和黑格一样，所选模型已有支撑时先问一声，同意才放置并移除这一件的支撑。
 * 取消、出错、无需改动都返回 false。没有支撑时不弹框，直接放置。
 */
export async function requestLayOnFace(faceIndex, worldNormal, opts = {}) {
  ensureBakedDisplay();
  const plan = planLay(faceIndex, worldNormal, opts.dir);
  // 出错或本来就满足：不必吓人，交给 layPartOnFace 自己提示
  if (plan.err || plan.satisfied) return layPartOnFace(faceIndex, worldNormal, opts);
  const id = plan.part.id;
  if (supportPointsOf([id]).length) {
    const yes = await confirmAction({
      title: '提醒',
      text: '所选模型已有支撑，继续放置会移除这个模型上的支撑。是否继续？',
      okText: '移除支撑并放置',
      cancelText: '取消',
    });
    if (!yes) return false;
    // 等待确认期间板上可能变过，点中的面不再属于这一件就放弃
    const again = localFaceOf(faceIndex);
    if (!again || again.part.id !== id) return false;
  }
  return layPartOnFace(faceIndex, worldNormal, opts);
}

/* ---------- 画线切割（内核见 cutKit.js） ----------
   画线（闭合圈，网格局部系）→ 拟合切面 → 后台线程里切开并按需加梯形插销 → 一件换成两件（A 在切面法线一侧，B 在另一侧）。
   两件都留在原来的位置、切面贴合；各自的局部几何回到「底面 y=0、XZ 居中」，位置补进 ox / oy / oz，q 为单位。
   整件顶点先按当前姿态摆进网格局部系再送去切，原零件在切好之前不动：切不开、被取消、切割期间被改动都原样不变。
   这一件有支撑点时先问一声（requestCutPart），同意才切并摘掉这一件的支撑，别的模型的支撑不动。
   保护面按三角形序号记，切完序号全变，不带到两块上。 */

/** 零件顶点按当前姿态摆进网格局部系（不含 raiseH），与画线点同一个坐标系 */
function partSoupInMeshFrame(part) {
  const src = part.geom.attributes.position.array;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    xformCorner(part, src[i], src[i + 1], src[i + 2], _corner);
    out[i] = _corner.x;
    out[i + 1] = _corner.y;
    out[i + 2] = _corner.z;
  }
  return out;
}

/** 切出来的一块（网格局部系的三角形汤）→ 新零件：底面落到局部 y=0、XZ 居中，位置补回 ox / oy / oz，切块仍在原处 */
function partFromCutSoup(pos, name, src) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < minX) minX = pos[i];
    if (pos[i] > maxX) maxX = pos[i];
    if (pos[i + 1] < minY) minY = pos[i + 1];
    if (pos[i + 2] < minZ) minZ = pos[i + 2];
    if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] -= cx;
    pos[i + 1] -= minY;
    pos[i + 2] -= cz;
  }
  const smooth = !!src.smooth;   // 简化过的模型沿用平滑法线，其余按面着色
  const part = makePart(positionsToGeom(pos, smooth ? smoothSoupNormals(pos) : null), name, false);
  part.ox = cx;
  part.oy = minY;
  part.oz = cz;
  part.smooth = smooth;
  return part;
}

/**
 * 沿画线切开一件模型。loop 是闭合圈上的点 [{x,y,z}]（网格局部系，不含 raiseH）；
 * opts.pin 为 null（只切不加销）或 { size, depth, clear, taper, aspect }（梯形插销，缺省值见 cutKit 的 PIN_DEFAULTS）；
 * opts.surface 为 'line'（默认：切口沿画线，线很平时按平面）或 'plane'（一律切最佳拟合平面）。
 * 返回 { ok: true, ids: [A, B], plane, info } 或 { ok: false, code, reason }。切不开是正常结果，不抛异常。
 * 这一件的支撑会被移除；要先征求同意用 requestCutPart。
 */
export async function cutPartByLine(partId, loop, opts = {}) {
  ensureBakedDisplay();
  const part = state.parts.find(p => p.id === partId);
  if (!part) return { ok: false, code: 'NO_PART', reason: '要切的模型已不在板上' };
  const plane = fitPlane(loop);
  if (!plane) return { ok: false, code: 'LINE_FLAT', reason: '画线围不出切面：点太少或几乎在一条直线上' };
  clearNestRulers();
  const arr0 = part.geom.attributes.position.array;
  const sig = () => [part.ox, part.oy, part.oz, part.q.x, part.q.y, part.q.z, part.q.w, part.base.x, part.base.y, part.base.z].join('|');
  const sig0 = sig();
  const t0 = performance.now();
  const pos = partSoupInMeshFrame(part);
  const flat = [];
  for (const p of loop) flat.push(p.x, p.y, p.z);
  const t1 = performance.now();
  let res;
  try {
    res = await cutAsync({
      pos, plane: { c: plane.c, n: plane.n }, loop: flat, pin: opts.pin || null,
      gap: typeof opts.gap === 'number' ? opts.gap : params.cutGap,
      wall: typeof opts.wall === 'number' ? opts.wall : params.cutWall,
      surface: opts.surface === 'plane' ? 'plane' : 'line',
    });
  } catch (e) {
    return { ok: false, code: 'KERNEL', reason: `几何内核出错：${(e && e.message) || e}` };
  }
  const t2 = performance.now();
  if (!res.ok) {
    /* 修复路径跑过就说明白修了什么：失败原因本身由 cutLine.js 那条「画线切割没成」写，这里不重复 */
    if (res.repair) log(`网格不是水密的，已尝试自动修复：${describeRepair(res.repair)}；这次没切成，原模型没有改动`, 'warn');
    return res;
  }
  // 切的时候用户动过这件模型（移动 / 缩放 / 旋转 / 删除 / 换了几何）：结果对不上了，放弃
  if (!state.parts.includes(part) || part.geom.attributes.position.array !== arr0 || sig() !== sig0) {
    return { ok: false, code: 'STALE', reason: '切割期间模型被改动，已放弃，请重新切割' };
  }

  const idx = state.parts.indexOf(part);
  const before = capturePartSnaps([part]);
  const selBefore = captureSel();
  const removed = dropSupportsOf([part.id]);   // 几何一换就认不出支撑点归谁，先摘
  const lostProt = part.protected ? part.protected.size : 0;
  const A = partFromCutSoup(res.upper.pos, `${part.name}-A`, part);
  const B = partFromCutSoup(res.lower.pos, `${part.name}-B`, part);
  state.parts.splice(idx, 1, A, B);
  part.geom.dispose();
  dropAnalysis();
  syncPlateMesh({ faces: true });
  updateBuildVolume();
  setSelection([A.id]);   // 只选 A：一蓝一灰，切缝看得出来
  syncFocusRing();
  if (removed.length) refreshSupportsForPlate();
  const t3 = performance.now();

  const ids = [A.id, B.id];
  const snapsAfter = capturePartSnaps([A, B]);
  const selAfter = captureSel();
  pushHistory({
    label: '画线切割',
    undo: () => {
      applyPartSnaps(before, selBefore, { keepSupports: true, dropIds: ids });
      if (removed.length) { putSupportsBack(removed); refreshSupportsForPlate(); }
    },
    redo: () => {
      if (removed.length) dropSupportsOf([part.id]);   // 零件还在时先摘点，之后就认不出了
      applyPartSnaps(snapsAfter, selAfter, { keepSupports: true, dropIds: [part.id] });
      if (removed.length) refreshSupportsForPlate();
    },
    dispose: () => { releaseSnaps(before); releaseSnaps(snapsAfter); },
  });

  const info = res.info;
  const pin = info.pin;
  const pinNote = pin ? `，梯形插销 宽 ${pin.size.toFixed(1)} × 深 ${pin.depth.toFixed(1)} mm` : (opts.pin ? '，未加插销' : '');
  /* 曲面切（cutSeam.js）的切缝就是画线本身：画线点之间沿表面走，不再有「吸附到网格顶点」的偏差可报 */
  const seamNote = info.surface === 'line' && info.sheet ? '，切口沿画线' : '';
  if (info.repair) log(`网格不是水密的，已自动修复再切：${describeRepair(info.repair)}`);
  log(`已按画线切开「${part.name}」：A ${A.nf.toLocaleString()} 面 + B ${B.nf.toLocaleString()} 面${seamNote}${pinNote}（内核 ${info.ms.total} ms）`, 'ok');
  if (removed.length) log(`这一件的 ${removed.length} 个支撑点已移除，请重新分析并生成支撑`, 'warn');
  if (lostProt) log(`「${part.name}」上的 ${lostProt} 个保护面没有带到切块上（面片已重新划分），需要的话请重新涂画`, 'warn');
  for (const w of info.warn || []) log(`⚠ ${w}`, 'warn');
  if (info.surface === 'plane' && plane.dev > Math.max(0.5, plane.span * 0.03)) {
    log(`⚠ 画线不在同一平面上（最大偏离 ${plane.dev.toFixed(2)} mm），按「平面」切的是最佳拟合平面，切口与画线有出入；要切口沿画线请把「切面」改成「随画线」`, 'warn');
  }
  if (opts.pin && !pin) {
    toast(removed.length ? '已切成两件，但没放下插销，并移除了这一件的支撑' : '已切成两件，但没放下插销', {
      description: (info.warn || []).find(w => w.includes('插销')) || '切面太薄、太窄或起伏太大；把插销尺寸调小后重切',
    });
  } else toast(removed.length ? '已切成两件，并移除了这一件的支撑' : '已切成两件');
  return {
    ok: true, ids, plane, info: {
      ...info,
      timing: {
        pack: +(t1 - t0).toFixed(1),                       // 主线程：摆姿态 + 拷贝顶点
        worker: +(t2 - t1).toFixed(1),                     // 排队 + 传输 + 后台计算 + 传回
        transfer: +(t2 - t1 - info.ms.total).toFixed(1),   // 其中不是内核计算的部分（排队 / 拷贝 / 传回）
        apply: +(t3 - t2).toFixed(1),                      // 主线程：建零件 + 重拼显示网格 + 快照
        total: +(t3 - t0).toFixed(1),
      },
    },
  };
}

/**
 * 交互入口：这一件已有支撑时先问一声，同意才切并移除这一件的支撑。取消返回 { ok: false, cancelled: true }。
 * 没有支撑时不弹框，直接切。
 */
export async function requestCutPart(partId, loop, opts = {}) {
  ensureBakedDisplay();
  if (supportPointsOf([partId]).length) {
    const yes = await confirmAction({
      title: '提醒',
      text: '这个模型已有支撑，切割后几何变了，会移除它上面的支撑。是否继续？',
      okText: '移除支撑并切割',
      cancelText: '取消',
    });
    if (!yes) return { ok: false, cancelled: true, code: 'CANCEL', reason: '已取消' };
  }
  return cutPartByLine(partId, loop, opts);
}

/* 比例下限只为了不翻面；实际尺寸再抬到 DIM_MIN。上限防止一次拖成天文数字。 */
const SCALE_MAX = 40;
const DIM_MIN = 0.2;

export function clampScale(f, base) {
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

/** 合并网格变了，分析作废。别的零件上的支撑先留着，不整板清掉。 */
function dropAnalysis() {
  if (state.orientResult) {
    state.orientResult = null;
    bus.emit('orientResults', null);
  }
  if (!state.analysis) return;
  state.analysis = null;
  hideInspector();
  bus.emit('sliceStats', null);
}

/** 把先前拿出来的支撑点放回去。同一个点对象不重复塞。 */
function putSupportsBack(pts) {
  if (!pts || !pts.length) return;
  if (!state.supportPoints) state.supportPoints = [];
  const have = new Set(state.supportPoints);
  for (const p of pts) if (!have.has(p)) state.supportPoints.push(p);
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
    seatPartsOnPlate([part]);
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
  seatPartsOnPlate([part]);
  tuckPartOntoPlate(part);
  commitPartEdit(false);
  if (before) commitGeomHistory('缩放到适合机型', before);
  return out;
}

/** 选中正好一件时返回它。多选时各件尺寸可能不同，这里返回 null。缩放面板改的是选中的全部零件。 */
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
  prev.mesh = new THREE.Mesh(part.geom, new THREE.MeshStandardMaterial({ color: 0xa7b0bd, roughness: 0.55, metalness: 0.15 }));
  prevScene.add(prev.mesh);
}

function resetWork() {
  clearNestRulers();
  clearSupports(false);
  state.joinLift = 0;   // 换模型后不再悬在上一块底板的高度上，底面回到平台
  state.supportLiftOn = false;   // 新模型先贴平台，进支撑步骤再按「模型抬高」抬起来
  state.protectedFaces.clear();
  for (const p of state.parts) p.protected.clear();
  state.analysis = null;
  state.orientResult = null;
  bus.emit('orientResults', null);
  bus.emit('sliceStats', null);
  bus.emit('supStats', null);
  hideInspector();
  bus.emit('modelsReplaced');   // 画线切割：新模型载入后，锚着已不在的零件的线一并清掉
}

function closestPart(parts, x, z) {
  let best = parts[0];
  let bestD = Infinity;
  for (const p of parts) {
    const dx = Math.max(Math.abs(x - p.ox) - p.base.x / 2, 0);
    const dz = Math.max(Math.abs(z - p.oz) - p.base.z / 2, 0);
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function worldXZOf(mesh, x, y, z) {
  const e = mesh.matrixWorld.elements;
  return [
    e[0] * x + e[4] * y + e[8] * z + e[12],
    e[2] * x + e[6] * y + e[10] * z + e[14],
  ];
}

/* 支撑外沿在零件局部的包围矩形。顶点全部计入，避免抽稀漏掉最外一圈格架。
   独占网格整份归它；几件共用的按三角形重心最近的一件切开。 */
function supportLocalQuads(parts) {
  const bounds = new Map();
  for (const p of parts) bounds.set(p.id, null);
  const grow = (id, x, z) => {
    let b = bounds.get(id);
    if (!bounds.has(id)) return;
    if (!b) {
      bounds.set(id, { minX: x, maxX: x, minZ: z, maxZ: z });
      return;
    }
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z;
    if (z > b.maxZ) b.maxZ = z;
  };
  for (const s of state.supports || []) {
    const mesh = s.mesh;
    const attr = mesh && mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position;
    if (!attr) continue;
    const owners = s.ownerIds || [];
    const exclusive = owners.length === 1 ? parts.find(p => p.id === owners[0]) : null;
    const pool = owners.length ? parts.filter(p => owners.includes(p.id)) : parts;
    if (!pool.length) continue;
    mesh.updateWorldMatrix(true, false);
    const arr = attr.array;
    if (exclusive) {
      for (let i = 0; i < arr.length; i += 3) {
        const w = worldXZOf(mesh, arr[i], arr[i + 1], arr[i + 2]);
        grow(exclusive.id, w[0] - exclusive.ox, w[1] - exclusive.oz);
      }
      continue;
    }
    const tris = (arr.length / 9) | 0;
    for (let t = 0; t < tris; t++) {
      const o = t * 9;
      let cx = 0;
      let cz = 0;
      const pts = [];
      for (let k = 0; k < 3; k++) {
        const w = worldXZOf(mesh, arr[o + k * 3], arr[o + k * 3 + 1], arr[o + k * 3 + 2]);
        pts.push(w[0], w[1]);
        cx += w[0];
        cz += w[1];
      }
      const owner = closestPart(pool, cx / 3, cz / 3);
      for (let k = 0; k < 3; k++) grow(owner.id, pts[k * 2] - owner.ox, pts[k * 2 + 1] - owner.oz);
    }
  }
  const out = new Map();
  for (const [id, b] of bounds) out.set(id, b ? quadTris(b.minX, b.minZ, b.maxX, b.maxZ) : []);
  return out;
}

function quadTris(minX, minZ, maxX, maxZ) {
  return [minX, 0, minZ, maxX, 0, minZ, maxX, 0, maxZ, minX, 0, minZ, maxX, 0, maxZ, minX, 0, maxZ];
}

/* 已生成边框的投影外沿（世界顶点收成零件局部的包围矩形）。
   笼架是空心的，占地按外沿矩形，不让别的边框穿进框里。还没生成边框时不预留。 */
function frameLocalQuads(parts) {
  if (params.nestFrameOverlap || !state.frame) return null;
  const frames = scene.getObjectByName('bboxFrameGroup');
  if (!frames || !frames.children.length) return null;
  frames.updateWorldMatrix(true, true);
  const byId = new Map();
  for (const p of parts) byId.set(p.id, p);
  const bounds = new Map();
  for (const p of parts) bounds.set(p.id, null);
  const grow = (id, x, z) => {
    let b = bounds.get(id);
    if (!bounds.has(id)) return;
    if (!b) { bounds.set(id, { minX: x, maxX: x, minZ: z, maxZ: z }); return; }
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z;
    if (z > b.maxZ) b.maxZ = z;
  };
  for (const mesh of frames.children) {
    const part = byId.get(mesh.userData.partId);
    const attr = mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position;
    if (!part || !attr) continue;
    const yaw = 2 * Math.atan2(part.q.y, part.q.w);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const e = mesh.matrixWorld.elements;
    const arr = attr.array;
    for (let i = 0; i < arr.length; i += 3) {
      const wx = e[0] * arr[i] + e[4] * arr[i + 1] + e[8] * arr[i + 2] + e[12];
      const wz = e[2] * arr[i] + e[6] * arr[i + 1] + e[10] * arr[i + 2] + e[14];
      const dx = wx - part.ox;
      const dz = wz - part.oz;
      grow(part.id, c * dx - s * dz, s * dx + c * dz);
    }
  }
  let any = false;
  const out = new Map();
  for (const [id, b] of bounds) {
    if (!b) { out.set(id, []); continue; }
    any = true;
    out.set(id, quadTris(b.minX, b.minZ, b.maxX, b.maxZ));
  }
  return any ? out : null;
}

/* 按当前开关拼出每件的占地。
   已生成边框且不可重叠时，占地就是边框投影外沿（它包住模型和支撑）。
   否则模型轮廓始终计入；支撑不可重叠时再并进支撑外沿。只膨胀这一次。 */
function keepoutPositions(parts) {
  const frames = frameLocalQuads(parts);
  const blockSupport = !frames && (state.supports || []).length > 0 && !params.nestSupportOverlap;
  const clouds = blockSupport ? supportLocalQuads(parts) : null;
  const out = new Map();
  for (const p of parts) {
    const base = p.geom.attributes.position.array;
    const extra = [];
    const frame = frames && frames.get(p.id);
    if (frame && frame.length) extra.push(...frame);
    else {
      const sup = clouds && clouds.get(p.id);
      if (sup && sup.length) extra.push(...sup);
    }
    if (!extra.length) { out.set(p.id, base); continue; }
    const merged = new Float32Array(base.length + extra.length);
    merged.set(base, 0);
    merged.set(extra, base.length);
    out.set(p.id, merged);
  }
  return out;
}

/* 轮廓装箱：绕竖直轴选角度，空档能塞就塞，靠在离板边的边距上。间距、边距和重叠开关读 params。 */
export function arrangeParts(parts) {
  const plateX = params.plateX || 150, plateZ = params.plateZ || 85;
  const gap = Math.max(0, Number(params.nestGap) || 0);
  const margin = Math.max(0, Number(params.nestMargin) || 0);
  const keep = keepoutPositions(parts);
  // 边框是轴对齐的笼架。转 90° 再按新朝向重做，框会挪出原来的格子，互相叠住。
  const framed = !params.nestFrameOverlap && state.frame;
  const align = params.nestAlign === 'center' || params.nestAlign === 'right' ? params.nestAlign : 'left';
  const pack = nestPlate(parts.map(p => ({
    id: p.id,
    positions: keep.get(p.id) || p.geom.attributes.position.array,
  })), plateX, plateZ, framed ? { gap, margin, align, angles: [0] } : { gap, margin, align });
  const byId = new Map(pack.placements.map(pose => [pose.id, pose]));
  for (const p of parts) {
    const pose = byId.get(p.id);
    if (!pose) continue;
    p.q.setFromAxisAngle(_yawAxis, pose.yaw || 0);
    p.ox = pose.x;
    p.oz = pose.z;
  }
  return pack;
}

/** 把板上所有模型按轮廓重新排紧。少于两件时只提示。可撤回。 */
export function layoutAllParts() {
  if ((state.parts || []).length < 2) {
    toast('至少两个模型才能自动排版');
    return false;
  }
  ensureBakedDisplay();
  const before = historyReplaying() ? null : capturePartSnaps(state.parts);
  const selBefore = before ? captureSel() : null;
  // 先认领支撑点。复制出来的点已经带着自己的零件 id，原来那件的点也写上，免得排完认到别人身上。
  stampSupportPartIds();
  for (const p of state.parts) bakePartRotation(p);
  const origins = new Map();
  for (const p of state.parts) origins.set(p.id, { ox: p.ox, oy: p.oy || 0, oz: p.oz });
  const pack = arrangeParts(state.parts);
  const moves = [];
  for (const p of state.parts) {
    const o = origins.get(p.id);
    if (!o) continue;
    moves.push({
      id: p.id,
      ox0: o.ox, oy0: o.oy, oz0: o.oz,
      ox1: p.ox, oy1: p.oy || 0, oz1: p.oz,
      yaw: 2 * Math.atan2(p.q.y, p.q.w),
    });
  }
  // 边框已经按投影外沿排好，并跟着零件挪过去。这段时间内不要按新包围盒重做，否则框会变大叠在一起。
  bus.emit('frameHold');
  const relocated = relocateSupports(moves);
  bus.emit('frameMove', moves);
  // 刚体挪完再按每件自己的支撑重做一圈，避免共用支撑网格把框撑偏，模型和边框错开。
  bus.emit('frameRebuild');
  syncPlateMesh();
  updateBuildVolume();
  const part = activePart();
  if (part) syncPreview(part);
  emitModelInfo();
  frameParts(state.parts, { animate: true });
  syncFocusRing();
  // 切片是按旧位置算的，作废。支撑跟着零件走，不删。
  dropAnalysis();
  updateRaft();
  showNestRulers(state.parts);
  if (relocated.shared) {
    refreshSupportsForPlate();
    log('有几件模型共用一套支撑网格，已按新位置重新连接', 'info');
  }
  if (before) {
    const after = capturePartSnaps(state.parts);
    const selAfter = captureSel();
    pushHistory({
      label: '自动排版',
      undo: () => {
        clearNestRulers();
        applyPartSnaps(before, selBefore, { keepSupports: true });
        relocateSupportsInverse(moves);
        bus.emit('frameMove', inversePoseMoves(moves));
        updateRaft();
        if (relocated.shared) refreshSupportsForPlate();
      },
      redo: () => {
        applyPartSnaps(after, selAfter, { keepSupports: true });
        relocateSupports(moves);
        bus.emit('frameMove', moves);
        updateRaft();
        if (relocated.shared) refreshSupportsForPlate();
        showNestRulers(state.parts);
      },
      dispose: () => { releaseSnaps(before); releaseSnaps(after); },
    });
  }
  const used = pack.usedArea > 1 ? Math.round(100 * pack.partArea / pack.usedArea) : 0;
  const supNote = params.nestSupportOverlap ? '支撑可重叠' : '支撑隔开';
  const frameNote = params.nestFrameOverlap ? '边框可重叠' : '边框隔开';
  log(`已排版 ${state.parts.length} 个模型：间距 ${pack.gap}mm，离板边 ${pack.margin}mm，${supNote}，${frameNote}，外接矩形利用率 ${used}%`, 'ok');
  if (pack.overflow) log('⚠ 排版后仍有模型超出当前板面，可换更大的打印机或减少模型', 'warn');
  toast(pack.overflow ? `已排版 ${state.parts.length} 个，有模型超出板面` : `已排版 ${state.parts.length} 个模型`);
  return true;
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
  // 重拼会换掉整张网格。拖动预览的那一块先摘掉，避免松手后还留着一份。
  discardMotionPreview();
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
  // 拖动中不走这里。面数据只在松手后的那一次重拼里算。
  if (faces) state.faces = computeFaceDataFull(pos);
  // 重拼会带回零件上的白顶点色。热力图或选中色在这一步之后再画。
  bus.emit('displayMesh');
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

/** 拾取 BVH 是否已就绪。没就绪时 meshPick 返回 null 不代表没打中，调用方只能退回逐三角形射线（要少打几条） */
export function pickReady() {
  return !!(state.mesh && meshBVH && meshBVHGeom === state.mesh.geometry);
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
 * 多模型不走这里，见 previewPartMotion。
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
  const mesh = state.mesh;
  if (!mesh || mesh.matrixAutoUpdate !== false) return false;
  return !!(mesh.userData.pose || mesh.userData.rigidHold);
}

/** 分析、热力图等要读烘焙后的顶点时再重拼。整板平移松手后先留着矩阵，这里才烤进顶点。 */
export function ensureBakedDisplay() {
  if (!displayPosePending()) return;
  syncPlateMesh({ faces: true });
}

/* 多模型拖动：只改矩阵。整板一起平移时松手也不重写顶点。
   只拖其中几件时，第一次把它们拆成单独一块，之后每帧仍只改这块的矩阵。 */
let motionPreview = null;

function coversAllParts(parts) {
  if (!parts || parts.length !== state.parts.length) return false;
  const ids = new Set();
  for (const p of parts) ids.add(p.id);
  for (const p of state.parts) if (!ids.has(p.id)) return false;
  return true;
}

function discardMotionPreview() {
  if (!motionPreview) return;
  if (motionPreview.mover) {
    modelGroup.remove(motionPreview.mover);
    motionPreview.mover.geometry.dispose();
    motionPreview.mover = null;
  }
  motionPreview = null;
}

function boundsFromPositions(geom) {
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
}

function beginMotionPreview(movingParts) {
  if (state.mesh.matrixAutoUpdate) state.mesh.updateMatrix();
  const base = state.mesh.matrix.clone();
  if (coversAllParts(movingParts)) return { kind: 'matrix', base, mover: null };
  const moving = new Set(movingParts);
  const srcGeom = state.mesh.geometry;
  const pos = srcGeom.attributes.position.array;
  const col = srcGeom.attributes.color ? srcGeom.attributes.color.array : null;
  const nrm = srcGeom.attributes.normal ? srcGeom.attributes.normal.array : null;
  const slices = [];
  let mv = 0;
  let st = 0;
  for (const p of state.parts) {
    const floats = p.geom.attributes.position.count * 3;
    const start = (p.faceStart || 0) * 9;
    if (floats < 9 || start < 0 || start + floats > pos.length) return null;
    const on = moving.has(p);
    slices.push({ start, floats, on });
    if (on) mv += floats;
    else st += floats;
  }
  if (!mv || !st) return null;
  const mPos = new Float32Array(mv);
  const mCol = new Float32Array(mv);
  const mNrm = new Float32Array(mv);
  const sPos = new Float32Array(st);
  const sCol = new Float32Array(st);
  const sNrm = new Float32Array(st);
  let mo = 0;
  let so = 0;
  for (const s of slices) {
    const o = s.on ? mo : so;
    const dstP = s.on ? mPos : sPos;
    const dstC = s.on ? mCol : sCol;
    const dstN = s.on ? mNrm : sNrm;
    dstP.set(pos.subarray(s.start, s.start + s.floats), o);
    if (col && col.length >= s.start + s.floats) dstC.set(col.subarray(s.start, s.start + s.floats), o);
    else dstC.fill(1, o, o + s.floats);
    if (nrm && nrm.length >= s.start + s.floats) dstN.set(nrm.subarray(s.start, s.start + s.floats), o);
    if (s.on) mo += s.floats;
    else so += s.floats;
  }
  const moverGeom = new THREE.BufferGeometry();
  moverGeom.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
  moverGeom.setAttribute('color', new THREE.BufferAttribute(mCol, 3));
  moverGeom.setAttribute('normal', new THREE.BufferAttribute(mNrm, 3));
  boundsFromPositions(moverGeom);
  const mover = new THREE.Mesh(moverGeom, modelMat);
  mover.name = 'dragPreview';
  mover.raycast = () => {};
  mover.matrixAutoUpdate = false;
  mover.frustumCulled = true;
  const staticGeom = new THREE.BufferGeometry();
  staticGeom.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  staticGeom.setAttribute('color', new THREE.BufferAttribute(sCol, 3));
  staticGeom.setAttribute('normal', new THREE.BufferAttribute(sNrm, 3));
  boundsFromPositions(staticGeom);
  const old = state.mesh.geometry;
  state.mesh.geometry = staticGeom;
  old.dispose();
  modelGroup.add(mover);
  return { kind: 'split', base, mover };
}

function applyMotionMatrix(obj, base, worldFromOld) {
  _previewM.copy(worldFromOld).multiply(base);
  obj.matrixAutoUpdate = false;
  obj.matrix.copy(_previewM);
  obj.matrixWorld.copy(_previewM);
  obj.matrixWorldNeedsUpdate = false;
}

/**
 * 用刚体或缩放矩阵预览选中零件，不重写顶点。
 * worldFromOld 把「这一下按下时的世界位置」变到现在。
 * 单件的平移和旋转仍走 previewPartPose。kind 为 scale 时单件也走矩阵。
 */
export function previewPartMotion(movingParts, worldFromOld, kind) {
  if (!state.mesh || !movingParts || !movingParts.length || !worldFromOld) return false;
  if (kind !== 'scale' && state.parts.length === 1 && movingParts.length === 1) return previewPartPose();
  if (!motionPreview) {
    motionPreview = beginMotionPreview(movingParts);
    if (!motionPreview) return false;
  }
  applyMotionMatrix(motionPreview.mover || state.mesh, motionPreview.base, worldFromOld);
  return true;
}

/** 切片预览要切「画面上真正在画的那几块」，拖动中的分体也算。 */
export function sliceViewMeshes() {
  const list = [];
  if (state.mesh && state.mesh.geometry) list.push(state.mesh);
  if (motionPreview && motionPreview.mover && motionPreview.mover.geometry) list.push(motionPreview.mover);
  return list;
}

function holdTranslation(mesh) {
  const e = mesh.matrix.elements;
  const pure = Math.abs(e[0] - 1) < 1e-5 && Math.abs(e[5] - 1) < 1e-5 && Math.abs(e[10] - 1) < 1e-5
    && Math.abs(e[1]) < 1e-5 && Math.abs(e[2]) < 1e-5 && Math.abs(e[3]) < 1e-5
    && Math.abs(e[4]) < 1e-5 && Math.abs(e[6]) < 1e-5 && Math.abs(e[7]) < 1e-5
    && Math.abs(e[8]) < 1e-5 && Math.abs(e[9]) < 1e-5 && Math.abs(e[11]) < 1e-5;
  if (!pure) return null;
  return { dx: e[12], dy: e[13] - raiseH(), dz: e[14] };
}

/** 松手。整板平移留下矩阵；旋转、缩放、只拖其中几件则交回调用方重拼一次。 */
export function finishMotionPreview(mode) {
  if (!motionPreview) return 'none';
  const split = motionPreview.kind === 'split';
  const mesh = state.mesh;
  discardMotionPreview();
  if (split || mode !== 'hold' || !mesh) {
    if (mesh && mesh.userData) delete mesh.userData.rigidHold;
    return 'rebuild';
  }
  const hold = holdTranslation(mesh);
  if (!hold) {
    delete mesh.userData.rigidHold;
    return 'rebuild';
  }
  mesh.userData.rigidHold = hold;
  mesh.matrixAutoUpdate = false;
  return 'hold';
}

/** 缩放因子不一致时退回改顶点。先把预览矩阵烤回一张完整网格。 */
export function resyncPlateForPaint() {
  discardMotionPreview();
  if (!state.parts.length) return;
  syncPlateMesh({ faces: false });
}

/** 把这几件的当前位置写进已有的合并网格，不再分配新缓冲，也不重建 BVH。 */
export function paintMovedParts(parts) {
  if (!state.mesh || !parts || !parts.length || motionPreview) return false;
  if (displayPosePending()) return false;
  const geom = state.mesh.geometry;
  const attr = geom.attributes.position;
  const arr = attr.array;
  for (const p of parts) {
    const src = p.geom.attributes.position.array;
    const off = (p.faceStart || 0) * 9;
    if (off < 0 || off + src.length > arr.length) return false;
    for (let i = 0; i < src.length; i += 3) {
      xformCorner(p, src[i], src[i + 1], src[i + 2], _corner);
      const o = off + i;
      arr[o] = _corner.x;
      arr[o + 1] = _corner.y;
      arr[o + 2] = _corner.z;
    }
  }
  attr.needsUpdate = true;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of state.parts) {
    const b = partBounds(p);
    if (b.min.x < minX) minX = b.min.x;
    if (b.min.y < minY) minY = b.min.y;
    if (b.min.z < minZ) minZ = b.min.z;
    if (b.max.x > maxX) maxX = b.max.x;
    if (b.max.y > maxY) maxY = b.max.y;
    if (b.max.z > maxZ) maxZ = b.max.z;
  }
  if (!geom.boundingBox) geom.boundingBox = new THREE.Box3();
  geom.boundingBox.min.set(minX, minY, minZ);
  geom.boundingBox.max.set(maxX, maxY, maxZ);
  if (!geom.boundingSphere) geom.boundingSphere = new THREE.Sphere();
  geom.boundingBox.getBoundingSphere(geom.boundingSphere);
  return true;
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
  state.selectedIds = valid;
  if (!valid.length) state.transformTool = null;
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
  syncPartTint();
}

/* 板上一个模型都不剩时拆掉合并网格和底板。零件几何由调用方先 dispose。 */
function dropMergedMesh() {
  discardMotionPreview();
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
  if (sel.tool && (state.selectedIds || []).length >= 1) state.transformTool = sel.tool;
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

/** 把一份几何快照写回这件模型。旋转面板用它回到「角度为 0」的姿势再重放。 */
export function restorePartSnap(part, snap) {
  if (!part || !snap) return;
  writeSnap(part, snap);
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
function applyPartSnaps(snaps, sel, opts = {}) {
  const missing = [];
  // opts.dropIds：先摘掉这些零件（画线切割的撤回 / 重做：两件换回一件，或一件换成两件）
  if (opts.dropIds && opts.dropIds.length) {
    const gone = new Set(opts.dropIds);
    for (const p of state.parts) if (gone.has(p.id)) p.geom.dispose();
    state.parts = state.parts.filter(p => !gone.has(p.id));
    state.selectedIds = (state.selectedIds || []).filter(id => !gone.has(id));
  }
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
  if (opts.keepSupports) dropAnalysis();
  else discardStaleWork('模型已改动，分析结果与支撑已清除，请重新分析');
  if (sel) restoreSel(sel);
  else emitModelInfo();
  syncFocusRing();
}

function applyPoses(poses) {
  const shifts = [];
  let rotated = false;
  let any = false;
  for (const s of poses) {
    const part = state.parts.find(p => p.id === s.id);
    if (!part) continue;
    const q = new THREE.Quaternion(s.q[0], s.q[1], s.q[2], s.q[3]);
    if (part.q.angleTo(q) > 0.002) rotated = true;
    shifts.push({
      id: part.id,
      dx: s.ox - part.ox,
      dy: (s.oy || 0) - (part.oy || 0),
      dz: s.oz - part.oz,
    });
    part.ox = s.ox;
    part.oy = s.oy;
    part.oz = s.oz;
    part.q.copy(q);
    any = true;
  }
  if (!any || !state.parts.length) return;
  syncPlateMesh({ faces: true });
  updateBuildVolume();
  if (rotated) discardStaleWork('模型已改动，分析结果与支撑已清除，请重新分析');
  else {
    const groups = new Map();
    for (const s of shifts) {
      const key = `${s.dx.toFixed(3)}|${s.dy.toFixed(3)}|${s.dz.toFixed(3)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { dx: s.dx, dy: s.dy, dz: s.dz, ids: [] });
      g.ids.push(s.id);
    }
    for (const g of groups.values()) shiftSupports(g.ids, g.dx, g.dy, g.dz);
    if (state.analysis || state.orientResult) {
      state.analysis = null;
      if (state.orientResult) {
        state.orientResult = null;
        bus.emit('orientResults', null);
      }
      hideInspector();
      bus.emit('sliceStats', null);
    }
  }
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

/** 几何变过的操作。没变就丢掉快照。sel 只在需要连选中一起恢复时传入。
 *  extra 给需要自己管支撑的操作：keepSupports 撤回 / 重做时不清掉整板支撑，onUndo / onRedo 在写回几何之后再做收尾。 */
export function commitGeomHistory(label, before, sel, extra) {
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
  const keep = extra && extra.keepSupports ? { keepSupports: true } : {};
  pushHistory({
    label,
    undo: () => {
      applyPartSnaps(before, sel ? sel.before : null, keep);
      if (extra && extra.onUndo) extra.onUndo();
    },
    redo: () => {
      applyPartSnaps(after, sel ? sel.after : null, keep);
      if (extra && extra.onRedo) extra.onRedo();
    },
    dispose: () => { releaseSnaps(before); releaseSnaps(after); },
  });
  return true;
}

/* 复制一份零件几何。不能共用 BufferGeometry，删掉其中一件时会把另一件的顶点一起释放。 */
function clonePartAt(src, dx, dy, dz, name) {
  const geom = src.geom.clone();
  const shared = src.source === src.geom.attributes.position.array;
  const part = {
    id: partSeq++,
    name,
    demo: !!src.demo,
    geom,
    size: { x: src.size.x, y: src.size.y, z: src.size.z },
    base: { x: src.base.x, y: src.base.y, z: src.base.z },
    born: src.born ? { x: src.born.x, y: src.born.y, z: src.born.z } : { x: src.size.x, y: src.size.y, z: src.size.z },
    nf: src.nf,
    nfFull: src.nfFull,
    ox: src.ox + dx,
    oy: (src.oy || 0) + dy,
    oz: src.oz + dz,
    q: src.q.clone(),
    faceStart: 0,
    protected: new Set(src.protected || []),
    smooth: !!src.smooth,
    source: !src.source || shared ? null : new Float32Array(src.source),
  };
  if (shared) part.source = geom.attributes.position.array;
  return part;
}

function dropClones(ids) {
  const want = new Set(ids || []);
  for (const p of state.parts) if (want.has(p.id)) p.geom.dispose();
  state.parts = state.parts.filter(p => !want.has(p.id));
  state.selectedIds = (state.selectedIds || []).filter(id => !want.has(id));
  if (!state.parts.some(p => p.id === state.activePartId)) {
    state.activePartId = state.parts.length ? state.parts[state.parts.length - 1].id : null;
  }
  if (state.focusId && !state.parts.some(p => p.id === state.focusId)) state.focusId = state.activePartId;
  if (!state.parts.length) {
    dropMergedMesh();
    syncPreview(null);
  } else {
    syncPreview(activePart());
    syncPlateMesh({ faces: true });
    updateBuildVolume();
  }
  emitModelInfo();
  syncFocusRing();
}

function cloneSelection(ids) {
  if (ids && ids.length) return state.parts.filter(p => ids.includes(p.id));
  if (state.selectedIds && state.selectedIds.length) return state.parts.filter(p => state.selectedIds.includes(p.id));
  if (state.parts.length === 1) return state.parts.slice();
  return activePart() ? [activePart()] : [];
}

function cellLeavesPlate(sel, dx, dy, dz) {
  const hx = (params.plateX || 150) / 2;
  const hz = (params.plateZ || 85) / 2;
  const py = params.plateY || 175;
  const lift = raiseH();
  for (const p of sel) {
    const b = partBounds(p);
    if (b.min.x + dx < -hx - 0.6 || b.max.x + dx > hx + 0.6) return true;
    if (b.min.z + dz < -hz - 0.6 || b.max.z + dz > hz + 0.6) return true;
    if (b.max.y + dy + lift > py + 0.6) return true;
  }
  return false;
}

/** 复制布局。不改板上的模型。预览和真正复制用同一份格子。 */
export function planClone(opts = {}) {
  const cols = Math.max(1, Math.min(12, Math.round(Number(opts.cols) || 1)));
  const rows = Math.max(1, Math.min(12, Math.round(Number(opts.rows) || 1)));
  const layers = Math.max(1, Math.min(8, Math.round(Number(opts.layers) || 1)));
  const gap = Math.max(0, Math.min(80, Number(opts.gap) || 0));
  const sel = cloneSelection(opts.ids);
  if (!sel.length) return { ok: false, reason: 'empty', cols, rows, layers, gap, cells: [], copies: 0, overflow: 0 };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of sel) {
    const b = partBounds(p);
    if (b.min.x < minX) minX = b.min.x;
    if (b.min.y < minY) minY = b.min.y;
    if (b.min.z < minZ) minZ = b.min.z;
    if (b.max.x > maxX) maxX = b.max.x;
    if (b.max.y > maxY) maxY = b.max.y;
    if (b.max.z > maxZ) maxZ = b.max.z;
  }
  const stepX = (maxX - minX) + gap;
  const stepZ = (maxZ - minZ) + gap;
  const stepY = (maxY - minY) + gap;
  const cells = [];
  let overflow = 0;
  for (let k = 0; k < layers; k++) {
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const dx = i * stepX, dy = k * stepY, dz = j * stepZ;
        const outside = cellLeavesPlate(sel, dx, dy, dz);
        if (outside && !(i === 0 && j === 0 && k === 0)) overflow++;
        cells.push({
          i, j, k, dx, dy, dz,
          origin: i === 0 && j === 0 && k === 0,
          overflow: outside,
          x: minX + dx, z: minZ + dz, w: maxX - minX, d: maxZ - minZ,
        });
      }
    }
  }
  return {
    ok: true,
    cols, rows, layers, gap, sel, cells,
    copies: cells.length - 1,
    overflow,
    stepX, stepY, stepZ,
    minX, minZ, w: maxX - minX, d: maxZ - minZ,
  };
}

let clonePreview = null;

function ghostMatrix(part, dx, dy, dz, target) {
  const cy = part.base.y / 2;
  const tLocal = new THREE.Matrix4().makeTranslation(0, -cy, 0);
  const rot = new THREE.Matrix4().makeRotationFromQuaternion(part.q);
  const tWorld = new THREE.Matrix4().makeTranslation(
    part.ox + dx,
    raiseH() + cy + (part.oy || 0) + dy,
    part.oz + dz,
  );
  return target.multiplyMatrices(tWorld, rot).multiply(tLocal);
}

/** 在板上放出半透明副本，改列行层和间距时跟着动。不写入零件。 */
export function showClonePreview(opts = {}) {
  clearClonePreview();
  const plan = planClone(opts);
  if (!plan.ok || plan.copies < 1) return plan;
  const group = new THREE.Group();
  group.name = 'clone-preview';
  const mat = new THREE.MeshStandardMaterial({
    color: 0x3b82f6, transparent: true, opacity: 0.42, roughness: 0.45, metalness: 0, depthWrite: false,
  });
  const bad = mat.clone();
  bad.color.setHex(0xef4444);
  const matrix = new THREE.Matrix4();
  for (const cell of plan.cells) {
    if (cell.origin) continue;
    for (const part of plan.sel) {
      const mesh = new THREE.Mesh(part.geom, cell.overflow ? bad : mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(ghostMatrix(part, cell.dx, cell.dy, cell.dz, matrix));
      mesh.matrixWorldNeedsUpdate = true;
      mesh.raycast = () => {};
      group.add(mesh);
    }
  }
  scene.add(group);
  clonePreview = { group, mat, bad };
  return plan;
}

export function clearClonePreview() {
  if (!clonePreview) return;
  scene.remove(clonePreview.group);
  clonePreview.group.clear();
  clonePreview.mat.dispose();
  clonePreview.bad.dispose();
  clonePreview = null;
}

/**
 * BPS 式复制：选中的模型留在原位，按列 × 行 × 层铺开副本。
 * 间距是包围盒之间的空隙。层是打印高度方向。来源零件上的支撑点跟着副本走。
 */
export function cloneParts(opts = {}) {
  const plan = planClone(opts);
  if (!plan.ok) {
    toast('先选中要复制的模型');
    return 0;
  }
  if (plan.copies < 1) {
    toast('列、行、层至少有一维大于 1');
    return 0;
  }
  clearClonePreview();
  const { sel, stepX, stepY, stepZ, cols, rows, layers, gap } = plan;
  const created = [];
  const pairs = [];
  let n = 0;
  for (let k = 0; k < layers; k++) {
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (i === 0 && j === 0 && k === 0) continue;
        n++;
        const dx = i * stepX, dy = k * stepY, dz = j * stepZ;
        for (const src of sel) {
          const name = sel.length === 1 && n === 1 ? `${src.name} 副本` : `${src.name} 副本 ${n}`;
          const part = clonePartAt(src, dx, dy, dz, name);
          created.push(part);
          pairs.push({ fromId: src.id, toId: part.id, dx, dy, dz });
        }
      }
    }
  }
  tagSupportOwners();
  const copiedPts = cloneSupportsOnto(pairs);
  const copiedVis = cloneSupportVisuals(pairs);
  const selBefore = captureSel();
  state.parts.push(...created);
  state.analysis = null;
  hideInspector();
  bus.emit('sliceStats', null);
  syncPlateMesh({ faces: true });
  updateBuildVolume();
  const ids = created.map(p => p.id);
  setSelection(ids);
  if (copiedPts.length && !copiedVis) refreshSupportsForPlate();
  const snaps = capturePartSnaps(created);
  pushHistory({
    label: `复制 ${created.length} 个模型`,
    undo: () => {
      dropClones(ids);
      if (copiedPts.length || copiedVis) {
        dropSupportsOf(ids);
        dropSupportMeshesOf(ids);
      }
      restoreSel(selBefore);
    },
    redo: () => {
      for (const snap of snaps) {
        if (!state.parts.some(p => p.id === snap.id)) state.parts.push(reviveSnap(snap));
      }
      syncPlateMesh({ faces: true });
      updateBuildVolume();
      setSelection(ids);
      if (copiedPts.length) putSupportsBack(copiedPts);
      if (copiedVis) cloneSupportVisuals(pairs);
    },
    dispose: () => releaseSnaps(snaps),
  });
  log(copiedPts.length
    ? `已复制 ${created.length} 个（${cols} 列 × ${rows} 行 × ${layers} 层，间距 ${gap} mm），支撑点 ${copiedPts.length} 个一并复制`
    : `已复制 ${created.length} 个（${cols} 列 × ${rows} 行 × ${layers} 层，间距 ${gap} mm）`, 'ok');
  return created.length;
}

/* ---------- 快速复制 / 粘贴 ----------
   Ctrl+C 把选中模型做成快照。Ctrl+V 按快照新建，整组沿 +X 铺开。
   剪贴板不跟场景走：换模型、删除、撤回都不清。再次复制才替换。
   来源零件上的支撑点跟着副本走，再按新位置重建结构。 */

const PASTE_GAP = 2;
let partClipboard = null;

function partFromClip(snap, dx, name) {
  const geom = positionsToGeom(new Float32Array(snap.position), null);
  const part = {
    id: partSeq++,
    name,
    demo: !!snap.demo,
    geom,
    size: { x: snap.size.x, y: snap.size.y, z: snap.size.z },
    base: { x: snap.base.x, y: snap.base.y, z: snap.base.z },
    born: snap.born ? { x: snap.born.x, y: snap.born.y, z: snap.born.z } : { x: snap.size.x, y: snap.size.y, z: snap.size.z },
    nf: snap.nf,
    nfFull: snap.nfFull,
    ox: snap.ox + dx,
    oy: snap.oy || 0,
    oz: snap.oz,
    q: new THREE.Quaternion(snap.q[0], snap.q[1], snap.q[2], snap.q[3]),
    faceStart: 0,
    protected: new Set(snap.protected || []),
    smooth: !!snap.smooth,
    source: snap.source ? new Float32Array(snap.source) : null,
  };
  if (snap.smooth) rewriteNormals(part);
  if (snap.sourceShared) part.source = part.geom.attributes.position.array;
  return part;
}

export function copySelectedParts() {
  const ids = state.selectedIds || [];
  const sel = state.parts.filter(p => ids.includes(p.id));
  if (!sel.length) {
    toast('先选中要复制的模型');
    return 0;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of sel) {
    const b = partBounds(p);
    if (b.min.x < minX) minX = b.min.x;
    if (b.max.x > maxX) maxX = b.max.x;
  }
  const stepX = Math.max(PASTE_GAP, (maxX - minX) + PASTE_GAP);
  if (partClipboard) releaseSnaps(partClipboard.snaps);
  partClipboard = { snaps: capturePartSnaps(sel), stepX, gen: 0 };
  const label = sel.length === 1 ? sel[0].name : `${sel.length} 个模型`;
  log(`已复制 ${label}`, 'ok');
  return sel.length;
}

export function pasteParts() {
  const clip = partClipboard;
  if (!clip || !clip.snaps.length) {
    toast('没有可粘贴的模型');
    return 0;
  }
  const gen = clip.gen + 1;
  const dx = clip.stepX * gen;
  const created = [];
  const pairs = [];
  for (const snap of clip.snaps) {
    if (!snap || !snap.position) continue;
    const name = clip.snaps.length === 1 && gen === 1 ? `${snap.name} 副本` : `${snap.name} 副本 ${gen}`;
    const part = partFromClip(snap, dx, name);
    created.push(part);
    pairs.push({ fromId: snap.id, toId: part.id, dx, dy: 0, dz: 0 });
  }
  if (!created.length) {
    toast('没有可粘贴的模型');
    return 0;
  }
  tagSupportOwners();
  const copiedPts = cloneSupportsOnto(pairs);
  const copiedVis = cloneSupportVisuals(pairs);
  clip.gen = gen;
  const selBefore = captureSel();
  state.parts.push(...created);
  state.analysis = null;
  hideInspector();
  bus.emit('sliceStats', null);
  syncPlateMesh({ faces: true });
  updateBuildVolume();
  const ids = created.map(p => p.id);
  setSelection(ids);
  if (copiedPts.length && !copiedVis) refreshSupportsForPlate();
  const snaps = capturePartSnaps(created);
  pushHistory({
    label: `粘贴 ${created.length} 个模型`,
    undo: () => {
      dropClones(ids);
      if (copiedPts.length || copiedVis) {
        dropSupportsOf(ids);
        dropSupportMeshesOf(ids);
      }
      restoreSel(selBefore);
    },
    redo: () => {
      for (const snap of snaps) {
        if (!state.parts.some(p => p.id === snap.id)) state.parts.push(reviveSnap(snap));
      }
      syncPlateMesh({ faces: true });
      updateBuildVolume();
      setSelection(ids);
      if (copiedPts.length) putSupportsBack(copiedPts);
      if (copiedVis) cloneSupportVisuals(pairs);
    },
    dispose: () => releaseSnaps(snaps),
  });
  log(copiedVis
    ? `已粘贴 ${created.length} 个，支撑一并复制`
    : copiedPts.length
      ? `已粘贴 ${created.length} 个，支撑点 ${copiedPts.length} 个一并复制`
      : `已粘贴 ${created.length} 个`, 'ok');
  if (cellLeavesPlate(created, 0, 0, 0)) log('粘贴的模型超出当前板面', 'warn');
  return created.length;
}

/** 删掉这些零件。选中框、分析、支撑一起清掉，剩下的模型留在原来的位置。 */
export function removeParts(ids, opts = {}) {
  clearNestRulers();
  const record = opts.record !== false;
  const quiet = !!opts.quiet;
  const want = new Set(ids || []);
  const gone = state.parts.filter(p => want.has(p.id));
  if (!gone.length) return 0;
  const snaps = record && !historyReplaying() ? capturePartSnaps(gone) : null;
  const selBefore = snaps ? captureSel() : null;
  // 先认领再摘零件，没记下 partId 的点还认得出是谁的。只拿掉被删零件的点。
  const removedPts = dropSupportsOf(gone.map(p => p.id));
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
  if (!state.parts.length) {
    discardStaleWork('模型已删除，分析结果与支撑已清除，请重新分析');
  } else {
    dropAnalysis();
    if (state.parts.length) syncPlateMesh({ faces: true });
    if (removedPts.length) refreshSupportsForPlate();
  }
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
      undo: () => {
        applyPartSnaps(snaps, selBefore, { keepSupports: true });
        if (removedPts.length) {
          putSupportsBack(removedPts);
          refreshSupportsForPlate();
        }
      },
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

/** 松手：旋转烤进几何并重拼。整板平移只留矩阵，不再复制几百万顶点。只拖其中几件才重拼一次。 */
export function commitPartEdit(rotated) {
  clearNestRulers();
  const motion = finishMotionPreview(rotated ? 'rebuild' : 'hold');
  if (rotated) {
    for (const p of state.parts) bakePartRotation(p);
    state.orientResult = null;
    bus.emit('orientResults', null);
    syncPlateMesh({ faces: true });
  } else if (motion === 'rebuild' || !displayPosePending()) {
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
    const used = pack.usedArea > 1 ? Math.round(100 * pack.partArea / pack.usedArea) : 0;
    const supNote = params.nestSupportOverlap ? '支撑可重叠' : '支撑隔开';
    const frameNote = params.nestFrameOverlap ? '边框可重叠' : '边框隔开';
    log(`已排版 ${state.parts.length} 个模型：间距 ${pack.gap}mm，离板边 ${pack.margin}mm，${supNote}，${frameNote}，外接矩形利用率 ${used}%`, 'ok');
    if (pack.overflow) log('⚠ 排版后仍有模型超出当前板面，可换更大的打印机或减少模型', 'warn');
    showNestRulers(state.parts);
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

/* 加点时若点到另一件模型，切到该零件再拉近。同一件上加点（包括第一次）不动视角。 */
export function focusPartFromHit(part) {
  if (!part) return;
  const changed = state.activePartId !== part.id;
  if (!changed) {
    state.focusId = part.id;
    return;
  }
  state.activePartId = part.id;
  syncPreview(part);
  if (state.parts.length > 1) framePart(part);
  else state.focusId = part.id;
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

/* 自动底板（底板类型之一）显示：几何在后台线程按「支撑投影 + 参数」算（规格没变走缓存）。
   支撑落点高度统一走 baseY()：自动底板顶面 / 平台 0。开自动底板时模型另按同一板厚抬高（joinLift），
   支撑从板顶往上长，板厚垫在下面，不占用户设的离地高度。 */
export const baseY = () => (params.autoPlateOn ? autoPlateThickness(params) : 0);

/** 自动底板跟随支撑显示模式：连接体 / 接触点模式只显示支撑本身，底板一并隐藏（support.js 的 syncSupportView 调用） */
export function setRaftVisible(visible) { if (raftMesh) raftMesh.visible = !!visible; }

/** 换工程时摘下自动底板，不释放。进行中的那次挤出作废，免得板加到下一盘上。 */
export function takeRaftMesh() {
  autoPlateSeq++;
  autoPlateGeom = null;
  autoPlateFp = '';
  const mesh = raftMesh;
  raftMesh = null;
  if (mesh && mesh.parent) mesh.parent.remove(mesh);
  return mesh;
}

export function putRaftMesh(mesh) {
  if (raftMesh && raftMesh !== mesh) {
    if (raftMesh.parent) scene.remove(raftMesh);
    if (raftMesh.geometry) raftMesh.geometry.dispose();
    if (raftMesh.material && raftMesh.material.dispose) raftMesh.material.dispose();
  }
  raftMesh = mesh || null;
  if (raftMesh && !raftMesh.parent) scene.add(raftMesh);
  bus.emit('raft');
}

export function syncActivePreview() {
  syncPreview(activePart());
}

/** 当前自动底板网格。没有底板时是 null。树脂用量拿它的体积，不把板再算进支撑网格。 */
export function raftObject() { return raftMesh; }

export function updateRaft() {
  if (raftMesh) {
    scene.remove(raftMesh);
    raftMesh.geometry.dispose();
    raftMesh = null;
    bus.emit('raft');
  }
  if (!state.mesh || !params.autoPlateOn) return;
  const mat = bindClip(new THREE.MeshStandardMaterial({ color: 0x2a3444, roughness: 0.9, metalness: 0.05 }));
  // 序号防竞（期间又改参数 / 换模型 / 切回连接底板）
  const seq = ++autoPlateSeq;
  ensureAutoPlateGeom().then(g => {
    if (!g || seq !== autoPlateSeq || !state.mesh || !params.autoPlateOn) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(g.vert, 3));
    geo.setIndex(new THREE.BufferAttribute(g.tri, 1));
    geo.computeVertexNormals();
    raftMesh = new THREE.Mesh(geo, mat);
    raftMesh.raycast = () => {};
    raftMesh.visible = (state.supView || 'full') === 'full';   // 重建时按当前显示模式决定（连接体 / 接触点模式不显示底板）
    scene.add(raftMesh);
    bus.emit('raft');
  }).catch(() => { /* 被更新的请求取代：交给后一次 */ });
}

/* 自动底板几何缓存：规格指纹未变直接复用（显示与导出共用同一份）；同一规格的并发调用共享一个请求 */
let autoPlateGeom = null, autoPlateFp = '', autoPlateSeq = 0, autoPlatePending = null;
export async function ensureAutoPlateGeom() {
  const spec = autoPlateSpec();
  if (!spec) return null;
  const fp = plateFingerprint(spec);
  if (autoPlateGeom && autoPlateFp === fp) return autoPlateGeom;
  if (autoPlatePending && autoPlatePending.fp === fp) return autoPlatePending.p;
  const p = autoPlateAsync(spec).then(g => {
    if (g) { autoPlateGeom = g; autoPlateFp = fp; }
    if (autoPlatePending && autoPlatePending.p === p) autoPlatePending = null;
    return g;
  }, () => {                                   // 被更新的规格取代：本次返回 null，下一次触发按最新规格重算
    if (autoPlatePending && autoPlatePending.p === p) autoPlatePending = null;
    return null;
  });
  autoPlatePending = { fp, p };
  return p;
}

/** 把模型挪到当前抬高 raiseH()（含已提交的连接底板高）。只挪位置，分析与支撑由调用方处理 */
export function placeModelAtLift() {
  if (!state.mesh) return;
  const hold = state.mesh.userData.rigidHold;
  if (hold) {
    _previewM.makeTranslation(hold.dx, hold.dy + raiseH(), hold.dz);
    state.mesh.matrixAutoUpdate = false;
    state.mesh.matrix.copy(_previewM);
    state.mesh.matrixWorld.copy(_previewM);
    state.mesh.matrixWorldNeedsUpdate = false;
  } else if (state.mesh.matrixAutoUpdate) {
    state.mesh.position.y = raiseH();
    state.mesh.updateMatrix();
  } else previewPartPose();
  syncFocusRing();
  bus.emit('lift');
}
export function handleRaiseHChange() {
  const h = raiseH();
  placeModelAtLift();
  clearSupports(false); updateSupStats();
  state.analysis = null;
  hideInspector();
  bus.emit('sliceStats', null);
  const lift = state.joinLift || 0;
  log(`抬高已改为 ${baseRaiseH()}mm${lift ? `（底板再抬 ${+lift.toFixed(2)}mm，模型底面离平台 ${+h.toFixed(2)}mm）` : '（模型底面离平台）'}，请重新运行逐层分析`, 'warn');
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
  } else if (kind === 'cube') {
    g = new THREE.BoxGeometry(40, 40, 40);   // 底面由 normalizeGeom 落到 y=0
  } else {
    g = mergeGeoms([
      { g: new THREE.BoxGeometry(30, 5, 30), y: 2.5 },
      { g: new THREE.CylinderGeometry(7, 10, 30, 24), y: 20 },
      { g: new THREE.SphereGeometry(8, 24, 16), y: 50 },
      { g: new THREE.BoxGeometry(30, 2.5, 2.5), y: 40 },
      { g: new THREE.BoxGeometry(1.5, 28, 2.5), x: 14, y: 54 },
    ]);
  }
  setGeometry(g, { knot: '环面结(演示)', mushroom: '蘑菇(演示)', tier: '双层平台(演示)', statue: '悬臂雕像(演示)', cube: '正方体(演示)' }[kind]);
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

function workerJob(buffer, ratio, onProgress) {
  const w = openSimplifyWorker();
  const done = waitWorker(w, onProgress);
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
      const text = `${ratio < 1 ? '简化' : '解析'} ${i + 1}/${list.length} · ${it.name}`;
      const report = p => setProgress(0.08 + 0.84 * ((i + p) / list.length), text);
      report(0);
      await new Promise(resolve => setTimeout(resolve, 0));
      try {
        const parsed = it.kind === 'stl' && isBinarySTL(it.buf)
          ? await workerJob(it.buf, ratio, report)
          : finishPositions(positionsFor(it), ratio);
        const part = adoptParsed(parsed, it.name, ratio);
        if (part) state.parts.push(part);
        else log(`文件里没有三角面（${it.name}）`, 'warn');
      } catch (e) {
        log(`解析失败（${it.name}）：${e.message || e}`, 'warn');
      }
    }
    if (!state.parts.length) {
      toast('没有载入成功的模型', { tone: 'danger' });
      if (state.mesh) { modelGroup.remove(state.mesh); state.mesh.geometry.dispose(); state.mesh = null; }
      state.faces = null;
      emitModelInfo();
      return;
    }
    setProgress(0.96, '整理模型与排版…');
    await new Promise(resolve => setTimeout(resolve, 0));
    if (!state.parts.some(p => p.id === state.activePartId)) state.activePartId = state.parts[0].id;
    syncPreview(activePart());
    commitPlate({ arrange: state.parts.length > 1, frame: 'all' });
    setProgress(1, '导入完成');
    log('已将 Z-up 转为 Y-up，如需调整可运行朝向优化');
  } finally {
    setProgress(null);
  }
}

export function loadModelFiles(files, opts) {
  const list = files.filter(file => modelKind(file.name));
  if (!list.length) {
    if (files.length) toast('请选择 .stl、.obj 或 .3mf 文件');
    return Promise.resolve();
  }
  const run = loadChain.then(async () => {
    const items = [];
    try {
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        setProgress(0.05 * i / list.length, `读取 ${i + 1}/${list.length} · ${file.name}`);
        items.push({ buf: await file.arrayBuffer(), name: file.name });
      }
    } catch (e) {
      setProgress(null);
      log(`读取模型失败：${e.message || e}`, 'warn');
      toast('无法读取模型文件，请重新选择', { tone: 'danger' });
      return;
    }
    await ingestSTL(items, opts);
  });
  loadChain = run.catch(() => {});
  return run;
}

/** 用存档里的局部几何换掉当前板上的全部零件。支撑点按零件序号对回新 id。
    没有支撑点时抬高一并清掉，免得下一块模型还悬在上一盘底板的高度上。
    有支撑点时抬高由打开工程的一侧先提交（点的 y 里已经含着），这里不再改。 */
export function applyProjectParts(savedParts, savedPoints) {
  if (!(savedPoints || []).length) {
    state.supportLiftOn = false;
    state.joinLift = 0;
  }
  clearSupports(false);
  updateSupStats();
  disposeParts();
  bus.emit('modelsReplaced');
  for (const sp of savedParts || []) {
    const pos = sp.positions instanceof Float32Array ? sp.positions : new Float32Array(sp.positions);
    if (pos.length < 9) continue;
    const part = makePart(positionsToGeom(pos, null), sp.name || '未命名', false);
    part.ox = sp.ox || 0;
    part.oy = sp.oy || 0;
    part.oz = sp.oz || 0;
    if (sp.q && sp.q.length === 4) part.q.set(sp.q[0], sp.q[1], sp.q[2], sp.q[3]);
    state.parts.push(part);
  }
  const ids = state.parts.map(p => p.id);
  state.supportPoints = (savedPoints || []).map(p => {
    const partId = ids[p.partIndex] != null ? ids[p.partIndex] : null;
    const x = p.x, y = p.y, z = p.z;
    return {
      x, y, z,
      ax: p.ax != null ? p.ax : x,
      ay: p.ay != null ? p.ay : y,
      az: p.az != null ? p.az : z,
      n: p.n || [0, -1, 0],
      manual: true,
      island: null,
      partId,
    };
  });
  if (!state.parts.length) {
    emitModelInfo();
    return 0;
  }
  state.activePartId = state.parts[0].id;
  syncPreview(activePart());
  commitPlate({ arrange: false, frame: 'all', quiet: true });
  setSelection(ids);
  log(`已打开工程：${state.parts.length} 个零件，${state.supportPoints.length} 个支撑点`, 'ok');
  return state.parts.length;
}

/** 把零件库里的一件放到板上。已有模型时挪到右侧，支撑点跟着平移。 */
export function appendArchivedPart(saved, savedPoints) {
  const pos = saved.positions instanceof Float32Array ? saved.positions : new Float32Array(saved.positions);
  if (pos.length < 9) return null;
  const part = makePart(positionsToGeom(pos, null), saved.name || '零件', false);
  let dx = -((saved.ox || 0));
  let dy = -((saved.oy || 0));
  let dz = -((saved.oz || 0));
  if (state.parts.length) {
    let maxX = -Infinity;
    for (const p of state.parts) {
      const b = partBounds(p);
      if (b.max.x > maxX) maxX = b.max.x;
    }
    part.ox = maxX + part.base.x / 2 + 4;
    dx = part.ox - (saved.ox || 0);
    dy = (part.oy || 0) - (saved.oy || 0);
    dz = part.oz - (saved.oz || 0);
  }
  state.parts.push(part);
  const extra = (savedPoints || []).map(p => ({
    x: p.x + dx, y: p.y + dy, z: p.z + dz,
    ax: (p.ax != null ? p.ax : p.x) + dx,
    ay: (p.ay != null ? p.ay : p.y) + dy,
    az: (p.az != null ? p.az : p.z) + dz,
    n: p.n || [0, -1, 0],
    manual: true,
    island: null,
    partId: part.id,
  }));
  if (extra.length) state.supportPoints = (state.supportPoints || []).concat(extra);
  if (!state.activePartId) state.activePartId = part.id;
  syncPreview(part);
  commitPlate({ arrange: false, frame: 'active', quiet: true });
  setSelection([part.id]);
  log(`已放入零件「${part.name}」${extra.length ? `，带 ${extra.length} 个支撑点` : ''}`, 'ok');
  return { id: part.id, points: extra.length };
}

export function loadSTLBuffer(buf, name) {
  return loadSTLBuffers([{ buf, name }], { append: false });
}
export function loadSTLBuffers(items, opts) {
  const run = loadChain.then(() => ingestSTL(items, opts));
  loadChain = run.catch(() => {});
  return run;
}

