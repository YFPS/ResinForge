/* ================================================================
   three.js 场景：renderer / camera / OrbitControls / 灯光 / 平台网格 / 材质 /
   modelGroup / supportGroup / animate 循环 / resize / pointerRay / paintAt /
   setMode / 四模式 pointer 处理 / 拖放模型（STL / OBJ / 3MF）。
   与旧 main.js 的差异仅两类：参数读 params.*，UI 副作用发 bus 事件。
   不依赖 DOM 的部分在模块级创建；renderer/controls 需 canvas，由 initScene(canvas) 完成。
================================================================ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { state, params, bus, log, toast, setProgress } from '../store.js';
import { loadDemo, loadModelFiles, localFaceOf, raiseH, baseY, plateAxisOrigin, acceptSupportFace } from './model.js';
import { modelKind } from './meshio.js';
import { addSupportPoint, moveSupportPoint, setSupportSelection, supportSelection, supportIndexNearHit, deleteSupportIndices, prepareSupportColors, setSupportView } from './support.js';
import { showHeightLine, clearHeightLine } from './heightLine.js';
import { downPolyLine, movePolyLine, finishPolyLine, cancelPolyLine } from './polyLine.js';
import { initManipulate, tickManipulate } from './manipulate.js';
import { initViewCube, tickViewCube } from './viewCube.js';

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.fog = new THREE.Fog(0x0d1117, 300, 900);
export const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 3000);
camera.position.set(95, 75, 95);

/* 光照：用户转到任意角度都不能出现纯黑面。
   世界光从四周围过来（上 / 对侧 / 下 / 斜前），环境光再抬一层底；
   头灯挂在相机上，跟着视线走——正在看的那一面始终迎光。
   RoomEnvironment 的 IBL 在 initScene 里接上，envMapIntensity 把各方向的环境光补够。 */
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
scene.add(new THREE.HemisphereLight(0xf4f7fb, 0xd0d7e0, 0.9));
const dl = new THREE.DirectionalLight(0xffffff, 0.7);
dl.position.set(60, 120, 40); scene.add(dl);
const dl2 = new THREE.DirectionalLight(0xe4ebf3, 0.55);
dl2.position.set(-80, 50, -60); scene.add(dl2);
const dl3 = new THREE.DirectionalLight(0xe4ebf3, 0.6);   // 从下往上，底面不黑
dl3.position.set(-20, -100, 30); scene.add(dl3);
const dl4 = new THREE.DirectionalLight(0xe4ebf3, 0.5);   // 补上原先三盏都打不到的斜向
dl4.position.set(80, 15, -70); scene.add(dl4);

/* 头灯：光源在相机后方偏上，目标在相机原点，光沿着视线打出去。
   相机必须进场景图，子节点才会参与光照。 */
function attachHeadlight(cam, intensity) {
  const head = new THREE.DirectionalLight(0xffffff, intensity);
  head.position.set(0.15, 0.4, 1);
  const target = new THREE.Object3D();
  cam.add(head);
  cam.add(target);
  head.target = target;
}
scene.add(camera);
attachHeadlight(camera, 0.8);
/* 机器板面。网格和边框都贴在 y=0，范围是当前机型的可打印板面。
   不画打印高度的立框。角上的轴按切片软件标注：X / Y 在板面（世界 +X / +Z），Z 向上（世界 +Y）。 */
const buildVolume = { group: null, mats: [] };

function axisLabel(text, color) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 64);
  g.fillStyle = color;
  g.font = '700 40px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(8, 4, 1);
  sp.raycast = () => {};
  return sp;
}

function ticks(min, max, step) {
  const out = [min];
  for (let v = Math.ceil((min + 0.05) / step) * step; v < max - 0.05; v += step) out.push(Math.round(v * 1000) / 1000);
  out.push(max);
  return out;
}

function lineSegments(pairs, color, role) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pairs, 3));
  const m = new THREE.LineBasicMaterial({ color });
  m.fog = false;
  m.userData.role = role;
  buildVolume.mats.push(m);
  const lines = new THREE.LineSegments(g, m);
  lines.raycast = () => {};
  return lines;
}

export function setBuildVolumeTheme(resolved) {
  const dark = resolved !== 'light';
  const colors = dark
    ? { grid: 0x3c4c60, edge: 0x93a6bd, x: 0xe25b5b, y: 0x3dbe74, z: 0x4c8dff }
    : { grid: 0xb4bec9, edge: 0x5c6b7c, x: 0xd64545, y: 0x1f9d55, z: 0x2f6fe0 };
  for (const m of buildVolume.mats) {
    const hex = colors[m.userData.role];
    if (hex != null && m.color) m.color.setHex(hex);
  }
}

export function updateBuildVolume() {
  if (buildVolume.group) {
    scene.remove(buildVolume.group);
    buildVolume.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    for (const m of buildVolume.mats) {
      if (m.map) m.map.dispose();
      m.dispose();
    }
    buildVolume.mats = [];
    buildVolume.group = null;
  }
  const frame = plateAxisOrigin();
  const px = frame.px;
  const pz = frame.pz;
  const hx = px / 2, hz = pz / 2;
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  const grid = [], edge = [];
  for (const x of ticks(-hx, hx, 10)) grid.push(x, 0.04, -hz, x, 0.04, hz);
  for (const z of ticks(-hz, hz, 10)) grid.push(-hx, 0.04, z, hx, 0.04, z);
  edge.push(
    -hx, 0.06, -hz, hx, 0.06, -hz,
    hx, 0.06, -hz, hx, 0.06, hz,
    hx, 0.06, hz, -hx, 0.06, hz,
    -hx, 0.06, hz, -hx, 0.06, -hz,
  );
  const group = new THREE.Group();
  group.name = 'buildVolume';
  group.add(lineSegments(grid, dark ? 0x3c4c60 : 0xb4bec9, 'grid'));
  group.add(lineSegments(edge, dark ? 0x93a6bd : 0x5c6b7c, 'edge'));

  const origin = new THREE.Vector3(frame.x, 0.08, frame.z);
  const axisLen = Math.min(22, Math.max(12, Math.min(px, pz) * 0.16));
  const axes = [
    [axisLen, 0, 0, 0xe25b5b, 'x', 'X'],   // 板面 X
    [0, 0, axisLen, 0x3dbe74, 'y', 'Y'],   // 板面 Y（世界 +Z）
    [0, axisLen, 0, 0x4c8dff, 'z', 'Z'],   // 高度 Z（世界 +Y）
  ];
  for (const [dx, dy, dz, color, role, text] of axes) {
    group.add(lineSegments([
      origin.x, origin.y, origin.z,
      origin.x + dx, origin.y + dy, origin.z + dz,
    ], color, role));
    const label = axisLabel(text, '#' + color.toString(16).padStart(6, '0'));
    label.position.set(origin.x + dx * 1.25, origin.y + dy * 1.25 + (dy ? 0 : 1.2), origin.z + dz * 1.25);
    group.add(label);
    buildVolume.mats.push(label.material);
  }
  scene.add(group);
  buildVolume.group = group;
  setBuildVolumeTheme(dark ? 'dark' : 'light');
}

