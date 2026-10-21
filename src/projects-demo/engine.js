import * as THREE from 'three';
import { state, params, bus } from '../store.js';
import {
  loadSTLBuffers, syncPlateMesh, emitModelInfo, placeModelAtLift, setSelection, onPlateChanged, raiseH, removeParts,
} from '../core/model.js';
import { rebuildStructure, runGenSup } from '../core/support.js';
import { runSliceAnalysis } from '../core/inspect.js';
import { frameParts, camera, getControls } from '../core/scene.js';
import { setParam } from '../demo/bridge.js';
import { geometryOf, stlFromGeometry, stlFromPositions, machineById, materialById } from './catalog.js';

/* 真实引擎封装：工程描述 ⇄ core 场景。
   工程描述 = { machineId, params（全量快照）, lift, parts[], points[] }：
   - parts：来源（gen / file / blob）+ 变换（ox / oy / oz / q）+ 保护面（局部面号）
   - points：支撑点，坐标存零件局部系（零件挪位、插进别的工程都不失效），part 为零件序号
   恢复顺序按 .ref/proj-roundtrip 实测验证过的那条：几何 → 变换 / 保护面 → 参数 → 抬高状态 → 逐层分析 →
   支撑点（零件序号 → 本次运行时 id）→ rebuildStructure。抬高状态必须先于分析写回，否则 syncModelLift
   会把已含抬高的支撑点再平移一次（实测 324 点里 251 点无法路由）。 */

const partMeta = new WeakMap();   // 运行时零件 → { uid, src, libId }
export const metaOf = part => partMeta.get(part) || {};
let uidSeq = 0;
export const newUid = () => `pt${Date.now().toString(36)}${(++uidSeq).toString(36)}`;

/* ---------- 坐标：世界系 ⇄ 零件局部系（与 core/model.js 的 xformCorner 互逆） ---------- */

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

function toLocal(part, x, y, z, lift) {
  const cy = part.base.y / 2;
  _v.set(x - part.ox, y - lift - cy - (part.oy || 0), z - part.oz);
  _q.copy(part.q).invert();
  _v.applyQuaternion(_q);
  return [_v.x, _v.y + cy, _v.z];
}

function toWorld(part, x, y, z, lift) {
  const cy = part.base.y / 2;
  _v.set(x, y - cy, z).applyQuaternion(part.q);
  return [_v.x + part.ox, _v.y + cy + (part.oy || 0) + lift, _v.z + part.oz];
}

function rotateN(part, n, inverse) {
  if (!n) return [0, -1, 0];
  _q.copy(part.q);
  if (inverse) _q.invert();
  _v.set(n[0], n[1], n[2]).applyQuaternion(_q);
  return [_v.x, _v.y, _v.z];
}

