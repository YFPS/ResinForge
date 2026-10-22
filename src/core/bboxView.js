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

/** 笼架量的是「模型 + 已生成支撑 + 自动底板」的世界体积，不是光模型。 */
export function frameWorldBox(parts) {
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
  const extras = [];
  for (const s of state.supports || []) {
    const b = meshAabb(s.mesh);
    if (!b) continue;
    if (selectedOnly && !overlapsXZ(model, b, 2)) continue;
    extras.push(b);
  }
  const raft = raftObject();
  if (raft) {
    const b = meshAabb(raft);
    if (b && (!selectedOnly || overlapsXZ(model, b, 2))) extras.push(b);
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

export function frameGeometry() {
  const mesh = frameGroup.children[0];
  return mesh && mesh.geometry ? mesh.geometry : null;
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
  const parts = frameTargetParts();
  if (!parts.length) {
    clearFrame(true);
    toast('先载入模型，再生成边框');
    return null;
  }
  building = true;
  try {
    const box = frameWorldBox(parts);
    const cfg = frameConfig();
    const modelOcc = cfg.inner && cfg.plate ? occupancyFromParts(parts, placeVertex) : null;
    const footprints = box && box.supportFootprints || [];
    const occupied = modelOcc
      ? (x, z) => modelOcc(x, z) || footprints.some(b => x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z)
      : null;
    const built = buildFrameGeometry(box, { ...cfg, supportWrapped: box.wrappedSupports > 0 }, occupied);
    disposeFrameMeshes();
    if (!built.geometry) {
      state.frame = null;
      frameGroup.visible = false;
      bus.emit('frame', null);
      toast(built.stats.warnings[0] || '边框没有生成');
      return null;
    }
    const mesh = new THREE.Mesh(built.geometry, frameMat);
    mesh.name = 'bboxFrame';
    mesh.userData.type = 'bbox-frame';
    mesh.raycast = () => {};
    frameGroup.add(mesh);
    frameGroup.visible = params.bfVisible !== false;
    const s = built.stats;
    state.frame = {
      triangles: s.triangles,
      pillars: s.pillars,
      beams: s.beams,
      braces: s.braces,
      holes: s.holes,
      inner: s.inner,
      arc: s.arc,
      plate: s.plate,
      support: s.support,
      partIds: parts.map(p => p.id),
      sizeText: `${(s.max.x - s.min.x).toFixed(1)} × ${(s.max.y - s.min.y).toFixed(1)} × ${(s.max.z - s.min.z).toFixed(1)} mm`,
      wrappedSupports: box.wrappedSupports || 0,
      warnings: s.warnings,
    };
    bus.emit('frame', state.frame);
    const extra = s.warnings.length ? `（${s.warnings[0]}）` : '';
    const wrap = box.wrappedSupports ? `，已包住 ${box.wrappedSupports} 块支撑` : '';
    if (!opts.quiet) {
      log(`包围盒边框已生成：${s.triangles.toLocaleString()} 面，${s.pillars} 根立柱${wrap}${s.inner ? `，内部立柱 ${s.inner}` : ''}${extra}`, 'ok');
      toast('边框已生成');
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

function onModelChange() {
  if (!state.frame || !params.bfFollow) return;
  const ids = state.frame.partIds || [];
  const live = (state.parts || []).some(p => ids.includes(p.id));
  if (!live) {
    clearFrame(true);
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