export const modelGroup = new THREE.Group(); scene.add(modelGroup);
export const supportGroup = new THREE.Group(); scene.add(supportGroup);

export const modelMat = new THREE.MeshStandardMaterial({
  color: 0xa7b0bd, roughness: 0.55, metalness: 0.15, vertexColors: true, envMapIntensity: 0.95
});
/** 落板支撑（格架塔、落到平台的短杆与底板）：#312F32 */
export const SUP_COLOR = 0x312f32;
/** 短小支撑（锚在模型表面上的十字短杆 / 分叉头）：红 */
export const SUP_ANCHOR_COLOR = 0xe0242c;
export const supMat = new THREE.MeshStandardMaterial({ color: SUP_COLOR, roughness: 0.5, metalness: 0.05, envMapIntensity: 0.95 });
export const supMatAnchor = new THREE.MeshStandardMaterial({ color: SUP_ANCHOR_COLOR, roughness: 0.5, metalness: 0.05, envMapIntensity: 0.95 });
export const supMatBase = new THREE.MeshStandardMaterial({ color: SUP_COLOR, roughness: 0.7, metalness: 0.05, envMapIntensity: 0.95 });   // 格架底座整板，与落板支撑同色
/* 「连接体」显示模式下针的半透明材质（玻璃感：能看穿、留轮廓；2026-10-14 用户定）。
   这里用同色相的亮一档：顶点色是实心 #312F32，再乘 0.5 透明度会融进深色视口。 */
export const supMatGlass = new THREE.MeshStandardMaterial({ color: 0xb0b1b1, roughness: 0.5, metalness: 0.05, envMapIntensity: 0.7, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });
export const supMatAnchorGlass = new THREE.MeshStandardMaterial({ color: 0xff4d55, roughness: 0.5, metalness: 0.05, envMapIntensity: 0.7, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });

/* 预览渲染器（朝向候选缩略图；preserveDrawingBuffer 供 toDataURL 出图，React 渲染 <img>） */
export const prevRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
prevRenderer.setSize(112, 112);
export const prevScene = new THREE.Scene();
prevScene.background = new THREE.Color(0x0d1117);
prevScene.add(new THREE.AmbientLight(0xffffff, 0.45));
prevScene.add(new THREE.HemisphereLight(0xf4f7fb, 0xd0d7e0, 0.85));
const pdl = new THREE.DirectionalLight(0xffffff, 0.7); pdl.position.set(60, 120, 40); prevScene.add(pdl);
const pdl2 = new THREE.DirectionalLight(0xe4ebf3, 0.45); pdl2.position.set(-50, -40, -30); prevScene.add(pdl2);
export const prevCam = new THREE.PerspectiveCamera(40, 1, 0.1, 3000);
prevScene.add(prevCam);
attachHeadlight(prevCam, 0.7);
export const prev = { mesh: null };   // 预览模型 Mesh（model.js setGeometry 重建，orient.js 渲染缩略图）

/* 需 canvas 的句柄（initScene 后可用） */
let canvas = null;
let renderer = null;
let controls = null;
export const getRenderer = () => renderer;
export const getControls = () => controls;
export const getCanvas = () => canvas;

function resize() {
  const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

/* ================================================================
   保护面笔刷
================================================================ */
const raycaster = new THREE.Raycaster();
export function pointerRay(e) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  return raycaster;
}
export function paintAt(e) {
  if (!state.mesh) return;
  const hits = pointerRay(e).intersectObject(state.mesh);
  if (!hits.length) return;
  const hit = hits[0];
  const r = params.brushR;
  const colorAttr = state.mesh.geometry.attributes.color;
  const pos = state.mesh.geometry.attributes.position;
  const fi = hit.face.a / 3;
  const hp = state.mesh.worldToLocal(hit.point.clone());   // 命中点为世界系，面重心在局部系，需转换（模型被抬高 raiseH）
  const nf = pos.count / 3;
  let added = 0;
  for (let f = 0; f < nf; f++) {
    if (state.protectedFaces.has(f)) continue;
    const i = f * 9;
    const cx = (pos.array[i] + pos.array[i + 3] + pos.array[i + 6]) / 3;
    const cy = (pos.array[i + 1] + pos.array[i + 4] + pos.array[i + 7]) / 3;
    const cz = (pos.array[i + 2] + pos.array[i + 5] + pos.array[i + 8]) / 3;
    if (Math.hypot(cx - hp.x, cy - hp.y, cz - hp.z) <= r) {
      state.protectedFaces.add(f); added++;
      const v = f * 3;
      for (let k = 0; k < 3; k++) colorAttr.setXYZ(v + k, 1, 0.38, 0.38);
      const loc = localFaceOf(f);
      if (loc) {
        loc.part.protected.add(loc.local);
        const pca = loc.part.geom.attributes.color;
        const pv = loc.local * 3;
        for (let k = 0; k < 3; k++) pca.setXYZ(pv + k, 1, 0.38, 0.38);
        pca.needsUpdate = true;
      }
    }
  }
  if (added) { colorAttr.needsUpdate = true; bus.emit('protectedChanged'); log(`保护面 +${added}（共 ${state.protectedFaces.size} 面）`); }
}
export function clearProtectedFaces() {
  state.protectedFaces.clear();
  for (const p of state.parts) {
    p.protected.clear();
    const ca = p.geom.attributes.color;
    if (ca) { ca.array.fill(1); ca.needsUpdate = true; }
  }
  if (state.mesh) {
    const ca = state.mesh.geometry.attributes.color;
    for (let i = 0; i < ca.array.length; i++) ca.array[i] = 1;
    ca.needsUpdate = true;
  }
  bus.emit('protectedChanged');
  log('保护面已清除');
}

/* ================================================================
   交互模式（旋转 / 保护面 / 加支撑 / 删支撑）
================================================================ */
let supportHotkeys = false;
/** 支撑这一步打开时，A 进入加点、D 删除点选的那一个点。旧界面整页都算支撑操作。 */
export function setSupportHotkeys(on) { supportHotkeys = !!on; }

