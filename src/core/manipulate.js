/* ================================================================
   视口里选中并摆放模型。
   - 单击选中一个模型。已经选中的模型上按住左键拖动，是在板面上移动（多选一起动）
   - 移动 / 旋转 / 缩放工具作用于当前全部选中：同一位移、绕整组中心转、从整组中心按同一比例缩放
   - 从空白处或未选中的模型上按住左键拖动，出现框线，松开后选中框到的模型
   - Ctrl/⌘ 再点是加减选中，再框是追加；Ctrl/⌘ A 全选，不选中网页文字
   - Delete 删除当前选中的模型。Ctrl/⌘ Z 撤回，Ctrl/⌘ Shift Z 或 Ctrl/⌘ Y 重做
   - M 开启移动，R 开启旋转，S 开启缩放。再按一次同一个键关掉。输入框里打字时不抢
   - 中键拖动平移视角，右键拖动旋转视角；右键点在单个模型上（没有拖开）弹出菜单
   - 菜单：沿坐标轴移动 / 拖圆环旋转 / 放大缩小
   - 放大缩小打开面板：毫米和百分比、锁定等比、还原、适应机型。选中多件时面板仍在，数值作用在全部选中上。拖拽时三色方块沿轴拉，每件各画一个包围盒
   - 切片 Z 是高度：沿 Z 下移或旋转扫进平台时，底面停在 Z = 0，不能为负
   - 缩放烤进局部顶点。切片 X = 局部 x，切片 Y = 局部 z，切片 Z（高度）= 局部 y，从底面向上长
   涂保护面、加支撑、删支撑仍占用左键，这里不抢。
================================================================ */
import * as THREE from 'three';
import { state, params, bus, log, toast } from '../store.js';
import { scene, camera, pointerRay, setMode } from './scene.js';
import {
  raiseH, localFaceOf, setSelection, syncPlateMesh, commitPartEdit, removeParts, previewPartPose, meshPick, scheduleMeshBVH,
  partBounds, clampPartsToPrintZ, seatPartsOnPlate, bakePartRotation, applyPartScale, finishPartScale, discardStaleWork, uniformScaleFactor,
  scalePartTo, scalePartToFit,
  capturePoses, capturePartSnaps, restorePartSnap, releaseSnaps, commitPoseHistory, commitGeomHistory,
} from './model.js';
import { undo, redo, pushHistory } from './history.js';
import { clearSupports, updateSupStats } from './support.js';
import { hideInspector } from './inspect.js';

/* 切片软件坐标：X / Y 在板面上，Z 向上。场景本身是 Y 朝上，所以切片 Y = 世界 +Z，切片 Z = 世界 +Y。 */
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const AXIS = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 0, 1),
  z: new THREE.Vector3(0, 1, 0),
};
const AXIS_COLOR = { x: 0xe55353, y: 0x10b890, z: 0x3760ea };
const EYE_COLOR = 0x9aa3b2;

let canvas = null;
let gizmo = null;
let moveRoot = null;
let rotRoot = null;
let eyeRoot = null;
let scaleRoot = null;
let scaleCage = null;
let selGroup = null;
let menuEl = null;
let scaleEl = null;
let rotEl = null;
let rotBasis = null;
let rotEuler = { x: 0, y: 0, z: 0 };
let rotKey = '';
let rotHold = false;
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
const _inv = new THREE.Matrix4();
const _local = new THREE.Vector3();
const _axisZ = new THREE.Vector3(0, 0, 1);

function ghostMat() {
  return new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0, depthWrite: false, depthTest: false,
  });
}

/* 手柄画在模型上面。只关深度测试还留在不透明队列里，后画的模型表面仍会盖住它。 */
function solidMat(hex) {
  return new THREE.MeshBasicMaterial({
    color: hex, depthTest: false, depthWrite: false, transparent: true, opacity: 1,
    fog: false, toneMapped: false,
  });
}

function tag(obj, tool, axis, mat) {
  obj.userData.tool = tool;
  obj.userData.axis = axis;
  obj.userData.mat = mat;
  obj.userData.base = mat.color.getHex();
  obj.traverse(o => { o.renderOrder = 30; });
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

/* 整圆躺在局部 XY（法线 +Z），三根轴都画全，避免半圆看起来被切掉。 */
function makeRing(axis) {
  const color = AXIS_COLOR[axis];
  const mat = solidMat(color);
  const g = new THREE.Group();
  const spin = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(16, 0.55, 8, 72), mat);
  // 拾取管不要伸到外面那圈灰环上，否则点灰环会先碰到彩圈
  const pick = new THREE.Mesh(new THREE.TorusGeometry(16, 1.05, 6, 32), ghostMat());
  spin.add(ring, pick);
  g.add(spin);
  if (axis === 'x') g.rotation.y = Math.PI / 2;            // 法线 → 世界 +X，切片 X
  else if (axis === 'z') g.rotation.x = -Math.PI / 2;      // 法线 → 世界 +Y，切片 Z（高度）
  g.userData.spin = spin;
  return tag(g, 'rotate', axis, mat);
}

/* 屏幕上的整圈，拖它绕视线转。局部圆环法线 +Z，摆放时对向相机。 */
function makeEyeRing() {
  const mat = solidMat(EYE_COLOR);
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(18.2, 0.38, 8, 80), mat);
  const pick = new THREE.Mesh(new THREE.TorusGeometry(18.2, 0.7, 6, 40), ghostMat());
  g.add(ring, pick);
  eyeRoot = tag(g, 'rotate', 'e', mat);
  ring.renderOrder = 32;
  return eyeRoot;
}

