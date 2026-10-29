/* ================================================================
   包围盒边框的场景侧：按当前零件生成笼架、跟随移动、堆叠、显隐。
   几何在 bboxFrame.js。边框不参与点选射线，免得挡住涂画和加点。
   ================================================================ */
import * as THREE from 'three';
import { bus, log, params, state, toast } from '../store.js';
import { scene } from './scene.js';
import {
  discardStaleWork, emitModelInfo, partBounds, placeVertex, raftObject, raiseH, syncPlateMesh,
} from './model.js';
import { FRAME_COLOR, buildFrameGeometry, normalizeFrameConfig, occupancyFromParts } from './bboxFrame.js';

export const frameGroup = new THREE.Group();
frameGroup.name = 'bboxFrameGroup';
scene.add(frameGroup);

export const frameMat = new THREE.MeshStandardMaterial({
  color: FRAME_COLOR,
  roughness: 0.46,
  metalness: 0.08,
  envMapIntensity: 0.95,
});

let timer = 0;
let booted = false;
let building = false;
let frameHoldUntil = 0;

export function frameConfig() {
  return normalizeFrameConfig({
    beam: params.bfBeam,
    offset: params.bfOffset,
    supportGap: params.bfSupportGap,
    top: params.bfTop,
    support: params.bfSupport,
    yHeight: params.bfYHeight,
    ySpacing: params.bfYSpacing,
    pillarSpacing: params.bfPillarSpacing,
    pillarW: params.bfPillarW,
    pillarD: params.bfPillarD,
    aSpacing: params.bfASpacing,
    aBase: params.bfABase,
    aConverge: params.bfAConverge,
    aCross: params.bfACross,
    aCrossRatio: params.bfACrossRatio,
    plate: params.bfPlate,
    plateH: params.bfPlateH,
    plateOffset: params.bfPlateOffset,
    plateAngle: params.bfPlateAngle,
    holes: params.bfHoles,
    holeShape: params.bfHoleShape,
    holeR: params.bfHoleR,
    holeSpacing: params.bfHoleSpacing,
    arc: params.bfArc,
    arcH: params.bfArcH,
    arcCurve: params.bfArcCurve,
    inner: false,
    innerSpacing: params.bfInnerSpacing,
    innerR: params.bfInnerR,
    innerMargin: params.bfInnerMargin,
    reinf: params.bfReinf,
    reinfType: params.bfReinfType,
    reinfLayers: params.bfReinfLayers,
    reinfSpacing: params.bfReinfSpacing,
    reinfRatio: params.bfReinfRatio,
    yBetween: params.bfYBetween,
    yWithin: params.bfYWithin,
    yBranch: params.bfYBranch,
    yTrunk: params.bfYTrunk,
    aToCorner: params.bfAToCorner,
  });
}

export function frameTargetParts() {
  const all = state.parts || [];
  if (params.bfScope === 'selected' && state.selectedIds && state.selectedIds.length) {
    const picked = all.filter(p => state.selectedIds.includes(p.id));
    if (picked.length) return picked;
  }
  return all.slice();
}

const _meshBox = new THREE.Box3();

function meshAabb(mesh) {
  if (!mesh || !mesh.geometry || !mesh.geometry.attributes || !mesh.geometry.attributes.position) return null;
  mesh.updateWorldMatrix(true, false);
  _meshBox.setFromObject(mesh);
  if (_meshBox.isEmpty() || !Number.isFinite(_meshBox.min.x) || !Number.isFinite(_meshBox.max.y)) return null;
  return {
    min: { x: _meshBox.min.x, y: _meshBox.min.y, z: _meshBox.min.z },
    max: { x: _meshBox.max.x, y: _meshBox.max.y, z: _meshBox.max.z },
  };
}

function overlapsXZ(a, b, pad) {
  return a.max.x + pad >= b.min.x && a.min.x - pad <= b.max.x
    && a.max.z + pad >= b.min.z && a.min.z - pad <= b.max.z;
}

