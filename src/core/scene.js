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
import { state, params, bus, log, toast } from '../store.js';
import { loadDemo, loadSTLBuffers, partAtWorld, focusPartFromHit, localFaceOf, raiseH, plateAxisOrigin, meshPick } from './model.js';
import { modelKind } from './meshio.js';
import { addSupportPoint, setSupportSelection, supportSelection, supportIndexNearHit, deleteSupportIndices, prepareSupportColors } from './support.js';
import { initManipulate, tickManipulate } from './manipulate.js';

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.fog = new THREE.Fog(0x0d1117, 300, 900);
export const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 3000);
camera.position.set(95, 75, 95);

/* 光照 = 方向光塑形 + 环境光（IBL）兜底：RoomEnvironment 经 PMREM 预滤波后作 scene.environment，
   等效简单全局光照。支撑检查要求任意角度不死黑：
   - 半球光地面色用中灰蓝（非近黑）——底面/侧下面的基础补光
   - 底部反向填充光（dl3，从下往上打）——抬亮正下方视角
   envMapIntensity 按材质微调。 */
scene.add(new THREE.HemisphereLight(0xcdd9e5, 0x55677e, 0.55));
const dl = new THREE.DirectionalLight(0xffffff, 1.1);
dl.position.set(60, 120, 40); scene.add(dl);
const dl2 = new THREE.DirectionalLight(0x8899aa, 0.35);
dl2.position.set(-80, 40, -60); scene.add(dl2);
const dl3 = new THREE.DirectionalLight(0xaabbcc, 0.5);   // 底部填充：正下视角不死黑
dl3.position.set(-20, -100, 30); scene.add(dl3);
/* 机器打印体积。网格在板面上，范围是当前机型的可打印尺寸。
   角上的轴按切片软件标注：X / Y 在板面（世界 +X / +Z），Z 向上（世界 +Y）。 */
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
    ? { grid: 0x3c4c60, edge: 0x93a6bd, cage: 0x2c3a4c, x: 0xe25b5b, y: 0x3dbe74, z: 0x4c8dff }
    : { grid: 0xb4bec9, edge: 0x5c6b7c, cage: 0xc5ced6, x: 0xd64545, y: 0x1f9d55, z: 0x2f6fe0 };
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
  const py = Math.max(20, params.plateY || 175);
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
  const cage = [
    -hx, 0, -hz, -hx, py, -hz, hx, 0, -hz, hx, py, -hz,
    hx, 0, hz, hx, py, hz, -hx, 0, hz, -hx, py, hz,
    -hx, py, -hz, hx, py, -hz, hx, py, -hz, hx, py, hz,
    hx, py, hz, -hx, py, hz, -hx, py, hz, -hx, py, -hz,
  ];
  const group = new THREE.Group();
  group.name = 'buildVolume';
  group.add(lineSegments(grid, dark ? 0x3c4c60 : 0xb4bec9, 'grid'));
  group.add(lineSegments(edge, dark ? 0x93a6bd : 0x5c6b7c, 'edge'));
  group.add(lineSegments(cage, dark ? 0x2c3a4c : 0xc5ced6, 'cage'));

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
  color: 0xb9c2cf, roughness: 0.55, metalness: 0.15, vertexColors: true, envMapIntensity: 0.45
});
export const supMat = new THREE.MeshStandardMaterial({ color: 0x38d996, roughness: 0.5, metalness: 0.05, envMapIntensity: 0.4 });
export const supMatAnchor = new THREE.MeshStandardMaterial({ color: 0xffb020, roughness: 0.5, metalness: 0.05, envMapIntensity: 0.4 });
export const supMatBase = new THREE.MeshStandardMaterial({ color: 0x7d8aa0, roughness: 0.7, metalness: 0.05, envMapIntensity: 0.4 });   // 格架底座整板