/** 支撑点属于哪个零件：优先 partId，没有就按 XZ 落在哪个零件的包围盒里 */
function partIndexOf(p, idIndex) {
  if (p.partId != null && idIndex.has(p.partId)) return idIndex.get(p.partId);
  let best = 0, bestD = Infinity;
  state.parts.forEach((part, i) => {
    const d = Math.hypot(p.x - part.ox, p.z - part.oz);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/* ---------- 采集：当前场景 → 工程描述 ---------- */

export function captureScene() {
  const lift = raiseH();
  const parts = state.parts.map(p => {
    const meta = partMeta.get(p) || {};
    return {
      uid: meta.uid || newUid(),
      name: p.name,
      src: meta.src && meta.src.kind !== 'mem' ? meta.src : null,   // 没来源 / 只在内存里的，由调用方落成 blob
      libId: meta.libId || null,
      ox: p.ox, oy: p.oy || 0, oz: p.oz,
      q: [p.q.x, p.q.y, p.q.z, p.q.w],
      protected: [...p.protected],
      nf: p.nf,
      size: { x: +p.size.x.toFixed(2), y: +p.size.y.toFixed(2), z: +p.size.z.toFixed(2) },
    };
  });
  // 用户在 Studio 里直接打开的模型没有登记来源：把局部几何交给调用方存成 blob
  const blobs = [];
  state.parts.forEach((p, i) => {
    if (!parts[i].src) blobs.push({ index: i, positions: p.geom.attributes.position.array.slice() });
  });
  const idIndex = new Map(state.parts.map((p, i) => [p.id, i]));
  const points = (state.supportPoints || []).map(p => {
    const i = partIndexOf(p, idIndex);
    const part = state.parts[i];
    const [x, y, z] = toLocal(part, p.x, p.y, p.z, lift);
    const a = p.ax !== undefined ? toLocal(part, p.ax, p.ay, p.az, lift) : [x, y, z];
    const { state: _derived, partId: _pid, x: _x, y: _y, z: _z, ax: _ax, ay: _ay, az: _az, n, ...rest } = p;
    return { ...rest, part: i, x, y, z, ax: a[0], ay: a[1], az: a[2], n: rotateN(part, n, true) };
  });
  return {
    params: JSON.parse(JSON.stringify(params)),
    lift: { supportLiftOn: !!state.supportLiftOn, joinLift: state.joinLift || 0 },
    parts,
    points,
    blobs,
    stats: sceneStats(),
  };
}

export function sceneStats() {
  const s = state.supportStats || {};
  const P = state.supportPoints || [];
  let tris = 0;
  for (const it of state.supports || []) {
    const g = it.mesh.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  }
  const faces = state.parts.reduce((n, p) => n + p.nf, 0);
  let height = 0;
  for (const p of state.parts) height = Math.max(height, (p.oy || 0) + p.size.y);
  return {
    parts: state.parts.length,
    faces,
    points: P.length,
    ok: s.ok ?? P.filter(p => ['ground', 'mesh', 'micro'].includes(p.state)).length,
    failed: P.filter(p => p.state === 'nohead' || p.state === 'unroutable').length,
    tris,
    height: +(height + raiseH()).toFixed(2),
  };
}

/** 内容签名：只看会进工程文件的东西（零件、位置、保护面、支撑点、参数），选中 / 视角变化不算修改 */
export function sceneSignature() {
  const r = v => Math.round(v * 1000);
  let h = 2166136261;
  const mix = s => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } };
  for (const p of state.parts) mix(`${p.name}|${p.nf}|${r(p.ox)}|${r(p.oy || 0)}|${r(p.oz)}|${r(p.q.x)},${r(p.q.y)},${r(p.q.z)}|${p.protected.size};`);
  for (const p of state.supportPoints || []) mix(`${r(p.ax ?? p.x)},${r(p.ay ?? p.y)},${r(p.az ?? p.z)}${p.manual ? 'm' : ''};`);
  mix(JSON.stringify(params));
  mix(`${state.supportLiftOn ? 1 : 0}|${r(state.joinLift || 0)}`);
  return (h >>> 0).toString(36);
}

/* ---------- 恢复：工程描述 → 当前场景 ---------- */

async function stlOf(src, getBlob) {
  if (src.kind === 'mem') return stlFromPositions(src.positions);   // 暂存里还没落盘的几何
  if (src.kind === 'blob') {
    const buf = await getBlob(src.hash);
    if (!buf) throw new Error('模型文件缺失（' + src.hash.slice(0, 8) + '）');
    return stlFromPositions(new Float32Array(buf));
  }
  const g = await geometryOf(src);
  return g.stl || stlFromGeometry(g);
}

/** 机器参数直接写 params（不经 demo/machines.js 的 selectMachine：那会把机型记进产品的 localStorage） */
export function applyMachine(id) {
  const m = machineById(id);
  if (!m) return;
  params.plateX = m.plateX;
  params.plateZ = m.plateZ;
  params.pixelUm = m.pixelUm;
  if (Number.isFinite(m.plateY)) params.plateY = m.plateY;
  setParam('pixelUm', m.pixelUm);
  onPlateChanged();
}

/**
 * 打开工程描述。onStep(label, progress) 报告进度；getBlob(hash) 取导入零件的几何。
 * 返回 { ms }。
 */
export async function openScene(desc, { onStep = () => {}, getBlob = async () => null } = {}) {
  const t0 = performance.now();
  onStep('读取工程文件', 0.06);
  if (desc.machineId) applyMachine(desc.machineId);
  for (const [k, v] of Object.entries(desc.params || {})) if (k in params) params[k] = v;
  setParam('layerH', params.layerH);   // 通知订阅参数的界面刷新一次
  onPlateChanged();

  onStep('载入零件', 0.16);
  const parts = desc.parts || [];
  if (!parts.length) {
    if (state.parts.length) removeParts(state.parts.map(p => p.id), { record: false, quiet: true });
    state.supportLiftOn = false;
    state.joinLift = 0;
    onStep(null, 1);
    return { ms: performance.now() - t0 };
  }
  // core 按扩展名认格式：名字不带 .stl 会被当成不支持的文件跳过（场景里还是原来的模型），载入后再把名字改回来
  const items = [];
  for (const p of parts) items.push({ buf: await stlOf(p.src, getBlob), name: /\.stl$/i.test(p.name) ? p.name : `${p.name}.stl` });
  const before = new Set(state.parts);
  await loadSTLBuffers(items, { append: false });
  if (state.parts.length !== parts.length || state.parts.some(p => before.has(p))) {
    throw new Error(`零件载入不全：${state.parts.filter(p => !before.has(p)).length} / ${parts.length}`);
  }
  state.parts.forEach((p, i) => {
    const d = parts[i];
    p.name = d.name;
    partMeta.set(p, { uid: d.uid || newUid(), src: d.src, libId: d.libId || null });
    if (d.ox != null) { p.ox = d.ox; p.oy = d.oy || 0; p.oz = d.oz; }
    if (d.q) p.q.set(d.q[0], d.q[1], d.q[2], d.q[3]);
    p.protected = new Set(d.protected || []);
  });
  syncPlateMesh();
  emitModelInfo();

  // 抬高状态先于分析写回
  state.supportLiftOn = !!desc.lift?.supportLiftOn;
  state.joinLift = desc.lift?.joinLift || 0;
  placeModelAtLift();
  setSelection(state.parts.map(p => p.id));
  frameParts(state.parts, { animate: false });

  const pts = desc.points || [];
  if (pts.length) {
    onStep('逐层分析', 0.32);
    await runSliceAnalysis();
    const lift = raiseH();
    const ids = state.parts.map(p => p.id);
    state.supportPoints = pts.map(s => {
      const part = state.parts[s.part];
      const [x, y, z] = toWorld(part, s.x, s.y, s.z, lift);
      const [ax, ay, az] = toWorld(part, s.ax, s.ay, s.az, lift);
      const { part: _idx, ...rest } = s;
      return { ...rest, x, y, z, ax, ay, az, n: rotateN(part, s.n, false), partId: ids[s.part] };
    });
    onStep('重建支撑结构', 0.62);
    await rebuildStructure();
  }
  setSelection([]);   // 恢复时为了让分析覆盖全部零件而全选，完成后取消，免得画面上挂着选框
  frameScene();
  onStep(null, 1);
  return { ms: performance.now() - t0 };
}

/* ---------- 取景：按「模型 + 支撑 + 平台面」整体取景（Studio 自带的取景只看模型，加了支撑和抬高后会显得挤） ---------- */

export function frameScene() {
  const controls = getControls();
  if (!controls || !state.mesh) return;
  const box = new THREE.Box3().setFromObject(state.mesh);
  for (const s of state.supports || []) box.expandByObject(s.mesh);
  box.expandByPoint(new THREE.Vector3(box.min.x, 0, box.min.z));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const vfov = camera.fov * Math.PI / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (camera.aspect || 1.6));
  // 两侧各有一列浮动卡片挡着，按 1.32 倍留边
  const dist = sphere.radius / Math.sin(Math.min(vfov, hfov) / 2) * 1.32;
  const dir = new THREE.Vector3(0.6, 0.42, 0.9).normalize();
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  camera.updateProjectionMatrix();
  controls.update();
}