function aimRotateRings() {
  if (!rotRoot) return;
  for (const g of rotRoot.children) {
    const spin = g.userData.spin;
    if (!spin) continue;
    g.updateWorldMatrix(true, false);
    _inv.copy(g.matrixWorld).invert();
    _local.copy(camera.position).applyMatrix4(_inv);
    if (_local.x * _local.x + _local.y * _local.y < 1e-8) continue;
    spin.rotation.z = Math.atan2(-_local.x, _local.y);
  }
  if (!eyeRoot) return;
  _local.copy(camera.position).sub(gizmo.position);
  if (_local.lengthSq() < 1e-8) return;
  _quat.setFromUnitVectors(_axisZ, _local.normalize());
  eyeRoot.quaternion.copy(gizmo.quaternion).invert().multiply(_quat);
}

/* 方块在轴的两端。局部 +Y 再转到切片轴上，与移动箭头同一套旋转。 */
function orientAxisGroup(g, axis) {
  if (axis === 'x') g.rotation.z = -Math.PI / 2;       // 局部 +Y → 世界 +X，切片 X
  else if (axis === 'y') g.rotation.x = Math.PI / 2;  // 局部 +Y → 世界 +Z，切片 Y
}

function makeScaleStem(axis, color) {
  const g = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, -16, 0, 0, 16, 0], 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
    color, depthTest: false, depthWrite: false, transparent: true, opacity: 1, fog: false, toneMapped: false,
  }));
  line.raycast = () => {};
  line.renderOrder = 29;
  g.add(line);
  orientAxisGroup(g, axis);
  return g;
}

function makeScaleEnd(axis, sign, mat) {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(2.05, 2.05, 2.05), mat);
  const pick = new THREE.Mesh(new THREE.BoxGeometry(4.2, 4.2, 4.2), ghostMat());
  box.position.y = 16 * sign;
  pick.position.y = 16 * sign;
  g.add(box, pick);
  orientAxisGroup(g, axis);
  const tagged = tag(g, 'scale', axis, mat);
  tagged.userData.sign = sign;
  return tagged;
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
    const mat = solidMat(AXIS_COLOR[axis]);
    scaleRoot.add(makeScaleStem(axis, AXIS_COLOR[axis]));
    scaleRoot.add(makeScaleEnd(axis, 1, mat));
    scaleRoot.add(makeScaleEnd(axis, -1, mat));
  }
  rotRoot.add(makeEyeRing());
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

/* 缩放工具开着时，当前选中的全部模型。面板和包围盒都跟着这份名单。 */
function scalePartsNow() {
  if (!scalingTool()) return [];
  const out = [];
  for (const id of state.selectedIds || []) {
    const p = state.parts.find(x => x.id === id);
    if (p) out.push(p);
  }
  return out;
}

/* 选中件的包围盒中心。一件时就是它自己的枢轴，多件时手柄落在整组中间。 */
function selectionPivot(parts, out) {
  if (!parts.length) return out.set(0, raiseH(), 0);
  if (parts.length === 1) return pivotOf(parts[0], out);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const lift = raiseH();
  for (const p of parts) {
    const b = partBounds(p);
    if (b.min.x < minX) minX = b.min.x;
    if (b.max.x > maxX) maxX = b.max.x;
    const y0 = b.min.y + lift, y1 = b.max.y + lift;
    if (y0 < minY) minY = y0;
    if (y1 > maxY) maxY = y1;
    if (b.min.z < minZ) minZ = b.min.z;
    if (b.max.z > maxZ) maxZ = b.max.z;
  }
  return out.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
}

function selectionHalf(parts) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of parts) {
    const b = partBounds(p);
    if (b.min.x < minX) minX = b.min.x;
    if (b.max.x > maxX) maxX = b.max.x;
    if (b.min.y < minY) minY = b.min.y;
    if (b.max.y > maxY) maxY = b.max.y;
    if (b.min.z < minZ) minZ = b.min.z;
    if (b.max.z > maxZ) maxZ = b.max.z;
  }
  return Math.max((maxX - minX) / 2, (maxY - minY) / 2, (maxZ - minZ) / 2, 0.5);
}

function pxScale(at) {
  const dist = Math.max(1, camera.position.distanceTo(at));
  const h = Math.max(1, canvas.clientHeight || 1);
  return 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * dist / h;
}

/* 枢轴到包围盒最远角的距离。缩放轴用它，跟模型保持同一比例。 */
function gizmoModelRadius(part) {
  const b = partBounds(part);
  const lift = raiseH();
  const px = part.ox;
  const py = lift + (part.oy || 0) + part.base.y / 2;
  const pz = part.oz;
  let r = 0;
  for (const x of [b.min.x, b.max.x]) {
    for (const y of [b.min.y + lift, b.max.y + lift]) {
      for (const z of [b.min.z, b.max.z]) {
        const d = Math.hypot(x - px, y - py, z - pz);
        if (d > r) r = d;
      }
    }
  }
  return Math.max(r, 0.5);
}

/* 旋转圈的世界半径。直径约为模型最长边的 0.62。
   默认取景时整圈落在顶栏和底栏之间，不会被挡住；拉远视角时和模型一起变小。
   用面对角或三维最远角会比模型大一截，圈伸出窗口。 */
function gizmoRotateRadius(part) {
  const b = partBounds(part);
  const hx = (b.max.x - b.min.x) / 2;
  const hy = (b.max.y - b.min.y) / 2;
  const hz = (b.max.z - b.min.z) / 2;
  return Math.max(Math.max(hx, hy, hz) * 0.62, 0.5);
}