/* 几件共用一张支撑网格时，整张网格的包围盒会把每一圈边框撑成整板那么大。按三角形重心只取这一件的那一块。 */
function closestSupportPart(x, z) {
  let best = null;
  let bestD = Infinity;
  for (const p of state.parts || []) {
    const hx = p.base ? p.base.x / 2 : 0;
    const hz = p.base ? p.base.z / 2 : 0;
    const dx = Math.max(Math.abs(x - p.ox) - hx, 0);
    const dz = Math.max(Math.abs(z - p.oz) - hz, 0);
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function supportRecordBox(rec, parts) {
  const mesh = rec && rec.mesh;
  const attr = mesh && mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position;
  if (!attr) return null;
  const want = new Set(parts.map(p => p.id));
  const owners = rec.ownerIds || [];
  if (owners.length === 1) {
    if (!want.has(owners[0])) return null;
    return meshAabb(mesh);
  }
  mesh.updateWorldMatrix(true, false);
  const e = mesh.matrixWorld.elements;
  const arr = attr.array;
  const world = (i) => {
    const x = arr[i], y = arr[i + 1], z = arr[i + 2];
    return [
      e[0] * x + e[4] * y + e[8] * z + e[12],
      e[1] * x + e[5] * y + e[9] * z + e[13],
      e[2] * x + e[6] * y + e[10] * z + e[14],
    ];
  };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;
  const tris = (arr.length / 9) | 0;
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const pa = world(o), pb = world(o + 3), pc = world(o + 6);
    const owner = closestSupportPart((pa[0] + pb[0] + pc[0]) / 3, (pa[2] + pb[2] + pc[2]) / 3);
    if (!owner || !want.has(owner.id)) continue;
    any = true;
    for (const p of [pa, pb, pc]) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[2] < minZ) minZ = p[2];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
      if (p[2] > maxZ) maxZ = p[2];
    }
  }
  if (!any) return null;
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

/** 笼架量的是这一组模型加上落在它们占地里的支撑、底板。isolate 时只收和这组模型在板面上重叠的支撑。 */
export function frameWorldBox(parts, opts = {}) {
  const lift = raiseH();
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of parts) {
    const b = partBounds(p);
    if (b.min.x < minX) minX = b.min.x;
    if (b.min.z < minZ) minZ = b.min.z;
    if (b.max.x > maxX) maxX = b.max.x;
    if (b.max.z > maxZ) maxZ = b.max.z;
    if (b.min.y + lift < minY) minY = b.min.y + lift;
    if (b.max.y + lift > maxY) maxY = b.max.y + lift;
  }
  if (!Number.isFinite(minX)) return null;
  const model = { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
  const selectedOnly = params.bfScope === 'selected' && parts.length && parts.length < (state.parts || []).length;
  const filterExtras = !!opts.isolate || selectedOnly;
  const extras = [];
  for (const s of state.supports || []) {
    const b = supportRecordBox(s, parts);
    if (!b) continue;
    if (filterExtras && !overlapsXZ(model, b, 2)) continue;
    extras.push(b);
  }
  const raft = raftObject();
  if (raft) {
    const b = meshAabb(raft);
    if (b && (!filterExtras || overlapsXZ(model, b, 2))) extras.push(b);
  }
  for (const b of extras) {
    if (b.min.x < minX) minX = b.min.x;
    if (b.min.y < minY) minY = b.min.y;
    if (b.min.z < minZ) minZ = b.min.z;
    if (b.max.x > maxX) maxX = b.max.x;
    if (b.max.y > maxY) maxY = b.max.y;
    if (b.max.z > maxZ) maxZ = b.max.z;
  }
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    wrappedSupports: extras.length,
    supportFootprints: extras,
  };
}

function disposeFrameMeshes() {
  for (const child of [...frameGroup.children]) {
    frameGroup.remove(child);
    if (child.geometry) child.geometry.dispose();
  }
}

/** 换工程时把边框网格摘下来留着，不释放。 */
export function takeFrameVisual() {
  if (timer) { clearTimeout(timer); timer = 0; }
  const kids = [...frameGroup.children];
  for (const child of kids) frameGroup.remove(child);
  const frame = state.frame;
  state.frame = null;
  frameGroup.visible = false;
  bus.emit('frame', null);
  return { kids, frame };
}