/* ---------- 零件放置：新零件放到已有零件右侧，放不下就换一行 ---------- */

export function placeNewPart(desc, size) {
  const plateX = params.plateX || 150, plateZ = params.plateZ || 85;
  const gap = 6, margin = 4;
  const boxes = (desc.parts || []).filter(p => p.size && p.ox != null).map(p => ({
    x0: p.ox - p.size.x / 2, x1: p.ox + p.size.x / 2, z0: p.oz - p.size.z / 2, z1: p.oz + p.size.z / 2,
  }));
  const fits = (x, z) => {
    const b = { x0: x - size.x / 2, x1: x + size.x / 2, z0: z - size.z / 2, z1: z + size.z / 2 };
    if (b.x0 < -plateX / 2 + margin || b.x1 > plateX / 2 - margin || b.z0 < -plateZ / 2 + margin || b.z1 > plateZ / 2 - margin) return false;
    return boxes.every(o => b.x1 + gap <= o.x0 || b.x0 - gap >= o.x1 || b.z1 + gap <= o.z0 || b.z0 - gap >= o.z1);
  };
  if (!boxes.length) return { x: 0, z: 0 };
  for (let z = 0, row = 0; row < 12; row++, z = (row % 2 ? 1 : -1) * Math.ceil(row / 2) * (size.z + gap)) {
    for (let x = -plateX / 2 + margin + size.x / 2; x <= plateX / 2 - margin - size.x / 2; x += 2) {
      if (fits(x, z)) return { x, z };
    }
  }
  const maxX = Math.max(...boxes.map(b => b.x1));
  return { x: maxX + gap + size.x / 2, z: 0 };   // 实在放不下：贴着放到右边，越界由界面提示
}

