/* ================================================================
   视口里选中并摆放模型。
   - 单击选中一个模型。已经选中的模型上按住左键拖动，是在板面上移动（多选一起动）
   - 从空白处或未选中的模型上按住左键拖动，出现框线，松开后选中框到的模型
   - Ctrl/⌘ 再点是加减选中，再框是追加；Ctrl/⌘ A 全选，不选中网页文字
   - Delete 删除当前选中的模型。Ctrl/⌘ Z 撤回，Ctrl/⌘ Shift Z 或 Ctrl/⌘ Y 重做
   - 中键拖动平移视角，右键拖动旋转视角；右键点在单个模型上（没有拖开）弹出菜单
   - 菜单：沿坐标轴移动 / 拖圆环旋转 / 放大缩小
   - 放大缩小在视口左侧打开面板：毫米和百分比、锁定等比、还原、适应机型。拖拽时三色方块沿轴拉，角标标出包围盒
   - 切片 Z 是高度：沿 Z 下移或旋转扫进平台时，底面停在 Z = 0，不能为负
   - 缩放烤进局部顶点。切片 X = 局部 x，切片 Y = 局部 z，切片 Z（高度）= 局部 y，从底面向上长
   涂保护面、加支撑、删支撑仍占用左键，这里不抢。
================================================================ */
import * as THREE from 'three';
import { state, bus, log, toast } from '../store.js';
import { scene, camera, pointerRay, setMode } from './scene.js';
import {
  raiseH, localFaceOf, setSelection, syncPlateMesh, commitPartEdit, removeParts, previewPartPose, meshPick, scheduleMeshBVH,
  partBounds, clampPartsToPrintZ, bakePartRotation, applyPartScale, finishPartScale, discardStaleWork, uniformScaleFactor,
  scalePartAxis, resetPartScale, scalePartToFit,
  capturePoses, capturePartSnaps, releaseSnaps, commitPoseHistory, commitGeomHistory,
} from './model.js';
import { undo, redo } from './history.js';
import { clearSupports, updateSupStats } from './support.js';
import { hideInspector } from './inspect.js';

/* 切片软件坐标：X / Y 在板面上，Z 向上。场景本身是 Y 朝上，所以切片 Y = 世界 +Z，切片 Z = 世界 +Y。 */
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const AXIS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 0, 1),
  z: new THREE.Vector3(0, 1, 0),
};
const AXIS_COLOR = { x: 0xe25b5b, y: 0x3dbe74, z: 0x4c8dff };

let canvas = null;
let gizmo = null;
let moveRoot = null;
let rotRoot = null;
let scaleRoot = null;
let scaleCage = null;
let selGroup = null;
let menuEl = null;
let scaleEl = null;
let scaleUniform = true;
let scaleDrag = true;
let scaleSpace = 'world';
let gesture = null;
let rightArm = null;
let marquee = null;
let marqueeEl = null;
let hovered = null;
let raised = null;

const _plane = new THREE.Plane();
const _hit = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _quat = new THREE.Quaternion();

function ghostMat() {
  return new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0, depthWrite: false, depthTest: false,
  });
}

function solidMat(hex) {
  return new THREE.MeshBasicMaterial({ color: hex, depthTest: false, fog: false, toneMapped: false });
}

function tag(obj, tool, axis, mat) {
  obj.userData.tool = tool;
  obj.userData.axis = axis;
  obj.userData.mat = mat;
  obj.userData.base = mat.color.getHex();
  obj.traverse(o => { o.renderOrder = 20; });
  return obj;
}

/* 箭头沿组的局部 +Y，组再转到世界轴上 */
function makeArrow(axis) {
  const color = AXIS_COLOR[axis];
  const mat = solidMat(color);
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 14, 12), mat);
  shaft.position.y = 7;
  const head = new THREE.Mesh(new THREE.ConeGeometry(1.55, 3.6, 16), mat);
  head.position.y = 15.8;
  const pick = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.1, 20, 8), ghostMat());
  pick.position.y = 10;
  g.add(shaft, head, pick);
  if (axis === 'x') g.rotation.z = -Math.PI / 2;          // 切片 X = 世界 +X
  else if (axis === 'y') g.rotation.x = Math.PI / 2;       // 切片 Y = 世界 +Z，躺在板面上
  // 切片 Z = 世界 +Y，箭头默认就朝上
  return tag(g, 'move', axis, mat);
}

/* 圆环在该轴的垂直面里。局部圆环默认躺在 XY（法线 +Z）。 */
function makeRing(axis) {
  const color = AXIS_COLOR[axis];
  const mat = solidMat(color);
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(16, 0.62, 8, 48), mat);
  const pick = new THREE.Mesh(new THREE.TorusGeometry(16, 1.7, 6, 32), ghostMat());
  if (axis === 'x') { ring.rotation.y = Math.PI / 2; pick.rotation.y = Math.PI / 2; }
  else if (axis === 'z') { ring.rotation.x = Math.PI / 2; pick.rotation.x = Math.PI / 2; }   // 绕高度（世界 Y）
  const len = 18;
  const ends = axis === 'x' ? [-len, 0, 0, len, 0, 0] : axis === 'y' ? [0, 0, -len, 0, 0, len] : [0, -len, 0, 0, len, 0];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(ends, 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false, fog: false, toneMapped: false }));
  line.raycast = () => {};
  line.renderOrder = 19;
  g.add(ring, pick, line);
  return tag(g, 'rotate', axis, mat);
}