export function setMode(m) {
  const prev = state.mode;
  state.mode = m;
  // 右键旋转、中键平移，各模式都一样。左键不转视角：旋转模式用来点选和框选，
  // 其余模式留给涂画 / 加支撑 / 删支撑。
  controls.enabled = true;
  controls.mouseButtons.LEFT = null;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
  controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  canvas.style.cursor = m === 'orbit' ? 'default' : 'crosshair';
  cancelTipDrag();
  clearSupportHover();
  if (m !== 'add') clearHeightLine();
  if (m !== 'poly') cancelPolyLine();
  if (m === 'del') prepareSupportColors();
  else setSupportSelection([]);
  cancelSupBox();
  bus.emit('mode', m);
  // 加支撑：先分析，再默认打开热力图，进来就是分析完成后的样子。
  // 退出加支撑 / 多线段 / 删支撑时关掉热力图。多线段和删支撑本身不强迫打开。
  const manual = x => x === 'add' || x === 'del' || x === 'poly';
  if (m === 'add' && prev !== 'add') {
    if (!tipHintShown) {
      tipHintShown = true;
      log('加点：点模型朝下的面加点；按在支撑杆身或针尖上可选中并拖动这一根。按 V 切到「仅连接体」视图更容易点中');
    }
    bus.emit('enterAddSupport');
  }
  else if ((m === 'del' || m === 'poly') && !manual(prev)) bus.emit('enterManual');
  if (!manual(m) && manual(prev)) bus.emit('leaveManual');
}

/* 删支撑：单击点选一个点，拖出框线框选。选中的点变成洋红。 */
let supBox = null;
let supBoxEl = null;
const _supV = new THREE.Vector3();

function supportScreenPos(p) {
  if (!canvas) return null;
  _supV.set(p.x, p.y, p.z).project(camera);
  if (_supV.z > 1) return null;
  const rect = canvas.getBoundingClientRect();
  return {
    x: (_supV.x * 0.5 + 0.5) * rect.width + rect.left,
    y: (-_supV.y * 0.5 + 0.5) * rect.height + rect.top,
  };
}

function supportIndicesInRect(x0, y0, x1, y1) {
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const hit = [];
  const pts = state.supportPoints || [];
  for (let i = 0; i < pts.length; i++) {
    const s = supportScreenPos(pts[i]);
    if (!s) continue;
    if (s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY) hit.push(i);
  }
  return hit;
}

function supportIndexNear(x, y, px = 16) {
  const pts = state.supportPoints || [];
  let best = -1, bd = px * px;
  for (let i = 0; i < pts.length; i++) {
    const s = supportScreenPos(pts[i]);
    if (!s) continue;
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d <= bd) { bd = d; best = i; }
  }
  return best;
}

/* ================================================================
   选中 / 拖拽已有支撑
   ----------------------------------------------------------------
   认哪一根支撑按「离指针最近的可见针身」来，不再只认针尖：
   - 按下时先射线打针身网格（真几何、前面那根优先），命中点找最近的针段（needleList 的针尖 C ↔ 针根 N）；
   - 射线没打中（细杆、远距离）再按屏幕距离找针段（12px），最后才退到针尖（16px）；
   - 背面（法线背对相机）的候选只在正面一个都没有时才接受，密集支撑里优先眼前这一侧；
   - 悬停就画蓝环 + 针身高亮线，先看清抓住的是哪一根，再按下。
   拖动仍只在松手时重建结构。 */
const SHAFT_PICK_PX = 12;
const TIP_PICK_PX = 16;
const TIP_DRAG_COLOR = 0xff3df2;
const HOVER_COLOR = 0x63c9ff;
let tipDrag = null;
let tipGhost = null;
let tipHintShown = false;
let hoverMark = null;
let hoverIndex = -1;
const _hgrV = new THREE.Vector3();
const _hgrA = { x: 0, y: 0, z: 0 };
const _hgrB = { x: 0, y: 0, z: 0 };

/** 遍历当前结构里的每根针。needleList 来自最后一次重建；点集增删后索引会错位，针尖对不上当前点就跳过。 */
function eachNeedle(cb) {
  const L = state.supportStats && state.supportStats.needleList;
  const pts = state.supportPoints || [];
  if (!Array.isArray(L) || !L.length || !pts.length) return;
  for (let k = 0; k < L.length; k++) {
    const nd = L[k];
    if (!nd || !nd.N) continue;
    const p = pts[nd.pi];
    if (!p) continue;
    const c = nd.C;
    const tx = c ? c[0] : p.x, ty = c ? c[1] : p.y, tz = c ? c[2] : p.z;
    if (Math.hypot(tx - p.x, ty - p.y, tz - p.z) > 1.5) continue;
    cb(nd, tx, ty, tz);
  }
}

function toScreen(x, y, z, rect, out) {
  _hgrV.set(x, y, z).project(camera);
  out.x = (_hgrV.x * 0.5 + 0.5) * rect.width + rect.left;
  out.y = (-_hgrV.y * 0.5 + 0.5) * rect.height + rect.top;
  out.z = _hgrV.z;
  return out;
}

/** 被托面法线是否朝着相机。背面候选只在正面一个都没有时才用。 */
function tipFrontFacing(p) {
  const n = p.n;
  if (!n) return true;
  return n[0] * (camera.position.x - p.x) + n[1] * (camera.position.y - p.y) + n[2] * (camera.position.z - p.z) > 0;
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  const t = L > 1e-9 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  const qx = ax + dx * t, qy = ay + dy * t;
  return { d2: (px - qx) ** 2 + (py - qy) ** 2, t };
}

function pointSegDist2(px, py, pz, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const L = dx * dx + dy * dy + dz * dz;
  const t = L > 1e-12 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / L)) : 0;
  const qx = ax + dx * t, qy = ay + dy * t, qz = az + dz * t;
  return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
}

/** 屏幕坐标附近最近的针身（投影成线段量距离）；同一像素距离取更靠前的。 */
function nearestNeedleScreen(x, y, px = SHAFT_PICK_PX, rect = null) {
  const rc = rect || (canvas && canvas.getBoundingClientRect());
  if (!canvas || !rc) return -1;
  const r2 = px * px;
  const scan = (frontOnly) => {
    let best = -1, bd = r2, bz = Infinity;
    eachNeedle((nd, tx, ty, tz) => {
      const p = (state.supportPoints || [])[nd.pi];
      if (!p) return;
      if (frontOnly && !tipFrontFacing(p)) return;
      toScreen(tx, ty, tz, rc, _hgrA);
      toScreen(nd.N[0], nd.N[1], nd.N[2], rc, _hgrB);
      if (_hgrA.z > 1 || _hgrB.z > 1) return;
      const { d2, t } = segDist2(x, y, _hgrA.x, _hgrA.y, _hgrB.x, _hgrB.y);
      if (d2 > bd + 0.01) return;
      const z = _hgrA.z + (_hgrB.z - _hgrA.z) * t;
      if (Math.abs(d2 - bd) <= 0.01 && z >= bz) return;
      bd = d2; bz = z; best = nd.pi;
    });
    return best;
  };
  const front = scan(true);
  return front >= 0 ? front : scan(false);
}