export function putFrameVisual(pack) {
  disposeFrameMeshes();
  const kids = pack && pack.kids || [];
  state.frame = pack && pack.frame || null;
  for (const child of kids) frameGroup.add(child);
  frameGroup.visible = params.bfVisible !== false && frameGroup.children.length > 0;
  bus.emit('frame', state.frame);
}

export function discardFrameVisual(pack) {
  for (const child of (pack && pack.kids) || []) {
    if (child.parent) child.parent.remove(child);
    if (child.geometry) child.geometry.dispose();
  }
}

export function frameGeometry() {
  const mesh = frameGroup.children[0];
  return mesh && mesh.geometry ? mesh.geometry : null;
}

/** 导出用：每圈边框的顶点，加上拖动中还没烤进顶点的位移。 */
export function frameExportParts() {
  const out = [];
  for (const mesh of frameGroup.children) {
    const arr = mesh.geometry && mesh.geometry.attributes.position && mesh.geometry.attributes.position.array;
    if (!arr || arr.length < 9) continue;
    out.push({ arr, dx: mesh.position.x, dy: mesh.position.y, dz: mesh.position.z });
  }
  return out;
}

export function setFrameVisible(on) {
  params.bfVisible = !!on;
  frameGroup.visible = !!on && frameGroup.children.length > 0;
  bus.emit('frame', state.frame);
}

export function clearFrame(quiet) {
  disposeFrameMeshes();
  state.frame = null;
  frameGroup.visible = false;
  bus.emit('frame', null);
  if (!quiet) {
    log('已清除包围盒边框');
    toast('已清除包围盒边框');
  }
}

export function rebuildFrame(opts = {}) {
  if (building) return state.frame;
  const parts = opts.parts || frameTargetParts();
  if (!parts.length) {
    clearFrame(true);
    if (!opts.quiet) toast('先载入模型，再生成边框');
    return null;
  }
  building = true;
  try {
    const cfg = frameConfig();
    disposeFrameMeshes();
    const totals = { triangles: 0, pillars: 0, beams: 0, braces: 0, holes: 0, inner: 0, wrapped: 0 };
    const warnings = [];
    let union = null;
    for (const part of parts) {
      const box = frameWorldBox([part], { isolate: true });
      if (!box) continue;
      const modelOcc = cfg.inner && cfg.plate ? occupancyFromParts([part], placeVertex) : null;
      const footprints = box.supportFootprints || [];
      const occupied = modelOcc
        ? (x, z) => modelOcc(x, z) || footprints.some(b => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z)
        : null;
      const built = buildFrameGeometry(box, { ...cfg, supportWrapped: box.wrappedSupports > 0 }, occupied);
      if (!built.geometry) {
        if (built.stats && built.stats.warnings) warnings.push(...built.stats.warnings);
        continue;
      }
      const mesh = new THREE.Mesh(built.geometry, frameMat);
      mesh.name = 'bboxFrame';
      mesh.userData.type = 'bbox-frame';
      mesh.userData.partId = part.id;
      mesh.raycast = () => {};
      frameGroup.add(mesh);
      const s = built.stats;
      totals.triangles += s.triangles || 0;
      totals.pillars += s.pillars || 0;
      totals.beams += s.beams || 0;
      totals.braces += s.braces || 0;
      totals.holes += s.holes || 0;
      totals.inner += s.inner || 0;
      totals.wrapped += box.wrappedSupports || 0;
      if (!union) union = { min: { ...s.min }, max: { ...s.max } };
      else {
        union.min.x = Math.min(union.min.x, s.min.x);
        union.min.y = Math.min(union.min.y, s.min.y);
        union.min.z = Math.min(union.min.z, s.min.z);
        union.max.x = Math.max(union.max.x, s.max.x);
        union.max.y = Math.max(union.max.y, s.max.y);
        union.max.z = Math.max(union.max.z, s.max.z);
      }
      if (s.warnings) warnings.push(...s.warnings);
    }
    frameGroup.position.set(0, 0, 0);
    if (!frameGroup.children.length) {
      state.frame = null;
      frameGroup.visible = false;
      bus.emit('frame', null);
      if (!opts.quiet) toast(warnings[0] || '边框没有生成');
      return null;
    }
    frameGroup.visible = params.bfVisible !== false;
    const n = frameGroup.children.length;
    state.frame = {
      triangles: totals.triangles,
      pillars: totals.pillars,
      beams: totals.beams,
      braces: totals.braces,
      holes: totals.holes,
      inner: totals.inner,
      arc: 0,
      plate: 0,
      support: 0,
      partIds: [...frameGroup.children].map(m => m.userData.partId),
      perPart: true,
      sizeText: union
        ? `${(union.max.x - union.min.x).toFixed(1)} × ${(union.max.y - union.min.y).toFixed(1)} × ${(union.max.z - union.min.z).toFixed(1)} mm`
        : '',
      wrappedSupports: totals.wrapped,
      warnings,
    };
    bus.emit('frame', state.frame);
    if (!opts.quiet) {
      const extra = warnings.length ? `（${warnings[0]}）` : '';
      log(`包围盒边框已生成：${n} 圈，${totals.triangles.toLocaleString()} 面，${totals.pillars} 根立柱${extra}`, 'ok');
      toast(n > 1 ? `已生成 ${n} 圈独立边框` : '边框已生成');
    }
    return state.frame;
  } finally {
    building = false;
  }
}