/* ---------- 生成支撑（真实算法）：进支撑步骤的抬高 + 分析 + 布点 + 结构 ---------- */

export async function generateSupports() {
  if (!state.mesh) return;
  if (!state.supportLiftOn) {
    state.supportLiftOn = true;
    placeModelAtLift();
    state.analysis = null;
  }
  setSelection(state.parts.map(p => p.id));
  if (!state.analysis) await runSliceAnalysis();
  await runGenSup();
}

/* ---------- 越界 / 适配检查 ---------- */

export function footprint(parts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, h = 0;
  for (const p of parts) {
    if (!p.size) continue;
    x0 = Math.min(x0, p.ox - p.size.x / 2); x1 = Math.max(x1, p.ox + p.size.x / 2);
    z0 = Math.min(z0, p.oz - p.size.z / 2); z1 = Math.max(z1, p.oz + p.size.z / 2);
    h = Math.max(h, (p.oy || 0) + p.size.y);
  }
  if (!Number.isFinite(x0)) return null;
  return { w: x1 - x0, d: z1 - z0, h, x0, x1, z0, z1 };
}

/** 当前零件（按现在的摆放）能不能放进某台机器：返回 { ok, over } over 为超出的毫米数 */
export function fitOn(machine, fp, lift = 4) {
  if (!fp || !machine) return { ok: true, over: 0 };
  const overX = Math.max(0, fp.x1 - machine.plateX / 2, -machine.plateX / 2 - fp.x0);
  const overZ = Math.max(0, fp.z1 - machine.plateZ / 2, -machine.plateZ / 2 - fp.z0);
  const overY = Math.max(0, fp.h + lift - machine.plateY);
  const over = Math.max(overX, overZ, overY);
  return { ok: over < 0.01, over, overY };
}

/* ---------- 缩略图：离屏渲染当前场景（模型用材料色，支撑用产品同色） ---------- */

export function renderThumb({ width = 640, height = 400, color = '#9aa0a6' } = {}) {
  if (!state.mesh) return null;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x7d828b, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.7); key.position.set(120, 200, 160); scene.add(key);
  const rim = new THREE.DirectionalLight(0xdfe7ff, 0.8); rim.position.set(-160, 90, -120); scene.add(rim);
  const tint = new THREE.Color(color).lerp(new THREE.Color(0xb7bcc5), 0.3);
  const mats = [
    new THREE.MeshStandardMaterial({ color: tint, roughness: 0.42, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({ color: 0x3a3c41, roughness: 0.55, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({ color: 0xe0242c, roughness: 0.5, metalness: 0.05 }),
  ];
  const add = (geom, mat, src) => {
    const m = new THREE.Mesh(geom, mat);
    src.updateMatrixWorld(true);
    m.matrixAutoUpdate = false;
    m.matrix.copy(src.matrixWorld);
    m.matrixWorld.copy(src.matrixWorld);
    scene.add(m);
    return m;
  };
  const meshes = [add(state.mesh.geometry, mats[0], state.mesh)];
  for (const s of state.supports || []) meshes.push(add(s.mesh.geometry, s.kind === 'anchor' ? mats[2] : mats[1], s.mesh));
  const box = new THREE.Box3();
  for (const m of meshes) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld));
  }
  const cam = new THREE.PerspectiveCamera(30, width / height, 0.5, 5000);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const dist = sphere.radius / Math.sin((30 * Math.PI / 180) / 2) * 0.92;
  cam.position.copy(sphere.center).add(new THREE.Vector3(0.95, 0.62, 1.15).normalize().multiplyScalar(dist));
  cam.near = Math.max(0.5, dist - sphere.radius * 2.5);
  cam.far = dist + sphere.radius * 3;
  cam.lookAt(sphere.center);
  cam.updateProjectionMatrix();
  renderer.render(scene, cam);
  const url = canvas.toDataURL('image/webp', 0.86);
  for (const m of mats) m.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return url;
}

/* ---------- 视口落点：屏幕坐标 → 板面 XZ ---------- */

export function plateHit(clientX, clientY, canvas) {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  ray.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
  return { x: hit.x, z: hit.z };
}

export { state, params, bus, materialById };
