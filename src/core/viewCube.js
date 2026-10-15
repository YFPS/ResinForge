/* ================================================================
   视角方块。挂在视口右上角，跟着主相机转。
   点一个面，相机保持距离，沿球面转到该方向。
   坐标跟切片软件一致：X 向右，Y 是板面进深（世界 +Z），Z 向上（世界 +Y）。
   上 / 下略微偏向前方，这样正上方不会和相机的上方向重合。
================================================================ */
import * as THREE from 'three';
import { camera, getControls, aimView } from './scene.js';

const HOVER = 0xf2f5ce;
const FACE = 0xffffff;
/* 半边长 0.5。镜头拉到能把整只方块连同角上的箭头装进画面，方块约占视窗高度的 37%，和参考视窗同一比例。 */
const DIST = 4.85;

/* 面朝外的法线、贴图的右与上、点击后相机所在的一侧 */
const FACE_DEFS = [
  { label: '右', normal: [1, 0, 0], right: [0, 0, -1], up: [0, 1, 0], aim: [1, 0, 0] },
  { label: '左', normal: [-1, 0, 0], right: [0, 0, 1], up: [0, 1, 0], aim: [-1, 0, 0] },
  { label: '上', normal: [0, 1, 0], right: [1, 0, 0], up: [0, 0, -1], aim: [0, 1, 0.08] },
  { label: '下', normal: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1], aim: [0, -1, 0.08] },
  { label: '前', normal: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], aim: [0, 0, 1] },
  { label: '后', normal: [0, 0, -1], right: [-1, 0, 0], up: [0, 1, 0], aim: [0, 0, -1] },
];

/* 纯红 / 绿 / 蓝。尾巴落在「左、下、前」那只角，各沿一条棱走到一半。
   红指向右，蓝指向上，绿从这一角沿底棱指向后（参考方块的正面在负向，正绿轴同样从正面那只角指向背后）。 */
const AXIS_ARROW = [
  { dir: [1, 0, 0], color: 0xff0000 },
  { dir: [0, 1, 0], color: 0x0000ff },
  { dir: [0, 0, -1], color: 0x00ff00 },
];

let host = null;
let wren = null;
let wscene = null;
let wcam = null;
let faces = [];
let down = null;

const _eye = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _ray = new THREE.Raycaster();
const _basis = new THREE.Matrix4();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _normal = new THREE.Vector3();

function labelTexture(text) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#1c2430';
  g.font = '700 72px "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 136);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function faceMesh(def) {
  const normal = _normal.fromArray(def.normal);
  const right = _right.fromArray(def.right);
  const up = _up.fromArray(def.up);
  const mat = new THREE.MeshBasicMaterial({
    map: labelTexture(def.label),
    color: FACE,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.96), mat);
  _basis.makeBasis(right, up, normal);
  mesh.quaternion.setFromRotationMatrix(_basis);
  mesh.position.copy(normal).multiplyScalar(0.5);
  mesh.userData.aim = new THREE.Vector3().fromArray(def.aim).normalize();
  return mesh;
}

/* 细线箭杆加小箭头，从左下前角贴着三条棱各走半条边。杆是线，不是粗圆柱。 */
function arrowMesh(dir, color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color, toneMapped: false, depthTest: true, depthWrite: false,
  });
  const lineMat = new THREE.LineBasicMaterial({
    color, toneMapped: false, depthTest: true, depthWrite: false,
  });
  const shaftLen = 0.38;
  const headLen = 0.11;
  const shaft = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, shaftLen, 0),
    ]),
    lineMat,
  );
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.048, headLen, 10), mat);
  head.position.y = shaftLen + headLen * 0.45;
  g.add(shaft, head);
  g.position.set(-0.52, -0.5, 0.52);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3().fromArray(dir).normalize());
  g.renderOrder = 3;
  return g;
}

function syncWidgetCamera() {
  const controls = getControls();
  if (!controls || !wcam) return;
  _eye.copy(camera.position).sub(controls.target);
  if (_eye.lengthSq() < 1e-8) _eye.set(0.4, 0.7, 0.8);
  _eye.normalize().multiplyScalar(DIST);
  wcam.position.copy(_eye);
  wcam.up.set(0, 1, 0);
  wcam.lookAt(0, 0, 0);
  wcam.updateMatrixWorld();
}

function resizeWidget() {
  if (!host || !wren) return;
  const w = host.clientWidth || 100;
  const h = host.clientHeight || 100;
  const pr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.floor(w * pr);
  const bh = Math.floor(h * pr);
  if (wren.domElement.width !== bw || wren.domElement.height !== bh) {
    wren.setPixelRatio(pr);
    wren.setSize(w, h, false);
  }
}

function pickFace(e) {
  if (!host || !wcam) return null;
  const rect = host.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  _ndc.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  syncWidgetCamera();
  _ray.setFromCamera(_ndc, wcam);
  const hits = _ray.intersectObjects(faces, false);
  return hits.length ? hits[0].object : null;
}

function paintHover(face) {
  for (const mesh of faces) mesh.material.color.setHex(mesh === face ? HOVER : FACE);
  if (host) host.style.cursor = face ? 'pointer' : 'default';
}

export function initViewCube(canvasEl) {
  if (host || !canvasEl || !canvasEl.parentElement) return;
  host = document.createElement('div');
  host.className = 'viewCube';
  host.title = '点一面，把视角转到那一面';
  const el = document.createElement('canvas');
  host.appendChild(el);
  canvasEl.parentElement.appendChild(host);

  wren = new THREE.WebGLRenderer({ canvas: el, antialias: true, alpha: true });
  wren.setClearColor(0x000000, 0);
  wscene = new THREE.Scene();
  wcam = new THREE.PerspectiveCamera(32, 1, 0.05, 30);

  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)),
    new THREE.LineBasicMaterial({ color: 0xb7bec8, toneMapped: false }),
  );
  wscene.add(edge);
  faces = FACE_DEFS.map(faceMesh);
  for (const mesh of faces) wscene.add(mesh);
  for (const a of AXIS_ARROW) wscene.add(arrowMesh(a.dir, a.color));

  host.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    down = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.stopPropagation();
  });
  host.addEventListener('pointermove', e => {
    paintHover(pickFace(e));
  });
  host.addEventListener('pointerleave', () => {
    down = null;
    paintHover(null);
  });
  host.addEventListener('pointerup', e => {
    if (!down || e.pointerId !== down.id) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 5) return;
    const face = pickFace(e);
    if (face) aimView(face.userData.aim);
  });
  host.addEventListener('contextmenu', e => e.preventDefault());
  resizeWidget();
}

export function tickViewCube() {
  if (!wren || !wscene || !wcam) return;
  resizeWidget();
  syncWidgetCamera();
  wren.render(wscene, wcam);
}
