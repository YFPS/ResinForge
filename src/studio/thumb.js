/* 工程/零件缩略图：按几何外接球取景，固定斜上前方，离屏 WebGL 渲染成 WebP。
   输入是 archive 里保存的 parts（positions / ox / oy / oz / q）和 supportPoints。 */
import * as THREE from 'three';

const W = 640;
const H = 440;
const MODEL_COLOR = 0x8f96a0;
const SUPPORT_COLOR = 0xe07a2f;
const BG = 0x000000;

let renderer = null;
let modelMaterial = null;
let supportMaterial = null;
let rodGeometry = null;

function ensureRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(BG, 0);

  modelMaterial = new THREE.MeshStandardMaterial({
    color: MODEL_COLOR,
    roughness: 0.72,
    metalness: 0.04,
    flatShading: true,
  });
  supportMaterial = new THREE.MeshBasicMaterial({ color: SUPPORT_COLOR });
  rodGeometry = new THREE.CylinderGeometry(1, 1, 1, 4, 1, false);
}

function positionsOf(part) {
  const raw = part?.positions;
  if (!raw || raw.length < 9) return null;
  return raw instanceof Float32Array ? raw : new Float32Array(raw);
}

function sampledPositions(pos) {
  const triangles = Math.floor(pos.length / 9);
  const stride = Math.max(1, Math.ceil(triangles / 160000));
  if (stride === 1) return new Float32Array(pos);
  const out = new Float32Array(Math.max(9, Math.floor(triangles / stride) * 9));
  let o = 0;
  for (let t = 0; t < triangles; t += stride) {
    const i = t * 9;
    if (o + 9 > out.length) break;
    out.set(pos.subarray(i, i + 9), o);
    o += 9;
  }
  return o === out.length ? out : out.subarray(0, o);
}

function addLights(scene) {
  scene.add(new THREE.AmbientLight(0xffffff, 1.2));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x4a4f57, 1));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(1.2, 2.2, 1.6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdfe7f2, 0.9);
  fill.position.set(-1.4, 0.8, 0.4);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.7);
  rim.position.set(-0.6, 0.4, -1.4);
  scene.add(rim);
}

export function renderProjectThumb(parts, points, raiseH = 0) {
  ensureRenderer();
  const scene = new THREE.Scene();
  addLights(scene);

  const box = new THREE.Box3();
  const meshes = [];
  const lift = Number.isFinite(raiseH) ? raiseH : 0;

  for (const part of parts || []) {
    const pos = positionsOf(part);
    if (!pos) continue;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(sampledPositions(pos), 3));
    geom.computeBoundingBox();
    const cy = (geom.boundingBox.min.y + geom.boundingBox.max.y) / 2;
    geom.translate(0, -cy, 0);
    geom.computeVertexNormals();

    const mesh = new THREE.Mesh(geom, modelMaterial);
    mesh.position.set(Number(part.ox) || 0, cy + (Number(part.oy) || 0) + lift, Number(part.oz) || 0);
    const q = part.q;
    if (q && q.length === 4) mesh.quaternion.set(q[0], q[1], q[2], q[3]);
    mesh.updateMatrixWorld(true);
    scene.add(mesh);
    meshes.push(mesh);
    box.expandByObject(mesh);
  }

  if (!meshes.length) return '';

  const rods = [];
  for (const p of points || []) {
    const x = Number(p.x), y = Number(p.y), z = Number(p.z);
    if (![x, y, z].every(Number.isFinite)) continue;
    const ay = Number.isFinite(Number(p.ay)) ? Number(p.ay) : 0;
    const ax = Number.isFinite(Number(p.ax)) ? Number(p.ax) : x;
    const az = Number.isFinite(Number(p.az)) ? Number(p.az) : z;
    if (Math.hypot(x - ax, y - ay, z - az) < 0.05) continue;
    rods.push([ax, ay, az, x, y, z]);
    box.expandByPoint(new THREE.Vector3(ax, ay, az));
    box.expandByPoint(new THREE.Vector3(x, y, z));
  }

  if (rods.length) {
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    const radius = Math.max(0.2, sphere.radius);
    const rodRadius = Math.max(0.12, Math.min(0.8, radius * 0.008));
    const inst = new THREE.InstancedMesh(rodGeometry, supportMaterial, rods.length);
    const matrix = new THREE.Matrix4();
    const start = new THREE.Vector3();
    const end = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    rods.forEach((r, i) => {
      start.set(r[0], r[1], r[2]);
      end.set(r[3], r[4], r[5]);
      const len = start.distanceTo(end);
      mid.addVectors(start, end).multiplyScalar(0.5);
      dir.subVectors(end, start).normalize();
      quat.setFromUnitVectors(up, dir);
      scale.set(rodRadius, len, rodRadius);
      matrix.compose(mid, quat, scale);
      inst.setMatrixAt(i, matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
  }

  if (box.isEmpty()) return '';
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(sphere.radius, 0.5);
  const camera = new THREE.PerspectiveCamera(32, W / H, 0.1, 1e6);
  const dir = new THREE.Vector3(0.72, 0.72, 1).normalize();
  let dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.04;
  const corners = [];
  for (let i = 0; i < 8; i++) {
    corners.push(new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    ));
  }
  const probe = new THREE.Vector3();
  for (let pass = 0; pass < 3; pass++) {
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    let extent = 0;
    for (const corner of corners) {
      probe.copy(corner).project(camera);
      extent = Math.max(extent, Math.abs(probe.x), Math.abs(probe.y));
    }
    if (!Number.isFinite(extent) || extent < 0.001) break;
    dist *= extent / 0.86;
  }
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.lookAt(center);
  camera.near = Math.max(0.05, dist / 2000);
  camera.far = dist + radius * 8 + 100;
  camera.updateProjectionMatrix();

  renderer.render(scene, camera);
  let url = '';
  try { url = renderer.domElement.toDataURL('image/webp', 0.85); } catch { /* fall through */ }
  if (!url || !url.startsWith('data:image/')) {
    try { url = renderer.domElement.toDataURL('image/png'); } catch { url = ''; }
  }

  for (const mesh of meshes) {
    scene.remove(mesh);
    mesh.geometry.dispose();
  }
  return url;
}