/* 方块沿组的局部 +Y，再转到切片轴上，与箭头同一套旋转。线段从枢轴连到方块。 */
function makeScaleHandle(axis) {
  const color = AXIS_COLOR[axis];
  const mat = solidMat(color);
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.4, 2.4), mat);
  const pick = new THREE.Mesh(new THREE.BoxGeometry(4.4, 4.4, 4.4), ghostMat());
  box.position.y = 16;
  pick.position.y = 16;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 16, 0], 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false, fog: false, toneMapped: false }));
  line.raycast = () => {};
  line.renderOrder = 19;
  g.add(line, box, pick);
  if (axis === 'x') g.rotation.z = -Math.PI / 2;       // 局部 +Y → 世界 +X，切片 X
  else if (axis === 'y') g.rotation.x = Math.PI / 2;  // 局部 +Y → 世界 +Z，切片 Y
  return tag(g, 'scale', axis, mat);
}

function scalingTool() {
  return state.transformTool === 'scale';
}

function buildGizmo() {
  gizmo = new THREE.Group();
  gizmo.name = 'partGizmo';
  gizmo.visible = false;
  gizmo.frustumCulled = false;
  moveRoot = new THREE.Group();
  rotRoot = new THREE.Group();
  scaleRoot = new THREE.Group();
  scaleRoot.name = 'scaleHandles';
  for (const axis of ['x', 'y', 'z']) {
    moveRoot.add(makeArrow(axis));
    rotRoot.add(makeRing(axis));
    scaleRoot.add(makeScaleHandle(axis));
  }
  gizmo.add(moveRoot, rotRoot, scaleRoot);
  scene.add(gizmo);

  const cageGeo = new THREE.BufferGeometry();
  cageGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * 3 * 2 * 3), 3));
  scaleCage = new THREE.LineSegments(cageGeo, new THREE.LineBasicMaterial({
    color: 0xf4f6f8, transparent: true, opacity: 0.95, depthTest: false, fog: false, toneMapped: false,
  }));
  scaleCage.name = 'partScaleCage';
  scaleCage.frustumCulled = false;
  scaleCage.renderOrder = 12;
  scaleCage.raycast = () => {};
  scaleCage.visible = false;
  scene.add(scaleCage);

  selGroup = new THREE.Group();
  selGroup.name = 'partSelection';
  scene.add(selGroup);
}

function pivotOf(part, out) {
  return out.set(part.ox, raiseH() + (part.oy || 0) + part.base.y / 2, part.oz);
}

function scalePartNow() {
  if (!scalingTool() || (state.selectedIds || []).length !== 1) return null;
  return state.parts.find(p => p.id === state.selectedIds[0]) || null;
}

function pxScale(at) {
  const dist = Math.max(1, camera.position.distanceTo(at));
  const h = Math.max(1, canvas.clientHeight || 1);
  return 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * dist / h;
}

function placeGizmo() {
  if (!gizmo) return;
  const part = scalePartNow() || (state.transformTool && (state.selectedIds || []).length === 1
    ? state.parts.find(p => p.id === state.selectedIds[0]) : null);
  const single = state.transformTool && (state.selectedIds || []).length === 1 ? part : null;
  moveRoot.visible = !!single && state.transformTool === 'move';
  rotRoot.visible = !!single && state.transformTool === 'rotate';
  scaleRoot.visible = !!scalePartNow() && scaleDrag;
  gizmo.visible = moveRoot.visible || rotRoot.visible || scaleRoot.visible;
  // 模型坐标系时手柄跟着零件旋转。q 为单位时与世界轴重合，两种模式看起来一样。
  if (scalePartNow() && scaleSpace === 'object') gizmo.quaternion.copy(scalePartNow().q);
  else gizmo.quaternion.identity();
  if (!single || !gizmo.visible) return;
  if (gesture && gesture.kind === 'scale') gizmo.position.copy(gesture.origin);
  else pivotOf(single, gizmo.position);
  gizmo.scale.setScalar((120 * pxScale(gizmo.position)) / 18);
  gizmo.updateMatrixWorld(true);
}

/* 包围盒八角的短折线。深色视口用浅色，浅色视口用深色，避免角标消失。 */
function syncScaleCage() {
  if (!scaleCage) return;
  const part = scalePartNow();
  scaleCage.visible = !!part;
  if (!part) return;
  const b = partBounds(part);
  const lift = raiseH();
  const x0 = b.min.x, y0 = b.min.y + lift, z0 = b.min.z;
  const x1 = b.max.x, y1 = b.max.y + lift, z1 = b.max.z;
  const mid = _tmp.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  let len = 14 * pxScale(mid);
  const shortest = Math.min(x1 - x0, y1 - y0, z1 - z0);
  if (len > shortest * 0.28) len = shortest * 0.28;
  if (len < 0.4) len = 0.4;
  const corners = [
    [x0, y0, z0, 1, 1, 1], [x1, y0, z0, -1, 1, 1], [x1, y0, z1, -1, 1, -1], [x0, y0, z1, 1, 1, -1],
    [x0, y1, z0, 1, -1, 1], [x1, y1, z0, -1, -1, 1], [x1, y1, z1, -1, -1, -1], [x0, y1, z1, 1, -1, -1],
  ];
  const pos = scaleCage.geometry.attributes.position.array;
  let o = 0;
  for (const [x, y, z, sx, sy, sz] of corners) {
    pos[o++] = x; pos[o++] = y; pos[o++] = z; pos[o++] = x + sx * len; pos[o++] = y; pos[o++] = z;
    pos[o++] = x; pos[o++] = y; pos[o++] = z; pos[o++] = x; pos[o++] = y + sy * len; pos[o++] = z;
    pos[o++] = x; pos[o++] = y; pos[o++] = z; pos[o++] = x; pos[o++] = y; pos[o++] = z + sz * len;
  }
  scaleCage.geometry.attributes.position.needsUpdate = true;
  scaleCage.geometry.computeBoundingSphere();
  const bg = scene.background;
  const lum = bg && bg.isColor ? bg.r * 0.2126 + bg.g * 0.7152 + bg.b * 0.0722 : 0;
  scaleCage.material.color.setHex(lum > 0.55 ? 0x1c2430 : 0xf4f6f8);
}