export function scheduleFrameRebuild() {
  if (!state.frame) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = 0;
    if (state.frame) rebuildFrame({ quiet: true });
  }, 140);
}

/** 旧的一整圈没有按模型分开时，先拆成每个模型一圈，拖动才能各自跟着走。 */
export function ensurePerPartFrames() {
  if (!state.frame) return false;
  const kids = frameGroup.children;
  if (kids.length && [...kids].every(m => m.userData.partId != null)) return false;
  rebuildFrame({ quiet: true });
  return true;
}

function shiftFrameGeom(geom, dx, dy, dz) {
  const attr = geom && geom.attributes && geom.attributes.position;
  if (!attr) return;
  const a = attr.array;
  for (let i = 0; i < a.length; i += 3) {
    a[i] += dx;
    a[i + 1] += dy;
    a[i + 2] += dz;
  }
  attr.needsUpdate = true;
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
}

/** 拖动时边框跟着模型走，不等重新生成。 */
export function previewFrameShift(partIds, dx, dy, dz) {
  if (!state.frame) return;
  const ids = new Set(partIds || []);
  frameGroup.position.set(0, 0, 0);
  for (const mesh of frameGroup.children) {
    if (ids.has(mesh.userData.partId)) mesh.position.set(dx, dy, dz);
    else mesh.position.set(0, 0, 0);
  }
}

/** 松手：把拖动位移烤进边框顶点。 */
export function bakeFrameShift(partIds, dx, dy, dz) {
  if (!state.frame) return;
  const ids = new Set(partIds || []);
  frameGroup.position.set(0, 0, 0);
  for (const mesh of frameGroup.children) {
    const follow = ids.has(mesh.userData.partId);
    mesh.position.set(0, 0, 0);
    if (follow) shiftFrameGeom(mesh.geometry, dx, dy, dz);
  }
}

function onModelChange() {
  if (!state.frame || !params.bfFollow) return;
  if (performance.now() < frameHoldUntil) return;
  const old = new Set(state.frame.partIds || []);
  const keep = (state.parts || []).filter(p => old.has(p.id));
  const added = (state.parts || []).filter(p => !old.has(p.id));
  if (!keep.length && !added.length) {
    clearFrame(true);
    return;
  }
  // 复制、删除会改变零件集合。马上按每个模型各做一圈，已有边框的模型留着，新模型另加一圈。
  if (added.length || keep.length !== old.size || !state.frame.perPart) {
    clearTimeout(timer);
    timer = 0;
    rebuildFrame({ quiet: true, parts: keep.concat(added) });
    return;
  }
  scheduleFrameRebuild();
}

export function initBBoxFrame() {
  if (booted) return;
  booted = true;
  bus.on('modelInfo', onModelChange);
  bus.on('lift', onModelChange);
  bus.on('supStats', onModelChange);
  bus.on('raft', onModelChange);
  bus.on('framePrepare', () => { if (state.frame) ensurePerPartFrames(); });
  bus.on('frameShift', (p) => {
    if (!p || !state.frame) return;
    if (p.bake) bakeFrameShift(p.partIds, p.dx, p.dy, p.dz);
    else previewFrameShift(p.partIds, p.dx, p.dy, p.dz);
  });
  bus.on('frameMove', (moves) => { relocateFrameMeshes(moves); });
  bus.on('frameHold', () => {
    frameHoldUntil = performance.now() + 800;
    clearTimeout(timer);
    timer = 0;
  });
  bus.on('frameRebuild', () => { if (state.frame) rebuildFrame({ quiet: true }); });
}