function placeGizmo() {
  if (!gizmo) return;
  const parts = state.transformTool ? liveSelected() : [];
  const single = parts.length === 1 ? parts[0] : null;
  moveRoot.visible = parts.length > 0 && state.transformTool === 'move';
  rotRoot.visible = parts.length > 0 && state.transformTool === 'rotate';
  scaleRoot.visible = parts.length > 0 && state.transformTool === 'scale' && scaleDrag;
  gizmo.visible = moveRoot.visible || rotRoot.visible || scaleRoot.visible;
  // 一件且是模型坐标系时，缩放手柄跟着它转。多件各有各的朝向，用世界轴。
  if (single && state.transformTool === 'scale' && scaleSpace === 'object') gizmo.quaternion.copy(single.q);
  else gizmo.quaternion.identity();
  if (!parts.length || !gizmo.visible) return;
  if (gesture && gesture.origin && gesture.kind !== 'move') gizmo.position.copy(gesture.origin);
  else selectionPivot(parts, gizmo.position);
  gizmo.scale.set(1, 1, 1);
  // 移动箭头保持屏幕上约 120px。旋转圈按整组最长边。缩放轴按整组对角。
  moveRoot.scale.setScalar((120 * pxScale(gizmo.position)) / 18);
  const radius = single ? gizmoModelRadius(single) : selectionHalf(parts) * Math.SQRT2;
  const rotR = single ? gizmoRotateRadius(single) : selectionHalf(parts) * 0.62;
  rotRoot.scale.setScalar(rotR / 16);
  scaleRoot.scale.setScalar((radius * 1.08) / 16);
  gizmo.updateMatrixWorld(true);
  if (rotRoot.visible) aimRotateRings();
}

/* 缩放时画完整线框，深色视口用浅色，浅色视口用深色。 */
function pushBoxEdges(b, lift, out) {
  const x0 = b.min.x, y0 = b.min.y + lift, z0 = b.min.z;
  const x1 = b.max.x, y1 = b.max.y + lift, z1 = b.max.z;
  out.push(
    x0, y0, z0, x1, y0, z0, x1, y0, z0, x1, y0, z1, x1, y0, z1, x0, y0, z1, x0, y0, z1, x0, y0, z0,
    x0, y1, z0, x1, y1, z0, x1, y1, z0, x1, y1, z1, x1, y1, z1, x0, y1, z1, x0, y1, z1, x0, y1, z0,
    x0, y0, z0, x0, y1, z0, x1, y0, z0, x1, y1, z0, x1, y0, z1, x1, y1, z1, x0, y0, z1, x0, y1, z1,
  );
}

function syncScaleCage() {
  if (!scaleCage) return;
  const parts = scalePartsNow();
  scaleCage.visible = parts.length > 0;
  if (!parts.length) return;
  const lift = raiseH();
  const edges = [];
  for (const part of parts) pushBoxEdges(partBounds(part), lift, edges);
  const attr = scaleCage.geometry.attributes.position;
  if (attr.array.length < edges.length) {
    scaleCage.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edges.length), 3));
  }
  const pos = scaleCage.geometry.attributes.position;
  pos.array.set(edges);
  pos.needsUpdate = true;
  scaleCage.geometry.setDrawRange(0, edges.length / 3);
  scaleCage.geometry.computeBoundingSphere();
  const bg = scene.background;
  const lum = bg && bg.isColor ? bg.r * 0.2126 + bg.g * 0.7152 + bg.b * 0.0722 : 0;
  scaleCage.material.color.setHex(lum > 0.55 ? 0x314056 : 0xb7c9de);
}

