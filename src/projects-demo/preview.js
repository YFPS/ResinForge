import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { geometryOf } from './catalog.js';

/* 不进场景的 3D 预览：零件缩略图（入库 / 导入时生成）与检查器里可转动的实时预览。
   几何按 core 的同一套规则归一化（XZ 居中、底面 y=0），支撑点存的就是这个局部系；
   预览里的支撑画成从接触点竖直落到平台的细针（文件里只有支撑点，完整的格架结构要打开工程才重建）。 */

const SUP = 0x3a3c41;

function normalize(g) {
  if (g.index) g = g.toNonIndexed();
  g.computeBoundingBox();
  const bb = g.boundingBox;
  g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  g.computeBoundingBox();
  g.computeVertexNormals();
  return g;
}

const geomCache = new Map();
/** 零件来源 → 归一化的局部几何（缓存，调用方不要 dispose） */
export function localGeometry(src, getBlob) {
  const key = JSON.stringify(src.kind === 'mem' ? { kind: 'mem', n: src.positions.length } : src);
  if (!geomCache.has(key)) {
    geomCache.set(key, (async () => {
      if (src.kind === 'blob') {
        const buf = await getBlob(src.hash);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf.slice(0)), 3));
        return normalize(g);
      }
      if (src.kind === 'mem') {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(src.positions.slice(), 3));
        return normalize(g);
      }
      const out = await geometryOf(src);
      if (out.stl) {
        const g = new STLLoader().parse(out.stl);
        g.rotateX(-Math.PI / 2);
        return normalize(g);
      }
      return normalize(out);
    })());
  }
  return geomCache.get(key);
}

function lights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x7d828b, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(120, 200, 160); scene.add(key);
  const rim = new THREE.DirectionalLight(0xdfe7ff, 0.75); rim.position.set(-160, 90, -120); scene.add(rim);
}

const tintOf = color => new THREE.Color(color).lerp(new THREE.Color(0xb7bcc5), 0.3);

/** 支撑点 → 细针（竖直落到 y = floor），坐标为该组的局部系 */
function pinsFor(points, floor, mat) {
  if (!points.length) return null;
  const g = new THREE.CylinderGeometry(0.28, 0.28, 1, 6, 1, false);
  g.translate(0, 0.5, 0);
  const pins = new THREE.InstancedMesh(g, mat, points.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3();
  points.forEach((p, i) => {
    const h = Math.max(0.1, p.y - floor);
    m4.compose(t.set(p.x, floor, p.z), q, s.set(1, h, 1));
    pins.setMatrixAt(i, m4);
  });
  return pins;
}

/**
 * 组装一个可渲染的组：parts = [{ geom, ox, oy, oz, q }]（geom 为局部几何），points 为世界系支撑点。
 * lift：模型抬高（支撑点已含）。
 */
function assemble(parts, points, { color, lift = 0 }) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: tintOf(color), roughness: 0.42, metalness: 0.05 });
  const supMat = new THREE.MeshStandardMaterial({ color: SUP, roughness: 0.55, metalness: 0.05 });
  for (const p of parts) {
    const mesh = new THREE.Mesh(p.geom, mat);
    const cy = p.geom.boundingBox.max.y / 2;
    // 与 core 的 xformCorner 一致：绕零件中心转，再平移到 (ox, oy, oz)，整体抬高 lift
    const pivot = new THREE.Group();
    pivot.position.set(p.ox || 0, cy + (p.oy || 0) + lift, p.oz || 0);
    if (p.q) pivot.quaternion.set(p.q[0], p.q[1], p.q[2], p.q[3]);
    mesh.position.set(0, -cy, 0);
    pivot.add(mesh);
    group.add(pivot);
  }
  const pins = pinsFor(points, 0, supMat);
  if (pins) group.add(pins);
  group.userData.dispose = () => { mat.dispose(); supMat.dispose(); if (pins) { pins.geometry.dispose(); pins.dispose(); } };
  return group;
}

function frame(camera, object, aspect) {
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const fov = camera.fov * Math.PI / 180;
  const dist = sphere.radius / Math.sin(fov / 2) * (aspect < 1 ? 1.05 / aspect : 1.0);
  camera.position.copy(sphere.center).add(new THREE.Vector3(0.95, 0.62, 1.15).normalize().multiplyScalar(dist));
  camera.near = Math.max(0.3, dist - sphere.radius * 3);
  camera.far = dist + sphere.radius * 4;
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
  return sphere.center;
}

/** 零件缩略图：单个零件（局部系）+ 它的支撑点（局部系，part 字段忽略） */
export function renderPartThumb(geom, points, { width = 480, height = 400, color = '#a3a9b2' } = {}) {
  if (!geom) return null;
  let g = geom;
  if (!g.boundingBox) g.computeBoundingBox();
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  lights(scene);
  const lift = points.length ? 4 : 0;
  const world = points.map(p => ({ x: p.x, y: p.y + lift, z: p.z }));
  const group = assemble([{ geom: g }], world, { color, lift });
  scene.add(group);
  const cam = new THREE.PerspectiveCamera(30, width / height, 0.3, 5000);
  frame(cam, group, width / height);
  renderer.render(scene, cam);
  const url = canvas.toDataURL('image/webp', 0.86);
  group.userData.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return url;
}

/**
 * 可转动的实时预览，挂在一个 canvas 上。update({ parts, points, color, lift }) 换内容。
 * 返回 { update, dispose }。
 */
export function createLivePreview(canvas, { autoRotate = true } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  lights(scene);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.3, 5000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  controls.autoRotate = autoRotate && !reduce;
  controls.autoRotateSpeed = 1.2;
  let current = null;
  let raf = 0;
  let alive = true;

  const resize = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  const loop = () => {
    if (!alive) return;
    raf = requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  };
  loop();

  function update({ parts, points, color, lift }) {
    if (current) { scene.remove(current); current.userData.dispose(); }
    current = assemble(parts, points, { color, lift });
    scene.add(current);
    resize();
    const center = frame(camera, current, camera.aspect || 1);
    controls.target.copy(center);
    controls.update();
  }

  function dispose() {
    alive = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    if (current) current.userData.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
  }

  return { update, dispose };
}

/** 工程描述 / 零件库条目 → 预览用的零件与世界系支撑点 */
export async function previewInputOf(item, getBlob) {
  if (item.desc) {
    const d = item.desc;
    const lift = (d.lift?.supportLiftOn ? (d.params?.raiseH ?? 4) : 0) + (d.lift?.joinLift || 0);
    const parts = await Promise.all(d.parts.map(async p => ({ ...p, geom: await localGeometry(p.src, getBlob) })));
    const points = (d.points || []).map(s => {
      const part = parts[s.part];
      if (!part) return null;
      const cy = part.geom.boundingBox.max.y / 2;
      const v = new THREE.Vector3(s.x, s.y - cy, s.z);
      if (part.q) v.applyQuaternion(new THREE.Quaternion(part.q[0], part.q[1], part.q[2], part.q[3]));
      return { x: v.x + (part.ox || 0), y: v.y + cy + (part.oy || 0) + lift, z: v.z + (part.oz || 0) };
    }).filter(Boolean);
    return { parts, points, lift };
  }
  const geom = await localGeometry(item.src, getBlob);
  const lift = item.sup?.points?.length ? 4 : 0;
  const points = (item.sup?.points || []).map(p => ({ x: p.x, y: p.y + lift, z: p.z }));
  return { parts: [{ geom }], points, lift };
}