function syncSelectionBoxes() {
  if (!selGroup) return;
  while (selGroup.children.length) {
    const c = selGroup.children.pop();
    c.geometry.dispose();
    c.material.dispose();
  }
  const lift = raiseH();
  // 缩放时改画角标，不再叠一条完整的蓝色框线
  if (scalingTool()) { raised = lift; return; }
  for (const id of state.selectedIds || []) {
    const p = state.parts.find(x => x.id === id);
    if (!p) continue;
    const b = partBounds(p);
    const x0 = b.min.x, y0 = b.min.y + lift, z0 = b.min.z;
    const x1 = b.max.x, y1 = b.max.y + lift, z1 = b.max.z;
    const pos = [
      x0, y0, z0, x1, y0, z0, x1, y0, z0, x1, y0, z1, x1, y0, z1, x0, y0, z1, x0, y0, z1, x0, y0, z0,
      x0, y1, z0, x1, y1, z0, x1, y1, z0, x1, y1, z1, x1, y1, z1, x0, y1, z1, x0, y1, z1, x0, y1, z0,
      x0, y0, z0, x0, y1, z0, x1, y0, z0, x1, y1, z0, x1, y0, z1, x1, y1, z1, x0, y0, z1, x0, y1, z1,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x3d8bfd, transparent: true, opacity: 0.95, depthTest: false });
    const line = new THREE.LineSegments(geo, mat);
    line.renderOrder = 8;
    line.raycast = () => {};
    selGroup.add(line);
  }
  raised = lift;
}

function setHover(group) {
  if (hovered === group) return;
  if (hovered && hovered.userData.mat) hovered.userData.mat.color.setHex(hovered.userData.base);
  hovered = group;
  if (hovered && hovered.userData.mat) hovered.userData.mat.color.setHex(0xffffff);
}

function pickGizmo(e) {
  if (!gizmo || !gizmo.visible) return null;
  const root = state.transformTool === 'move' ? moveRoot : state.transformTool === 'rotate' ? rotRoot : scalingTool() ? scaleRoot : null;
  if (!root || !root.visible) return null;
  root.updateMatrixWorld(true);
  // 只测当前这套手柄。另一套虽然 visible=false，Mesh.raycast 仍会命中。
  const hits = pointerRay(e).intersectObjects(root.children, true);
  for (const h of hits) {
    let o = h.object;
    while (o && o !== root) {
      if (o.userData && o.userData.axis) return o;
      o = o.parent;
    }
  }
  return null;
}

function pickModel(e, allowBuild) {
  if (!state.mesh) return null;
  const ray = pointerRay(e).ray;
  let hit = meshPick(ray);
  if (!hit && allowBuild) {
    scheduleMeshBVH();
    const hits = pointerRay(e).intersectObject(state.mesh, false);
    if (!hits.length) return null;
    const loc = localFaceOf(hits[0].faceIndex);
    if (!loc) return null;
    return { part: loc.part, point: hits[0].point.clone() };
  }
  if (!hit) return null;
  const loc = localFaceOf(hit.face);
  if (!loc) return null;
  return { part: loc.part, point: hit.point };
}

function liveSelected() {
  const ids = state.selectedIds || [];
  return state.parts.filter(p => ids.includes(p.id));
}

function snapshot(parts) {
  return parts.map(p => ({ part: p, ox: p.ox, oy: p.oy || 0, oz: p.oz, q: p.q.clone() }));
}

/* 射线与过 origin、方向 dir（单位向量）的轴的最近点参数 */
function axisParam(ray, origin, dir) {
  const w0x = ray.origin.x - origin.x;
  const w0y = ray.origin.y - origin.y;
  const w0z = ray.origin.z - origin.z;
  const b = ray.direction.dot(dir);
  const d = ray.direction.x * w0x + ray.direction.y * w0y + ray.direction.z * w0z;
  const e = dir.x * w0x + dir.y * w0y + dir.z * w0z;
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-6) return e;
  return (e - b * d) / denom;
}

function planePoint(ray, origin, normal, out) {
  _plane.setFromNormalAndCoplanarPoint(normal, origin);
  if (Math.abs(_plane.normal.dot(ray.direction)) < 1e-6) return null;
  const p = ray.intersectPlane(_plane, out);
  return p || null;
}

function invalidateWork() {
  const dirty = !!(state.analysis || (state.supportPoints && state.supportPoints.length) || (state.supports && state.supports.length));
  if (!dirty) return;
  clearSupports(false);
  state.analysis = null;
  hideInspector();
  bus.emit('sliceStats', null);
  updateSupStats();
  log('模型已移动，分析结果与支撑已清除，请重新分析', 'warn');
}

function reallyMoved(snaps) {
  for (const s of snaps) {
    if (Math.hypot(s.part.ox - s.ox, s.part.oy - s.oy, s.part.oz - s.oz) > 0.02) return true;
    if (s.part.q.angleTo(s.q) > 0.002) return true;
  }
  return false;
}

function writeFromSnapshot(snaps) {
  for (const s of snaps) {
    s.part.ox = s.ox;
    s.part.oy = s.oy;
    s.part.oz = s.oz;
    s.part.q.copy(s.q);
  }
}

function partsOf(g) {
  return g.snaps.map(s => s.part);
}