/** 射线命中点（针身表面）附近最近的针段。tol 要盖住针截面半径 + 一点点抖动。 */
function nearestNeedleToPoint(hx, hy, hz, tol = 1.0) {
  let best = -1, bd = tol * tol;
  eachNeedle((nd, tx, ty, tz) => {
    const d2 = pointSegDist2(hx, hy, hz, tx, ty, tz, nd.N[0], nd.N[1], nd.N[2]);
    if (d2 < bd) { bd = d2; best = nd.pi; }
  });
  return best;
}

/** 屏幕坐标附近最近的针尖；先只认正面，正面没有才放宽。 */
function tipIndexNearScreen(x, y, px = TIP_PICK_PX) {
  const pts = state.supportPoints || [];
  if (!canvas || !pts.length) return -1;
  const rect = canvas.getBoundingClientRect();
  const r2 = px * px;
  const scan = (frontOnly) => {
    let best = -1, bd = r2;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (frontOnly && !tipFrontFacing(p)) continue;
      _hgrV.set(p.x, p.y, p.z).project(camera);
      if (_hgrV.z > 1 || _hgrV.z < -1) continue;
      const dx = (_hgrV.x * 0.5 + 0.5) * rect.width + rect.left - x;
      const dy = (-_hgrV.y * 0.5 + 0.5) * rect.height + rect.top - y;
      const d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = i; }
    }
    return best;
  };
  const front = scan(true);
  return front >= 0 ? front : scan(false);
}

/** 指针下的支撑点：射线打针身 → 屏幕距离找针身 → 针尖。格架不参与，免得点塔身误抓一根支撑。 */
function supportIndexAtPointer(e, withRay) {
  const pts = state.supportPoints || [];
  if (!pts.length) return -1;
  if (withRay && state.mesh) {
    const meshes = [];
    for (const s of state.supports) if (s.part === 'needle' && s.mesh.visible) meshes.push(s.mesh);
    if (meshes.length) {
      const hits = pointerRay(e).intersectObjects(meshes, false);
      for (let i = 0; i < hits.length && i < 6; i++) {
        const h = hits[i];
        const byNeedle = nearestNeedleToPoint(h.point.x, h.point.y, h.point.z, 1.0);
        if (byNeedle >= 0) return byNeedle;
        // 短小支撑（十字短杆 / 分叉）不在 needleList 里，按命中点就近认点；远于 4mm 不认
        const near = supportIndexNearHit(h.point.x, h.point.y, h.point.z);
        if (near >= 0) {
          const q = pts[near];
          if (q && Math.hypot(q.x - h.point.x, q.y - h.point.y, q.z - h.point.z) < 4) return near;
        }
      }
    }
  }
  const shaft = nearestNeedleScreen(e.clientX, e.clientY);
  if (shaft >= 0) return shaft;
  return tipIndexNearScreen(e.clientX, e.clientY);
}

function ensureHoverMark() {
  if (hoverMark) return hoverMark;
  const g = new THREE.Group();
  g.name = 'supportHover';
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.85, 28),
    new THREE.MeshBasicMaterial({ color: HOVER_COLOR, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
  );
  ring.raycast = () => {};
  ring.renderOrder = 9;
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: HOVER_COLOR, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false }),
  );
  line.raycast = () => {};
  line.renderOrder = 8;
  g.add(ring, line);
  g.visible = false;
  scene.add(g);
  hoverMark = g;
  return g;
}

/** 悬停环按像素大小缩放（远近都看得见），并沿针轴画一条高亮线。 */
function placeHoverMark(index) {
  const p = (state.supportPoints || [])[index];
  const g = ensureHoverMark();
  if (!p) { g.visible = false; hoverIndex = -1; return; }
  const ring = g.children[0], line = g.children[1];
  let root = null;
  eachNeedle(nd => { if (nd.pi === index && !root) root = nd.N; });
  if (root) {
    const a = line.geometry.attributes.position;
    a.setXYZ(0, p.x, p.y, p.z);
    a.setXYZ(1, root[0], root[1], root[2]);
    a.needsUpdate = true;
    line.geometry.computeBoundingSphere();
    line.visible = true;
  } else line.visible = false;
  g.visible = true;
  tickSupportHover();
}

function tickSupportHover() {
  if (!hoverMark || !hoverMark.visible) return;
  const p = (state.supportPoints || [])[hoverIndex];
  if (!p) { clearSupportHover(); return; }
  const ring = hoverMark.children[0];
  ring.position.set(p.x, p.y, p.z);
  const dist = camera.position.distanceTo(ring.position);
  const perPx = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * dist / Math.max(1, canvas.clientHeight);
  ring.scale.setScalar(perPx * 11 / 0.85);
  ring.lookAt(camera.position);
}

function setSupportHover(index) {
  if (index === hoverIndex) {
    if (index >= 0) placeHoverMark(index);
    return;
  }
  hoverIndex = index;
  if (index < 0) { if (hoverMark) hoverMark.visible = false; return; }
  placeHoverMark(index);
}

let hoverTimer = 0;

function cancelHoverPick() {
  if (!hoverTimer) return;
  clearTimeout(hoverTimer);
  hoverTimer = 0;
}

function clearSupportHover() {
  cancelHoverPick();
  hoverIndex = -1;
  if (hoverMark) hoverMark.visible = false;
}

/** 这一根支撑的针根（格架节点 / 自由针的落点）。短小支撑没有针，返回 null。 */
function rootOfPoint(index) {
  let root = null;
  eachNeedle(nd => {
    if (nd.pi === index && !root) root = { x: nd.N[0], y: nd.N[1], z: nd.N[2] };
  });
  return root;
}

/** 悬停环用「停顿一下再射线」：指针移动时先只换光标，停 55ms 才精确认一次。
 *  射线只打针身网格（几十万面也只要一两毫秒），不会像逐帧打整模那样卡；
 *  这样环画出来的就是按下时真正会抓住的那一根，不会指错。 */
function scheduleSupportHover(x, y, cheap) {
  if (hoverMark && hoverMark.visible && hoverIndex === cheap) return;
  cancelHoverPick();
  hoverIndex = -1;
  if (hoverMark) hoverMark.visible = false;
  hoverTimer = setTimeout(() => {
    hoverTimer = 0;
    if (!canvas || state.mode !== 'add' || tipDrag) return;
    const idx = supportIndexAtPointer({ clientX: x, clientY: y }, true);
    if (idx >= 0) setSupportHover(idx);
  }, 55);
}

function ensureTipGhost() {
  if (tipGhost) return tipGhost;
  const g = new THREE.Group();
  g.name = 'tipDragGhost';
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.85, 16, 12),
    new THREE.MeshBasicMaterial({ color: TIP_DRAG_COLOR, transparent: true, opacity: 0.92, depthWrite: false }),
  );
  tip.raycast = () => {};
  tip.renderOrder = 6;
  const band = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: TIP_DRAG_COLOR, transparent: true, opacity: 0.95, depthTest: false }),
  );
  band.raycast = () => {};
  band.renderOrder = 5;
  const drop = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineDashedMaterial({ color: 0xc8d2df, dashSize: 0.8, gapSize: 0.5, transparent: true, opacity: 0.4, depthTest: false }),
  );
  drop.raycast = () => {};
  drop.renderOrder = 4;
  g.add(tip, band, drop);
  g.userData = { tip, band, drop };
  scene.add(g);
  tipGhost = g;
  return g;
}