/* 排版后边框跟着各自的零件走，投影外沿和模型一起挪。 */
function relocateFrameMeshes(moves) {
  if (!state.frame || !moves || !moves.length) return;
  const byId = new Map();
  for (const m of moves) {
    const yaw = m.yaw || 0;
    byId.set(m.id, {
      ...m,
      c: Math.cos(yaw),
      s: Math.sin(yaw),
      dy: (m.oy1 || 0) - (m.oy0 || 0),
    });
  }
  frameGroup.position.set(0, 0, 0);
  for (const mesh of frameGroup.children) {
    const m = byId.get(mesh.userData.partId);
    const pos = mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position;
    if (!m || !pos) continue;
    mesh.position.set(0, 0, 0);
    const a = pos.array;
    for (let i = 0; i < a.length; i += 3) {
      const lx = a[i] - m.ox0;
      const lz = a[i + 2] - m.oz0;
      a[i] = m.ox1 + m.c * lx + m.s * lz;
      a[i + 1] += m.dy;
      a[i + 2] = m.oz1 - m.s * lx + m.c * lz;
    }
    pos.needsUpdate = true;
    const nrm = mesh.geometry.attributes.normal;
    if (nrm) {
      const b = nrm.array;
      for (let i = 0; i < b.length; i += 3) {
        const nx = b[i];
        const nz = b[i + 2];
        b[i] = m.c * nx + m.s * nz;
        b[i + 2] = -m.s * nx + m.c * nz;
      }
      nrm.needsUpdate = true;
    }
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
  }
}

/** 选中的多件（没选则全部）按包围盒竖直叠起，水平中心对齐第一件。 */
export function stackFrameParts() {
  const picked = state.selectedIds && state.selectedIds.length > 1
    ? state.parts.filter(p => state.selectedIds.includes(p.id))
    : state.parts.slice();
  if (picked.length < 2) {
    toast('至少需要两件模型才能堆叠');
    return false;
  }
  const lift = raiseH();
  const gap = (params.bfTop || 0) + (params.bfBeam || 2) + 0.4;
  const first = frameWorldBox([picked[0]]);
  const cx = (first.min.x + first.max.x) / 2;
  const cz = (first.min.z + first.max.z) / 2;
  let top = 0;
  picked.forEach((part, i) => {
    const b = partBounds(part);
    const worldMinY = b.min.y + lift;
    const worldMaxY = b.max.y + lift;
    part.ox += cx - (b.min.x + b.max.x) / 2;
    part.oz += cz - (b.min.z + b.max.z) / 2;
    if (i === 0) part.oy = (part.oy || 0) + (0 - worldMinY);
    else part.oy = (part.oy || 0) + (top - worldMinY);
    const next = partBounds(part);
    top = next.max.y + lift + gap;
  });
  discardStaleWork('模型已堆叠，分析结果与支撑已清除');
  syncPlateMesh({ faces: true });
  emitModelInfo();
  log(`已竖直堆叠 ${picked.length} 件模型`, 'ok');
  toast(`已堆叠 ${picked.length} 件模型`);
  if (state.frame) rebuildFrame();
  return true;
}

/** 把堆叠抬高清掉，每件底面回到平台。水平位置不动。 */
export function resetFrameStack() {
  const parts = state.parts || [];
  if (!parts.length) return false;
  const lift = raiseH();
  for (const part of parts) {
    const b = partBounds(part);
    part.oy = (part.oy || 0) + (0 - (b.min.y + lift));
  }
  discardStaleWork('模型已铺回平台，分析结果与支撑已清除');
  syncPlateMesh({ faces: true });
  emitModelInfo();
  log('模型已铺回平台', 'ok');
  toast('模型已铺回平台');
  if (state.frame) rebuildFrame();
  return true;
}