function applyGesture(e) {
  const g = gesture;
  if (!g) return;
  const ray = pointerRay(e).ray;
  if (g.kind === 'free') {
    if (!planePoint(ray, _tmp.set(0, g.planeY, 0), WORLD_UP, _hit)) return;
    writeFromSnapshot(g.snaps);
    const dx = _hit.x - g.start.x;
    const dz = _hit.z - g.start.z;
    for (const s of g.snaps) {
      s.part.ox = s.ox + dx;
      s.part.oz = s.oz + dz;
    }
  } else if (g.kind === 'move') {
    const delta = axisParam(ray, g.origin, g.dir) - g.startParam;
    writeFromSnapshot(g.snaps);
    for (const s of g.snaps) {
      s.part.ox = s.ox + g.dir.x * delta;
      s.part.oy = s.oy + g.dir.y * delta;
      s.part.oz = s.oz + g.dir.z * delta;
    }
    clampPartsToPrintZ(partsOf(g));
  } else if (g.kind === 'rotate') {
    if (!planePoint(ray, g.origin, g.dir, _hit)) return;
    _tmp.copy(_hit).sub(g.origin);
    _tmp.addScaledVector(g.dir, -_tmp.dot(g.dir));
    if (_tmp.lengthSq() < 1e-6 || g.startVec.lengthSq() < 1e-6) return;
    const cross = _tmp2.crossVectors(g.startVec, _tmp);
    const ang = Math.atan2(g.dir.dot(cross), g.startVec.dot(_tmp));
    _quat.setFromAxisAngle(g.dir, ang);
    writeFromSnapshot(g.snaps);
    for (const s of g.snaps) {
      s.part.q.copy(s.q).premultiply(_quat).normalize();
    }
    clampPartsToPrintZ(partsOf(g));
  } else if (g.kind === 'scale') {
    applyScaleGesture(g, e, ray);
    return;
  }
  if (!g.moved && reallyMoved(g.snaps)) {
    g.moved = true;
    invalidateWork();
  }
  if (g.moved) {
    if (!previewPartPose()) syncPlateMesh({ faces: false });
    syncSelectionBoxes();
    canvas.style.cursor = 'grabbing';
  }
}

function beginFree(picked, e) {
  const parts = liveSelected();
  if (!parts.length) return;
  gesture = {
    kind: 'free',
    pid: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    moved: false,
    planeY: picked.point.y,
    start: picked.point.clone(),
    snaps: snapshot(parts),
    before: capturePoses(parts),
    hist: 'pose',
  };
}

/* 沿轴拉动：现在的轴参数 / 按下时的轴参数。向外大于 1，朝枢轴小于 1。 */
function scaleFactor(g, ray) {
  return axisParam(ray, g.origin, g.dir) / g.startParam;
}

function applyScaleGesture(g, e, ray) {
  const part = g.snaps[0].part;
  writeFromSnapshot(g.snaps);
  let factor = scaleFactor(g, ray);
  let fx = 1;
  let fy = 1;
  let fz = 1;
  if (g.uniform) {
    factor = uniformScaleFactor(factor, g.base);
    fx = fy = fz = factor;
  } else if (g.axis === 'x') fx = factor;
  else if (g.axis === 'y') fz = factor;   // 切片 Y = 局部 z
  else if (g.axis === 'z') fy = factor;   // 切片 Z = 局部 y，从底面乘
  const applied = applyPartScale(part, fx, fy, fz, g.src, g.base, g.srcSource);
  if (!applied) return;
  g.fx = applied.fx;
  g.fy = applied.fy;
  g.fz = applied.fz;
  const delta = Math.max(Math.abs(g.fx - 1), Math.abs(g.fy - 1), Math.abs(g.fz - 1));
  if (delta <= 0.002 && !g.moved) {
    applyPartScale(part, 1, 1, 1, g.src, g.base, g.srcSource);
    writeFromSnapshot(g.snaps);
    return;
  }
  if (!g.moved) {
    g.moved = true;
    discardStaleWork('模型尺寸已变，分析结果与支撑已清除，请重新分析');
  }
  clampPartsToPrintZ([part]);
  syncPlateMesh({ faces: false });
  syncSelectionBoxes();
  syncScaleCage();
  syncScalePanel();
  canvas.style.cursor = 'grabbing';
}

function beginScale(part, group, e) {
  const before = capturePartSnaps([part]);
  const objectSpace = scaleSpace === 'object';
  let baked = false;
  if (!objectSpace) {
    baked = bakePartRotation(part);
    if (baked) syncPlateMesh({ faces: false });
  }
  const origin = pivotOf(part, new THREE.Vector3());
  const axis = group.userData.axis;
  const dir = AXIS[axis].clone();
  // 绕世界 Y 转 90° 时，切片 Y（世界 +Z）应转到世界 +X。q 为单位时方向就是 AXIS。
  if (objectSpace) dir.applyQuaternion(part.q);
  let startParam = axisParam(pointerRay(e).ray, origin, dir);
  if (!(Math.abs(startParam) > 1)) startParam = 16 * (gizmo.scale.x || 1);
  gesture = {
    kind: 'scale',
    pid: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    moved: false,
    baked,
    origin,
    dir,
    axis,
    uniform: scaleUniform,
    startParam,
    src: new Float32Array(part.geom.attributes.position.array),
    srcSource: part.source ? new Float32Array(part.source) : null,
    base: { x: part.base.x, y: part.base.y, z: part.base.z },
    snaps: snapshot([part]),
    before,
    hist: 'geom',
    handle: group,
    fx: 1,
    fy: 1,
    fz: 1,
  };
  setHover(group);
}