/** 幽灵：针尖球（新位置）＋ 针根到新针尖的预演杆（没有针根时从原针尖拉过来）＋ 新针尖落到平台 / 底板顶面的引导线。
 *  invalid 时整套变红。预演杆让支撑看起来是绕针根转过去的，不用等格架重算完才知道落点。 */
function placeTipGhost(pos, valid) {
  const d = tipDrag;
  if (!d) return;
  const g = ensureTipGhost();
  const { tip, band, drop } = g.userData;
  const col = valid ? TIP_DRAG_COLOR : 0xff4d4d;
  tip.position.set(pos.x, pos.y, pos.z);
  tip.material.color.setHex(col);
  const from = d.root || d.from;
  const bp = band.geometry.attributes.position;
  bp.setXYZ(0, from.x, from.y, from.z);
  bp.setXYZ(1, pos.x, pos.y, pos.z);
  bp.needsUpdate = true;
  band.geometry.computeBoundingSphere();
  band.material.color.setHex(col);
  const footY = Math.min(baseY(), pos.y - 0.01);
  const dp = drop.geometry.attributes.position;
  dp.setXYZ(0, pos.x, pos.y, pos.z);
  dp.setXYZ(1, pos.x, footY, pos.z);
  dp.needsUpdate = true;
  drop.geometry.computeBoundingSphere();
  drop.computeLineDistances();
}

function disposeTipGhost() {
  if (!tipGhost) return;
  scene.remove(tipGhost);
  tipGhost.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  tipGhost = null;
}

function beginTipDrag(e, index) {
  if (tipDrag) cancelTipDrag();           // 第二根手指 / 上一次没收尾的拖动：先收干净
  if (tipGhost) disposeTipGhost();        // 上一次落点还在重建：撤掉预演杆，换这一根
  const pts = state.supportPoints || [];
  const pt = pts[index];
  if (!pt) return false;
  clearSupportHover();
  tipDrag = {
    pt, pid: e.pointerId, x0: e.clientX, y0: e.clientY,
    active: false, hasHit: false, valid: false,
    from: { x: pt.x, y: pt.y, z: pt.z },
    root: rootOfPoint(index),
    pos: { x: pt.x, y: pt.y, z: pt.z },
    normal: null, face: -1, partId: pt.partId,
    prevSel: [...supportSelection()],
  };
  setSupportSelection([index]);          // 整根支撑先变洋红：确认抓住的是哪一根
  canvas.style.cursor = 'grab';
  // 捕获指针：拖到画布外（甚至拖过窗口标题栏）也能收到 pointermove / pointerup，幽灵不会卡在画面上
  try { canvas.setPointerCapture(e.pointerId); } catch { /* 触屏浏览器可能不支持，退回 window 监听 */ }
  return true;
}