function syncSelectionBoxes() {
  if (!selGroup) return;
  while (selGroup.children.length) {
    const c = selGroup.children.pop();
    c.geometry.dispose();
    c.material.dispose();
  }
  const lift = raiseH();
  // 缩放时改画线框，不再叠一条蓝色选中框
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
    const lift = raiseH();
    for (const s of g.snaps) {
      const cy = lift + s.oy + s.part.base.y / 2;
      _local.set(s.ox - g.origin.x, cy - g.origin.y, s.oz - g.origin.z);
      _local.applyQuaternion(_quat);
      s.part.ox = g.origin.x + _local.x;
      s.part.oz = g.origin.z + _local.z;
      s.part.oy = g.origin.y + _local.y - lift - s.part.base.y / 2;
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

function placeScaled(it, origin, fx, fy, fz) {
  const lift = raiseH();
  const oldCy = lift + it.oy + it.base.y / 2;
  it.part.ox = origin.x + (it.ox - origin.x) * fx;
  it.part.oz = origin.z + (it.oz - origin.z) * fz;
  const cy = origin.y + (oldCy - origin.y) * fy;
  it.part.oy = cy - lift - it.part.base.y / 2;
}

function applyScaleGesture(g, e, ray) {
  writeFromSnapshot(g.snaps);
  const factor = scaleFactor(g, ray);
  let any = false;
  let maxDelta = 0;
  for (const it of g.items) {
    let f = factor;
    let fx = 1;
    let fy = 1;
    let fz = 1;
    if (g.uniform) {
      f = uniformScaleFactor(f, it.base);
      fx = fy = fz = f;
    } else if (g.axis === 'x') fx = f;
    else if (g.axis === 'y') fz = f;   // 切片 Y = 局部 z
    else if (g.axis === 'z') fy = f;   // 切片 Z = 局部 y，从底面乘
    const applied = applyPartScale(it.part, fx, fy, fz, it.src, it.base, it.srcSource);
    if (!applied) continue;
    any = true;
    placeScaled(it, g.origin, applied.fx, applied.fy, applied.fz);
    g.fx = applied.fx;
    g.fy = applied.fy;
    g.fz = applied.fz;
    maxDelta = Math.max(maxDelta, Math.abs(applied.fx - 1), Math.abs(applied.fy - 1), Math.abs(applied.fz - 1));
  }
  if (!any) return;
  if (maxDelta <= 0.002 && !g.moved) {
    for (const it of g.items) applyPartScale(it.part, 1, 1, 1, it.src, it.base, it.srcSource);
    writeFromSnapshot(g.snaps);
    return;
  }
  if (!g.moved) {
    g.moved = true;
    discardStaleWork('模型尺寸已变，分析结果与支撑已清除，请重新分析');
  }
  clampPartsToPrintZ(g.items.map(it => it.part));
  syncPlateMesh({ faces: false });
  syncSelectionBoxes();
  syncScaleCage();
  syncScalePanel();
  canvas.style.cursor = 'grabbing';
}

function beginScale(parts, group, e) {
  const list = Array.isArray(parts) ? parts : [parts];
  const before = capturePartSnaps(list);
  const objectSpace = list.length === 1 && scaleSpace === 'object';
  let baked = false;
  if (!objectSpace) {
    for (const part of list) if (bakePartRotation(part)) baked = true;
    if (baked) syncPlateMesh({ faces: false });
  }
  const origin = selectionPivot(list, new THREE.Vector3());
  const axis = group.userData.axis;
  const dir = AXIS[axis].clone();
  // 绕世界 Y 转 90° 时，切片 Y（世界 +Z）应转到世界 +X。q 为单位时方向就是 AXIS。
  if (objectSpace) dir.applyQuaternion(list[0].q);
  let startParam = axisParam(pointerRay(e).ray, origin, dir);
  if (!(Math.abs(startParam) > 1)) {
    startParam = (group.userData.sign || 1) * 16 * (scaleRoot?.scale.x || 1) * (gizmo.scale.x || 1);
  }
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
    items: list.map(part => ({
      part,
      src: new Float32Array(part.geom.attributes.position.array),
      srcSource: part.source ? new Float32Array(part.source) : null,
      base: { x: part.base.x, y: part.base.y, z: part.base.z },
      ox: part.ox,
      oy: part.oy || 0,
      oz: part.oz,
    })),
    snaps: snapshot(list),
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
  if (!parts.length) return;
  if (group.userData.tool === 'scale') {
    beginScale(parts, group, e);
    return;
  }
  const origin = selectionPivot(parts, new THREE.Vector3());
  const dir = group.userData.axis === 'e'
    ? camera.position.clone().sub(origin).normalize()
    : AXIS[group.userData.axis];
  if (!dir || dir.lengthSq() < 1e-8) return;
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
    for (const it of g.items) finishPartScale(it.part);
    if (g.moved) seatPartsOnPlate(g.items.map(it => it.part));
    if (g.moved) {
      if (g.items.length === 1) {
        const p = g.items[0].part;
        log(`模型已缩放：X ${p.size.x.toFixed(1)} × Y ${p.size.z.toFixed(1)} × Z ${p.size.y.toFixed(1)} mm`, 'ok');
      } else log(`已缩放 ${g.items.length} 个模型`, 'ok');
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
  if (g.kind === 'rotate') seatPartsOnPlate(partsOf(g));
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

/* 各件尺寸一致时返回这个数，否则返回 null（面板留空，不假装它们一样大）。 */
function sameMeasure(vals) {
  if (!vals.length) return null;
  const a = vals[0];
  for (let i = 1; i < vals.length; i++) if (Math.abs(vals[i] - a) > 0.015) return null;
  return a;
}

/* 一次改全部选中，只记一条撤回。scalePartTo 自己不再记历史。 */
function scaleSelection(parts, label, each) {
  if (!parts.length) return false;
  const before = capturePartSnaps(parts);
  for (const part of parts) each(part);
  seatPartsOnPlate(parts);
  syncPlateMesh({ faces: false });
  const changed = commitGeomHistory(label, before);
  syncScaleCage();
  syncSelectionBoxes();
  syncScalePanel();
  if (!changed) return false;
  if (parts.length === 1) logScale(parts[0], label);
  else log(`已缩放 ${parts.length} 个模型`, 'ok');
  return true;
}

function targetMm(part, axis, kind, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const born = sliceBorn(part);
  return kind === 'pct' ? born[axis] * n / 100 : n;
}

function applyAxisMm(part, axis, mm) {
  if (mm == null) return;
  const target = { x: part.size.x, y: part.size.z, z: part.size.y };
  target[axis] = mm;
  scalePartTo(part, target, { uniform: scaleUniform, changed: axis, space: scaleSpace, history: false });
}

function applyScaleInput(axis, kind, raw) {
  const parts = scalePartsNow();
  if (!parts.length) return;
  if (targetMm(parts[0], axis, kind, raw) == null) { syncScalePanel(); return; }
  scaleSelection(parts, '模型已缩放', part => applyAxisMm(part, axis, targetMm(part, axis, kind, raw)));
}

/* 整组缩进当前机型，间隙也跟着缩。单件仍走原来的适应。 */
function fitSelection(parts) {
  if (parts.length === 1) {
    scalePartToFit(parts[0]);
    syncScaleCage();
    syncScalePanel();
    logScale(parts[0], '已缩放到适合当前机型');
    return;
  }
  const before = capturePartSnaps(parts);
  for (const part of parts) bakePartRotation(part);
  const origin = selectionPivot(parts, new THREE.Vector3());
  const items = parts.map(part => ({
    part,
    ox: part.ox,
    oy: part.oy || 0,
    oz: part.oz,
    base: { x: part.base.x, y: part.base.y, z: part.base.z },
  }));
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const lift = raiseH();
  for (const part of parts) {
    const b = partBounds(part);
    if (b.min.x < minX) minX = b.min.x;
    if (b.max.x > maxX) maxX = b.max.x;
    const y0 = b.min.y + lift, y1 = b.max.y + lift;
    if (y0 < minY) minY = y0;
    if (y1 > maxY) maxY = y1;
    if (b.min.z < minZ) minZ = b.min.z;
    if (b.max.z > maxZ) maxZ = b.max.z;
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const spanZ = Math.max(maxZ - minZ, 1e-6);
  const fitX = Math.max((params.plateX || 150) - 2, 0.2);
  const fitZ = Math.max((params.plateZ || 85) - 2, 0.2);
  const fitY = Math.max((params.plateY || 175) - lift - 2, 0.2);
  let factor = Math.min(fitX / spanX, fitZ / spanZ, fitY / spanY);
  for (const it of items) factor = Math.min(factor, uniformScaleFactor(factor, it.base));
  for (const it of items) {
    scalePartTo(it.part, {
      x: it.part.size.x * factor,
      y: it.part.size.z * factor,
      z: it.part.size.y * factor,
    }, { uniform: true, changed: 'x', space: 'object', history: false });
    placeScaled(it, origin, factor, factor, factor);
  }
  clampPartsToPrintZ(parts);
  const px = params.plateX || 150;
  const pz = params.plateZ || 85;
  let loX = Infinity, hiX = -Infinity, loZ = Infinity, hiZ = -Infinity;
  for (const part of parts) {
    const b = partBounds(part);
    if (b.min.x < loX) loX = b.min.x;
    if (b.max.x > hiX) hiX = b.max.x;
    if (b.min.z < loZ) loZ = b.min.z;
    if (b.max.z > hiZ) hiZ = b.max.z;
  }
  let dx = 0, dz = 0;
  if (loX < -px / 2) dx = -px / 2 - loX;
  else if (hiX > px / 2) dx = px / 2 - hiX;
  if (loZ < -pz / 2) dz = -pz / 2 - loZ;
  else if (hiZ > pz / 2) dz = pz / 2 - hiZ;
  if (dx || dz) for (const part of parts) { part.ox += dx; part.oz += dz; }
  seatPartsOnPlate(parts);
  commitPartEdit(false);
  const changed = commitGeomHistory('缩放到适合机型', before);
  syncScaleCage();
  syncSelectionBoxes();
  syncScalePanel();
  if (changed) log(`已缩放 ${parts.length} 个模型`, 'ok');
}

/* 工作室画布在更低的层里，面板挂到 .stu 才能浮在左右卡片和底栏之上。演示界面仍挂在视口里。 */
function scaleHost() {
  const stage = canvas && canvas.parentElement;
  return (stage && stage.closest('.stu')) || stage || document.body;
}

function placeScalePanel() {
  if (!scaleEl || !canvas || !canvas.parentElement) return;
  const host = scaleEl.parentElement || scaleHost();
  // 宿主写了 --scale-panel-place: css 时，位置全部交给样式（工作室：底栏正上方居中）
  if (getComputedStyle(host).getPropertyValue('--scale-panel-place').trim() === 'css') {
    scaleEl.style.top = '';
    scaleEl.style.left = '';
    scaleEl.style.right = '';
    scaleEl.style.bottom = '';
    scaleEl.style.maxHeight = '';
    scaleEl.style.transform = '';
    return;
  }
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

function motionReduced() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* 缩放 / 旋转窗口的出现和收起。已经开着时再同步内容，不把进场动画重放一遍。 */
function setFloatOpen(el, open) {
  if (!el) return;
  if (open) {
    if (!el.hidden && !el.classList.contains('panelOut')) return;
    el.hidden = false;
    el.classList.remove('panelOut');
    if (motionReduced()) return;
    el.classList.remove('panelIn');
    void el.offsetWidth;
    el.classList.add('panelIn');
    return;
  }
  if (el.hidden || el.classList.contains('panelOut')) return;
  el.classList.remove('panelIn');
  if (motionReduced()) {
    el.hidden = true;
    return;
  }
  el.classList.add('panelOut');
  let timer = 0;
  const finish = (ev) => {
    if (ev && ev.target !== el) return;
    window.clearTimeout(timer);
    el.removeEventListener('animationend', finish);
    if (!el.classList.contains('panelOut')) return;
    el.classList.remove('panelOut');
    el.hidden = true;
  };
  el.addEventListener('animationend', finish);
  timer = window.setTimeout(() => finish(null), 420);
}

function syncScalePanel() {
  if (!scaleEl) return;
  const parts = scalePartsNow();
  setFloatOpen(scaleEl, parts.length > 0);
  if (!parts.length) return;
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
  for (const axis of ['x', 'y', 'z']) {
    const row = scaleEl.querySelector(`[data-axis="${axis}"]`);
    const mm = row.querySelector('input[data-kind="mm"]');
    const pct = row.querySelector('input[data-kind="pct"]');
    const mmV = sameMeasure(parts.map(part => sliceLive(part)[axis]));
    const pctV = sameMeasure(parts.map(part => {
      const born = sliceBorn(part);
      return sliceLive(part)[axis] / Math.max(born[axis], 1e-6) * 100;
    }));
    if (document.activeElement !== mm) {
      mm.value = mmV == null ? '' : mmV.toFixed(2);
      mm.placeholder = mmV == null ? '多个' : '';
    }
    if (document.activeElement !== pct) {
      pct.value = pctV == null ? '' : pctV.toFixed(2);
      pct.placeholder = pctV == null ? '多个' : '';
    }
  }
}

function scaleSpinHtml(kind) {
  const label = kind === 'mm' ? '大小' : '比率';
  const unit = kind === 'mm' ? 'mm' : '%';
  return `<input data-kind="${kind}" inputmode="decimal" autocomplete="off" aria-label="${label}">
    <em>${unit}</em>
    <span class="scaleSteps">
      <button type="button" data-kind="${kind}" data-step="1" aria-label="增大${label}">▴</button>
      <button type="button" data-kind="${kind}" data-step="-1" aria-label="减小${label}">▾</button>
    </span>`;
}

function ensureScalePanel() {
  if (scaleEl) return scaleEl;
  const host = scaleHost();
  scaleEl = document.createElement('div');
  scaleEl.className = 'scalePanel';
  scaleEl.hidden = true;
  scaleEl.setAttribute('role', 'dialog');
  scaleEl.setAttribute('aria-label', '缩放');
  scaleEl.addEventListener('pointerdown', ev => ev.stopPropagation());
  scaleEl.addEventListener('contextmenu', ev => ev.preventDefault());
  scaleEl.innerHTML = `
    <b class="scaleBrand">缩放</b>
    <span class="scaleIconBtns">
      <button type="button" class="scaleLink" data-act="link" aria-pressed="true" title="已锁定，三轴同一比例。点击后可单独改 XYZ"></button>
      <button type="button" class="scaleIcon" data-act="space" title="切换模型坐标系或世界坐标系"></button>
      <button type="button" class="scaleIcon" data-act="reset" title="还原模型的原始大小">${SCALE_SVG.reset}</button>
    </span>
    <div class="scaleAxes"></div>
    <div class="scaleActs"></div>`;
  const axes = scaleEl.querySelector('.scaleAxes');
  const colors = { x: '#e55353', y: '#10b890', z: '#3760ea' };
  for (const axis of ['x', 'y', 'z']) {
    const row = document.createElement('div');
    row.className = 'scaleRow';
    row.dataset.axis = axis;
    row.innerHTML = `
      <span class="scaleAxis"><i style="background:${colors[axis]}"></i>${axis.toUpperCase()}</span>
      <span class="scaleSpin">${scaleSpinHtml('mm')}</span>
      <span class="scaleSpin">${scaleSpinHtml('pct')}</span>`;
    axes.appendChild(row);
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
  scaleEl.querySelector('.scaleActs').append(fit, drag);
  host.appendChild(scaleEl);

  scaleEl.querySelector('[data-act="space"]').addEventListener('click', () => {
    scaleSpace = scaleSpace === 'world' ? 'object' : 'world';
    placeGizmo();
    syncScalePanel();
  });
  scaleEl.querySelector('[data-act="reset"]').addEventListener('click', () => {
    const parts = scalePartsNow();
    if (!parts.length) return;
    scaleSelection(parts, '已还原模型的原始大小', part => {
      const b = part.born || part.size;
      scalePartTo(part, { x: b.x, y: b.z, z: b.y }, { uniform: false, space: scaleSpace, history: false, label: '还原大小' });
    });
  });
  scaleEl.querySelector('[data-act="link"]').addEventListener('click', () => {
    scaleUniform = !scaleUniform;
    syncScalePanel();
  });
  fit.addEventListener('click', () => {
    const parts = scalePartsNow();
    if (!parts.length) return;
    fitSelection(parts);
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
      const parts = scalePartsNow();
      const row = btn.closest('[data-axis]');
      if (!parts.length || !row) return;
      const axis = row.dataset.axis;
      const kind = btn.dataset.kind;
      const step = Number(btn.dataset.step);
      scaleSelection(parts, '模型已缩放', part => {
        const live = sliceLive(part);
        const born = sliceBorn(part);
        const cur = kind === 'pct' ? live[axis] / Math.max(born[axis], 1e-6) * 100 : live[axis];
        applyAxisMm(part, axis, targetMm(part, axis, kind, cur + step));
      });
    });
  }
  return scaleEl;
}

function rotSelectionKey() {
  return (state.selectedIds || []).join(',');
}

function selectedParts() {
  const out = [];
  for (const id of state.selectedIds || []) {
    const p = state.parts.find(x => x.id === id);
    if (p) out.push(p);
  }
  return out;
}

/* 角度 0 的姿势。面板上的 X/Y/Z 都相对这一份重放，所以改一个数不会在上次结果上越叠越偏。 */
function captureRotBasis() {
  releaseSnaps(rotBasis);
  const parts = selectedParts();
  rotBasis = parts.length ? capturePartSnaps(parts) : null;
  rotEuler = { x: 0, y: 0, z: 0 };
  rotKey = rotSelectionKey();
}

function finishRotateSession() {
  if (!rotBasis) return;
  let baked = false;
  for (const snap of rotBasis) {
    const part = state.parts.find(p => p.id === snap.id);
    if (part && bakePartRotation(part)) baked = true;
  }
  if (baked) syncPlateMesh({ faces: true });
  releaseSnaps(rotBasis);
  rotBasis = null;
  rotEuler = { x: 0, y: 0, z: 0 };
  rotKey = '';
}

function eulerQuat(deg, out) {
  const qx = _quat.clone().setFromAxisAngle(AXIS.x, deg.x * Math.PI / 180);
  const qy = new THREE.Quaternion().setFromAxisAngle(AXIS.y, deg.y * Math.PI / 180);
  const qz = new THREE.Quaternion().setFromAxisAngle(AXIS.z, deg.z * Math.PI / 180);
  out.identity();
  out.premultiply(qx);
  out.premultiply(qy);
  out.premultiply(qz);
  return out;
}

/* 切片轴：X 绕世界 +X，Y 绕世界 +Z，Z 绕世界 +Y。先 X 再 Y 再 Z。转完每件最低点落到板上。 */
function applyRotEuler(next) {
  if (!rotBasis) captureRotBasis();
  if (!rotBasis || !rotBasis.length) return;
  const parts = [];
  for (const snap of rotBasis) {
    const part = state.parts.find(p => p.id === snap.id);
    if (!part || !snap.position) continue;
    parts.push(part);
  }
  if (!parts.length) return;
  const before = capturePartSnaps(parts);
  const beforeEuler = { x: rotEuler.x, y: rotEuler.y, z: rotEuler.z };
  for (const snap of rotBasis) {
    const part = state.parts.find(p => p.id === snap.id);
    if (part && snap.position) restorePartSnap(part, snap);
  }
  const live = [];
  for (const snap of rotBasis) {
    const part = state.parts.find(p => p.id === snap.id);
    if (part) live.push(part);
  }
  eulerQuat(next, _quat);
  const origin = selectionPivot(live, new THREE.Vector3());
  const lift = raiseH();
  for (const part of live) {
    const cy = lift + (part.oy || 0) + part.base.y / 2;
    _local.set(part.ox - origin.x, cy - origin.y, part.oz - origin.z);
    _local.applyQuaternion(_quat);
    part.ox = origin.x + _local.x;
    part.oz = origin.z + _local.z;
    part.oy = origin.y + _local.y - lift - part.base.y / 2;
    part.q.premultiply(_quat).normalize();
  }
  seatPartsOnPlate(live);
  for (const part of live) bakePartRotation(part);
  rotEuler = { x: next.x, y: next.y, z: next.z };
  syncPlateMesh({ faces: true });
  placeGizmo();
  syncSelectionBoxes();
  discardStaleWork('模型已旋转，分析结果与支撑已清除，请重新分析');
  const after = capturePartSnaps(live);
  const afterEuler = { x: rotEuler.x, y: rotEuler.y, z: rotEuler.z };
  const changed = before.some(snap => {
    const part = state.parts.find(p => p.id === snap.id);
    if (!part) return true;
    if (Math.abs(snap.ox - part.ox) > 0.02 || Math.abs(snap.oy - part.oy) > 0.02 || Math.abs(snap.oz - part.oz) > 0.02) return true;
    const pos = part.geom.attributes.position.array;
    if (!snap.position || pos.length !== snap.position.length) return true;
    for (let i = 0; i < pos.length; i++) if (pos[i] !== snap.position[i]) return true;
    return false;
  });
  if (!changed) {
    releaseSnaps(before);
    releaseSnaps(after);
    syncRotatePanel();
    return;
  }
  rotHold = true;
  pushHistory({
    label: '旋转模型',
    undo: () => {
      rotHold = true;
      for (const snap of before) {
        const part = state.parts.find(p => p.id === snap.id);
        if (part) restorePartSnap(part, snap);
      }
      rotEuler = { x: beforeEuler.x, y: beforeEuler.y, z: beforeEuler.z };
      syncPlateMesh({ faces: true });
      syncRotatePanel();
    },
    redo: () => {
      rotHold = true;
      for (const snap of after) {
        const part = state.parts.find(p => p.id === snap.id);
        if (part) restorePartSnap(part, snap);
      }
      rotEuler = { x: afterEuler.x, y: afterEuler.y, z: afterEuler.z };
      syncPlateMesh({ faces: true });
      syncRotatePanel();
    },
    dispose: () => { releaseSnaps(before); releaseSnaps(after); },
  });
  rotHold = false;
  log(`已旋转：X ${rotEuler.x.toFixed(1)}° · Y ${rotEuler.y.toFixed(1)}° · Z ${rotEuler.z.toFixed(1)}°`, 'ok');
  syncRotatePanel();
}

function setRotAxis(axis, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) { syncRotatePanel(); return; }
  applyRotEuler({ ...rotEuler, [axis]: n });
}

function placeFloatPanel(el) {
  if (!el || !canvas || !canvas.parentElement) return;
  const host = el.parentElement || scaleHost();
  if (getComputedStyle(host).getPropertyValue('--scale-panel-place').trim() === 'css') {
    el.style.top = '';
    el.style.left = '';
    el.style.right = '';
    el.style.bottom = '';
    el.style.maxHeight = '';
    el.style.transform = '';
    return;
  }
  const bar = host.querySelector('.modeBar, .mode-bar');
  let top = 12;
  if (bar) {
    const hr = host.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    top = Math.max(12, br.bottom - hr.top + 8);
  }
  el.style.top = `${Math.round(top)}px`;
  el.style.maxHeight = `calc(100% - ${Math.round(top + 148)}px)`;
}

function syncRotatePanel() {
  if (!rotEl) return;
  const on = state.transformTool === 'rotate' && (state.selectedIds || []).length > 0;
  setFloatOpen(rotEl, on);
  if (!on) return;
  placeFloatPanel(rotEl);
  for (const axis of ['x', 'y', 'z']) {
    const input = rotEl.querySelector(`[data-axis="${axis}"] input`);
    if (input && document.activeElement !== input) input.value = rotEuler[axis].toFixed(2);
  }
}

function ensureRotatePanel() {
  if (rotEl) return rotEl;
  const host = scaleHost();
  rotEl = document.createElement('div');
  rotEl.className = 'scalePanel rotPanel';
  rotEl.hidden = true;
  rotEl.setAttribute('role', 'dialog');
  rotEl.setAttribute('aria-label', '旋转');
  rotEl.addEventListener('pointerdown', ev => ev.stopPropagation());
  rotEl.addEventListener('contextmenu', ev => ev.preventDefault());
  rotEl.innerHTML = `
    <b class="scaleBrand">旋转</b>
    <span class="scaleIconBtns">
      <button type="button" class="scaleIcon" data-act="reset" title="角度回到 0">${SCALE_SVG.reset}</button>
    </span>
    <div class="rotAxes"></div>`;
  const axes = rotEl.querySelector('.rotAxes');
  const colors = { x: '#e55353', y: '#10b890', z: '#3760ea' };
  for (const axis of ['x', 'y', 'z']) {
    const row = document.createElement('div');
    row.className = 'rotRow';
    row.dataset.axis = axis;
    row.innerHTML = `
      <span class="scaleAxis"><i style="background:${colors[axis]}"></i>${axis.toUpperCase()}</span>
      <span class="scaleSpin">
        <input data-kind="deg" inputmode="decimal" autocomplete="off" aria-label="${axis.toUpperCase()} 角度">
        <em>°</em>
        <span class="scaleSteps">
          <button type="button" data-step="1" aria-label="增大角度">▴</button>
          <button type="button" data-step="-1" aria-label="减小角度">▾</button>
        </span>
      </span>
      <button type="button" class="rotNudge" data-step="-45">-45°</button>
      <button type="button" class="rotNudge" data-step="45">+45°</button>`;
    axes.appendChild(row);
  }
  host.appendChild(rotEl);
  rotEl.querySelector('[data-act="reset"]').addEventListener('click', () => {
    applyRotEuler({ x: 0, y: 0, z: 0 });
  });
  for (const input of rotEl.querySelectorAll('input')) {
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') input.blur(); });
    input.addEventListener('change', () => {
      const row = input.closest('[data-axis]');
      setRotAxis(row.dataset.axis, input.value);
    });
  }
  for (const btn of rotEl.querySelectorAll('.scaleSteps button, .rotNudge')) {
    btn.addEventListener('pointerdown', ev => { ev.preventDefault(); ev.stopPropagation(); });
    btn.addEventListener('click', () => {
      const row = btn.closest('[data-axis]');
      if (!row) return;
      const axis = row.dataset.axis;
      setRotAxis(axis, rotEuler[axis] + Number(btn.dataset.step));
    });
  }
  return rotEl;
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
  setTransformTool(tool);
}

/** 切换模型变换工具（move / rotate / scale），再点同一个取消。工具栏按钮与右键菜单共用。 */
export function setTransformTool(tool) {
  hideMenu();
  const prev = state.transformTool;
  if (!tool || tool === prev) {
    if (prev === 'rotate') finishRotateSession();
    state.transformTool = null;
    bus.emit('selection', { ids: (state.selectedIds || []).slice(), tool: null });
    syncRotatePanel();
    return;
  }
  if (!(state.selectedIds || []).length) {
    toast('先选中模型，再使用变换工具');
    return;
  }
  if (state.mode !== 'orbit') setMode('orbit');
  if (tool !== 'move' && tool !== 'rotate' && tool !== 'scale') return;
  if (prev === 'rotate') finishRotateSession();
  if (tool === 'scale') scaleDrag = true;
  state.transformTool = tool;
  if (tool === 'rotate') captureRotBasis();
  const tip = {
    move: '拖动坐标轴移动模型',
    rotate: '拖动圆环绕坐标轴旋转',
  }[tool];
  if (tip) toast(tip);
  bus.emit('selection', { ids: state.selectedIds.slice(), tool });
  syncRotatePanel();
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
    if (rotEl && !rotEl.hidden && rotEl.contains(document.activeElement)) {
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
  // M 移动，R 旋转，S 缩放。再按一次关掉。输入框、命令面板和带修饰键的组合不抢。
  if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !typingTarget() && !dialogOpen()) {
    const k = (e.key || '').toLowerCase();
    if (k === 'm' || e.code === 'KeyM') {
      e.preventDefault();
      e.stopPropagation();
      setTransformTool('move');
      return;
    }
    if (k === 's' || e.code === 'KeyS') {
      e.preventDefault();
      e.stopPropagation();
      setTransformTool('scale');
      return;
    }
    if (k === 'r' || e.code === 'KeyR') {
      e.preventDefault();
      e.stopPropagation();
      setTransformTool('rotate');
      return;
    }
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
  ensureRotatePanel();
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
  window.addEventListener('resize', () => {
    if (scaleEl && !scaleEl.hidden) placeScalePanel();
    if (rotEl && !rotEl.hidden) placeFloatPanel(rotEl);
  });
  bus.on('modelInfo', () => { syncSelectionBoxes(); syncScalePanel(); syncRotatePanel(); });
  bus.on('selection', () => {
    hideMenu();
    syncSelectionBoxes();
    syncScalePanel();
    if (state.transformTool === 'rotate') {
      if (rotSelectionKey() !== rotKey) {
        finishRotateSession();
        if (state.transformTool === 'rotate') captureRotBasis();
      }
    } else if (rotBasis) finishRotateSession();
    syncRotatePanel();
  });
  bus.on('history', () => {
    if (state.transformTool !== 'rotate') return;
    if (rotHold) { rotHold = false; return; }
    captureRotBasis();
    syncRotatePanel();
  });
}