function beginGizmo(group, e) {
  const parts = liveSelected();
  if (parts.length !== 1) return;
  const part = parts[0];
  if (group.userData.tool === 'scale') {
    beginScale(part, group, e);
    return;
  }
  const origin = pivotOf(part, new THREE.Vector3());
  const dir = AXIS[group.userData.axis];
  const ray = pointerRay(e).ray;
  if (group.userData.tool === 'move') {
    gesture = {
      kind: 'move', pid: e.pointerId, x: e.clientX, y: e.clientY, moved: false,
      origin, dir, startParam: axisParam(ray, origin, dir), snaps: snapshot(parts),
      before: capturePoses(parts), hist: 'pose', handle: group,
    };
  } else {
    if (!planePoint(ray, origin, dir, _hit)) return;
    const startVec = _hit.clone().sub(origin);
    startVec.addScaledVector(dir, -startVec.dot(dir));
    if (startVec.lengthSq() < 1e-6) return;
    gesture = {
      kind: 'rotate', pid: e.pointerId, x: e.clientX, y: e.clientY, moved: false,
      origin, dir, startVec, snaps: snapshot(parts),
      before: capturePartSnaps(parts), hist: 'geom', handle: group,
    };
  }
  setHover(group);
}

function endGesture() {
  const g = gesture;
  gesture = null;
  setHover(null);
  if (!g) return;
  if (state.mode === 'orbit') canvas.style.cursor = 'default';
  if (g.kind === 'scale') {
    if (!g.moved && !g.baked) {
      releaseSnaps(g.before);
      return;
    }
    finishPartScale(g.snaps[0].part);
    if (g.moved) {
      const p = g.snaps[0].part;
      log(`模型已缩放：X ${p.size.x.toFixed(1)} × Y ${p.size.z.toFixed(1)} × Z ${p.size.y.toFixed(1)} mm`, 'ok');
    }
    commitPartEdit(!g.moved && !!g.baked);
    syncSelectionBoxes();
    syncScalePanel();
    commitGeomHistory(g.moved ? '缩放模型' : '旋转模型', g.before);
    return;
  }
  if (!g.moved) {
    if (g.hist === 'geom') releaseSnaps(g.before);
    return;
  }
  commitPartEdit(g.kind === 'rotate');
  syncSelectionBoxes();
  if (g.kind === 'rotate') commitGeomHistory('旋转模型', g.before);
  else commitPoseHistory('移动模型', g.before);
}

const SCALE_SVG = {
  reset: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  world: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.8 2.5 15.2 0 18M12 3c-2.5 2.8-2.5 15.2 0 18"/></svg>',
  object: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.1 0l1.4-1.4a5 5 0 0 0-7.1-7.1L10 5"/><path d="M14 11a5 5 0 0 0-7.1 0L5.5 12.4a5 5 0 0 0 7.1 7.1L14 19"/></svg>',
  unlink: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 15l6-6"/><path d="M10.5 13.5l-1.8 1.8a4 4 0 0 1-5.7-5.7l1.8-1.8"/><path d="M13.5 10.5l1.8-1.8a4 4 0 0 1 5.7 5.7l-1.8 1.8"/></svg>',
  drag: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>',
};

function sliceBorn(part) {
  const b = part.born || part.size;
  return { x: b.x, y: b.z, z: b.y };
}

function sliceLive(part) {
  return { x: part.size.x, y: part.size.z, z: part.size.y };
}

function logScale(part, prefix) {
  log(`${prefix}：X ${part.size.x.toFixed(1)} × Y ${part.size.z.toFixed(1)} × Z ${part.size.y.toFixed(1)} mm`, 'ok');
}

function applyScaleInput(axis, kind, raw) {
  const part = scalePartNow();
  if (!part) return;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) { syncScalePanel(); return; }
  const before = part.size.x + part.size.y + part.size.z;
  const born = sliceBorn(part);
  const mm = kind === 'pct' ? born[axis] * n / 100 : n;
  scalePartAxis(part, axis, mm, scaleUniform, scaleSpace);
  syncScalePanel();
  if (Math.abs(part.size.x + part.size.y + part.size.z - before) > 1e-3) logScale(part, '模型已缩放');
}

function placeScalePanel() {
  if (!scaleEl || !canvas || !canvas.parentElement) return;
  const host = canvas.parentElement;
  const bar = host.querySelector('.modeBar, .mode-bar');
  let top = 12;
  if (bar) {
    const hr = host.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    top = Math.max(12, br.bottom - hr.top + 8);
  }
  scaleEl.style.top = `${Math.round(top)}px`;
  scaleEl.style.maxHeight = `calc(100% - ${Math.round(top + 148)}px)`;
}

function syncScalePanel() {
  if (!scaleEl) return;
  const part = scalePartNow();
  scaleEl.hidden = !part;
  if (!part) return;
  placeScalePanel();
  scaleEl.dataset.space = scaleSpace;
  const spaceBtn = scaleEl.querySelector('[data-act="space"]');
  spaceBtn.innerHTML = scaleSpace === 'object' ? SCALE_SVG.object : SCALE_SVG.world;
  spaceBtn.title = scaleSpace === 'object'
    ? '切换模型坐标系或世界坐标系。当前是模型坐标系'
    : '切换模型坐标系或世界坐标系。当前是世界坐标系';
  const link = scaleEl.querySelector('[data-act="link"]');
  link.setAttribute('aria-pressed', scaleUniform ? 'true' : 'false');
  link.innerHTML = scaleUniform ? SCALE_SVG.link : SCALE_SVG.unlink;
  link.title = scaleUniform ? '已锁定，三轴同一比例。点击后可单独改 XYZ' : '未锁定，可单独改 XYZ。点击后三轴同一比例';
  const drag = scaleEl.querySelector('[data-act="drag"]');
  drag.setAttribute('aria-pressed', scaleDrag ? 'true' : 'false');
  const live = sliceLive(part);
  const born = sliceBorn(part);
  for (const axis of ['x', 'y', 'z']) {
    const row = scaleEl.querySelector(`[data-axis="${axis}"]`);
    const mm = row.querySelector('input[data-kind="mm"]');
    const pct = row.querySelector('input[data-kind="pct"]');
    if (document.activeElement !== mm) mm.value = live[axis].toFixed(2);
    if (document.activeElement !== pct) pct.value = (live[axis] / Math.max(born[axis], 1e-6) * 100).toFixed(2);
  }
}