function moveTipDrag(e) {
  const d = tipDrag;
  if (!d) return;
  if (!d.active && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
  d.active = true;
  const hits = state.mesh ? pointerRay(e).intersectObject(state.mesh) : [];
  const h = hits[0];
  if (!h) { d.hasHit = false; d.valid = false; placeTipGhost(d.pos, false); canvas.style.cursor = 'not-allowed'; return; }
  const fn = h.face ? h.face.normal : null;
  const prot = state.protectedFaces.has(h.faceIndex);
  const up = !fn || fn.y > 0.3;
  d.valid = !prot && !up;
  d.hasHit = true;
  d.pos = { x: h.point.x, y: h.point.y, z: h.point.z };
  d.normal = fn ? [fn.x, fn.y, fn.z] : [0, -1, 0];
  d.face = h.faceIndex;
  const loc = localFaceOf(h.faceIndex);
  if (loc) d.partId = loc.part.id;
  placeTipGhost(d.pos, d.valid);
  canvas.style.cursor = d.valid ? 'grabbing' : 'not-allowed';
}

function finishTipDrag() {
  const d = tipDrag;
  tipDrag = null;
  if (!d) return;
  if (canvas) { try { canvas.releasePointerCapture(d.pid); } catch { /* 没捕获或已自动释放 */ } }
  canvas.style.cursor = state.mode === 'add' ? 'crosshair' : 'default';
  if (!d.active) { disposeTipGhost(); return; }   // 只点了一下：保持选中，不重建
  if (!d.hasHit) { disposeTipGhost(); toast('请把针尖拖到模型表面上再松手'); return; }
  if (!d.valid) {
    disposeTipGhost();
    toast(state.protectedFaces.has(d.face) ? '该面为保护面，已阻止移动支撑' : '只能把针尖拖到朝下（悬空）的表面上');
    return;
  }
  const idx = (state.supportPoints || []).indexOf(d.pt);
  if (idx < 0) { disposeTipGhost(); return; }     // 拖动期间点集被清空 / 重建替换：放弃这次落点
  const moved = Math.hypot(d.pos.x - d.from.x, d.pos.y - d.from.y, d.pos.z - d.from.z);
  if (moved < 0.05) { disposeTipGhost(); return; } // 手抖几像素：不值得整次重建
  if (!acceptSupportFace(d.face)) { disposeTipGhost(); return; } // 多件时只接受当前选中零件的面（与手动加点同一条规则）
  // 重算格架要一两秒：预演杆留在画面上，等新结构上屏再撤，免得支撑先「弹回原位」再跳过去
  const pendingGhost = tipGhost;
  canvas.style.cursor = 'progress';
  moveSupportPoint(idx, d.pos, d.normal, d.partId).finally(() => {
    if (tipGhost === pendingGhost) {
      disposeTipGhost();
      if (canvas) canvas.style.cursor = state.mode === 'add' ? 'crosshair' : 'default';
    }
  });
}

function cancelTipDrag() {
  const d = tipDrag;
  if (!d) return;
  tipDrag = null;
  if (canvas) { try { canvas.releasePointerCapture(d.pid); } catch { /* 没捕获或已自动释放 */ } }
  disposeTipGhost();
  setSupportSelection(d.prevSel);
  if (canvas) canvas.style.cursor = state.mode === 'add' ? 'crosshair' : 'default';
}

function ensureSupBox() {
  if (supBoxEl) return supBoxEl;
  supBoxEl = document.createElement('div');
  supBoxEl.hidden = true;
  supBoxEl.setAttribute('aria-hidden', 'true');
  Object.assign(supBoxEl.style, {
    position: 'fixed', zIndex: '80', pointerEvents: 'none', boxSizing: 'border-box',
    border: '1px solid #ff3df2', background: 'rgba(255, 61, 242, 0.16)',
  });
  document.body.appendChild(supBoxEl);
  return supBoxEl;
}

function layoutSupBox(x0, y0, x1, y1) {
  const el = ensureSupBox();
  el.hidden = false;
  el.style.left = `${Math.min(x0, x1)}px`;
  el.style.top = `${Math.min(y0, y1)}px`;
  el.style.width = `${Math.abs(x1 - x0)}px`;
  el.style.height = `${Math.abs(y1 - y0)}px`;
}

function cancelSupBox() {
  supBox = null;
  if (supBoxEl) supBoxEl.hidden = true;
}

/** 单击：优先按针身认（看得见哪根点哪根），其次打支撑杆身，最后才是屏幕上的支撑点。只选中，不删除。 */
function pickClickedSupport(x, y) {
  const byNeedle = supportIndexAtPointer({ clientX: x, clientY: y }, true);
  if (byNeedle >= 0) return byNeedle;
  const screen = supportIndexNear(x, y, 16);
  const hits = pointerRay({ clientX: x, clientY: y }).intersectObjects(supportGroup.children, false);
  const hit = hits.find(h => h.object.userData.kind === 'ground' || h.object.userData.kind === 'anchor');
  if (hit) {
    const p = hit.point;
    const idx = supportIndexNearHit(p.x, p.y, p.z);
    if (idx >= 0) return idx;
  }
  return screen;
}

function finishSupBox(e) {
  const box = supBox;
  supBox = null;
  if (supBoxEl) supBoxEl.hidden = true;
  if (!box) return;
  const cur = [...supportSelection()];
  if (!box.active) {
    const i = pickClickedSupport(box.x, box.y);
    if (i < 0) { if (!box.additive) setSupportSelection([]); return; }
    if (box.additive) {
      const next = cur.includes(i) ? cur.filter(n => n !== i) : cur.concat(i);
      setSupportSelection(next);
    } else setSupportSelection([i]);
    return;
  }
  const hit = supportIndicesInRect(box.x, box.y, e.clientX, e.clientY);
  const next = box.additive ? [...new Set(cur.concat(hit))] : hit;
  setSupportSelection(next);
  if (next.length) log(`已框选 ${next.length} 个支撑点，按 Del 删除`, 'ok');
}

function typingTarget() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function onSupportKey(e) {
  if (e.isComposing || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = (e.key || '').toLowerCase();
  // 拖拽针尖中按 Esc：放弃这次移动，结构保持原样
  if (tipDrag && (k === 'escape' || e.code === 'Escape')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    cancelTipDrag();
    return;
  }
  // 接触点间距面板会把焦点放进数字框。多线段的回车 / Esc 仍要生效，不能当成在打字。
  if (state.mode === 'poly' && (k === 'enter' || e.code === 'Enter')) {
    const el = document.activeElement;
    if (el && el.tagName === 'INPUT') el.blur();
    e.preventDefault();
    e.stopImmediatePropagation();
    finishPolyLine();
    return;
  }
  if (state.mode === 'poly' && (k === 'escape' || e.code === 'Escape')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    cancelPolyLine();
    return;
  }
  if (typingTarget()) return;
  if (document.querySelector('dialog[open], [role="dialog"][data-state="open"]')) return;
  const hot = supportHotkeys || state.mode === 'add' || state.mode === 'del';
  // V：循环切换支撑显示（全部 → 仅连接体 → 仅接触点，黑格同款快捷键）
  if (!e.shiftKey && (k === 'v' || e.code === 'KeyV')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const cur = state.supView || 'full';
    setSupportView(cur === 'full' ? 'needle' : cur === 'needle' ? 'point' : 'full');
    return;
  }
  if (hot && !e.shiftKey && (k === 'a' || e.code === 'KeyA')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    setMode('add');
    return;
  }
  if (hot && !e.shiftKey && (k === 'd' || e.code === 'KeyD')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    // 先进入删支撑。没有点选时只切换，不提示「请先点选」。
    const sel = [...supportSelection()];
    if (state.mode !== 'del') setMode('del');
    if (sel.length === 1) deleteSupportIndices(sel);
    return;
  }
  if (e.key !== 'Delete' && e.code !== 'Delete') return;
  if (state.mode !== 'del') return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const sel = [...supportSelection()];
  if (!sel.length) { toast('请先框选或点选支撑点'); return; }
  deleteSupportIndices(sel);
}

/* 摄影机缓动。用户一开始拖视角就取消，避免和 OrbitControls 抢 */
let camTween = null;
let focusRing = null;

const _aimQ = new THREE.Quaternion();
const _aimOff = new THREE.Vector3();

/* 保持离目标的距离，沿球面转到 dir 那一侧。上 / 下带一点前向偏移，避免和世界上方向重合。 */
export function aimView(dir) {
  if (!controls || !dir) return;
  const target = controls.target.clone();
  const from = camera.position.clone().sub(target);
  if (from.lengthSq() < 1e-4) from.set(1, 1, 1);
  const toDir = dir.clone().normalize();
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    camera.position.copy(target).addScaledVector(toDir, from.length());
    camTween = null;
    return;
  }
  camTween = {
    kind: 'aim',
    from,
    turn: new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), toDir),
    target,
    start: performance.now(),
    dur: 340,
  };
}

function startTween(to, target, dur) {
  if (!controls) return;
  if (dur <= 0) {
    camera.position.copy(to);
    controls.target.copy(target);
    camTween = null;
    return;
  }
  camTween = {
    from: camera.position.clone(),
    to: to.clone(),
    t0: controls.target.clone(),
    target: target.clone(),
    start: performance.now(),
    dur,
  };
}

function setFocusRing(part) {
  if (focusRing) {
    scene.remove(focusRing);
    focusRing.geometry.dispose();
    focusRing.material.dispose();
    focusRing = null;
  }
  // 选中盒已经标出选中的模型，这里只保留「摄影机对着谁」的贴地圈
  if (!part || state.parts.length < 2 || (state.selectedIds && state.selectedIds.length)) return;
  const pad = 1.4;
  const hx = part.size.x / 2 + pad, hz = part.size.z / 2 + pad;
  const y = raiseH() + 0.15;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    part.ox - hx, y, part.oz - hz,
    part.ox + hx, y, part.oz - hz,
    part.ox + hx, y, part.oz + hz,
    part.ox - hx, y, part.oz + hz,
  ], 3));
  focusRing = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x3d8bfd, transparent: true, opacity: 0.95, depthTest: false }));
  focusRing.renderOrder = 3;
  focusRing.raycast = () => {};
  scene.add(focusRing);
}

export function syncFocusRing() {
  const p = state.parts.find(x => x.id === state.focusId);
  setFocusRing(p || null);
}