/* 预览渲染器（朝向候选缩略图；preserveDrawingBuffer 供 toDataURL 出图，React 渲染 <img>） */
export const prevRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
prevRenderer.setSize(112, 112);
export const prevScene = new THREE.Scene();
prevScene.background = new THREE.Color(0x0d1117);
prevScene.add(new THREE.HemisphereLight(0xcdd9e5, 0x0d1117, 1.3));
const pdl = new THREE.DirectionalLight(0xffffff, 1.6); pdl.position.set(60, 120, 40); prevScene.add(pdl);
export const prevCam = new THREE.PerspectiveCamera(40, 1, 0.1, 3000);
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
  state.mode = m;
  // 右键旋转、中键平移，各模式都一样。左键不转视角：旋转模式用来点选和框选，
  // 其余模式留给涂画 / 加支撑 / 删支撑。
  controls.enabled = true;
  controls.mouseButtons.LEFT = null;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
  controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  canvas.style.cursor = m === 'orbit' ? 'default' : 'crosshair';
  if (m === 'del') prepareSupportColors();
  else setSupportSelection([]);
  cancelSupBox();
  bus.emit('mode', m);
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

/** 单击：优先打在支撑杆身上，其次才是屏幕上的支撑点。只选中，不删除。 */
function pickClickedSupport(x, y) {
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
  if (typingTarget()) return;
  if (document.querySelector('dialog[open], [role="dialog"][data-state="open"]')) return;
  const hot = supportHotkeys || state.mode === 'add' || state.mode === 'del';
  const k = (e.key || '').toLowerCase();
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
  camera.position.lerpVectors(camTween.from, camTween.to, k);
  controls.target.lerpVectors(camTween.t0, camTween.target, k);
  if (u >= 1) camTween = null;
}

/* ================================================================
   初始化：renderer / controls / 事件 / 动画循环 / 启动流程
================================================================ */
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
      const hits = pointerRay(e).intersectObject(state.mesh);
      if (!hits.length) return;   // 没点到模型：不加支撑。旋转改由右键，平移改由中键
      e.stopPropagation();
      const h = hits[0];
      if (state.protectedFaces.has(h.faceIndex)) { toast('该面为保护面，已阻止添加支撑'); return; }
      // 命中面法线作为接触端朝向（模型仅平移变换，几何面法线即世界系方向）；朝上的面无从支撑
      const fn = h.face ? h.face.normal : null;
      if (fn && fn.y > 0.3) { toast('只能在朝下（悬空）的表面添加支撑点'); return; }
      // 点到另一件模型时把摄影机跳过去，方便接着在这件上加点
      focusPartFromHit(partAtWorld(h.point.x, h.point.z));
      // 加点后整体重建结构（树/格架分支互连，不能单根追加）——与 PrusaSlicer 的支撑点编辑一致
      addSupportPoint(h.point, fn ? [fn.x, fn.y, fn.z] : null);
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
    // 加支撑：悬在模型上是十字准星，空白处恢复默认箭头（旋转是右键，平移是中键）
    if (state.mode === 'add' && state.mesh && e.buttons === 0) {
      canvas.style.cursor = meshPick(pointerRay(e).ray) ? 'crosshair' : 'default';
    }
  });
  window.addEventListener('pointerup', () => { state.painting = false; });

  /* 拖放 STL / OBJ / 3MF。不支持的文件直接提示，不清掉板上已有的模型。 */
  window.addEventListener('dragover', e => { e.preventDefault(); bus.emit('dropHint', true); });
  window.addEventListener('dragleave', e => { if (e.target === document.body || e.target === canvas.parentElement) bus.emit('dropHint', false); });
  window.addEventListener('drop', e => {
    e.preventDefault(); bus.emit('dropHint', false);
    const files = [...e.dataTransfer.files].filter(f => modelKind(f.name));
    if (!files.length) { if (e.dataTransfer.files.length) toast('请拖入 .stl、.obj 或 .3mf 文件'); return; }
    // 板上已有真实模型时追加，只有演示模型时换成拖进来的这一批
    const append = state.parts.some(p => !p.demo);
    Promise.all(files.map(async f => ({ buf: await f.arrayBuffer(), name: f.name })))
      .then(items => loadSTLBuffers(items, { append }));
  });

  initManipulate(canvas);

  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    stepCamera(performance.now());
    tickManipulate();
    renderer.render(scene, camera);
  })();

  /* 启动 */
  resize();
  updateBuildVolume();
  loadDemo('knot');
  log('ResinForge v0.1 就绪：像素级切片 + 多目标朝向优化 + 孤岛检测 + 语义保护面权重', 'ok');
  log('流程：载入模型 → 朝向优化 → (涂保护面) → 逐层分析 → 生成支撑 → 导出 STL');
}