function scaleSpinHtml(kind) {
  const label = kind === 'mm' ? '大小' : '比率';
  return `<input data-kind="${kind}" inputmode="decimal" autocomplete="off" aria-label="${label}">
    <span class="scaleSteps">
      <button type="button" data-kind="${kind}" data-step="1" aria-label="增大${label}">▴</button>
      <button type="button" data-kind="${kind}" data-step="-1" aria-label="减小${label}">▾</button>
    </span>`;
}

function ensureScalePanel() {
  if (scaleEl) return scaleEl;
  const host = canvas.parentElement || document.body;
  scaleEl = document.createElement('div');
  scaleEl.className = 'scalePanel';
  scaleEl.hidden = true;
  scaleEl.setAttribute('role', 'dialog');
  scaleEl.setAttribute('aria-label', '缩放');
  scaleEl.addEventListener('pointerdown', ev => ev.stopPropagation());
  scaleEl.addEventListener('contextmenu', ev => ev.preventDefault());
  scaleEl.innerHTML = `
    <div class="scaleHead">
      <b>缩放</b>
      <span class="scaleIconBtns">
        <button type="button" class="scaleIcon" data-act="space" title="切换模型坐标系或世界坐标系"></button>
        <button type="button" class="scaleIcon" data-act="reset" title="还原模型的原始大小">${SCALE_SVG.reset}</button>
      </span>
    </div>
    <div class="scaleCols">
      <span></span>
      <span>大小 (mm)</span>
      <span>比率 (%)</span>
      <button type="button" class="scaleLink" data-act="link" aria-pressed="true"></button>
    </div>`;
  const colors = { x: '#e25b5b', y: '#3dbe74', z: '#4c8dff' };
  for (const axis of ['x', 'y', 'z']) {
    const row = document.createElement('div');
    row.className = 'scaleRow';
    row.dataset.axis = axis;
    row.innerHTML = `
      <span class="scaleAxis"><i style="background:${colors[axis]}"></i>${axis.toUpperCase()}</span>
      <span class="scaleSpin">${scaleSpinHtml('mm')}</span>
      <span class="scaleSpin">${scaleSpinHtml('pct')}</span>
      <span></span>`;
    scaleEl.appendChild(row);
  }
  const fit = document.createElement('button');
  fit.type = 'button';
  fit.className = 'scaleAction';
  fit.dataset.act = 'fit';
  fit.textContent = '缩放以适应';
  const drag = document.createElement('button');
  drag.type = 'button';
  drag.className = 'scaleAction';
  drag.dataset.act = 'drag';
  drag.innerHTML = `${SCALE_SVG.drag}<span>拖拽缩放</span>`;
  scaleEl.append(fit, drag);
  host.appendChild(scaleEl);

  scaleEl.querySelector('[data-act="space"]').addEventListener('click', () => {
    scaleSpace = scaleSpace === 'world' ? 'object' : 'world';
    placeGizmo();
    syncScalePanel();
  });
  scaleEl.querySelector('[data-act="reset"]').addEventListener('click', () => {
    const part = scalePartNow();
    if (!part) return;
    resetPartScale(part, scaleSpace);
    syncScalePanel();
    logScale(part, '已还原模型的原始大小');
  });
  scaleEl.querySelector('[data-act="link"]').addEventListener('click', () => {
    scaleUniform = !scaleUniform;
    syncScalePanel();
  });
  fit.addEventListener('click', () => {
    const part = scalePartNow();
    if (!part) return;
    scalePartToFit(part);
    syncScalePanel();
    logScale(part, '已缩放到适合当前机型');
  });
  drag.addEventListener('click', () => {
    scaleDrag = !scaleDrag;
    placeGizmo();
    syncScalePanel();
  });
  for (const input of scaleEl.querySelectorAll('input')) {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') input.blur(); });
    input.addEventListener('change', () => {
      const row = input.closest('[data-axis]');
      applyScaleInput(row.dataset.axis, input.dataset.kind, input.value);
    });
  }
  for (const btn of scaleEl.querySelectorAll('.scaleSteps button')) {
    btn.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); });
    btn.addEventListener('click', () => {
      const part = scalePartNow();
      const row = btn.closest('[data-axis]');
      if (!part || !row) return;
      const axis = row.dataset.axis;
      const kind = btn.dataset.kind;
      const live = sliceLive(part);
      const born = sliceBorn(part);
      const cur = kind === 'pct' ? live[axis] / Math.max(born[axis], 1e-6) * 100 : live[axis];
      applyScaleInput(axis, kind, cur + Number(btn.dataset.step));
    });
  }
  return scaleEl;
}

function hideMenu() {
  if (menuEl) menuEl.hidden = true;
}

function ensureMenu() {
  if (menuEl) return menuEl;
  menuEl = document.createElement('div');
  menuEl.className = 'partMenu';
  menuEl.hidden = true;
  menuEl.setAttribute('role', 'menu');
  menuEl.addEventListener('contextmenu', ev => ev.preventDefault());
  menuEl.addEventListener('pointerdown', ev => ev.stopPropagation());
  const items = [
    ['move', '模型移动', '沿坐标轴'],
    ['rotate', '模型旋转', '拖动圆环'],
    ['scale', '放大缩小', '尺寸与比例'],
  ];
  for (const [tool, title, hint] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'partMenuItem';
    b.dataset.tool = tool;
    b.setAttribute('role', 'menuitem');
    const s = document.createElement('span');
    s.textContent = title;
    const h = document.createElement('small');
    h.textContent = hint;
    b.append(s, h);
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      chooseTool(tool);
    });
    menuEl.appendChild(b);
  }
  document.body.appendChild(menuEl);
  return menuEl;
}