/** 把摄影机对准一个零件。多模型时在底面画一圈选框 */
export function framePart(part, { animate = true } = {}) {
  if (!part || !controls) return;
  state.focusId = part.id;
  const y0 = raiseH();
  const target = new THREE.Vector3(part.ox, y0 + part.size.y * 0.42, part.oz);
  const r = Math.max(part.size.x, part.size.y, part.size.z, 16);
  const to = new THREE.Vector3(part.ox + r * 0.85, y0 + part.size.y * 0.32 + r * 0.45, part.oz + r * 1.15);
  startTween(to, target, animate ? 420 : 0);
  setFocusRing(part);
}

/** 看整板。只有一个零件时等价于对准它，不画选框 */
export function frameParts(parts, { animate = false } = {}) {
  if (!controls || !parts || !parts.length) return;
  if (parts.length === 1) {
    state.focusId = null;
    setFocusRing(null);
    const p = parts[0];
    const y0 = raiseH();
    const target = new THREE.Vector3(p.ox, y0 + p.size.y * 0.42, p.oz);
    const r = Math.max(p.size.x, p.size.y, p.size.z, 16);
    startTween(new THREE.Vector3(p.ox + r * 0.9, y0 + p.size.y * 0.35 + r * 0.5, p.oz + r * 1.2), target, animate ? 420 : 0);
    return;
  }
  state.focusId = null;
  setFocusRing(null);
  const y0 = raiseH();
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = y0;
  for (const p of parts) {
    minX = Math.min(minX, p.ox - p.size.x / 2);
    maxX = Math.max(maxX, p.ox + p.size.x / 2);
    minZ = Math.min(minZ, p.oz - p.size.z / 2);
    maxZ = Math.max(maxZ, p.oz + p.size.z / 2);
    maxY = Math.max(maxY, y0 + p.size.y);
  }
  const cx = (minX + maxX) / 2, cy = (y0 + maxY) / 2, cz = (minZ + maxZ) / 2;
  const r = Math.max(maxX - minX, maxY - y0, maxZ - minZ, 24);
  startTween(
    new THREE.Vector3(cx + r * 0.8, cy + r * 0.28, cz + r * 1.05),
    new THREE.Vector3(cx, cy * 0.55, cz),
    animate ? 420 : 0,
  );
}

function stepCamera(now) {
  if (!camTween) return;
  const u = Math.min(1, (now - camTween.start) / camTween.dur);
  const k = 1 - (1 - u) ** 3;
  if (camTween.kind === 'aim') {
    _aimQ.identity().slerp(camTween.turn, k);
    _aimOff.copy(camTween.from).applyQuaternion(_aimQ);
    camera.position.copy(camTween.target).add(_aimOff);
    controls.target.copy(camTween.target);
    if (u >= 1) camTween = null;
    return;
  }
  camera.position.lerpVectors(camTween.from, camTween.to, k);
  controls.target.lerpVectors(camTween.t0, camTween.target, k);
  if (u >= 1) camTween = null;
}

/* ================================================================
   初始化：renderer / controls / 事件 / 动画循环 / 启动流程
================================================================ */
/* 视口性能读数。每约半秒结算一次：
   FPS = 这段时间的帧数；
   CPU = 渲染循环占主线程的时间比例（封顶 100，不含后台线程）；
   mem = Chrome 的 JS 堆已用量，其它浏览器为 0。 */
const perfSample = { fps: 0, cpu: 0, mem: 0, ready: false };
const perfAcc = { frames: 0, work: 0, t0: 0 };

function samplePerf(tWork) {
  const now = performance.now();
  if (!perfAcc.t0) perfAcc.t0 = tWork;
  perfAcc.frames += 1;
  perfAcc.work += now - tWork;
  const wall = now - perfAcc.t0;
  if (wall < 500) return;
  perfSample.fps = Math.round(perfAcc.frames * 1000 / wall);
  perfSample.cpu = Math.min(100, Math.round(perfAcc.work / wall * 100));
  perfSample.mem = performance.memory ? performance.memory.usedJSHeapSize : 0;
  perfSample.ready = true;
  perfAcc.frames = 0;
  perfAcc.work = 0;
  perfAcc.t0 = now;
}

function polyView() {
  return {
    camera,
    width: canvas ? canvas.clientWidth : 1,
    height: canvas ? canvas.clientHeight : 1,
  };
}

export function readPerf() {
  return perfSample;
}

/* 桌面版文件拖放。壳子在松开时把路径放进 fs 的读取范围，这里再读成 File 交给原来的载入。 */
function bindTauriModelDrop() {
  if (!('__TAURI_INTERNALS__' in window)) return;
  import('@tauri-apps/api/webview').then(({ getCurrentWebview }) => {
    getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === 'enter' || payload.type === 'over') {
        bus.emit('dropHint', true);
        return;
      }
      bus.emit('dropHint', false);
      if (payload.type === 'drop') loadDroppedModelPaths(payload.paths || []);
    }).catch((e) => log(`拖放监听失败：${e && e.message || e}`, 'warn'));
  }).catch((e) => log(`拖放监听失败：${e && e.message || e}`, 'warn'));
}

async function loadDroppedModelPaths(paths) {
  const wanted = [];
  for (const path of paths) {
    const name = String(path).split(/[/\\]/).pop() || String(path);
    if (modelKind(name)) wanted.push({ path, name });
  }
  if (!wanted.length) {
    if (paths.length) toast('请拖入 .stl、.obj 或 .3mf 文件');
    return;
  }
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const files = [];
    for (let i = 0; i < wanted.length; i++) {
      const it = wanted[i];
      setProgress(0.04 * (i / wanted.length), `读取 ${i + 1}/${wanted.length} · ${it.name}`);
      const bytes = await readFile(it.path);
      files.push(new File([bytes], it.name));
    }
    loadModelFiles(files, { append: state.parts.some(p => !p.demo) });
  } catch (e) {
    setProgress(null);
    log(`读取拖入的模型失败：${e && e.message || e}`, 'warn');
    toast('无法读取拖入的文件');
  }
}

export function initScene(canvasEl) {
  canvas = canvasEl;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  /* 环境光照（IBL ≈ 简易全局光照）：主场景与缩略图场景各自 PMREM（纹理绑定 GL 上下文，不能跨 renderer 共享） */
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const pmremPrev = new THREE.PMREMGenerator(prevRenderer);
  prevScene.environment = pmremPrev.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose(); pmremPrev.dispose();
  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 22, 0);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  // 鼠标键位：中键拖动平移视角，右键拖动旋转，滚轮缩放。左键留给点选、框选、涂画和加删支撑。
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
  controls.screenSpacePanning = true;   // 中键平移沿屏幕平面（上下拖 = 画面上下移），不是沿地面
  controls.addEventListener('start', () => { camTween = null; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());   // 右键旋转时不弹系统菜单
  canvas.addEventListener('mousedown', e => {
    if (e.button === 1 || e.button === 2) e.preventDefault();   // 中键不触发浏览器自动滚动，右键不选中文字
  }, true);
  window.addEventListener('resize', resize);

  // 捕获阶段先于 OrbitControls（它在冒泡阶段听 pointerdown）。右键旋转、中键平移交给 OrbitControls。
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;   // 仅左键触发涂画/加/删支撑；右键（旋转）/ 中键（平移）交给 OrbitControls
    if (state.mode === 'paint') { state.painting = true; paintAt(e); }
    else if (state.mode === 'add' && state.mesh) {
      // 先认支撑：按在针身或针尖附近都算抓住这一根（射线优先，看见哪根抓哪根），否则才是新增点
      const tip = supportIndexAtPointer(e, true);
      if (tip >= 0) {
        e.preventDefault();
        e.stopPropagation();
        beginTipDrag(e, tip);
        return;
      }
      const hits = pointerRay(e).intersectObject(state.mesh);
      if (!hits.length) return;   // 没点到模型：不加支撑。旋转改由右键，平移改由中键
      e.stopPropagation();
      const h = hits[0];
      if (state.protectedFaces.has(h.faceIndex)) { toast('该面为保护面，已阻止添加支撑'); return; }
      // 命中面法线作为接触端朝向（模型仅平移变换，几何面法线即世界系方向）；朝上的面无从支撑
      const fn = h.face ? h.face.normal : null;
      if (fn && fn.y > 0.3) { toast('只能在朝下（悬空）的表面添加支撑点'); return; }
      const loc = localFaceOf(h.faceIndex);
      if (!acceptSupportFace(h.faceIndex)) return;
      addSupportPoint(h.point, fn ? [fn.x, fn.y, fn.z] : null, loc && loc.part.id);
    } else if (state.mode === 'poly' && state.mesh) {
      const hits = pointerRay(e).intersectObject(state.mesh);
      if (!hits.length) return;
      e.stopPropagation();
      downPolyLine(hits[0], polyView());
    } else if (state.mode === 'del') {
      // 左键留给点选和框选支撑点，不让后面的模型框选把这次拖动接走
      e.stopImmediatePropagation();
      if (!(state.supportPoints || []).length) return;
      supBox = {
        x: e.clientX, y: e.clientY, pid: e.pointerId,
        additive: e.ctrlKey || e.metaKey || e.shiftKey,
        active: false,
      };
    }
  }, true);
  window.addEventListener('pointermove', e => {
    if (!supBox || e.pointerId !== supBox.pid) return;
    if (!supBox.active && Math.hypot(e.clientX - supBox.x, e.clientY - supBox.y) < 5) return;
    supBox.active = true;
    layoutSupBox(supBox.x, supBox.y, e.clientX, e.clientY);
  });
  window.addEventListener('pointerup', e => {
    if (!supBox || e.pointerId !== supBox.pid) return;
    finishSupBox(e);
  });
  window.addEventListener('pointercancel', () => cancelSupBox());
  window.addEventListener('keydown', onSupportKey, true);
  canvas.addEventListener('pointermove', e => {
    if (state.painting && state.mode === 'paint') paintAt(e);
    if (e.buttons !== 0) clearSupportHover();   // 拖视角 / 拖支撑时不挂悬停环
    // 加支撑时画高度线。多线段只画贴在表面上的折线，不再叠高度线。
    if ((state.mode === 'add' || state.mode === 'poly') && state.mesh && e.buttons === 0) {
      const hits = pointerRay(e).intersectObject(state.mesh);
      if (state.mode === 'add') {
        // 悬停先认针身 / 针尖：光标立即变抓，蓝环等指针停 55ms 再用射线确认（见 scheduleSupportHover）
        const cand = supportIndexAtPointer(e, false);
        canvas.style.cursor = cand >= 0 ? 'grab' : (hits.length ? 'crosshair' : 'default');
        if (cand >= 0) {
          showHeightLine(null, polyView());
          scheduleSupportHover(e.clientX, e.clientY, cand);
        } else {
          clearSupportHover();
          showHeightLine(hits[0] || null, polyView());
        }
      } else {
        canvas.style.cursor = hits.length ? 'crosshair' : 'default';
        movePolyLine(hits[0] || null, polyView());
      }
    } else if (state.mode !== 'add') {
      clearSupportHover();
    }
  });
  canvas.addEventListener('pointerleave', () => clearSupportHover());
  window.addEventListener('pointerup', () => { state.painting = false; });
  // 拖拽针尖：指针可能在画布外松开，统一听 window，按 pointerId 认这一根手指 / 鼠标
  window.addEventListener('pointermove', e => {
    if (tipDrag && e.pointerId === tipDrag.pid) moveTipDrag(e);
  });
  window.addEventListener('pointerup', e => {
    if (tipDrag && e.pointerId === tipDrag.pid) finishTipDrag();
  });
  window.addEventListener('pointercancel', e => {
    if (tipDrag && e.pointerId === tipDrag.pid) cancelTipDrag();
  });

  /* 拖放 STL / OBJ / 3MF。不支持的文件直接提示，不清掉板上已有的模型。
     浏览器走 HTML5 drop。Windows 桌面壳会换成自己的投放目标，并关掉 WebView2 的外部拖放，
     所以打包后 dataTransfer.files 一直是空的，松开像没反应。桌面版改听壳子的 drag-drop。 */
  window.addEventListener('dragover', e => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    bus.emit('dropHint', true);
  });
  window.addEventListener('dragleave', e => { if (e.target === document.body || e.target === canvas.parentElement) bus.emit('dropHint', false); });
  window.addEventListener('drop', e => {
    e.preventDefault(); bus.emit('dropHint', false);
    const raw = e.dataTransfer ? [...e.dataTransfer.files] : [];
    const files = raw.filter(f => modelKind(f.name));
    if (!files.length) { if (raw.length) toast('请拖入 .stl、.obj 或 .3mf 文件'); return; }
    // 板上已有真实模型时追加，只有演示模型时换成拖进来的这一批
    loadModelFiles(files, { append: state.parts.some(p => !p.demo) });
  });
  bindTauriModelDrop();

  initManipulate(canvas);
  initViewCube(canvas);

  (function animate() {
    requestAnimationFrame(animate);
    const tWork = performance.now();
    controls.update();
    stepCamera(tWork);
    tickManipulate();
    tickSupportHover();
    renderer.render(scene, camera);
    tickViewCube();
    samplePerf(tWork);
  })();

  /* 启动 */
  resize();
  updateBuildVolume();
  loadDemo('knot');
  log('ResinForge v0.1 就绪：像素级切片 + 多目标朝向优化 + 孤岛检测 + 语义保护面权重', 'ok');
  log('流程：载入模型 → 朝向优化 → (涂保护面) → 逐层分析 → 生成支撑 → 导出 STL');
}