function showMenu(x, y) {
  if ((state.selectedIds || []).length !== 1) return;
  const el = ensureMenu();
  for (const b of el.querySelectorAll('button')) {
    if (b.dataset.tool === state.transformTool) b.dataset.active = '1';
    else b.removeAttribute('data-active');
  }
  el.hidden = false;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  const r = el.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) el.style.left = `${Math.max(8, x - r.width)}px`;
  if (r.bottom > window.innerHeight - 8) el.style.top = `${Math.max(8, y - r.height)}px`;
}

function chooseTool(tool) {
  hideMenu();
  if ((state.selectedIds || []).length !== 1) return;
  if (state.mode !== 'orbit') setMode('orbit');
  if (tool !== 'move' && tool !== 'rotate' && tool !== 'scale') return;
  if (tool === 'scale') scaleDrag = true;
  state.transformTool = tool;
  const tip = {
    move: '拖动坐标轴移动模型',
    rotate: '拖动圆环绕坐标轴旋转',
  }[tool];
  if (tip) toast(tip);
  bus.emit('selection', { ids: state.selectedIds.slice(), tool });
}

function typingTarget() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function dialogOpen() {
  return !!document.querySelector('dialog[open], [role="dialog"][data-state="open"]');
}

function onKeyDown(e) {
  const meta = e.ctrlKey || e.metaKey;
  if (meta && !e.altKey && !typingTarget()) {
    const k = (e.key || '').toLowerCase();
    if (!e.shiftKey && (k === 'a' || e.code === 'KeyA')) {
      e.preventDefault();
      if (state.parts.length) setSelection(state.parts.map(p => p.id));
      return;
    }
    // 输入框里不进来，文字自己的撤回还在。命令面板开着时也不改模型。
    const undoKey = !e.shiftKey && k === 'z';
    const redoKey = (e.shiftKey && k === 'z') || (!e.shiftKey && k === 'y');
    if (!dialogOpen() && !e.repeat && (undoKey || redoKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (marquee) cancelMarquee();
      if (gesture) endGesture();
      hideMenu();
      if (undoKey) undo();
      else redo();
      return;
    }
  }
  if (e.key === 'Escape') {
    if (marquee) { cancelMarquee(); return; }
    if (menuEl && !menuEl.hidden) { hideMenu(); return; }
    if (scaleEl && !scaleEl.hidden && scaleEl.contains(document.activeElement)) {
      document.activeElement.blur();
      return;
    }
    if (state.transformTool) {
      state.transformTool = null;
      bus.emit('selection', { ids: (state.selectedIds || []).slice(), tool: null });
      return;
    }
    if ((state.selectedIds || []).length) setSelection([]);
    return;
  }
  // Delete：删掉视口里选中的模型。输入框里打字时不抢，避免把字删掉却把模型也删了。
  if (e.key !== 'Delete' && e.code !== 'Delete') return;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typingTarget()) return;
  if (document.querySelector('dialog[open], [role="dialog"][data-state="open"]')) return;
  const ids = (state.selectedIds || []).slice();
  if (!ids.length) return;
  e.preventDefault();
  if (marquee) cancelMarquee();
  if (gesture) endGesture();
  hideMenu();
  removeParts(ids);
}

/* 框选矩形。拖开超过几像素才显示，免得单击被当成一次空框。 */
function ensureMarquee() {
  if (marqueeEl) return marqueeEl;
  marqueeEl = document.createElement('div');
  marqueeEl.className = 'partMarquee';
  marqueeEl.hidden = true;
  marqueeEl.setAttribute('aria-hidden', 'true');
  Object.assign(marqueeEl.style, {
    position: 'fixed',
    zIndex: '80',
    pointerEvents: 'none',
    boxSizing: 'border-box',
    border: '1px solid #3d8bfd',
    background: 'rgba(61, 139, 253, 0.16)',
  });
  document.body.appendChild(marqueeEl);
  return marqueeEl;
}

function layoutMarquee(x0, y0, x1, y1) {
  const el = ensureMarquee();
  el.hidden = false;
  el.style.left = `${Math.min(x0, x1)}px`;
  el.style.top = `${Math.min(y0, y1)}px`;
  el.style.width = `${Math.abs(x1 - x0)}px`;
  el.style.height = `${Math.abs(y1 - y0)}px`;
}

function hideMarquee() {
  if (marqueeEl) marqueeEl.hidden = true;
}

function cancelMarquee() {
  marquee = null;
  hideMarquee();
  if (canvas && state.mode === 'orbit') canvas.style.cursor = 'default';
}

/* 包围盒八个角投到屏幕上，和框相交就算选中。相机背后的角丢掉，避免投影翻到对面。 */
function partsInRect(x0, y0, x1, y1) {
  const box = {
    minX: Math.min(x0, x1), minY: Math.min(y0, y1),
    maxX: Math.max(x0, x1), maxY: Math.max(y0, y1),
  };
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return [];
  const lift = raiseH();
  camera.updateMatrixWorld();
  const inv = camera.matrixWorldInverse;
  const ids = [];
  for (const p of state.parts) {
    const b = partBounds(p);
    const xs = [b.min.x, b.max.x];
    const ys = [b.min.y + lift, b.max.y + lift];
    const zs = [b.min.z, b.max.z];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let n = 0;
    for (const x of xs) {
      for (const y of ys) {
        for (const z of zs) {
          _tmp.set(x, y, z).applyMatrix4(inv);
          if (_tmp.z >= -0.01) continue;
          _tmp.set(x, y, z).project(camera);
          const sx = (_tmp.x * 0.5 + 0.5) * rect.width + rect.left;
          const sy = (-_tmp.y * 0.5 + 0.5) * rect.height + rect.top;
          n++;
          if (sx < minX) minX = sx;
          if (sy < minY) minY = sy;
          if (sx > maxX) maxX = sx;
          if (sy > maxY) maxY = sy;
        }
      }
    }
    if (!n) continue;
    if (minX <= box.maxX && maxX >= box.minX && minY <= box.maxY && maxY >= box.minY) ids.push(p.id);
  }
  return ids;
}

function finishMarquee(e) {
  const m = marquee;
  marquee = null;
  hideMarquee();
  if (!m) return;
  if (state.mode === 'orbit') canvas.style.cursor = 'default';
  if (!m.active) {
    const picked = pickModel(e, true);
    if (picked) {
      const id = picked.part.id;
      if (m.additive) {
        const ids = (state.selectedIds || []).slice();
        const at = ids.indexOf(id);
        if (at >= 0) ids.splice(at, 1);
        else ids.push(id);
        setSelection(ids);
      } else setSelection([id]);
    } else if (!m.additive && e.target === canvas) setSelection([]);
    return;
  }
  const hit = partsInRect(m.x, m.y, e.clientX, e.clientY);
  if (m.additive) {
    const ids = m.base.slice();
    for (const id of hit) if (!ids.includes(id)) ids.push(id);
    setSelection(ids);
  } else setSelection(hit);
}

function onPointerDown(e) {
  if (e.button === 2) {
    if (e.target !== canvas) return;
    rightArm = { x: e.clientX, y: e.clientY, pid: e.pointerId };
    return;
  }
  if (e.button !== 0 || e.target !== canvas) return;
  hideMenu();
  if (state.mode !== 'orbit') return;
  const gHit = pickGizmo(e);
  if (gHit) {
    e.stopPropagation();
    e.preventDefault();
    beginGizmo(gHit, e);
    return;
  }
  // 按在已经选中的模型上：沿板面移动，不画框选。空白处或未选中的模型上拖动才框选。
  const picked = pickModel(e, true);
  const ids = state.selectedIds || [];
  if (picked && ids.includes(picked.part.id)) {
    e.stopPropagation();
    e.preventDefault();
    beginFree(picked, e);
    setHover(null);
    canvas.style.cursor = 'move';
    return;
  }
  e.stopPropagation();
  e.preventDefault();
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;
  marquee = {
    x: e.clientX,
    y: e.clientY,
    pid: e.pointerId,
    additive,
    base: additive ? ids.slice() : [],
    active: false,
  };
}

function onPointerMove(e) {
  if (rightArm && e.pointerId === rightArm.pid) {
    if (Math.hypot(e.clientX - rightArm.x, e.clientY - rightArm.y) > 6) hideMenu();
  }
  if (marquee && e.pointerId === marquee.pid) {
    if (!marquee.active && Math.hypot(e.clientX - marquee.x, e.clientY - marquee.y) < 5) return;
    marquee.active = true;
    layoutMarquee(marquee.x, marquee.y, e.clientX, e.clientY);
    canvas.style.cursor = 'crosshair';
    return;
  }
  if (gesture && e.pointerId === gesture.pid) {
    if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) < 4 && !gesture.moved) return;
    applyGesture(e);
    return;
  }
  if (gesture || marquee || state.mode !== 'orbit' || e.target !== canvas) return;
  // 按住中键平移、右键旋转时不再对整模求交，否则几百万面每帧都卡
  if (e.buttons !== 0) return;
  const gHit = pickGizmo(e);
  setHover(gHit);
  const under = gHit ? null : pickModel(e, false);
  if (gHit) canvas.style.cursor = 'grab';
  else if (under && (state.selectedIds || []).includes(under.part.id)) canvas.style.cursor = 'move';
  else if (under) canvas.style.cursor = 'pointer';
  else canvas.style.cursor = 'default';
}

function onPointerUp(e) {
  if (e.button === 2 && rightArm && e.pointerId === rightArm.pid) {
    const arm = rightArm;
    rightArm = null;
    const moved = Math.hypot(e.clientX - arm.x, e.clientY - arm.y) > 6;
    if (!moved && e.target === canvas) {
      const picked = pickModel(e, true);
      if (!picked) { hideMenu(); return; }
      const ids = state.selectedIds || [];
      // 点在已选中的模型上时保留整组；多选不弹菜单。点在未选中的模型上则只选它。
      if (!ids.includes(picked.part.id)) setSelection([picked.part.id]);
      if ((state.selectedIds || []).length === 1) showMenu(e.clientX, e.clientY);
      else hideMenu();
    }
    return;
  }
  if (e.button !== 0) return;
  if (gesture && e.pointerId === gesture.pid) endGesture();
  if (marquee && e.pointerId === marquee.pid) finishMarquee(e);
}

export function tickManipulate() {
  if (!gizmo) return;
  placeGizmo();
  syncScaleCage();
  if (raised != null && raised !== raiseH()) syncSelectionBoxes();
}

export function initManipulate(canvasEl) {
  if (canvas) return;
  canvas = canvasEl;
  buildGizmo();
  ensureMenu();
  ensureScalePanel();
  canvas.addEventListener('selectstart', e => e.preventDefault());
  canvas.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', () => {
    if (gesture) endGesture();
    if (marquee) cancelMarquee();
  });
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('selectstart', e => { if (gesture || marquee) e.preventDefault(); }, true);
  window.addEventListener('pointerdown', e => {
    if (!menuEl || menuEl.hidden || menuEl.contains(e.target)) return;
    if (e.button === 2 && e.target === canvas) return;
    hideMenu();
  }, true);
  window.addEventListener('blur', () => {
    if (gesture) endGesture();
    if (marquee) cancelMarquee();
  });
  window.addEventListener('resize', () => { if (scaleEl && !scaleEl.hidden) placeScalePanel(); });
  bus.on('modelInfo', () => { syncSelectionBoxes(); syncScalePanel(); });
  bus.on('selection', () => { hideMenu(); syncSelectionBoxes(); syncScalePanel(); });
}
