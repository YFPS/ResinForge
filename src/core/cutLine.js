/* ================================================================
   画线切割：在模型表面点出一圈线 → 沿这一圈把这件模型切成两件（默认加梯形插销）。
   切面默认「随画线」：线有起伏时切口落在模型表面的位置就是画线（曲面切，见 cutCurve.js）；线很平、或「切面」选了「平面」时切最佳拟合平面。
   这个文件管「画线」这一半：交互（点点成线、贴着表面走、封口）、保留的线（显示 / 隐藏 / 删除 / 继续编辑 / 按线切割）、
   线在场景里的绘制（含切面预览）。切开本身在 model.js 的 cutPartByLine，内核是 cutKit.js（manifold-3d，后台线程）。
   线上的点贴在零件的三角形上（零件局部面号 + 重心坐标）：零件移动 / 旋转 / 缩放 / 按面放置之后线跟着走。
   锚着的零件不在了（被删、被切开）就按最后一次的位置画成虚线；撤回之后零件回来，线自动接上。
   切开成功后，线再锚到 A 件的切缝上（见 rebind），之后搬动 A 件线也跟着走。
   线和支撑一样不进存档，刷新即丢。
================================================================ */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { state, params, bus, log, toast } from '../store.js';
import { localFaceOf, raiseH, ensureBakedDisplay, meshPick, pickReady, partTriangle, requestCutPart } from './model.js';
import { fitPlane, PIN_DEFAULTS, FLAT_TOL } from './cutKit.js';
import { frameOf } from './cutGeom.js';
import { loopToLocal } from './cutCurve.js';
import { loopTangled, previewMembrane } from './cutSeam.js';
import { scene, getCanvas, setMode, pointerRay, viewCamera } from './scene.js';

export const CUT_FLAT_TOL = FLAT_TOL;   // 画线偏离拟合平面不超过它就按平面切（界面状态条据此说明）

const LIFT = 0.25;          // 线沿面法线抬出表面的距离（mm）：贴着表面的粗线会被模型的深度挡掉一截
const STEP = 0.6;           // 贴面采样步长（mm）
const CLOSE_PX = 12;        // 指针离起点这么近（屏幕像素）就算点回了起点，可以封口
const DBL_MS = 320;         // 双击间隔
const C_LINE = 0xffb020;    // 保留的线：琥珀色（深浅两种视口底色上都醒目，不与支撑红 / 选中蓝撞色）
const C_LINE_ON = 0xffd36b; // 选中的那一条
const C_DRAFT = 0xffffff;   // 正在画的线
const C_CLOSE = 0x3ee06a;   // 可封口时的起点

let draft = null;           // 正在画：{ partId, ctrl: [pt], legs: [[pt]], hover, rubber: [pt], closable, orig }
let activeId = null;        // 选中的保留线
let lineSeq = 0;
let nameSeq = 0;
let busy = false;           // 切割进行中
let group = null;           // 场景里的 THREE.Group（每次重画整个重建，线很少）
let pruneFlag = false;      // 载入了新模型：下一次刷新时清掉锚着已不在的零件的线
let lastDown = 0;
let lastView = null;
let lastSummary = '';

const raycaster = new THREE.Raycaster();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector2();
const _n = new THREE.Vector3();
const _tri = new Float64Array(9);

/* ---------- 点：贴在零件三角形上 ---------- */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const partMap = () => new Map(state.parts.map(p => [p.id, p]));
const triCount = part => (part.geom && part.geom.attributes.position ? part.geom.attributes.position.count / 3 : 0);

/** 重心坐标 (u 对第 2 个顶点，v 对第 3 个顶点) → 点与面法线，写进 out */
function triPoint(t, u, v, out) {
  const w = 1 - u - v;
  out.x = t[0] * w + t[3] * u + t[6] * v;
  out.y = t[1] * w + t[4] * u + t[7] * v;
  out.z = t[2] * w + t[5] * u + t[8] * v;
  const abx = t[3] - t[0], aby = t[4] - t[1], abz = t[5] - t[2];
  const acx = t[6] - t[0], acy = t[7] - t[1], acz = t[8] - t[2];
  const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
  const l = Math.hypot(nx, ny, nz);
  if (l > 1e-12) { out.nx = nx / l; out.ny = ny / l; out.nz = nz / l; }
  return out;
}

/** 点 p 在三角形 t 里的重心坐标 [u, v]（钳进三角形） */
function baryOf(t, px, py, pz) {
  const abx = t[3] - t[0], aby = t[4] - t[1], abz = t[5] - t[2];
  const acx = t[6] - t[0], acy = t[7] - t[1], acz = t[8] - t[2];
  const apx = px - t[0], apy = py - t[1], apz = pz - t[2];
  const d00 = abx * abx + aby * aby + abz * abz;
  const d01 = abx * acx + aby * acy + abz * acz;
  const d11 = acx * acx + acy * acy + acz * acz;
  const d20 = apx * abx + apy * aby + apz * abz;
  const d21 = apx * acx + apy * acy + apz * acz;
  const den = d00 * d11 - d01 * d01;
  let u = 1 / 3, v = 1 / 3;
  if (Math.abs(den) > 1e-18) { u = (d11 * d20 - d01 * d21) / den; v = (d00 * d21 - d01 * d20) / den; }
  if (u < 0) u = 0;
  if (v < 0) v = 0;
  if (u + v > 1) { const s = u + v; u /= s; v /= s; }
  return [u, v];
}

/** 世界系命中点 + 合并网格面号 → 点。点位存网格局部系（不含 raiseH） */
function makePt(fi, pw) {
  const loc = localFaceOf(fi);
  if (!loc) return null;
  const t = partTriangle(loc.part, loc.local, _tri);
  if (!t) return null;
  const [u, v] = baryOf(t, pw.x, pw.y - raiseH(), pw.z);
  const pt = {
    anchors: [{ pid: loc.part.id, f: loc.local, u, v, nf: triCount(loc.part) }],
    pid: loc.part.id, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0,
  };
  triPoint(t, u, v, pt);
  return pt;
}

/** 点的第一个还能用的锚点：零件还在、面数没变（简化过就对不上了） */
function liveAnchor(pt, byId) {
  for (const a of pt.anchors) {
    const part = byId.get(a.pid);
    if (!part || triCount(part) !== a.nf) continue;
    if (!partTriangle(part, a.f, _tri)) continue;
    return { a, part };
  }
  return null;
}

/** 按零件现在的姿态重新求点位。有任何一个点锚不上就整串不动（沿用上次的位置），返回 false */
function evalPts(pts, byId) {
  const hold = [];
  for (const pt of pts) {
    const hit = liveAnchor(pt, byId);
    if (!hit) return false;
    hold.push({ a: hit.a, t: Array.from(partTriangle(hit.part, hit.a.f, _tri)) });
  }
  for (let i = 0; i < pts.length; i++) {
    triPoint(hold[i].t, hold[i].a.u, hold[i].a.v, pts[i]);
    pts[i].pid = hold[i].a.pid;
  }
  return true;
}

/* ---------- 线：控制点 + 逐段贴面路径 ---------- */

/** 各段首尾相接的点列。闭合：每段都去掉最后一个（它是下一段的头），得到不重复的一圈；开放：最后一段完整保留 */
function chain(legs, closed) {
  const out = [];
  for (let k = 0; k < legs.length; k++) {
    const leg = legs[k];
    const keep = closed || k < legs.length - 1 ? leg.length - 1 : leg.length;
    for (let i = 0; i < keep; i++) {
      const prev = out[out.length - 1];
      if (prev && dist(prev, leg[i]) < 0.02) continue;
      out.push(leg[i]);
    }
  }
  return out;
}

/** 一条线（或草稿）里不重复的全部点对象 */
function uniquePts(ctrl, legs) {
  const set = new Set(ctrl);
  for (const leg of legs) for (const p of leg) set.add(p);
  return [...set];
}

const linePts = line => uniquePts(line.ctrl, line.legs);

/** 射线打到的、朝向射线来处的最近一个面：{ fi, point（世界系 Vector3）}。拾取 BVH 好了走 BVH，没好才逐三角形（少打几条） */
function pickRay(rc) {
  const mesh = state.mesh;
  if (!mesh) return null;
  const dir = rc.ray.direction;
  if (pickReady()) {
    const h = meshPick(rc.ray);
    if (!h) return null;
    const a = mesh.geometry.attributes.position;
    const i = h.face * 3;
    if (i + 2 >= a.count) return null;
    const ax = a.getX(i), ay = a.getY(i), az = a.getZ(i);
    const abx = a.getX(i + 1) - ax, aby = a.getY(i + 1) - ay, abz = a.getZ(i + 1) - az;
    const acx = a.getX(i + 2) - ax, acy = a.getY(i + 2) - ay, acz = a.getZ(i + 2) - az;
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    return nx * dir.x + ny * dir.y + nz * dir.z < 0 ? { fi: h.face, point: h.point } : null;
  }
  const hits = rc.intersectObject(mesh, false);
  for (const h of hits) {
    if (!h.face) continue;
    _n.copy(h.face.normal).transformDirection(mesh.matrixWorld);
    if (_n.dot(dir) < 0) return { fi: h.faceIndex != null ? h.faceIndex : h.face.a / 3, point: h.point };
  }
  return null;
}

/** 沿屏幕上 a→b 的连线逐点打回模型，得到贴在表面上的一串点（首尾就是 a、b）。只认同一件零件上的命中 */
function legBetween(a, b, view, partId) {
  const span = dist(a, b);
  if (span < 1e-4) return [a];
  const lift = raiseH();
  const cam = view.camera;
  _v.set(a.x, a.y + lift, a.z).project(cam);
  const ax = _v.x, ay = _v.y;
  _v.set(b.x, b.y + lift, b.z).project(cam);
  const bx = _v.x, by = _v.y;
  const steps = Math.max(2, Math.min(pickReady() ? 100 : 20, Math.ceil(span / STEP)));
  const limit = Math.max(16, span * span * 0.55);
  const out = [a];
  let prev = a;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    _v2.set(ax + (bx - ax) * t, ay + (by - ay) * t);
    raycaster.setFromCamera(_v2, cam);
    const h = pickRay(raycaster);
    if (!h) continue;
    const loc = localFaceOf(h.fi);
    if (!loc || loc.part.id !== partId) continue;
    // 偏离 a→b 直线太远的命中是屏幕连线擦过了别的表面（轮廓背后），丢掉
    const ex = a.x + (b.x - a.x) * t, ey = a.y + (b.y - a.y) * t, ez = a.z + (b.z - a.z) * t;
    const off = (h.point.x - ex) ** 2 + (h.point.y - lift - ey) ** 2 + (h.point.z - ez) ** 2;
    if (off > limit) continue;
    const p = makePt(h.fi, h.point);
    if (!p) continue;
    if (dist(prev, p) > Math.max(5, span * 0.45)) continue;
    out.push(p);
    prev = p;
  }
  // 终点就是 b 本身：最后一个采样点离 b 太近（< 0.05mm）就让它让位，免得出现两个几乎重合的点
  if (prev === a || dist(prev, b) > 0.05) out.push(b);
  else out[out.length - 1] = b;
  return out;
}

/** 点 p 此刻在当前视角下看得见（射线先打到的就是它附近的表面） */
function visibleFrom(view, p) {
  _v.set(p.x, p.y + raiseH(), p.z).project(view.camera);
  if (_v.z > 1) return false;
  _v2.set(_v.x, _v.y);
  raycaster.setFromCamera(_v2, view.camera);
  const h = pickRay(raycaster);
  if (!h) return false;
  return Math.hypot(h.point.x - p.x, h.point.y - raiseH() - p.y, h.point.z - p.z) < 0.8;
}

function viewOf(e) {
  const cv = getCanvas();
  const rect = cv ? cv.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
  lastView = { camera: viewCamera(), width: rect.width || 1, height: rect.height || 1, sx: e ? e.clientX - rect.left : -1e9, sy: e ? e.clientY - rect.top : -1e9 };
  return lastView;
}

const viewNow = () => (lastView ? { ...lastView, camera: viewCamera(), sx: -1e9, sy: -1e9 } : viewOf(null));

/** 指针离草稿起点（屏幕像素）够近，且已经点够 3 个点：再点一下就封口 */
function nearFirst(view) {
  if (!draft || draft.ctrl.length < 3) return false;
  const f = draft.ctrl[0];
  _v.set(f.x, f.y + raiseH(), f.z).project(view.camera);
  if (_v.z > 1) return false;
  const px = (_v.x * 0.5 + 0.5) * view.width;
  const py = (-_v.y * 0.5 + 0.5) * view.height;
  if (Math.hypot(px - view.sx, py - view.sy) > CLOSE_PX) return false;
  // 起点在模型背面时它的投影也可能落在指针底下（正面的点与背面的点重叠在屏幕同一处）：看不见就不算点回了起点
  return visibleFrom(view, f);
}

/* ---------- 画线交互（scene.js 在 cut 模式下转发指针 / 键盘） ---------- */

export function enterCutMode() {
  ensureBakedDisplay();
  log('画线切割：在模型表面依次点出一圈（至少 3 点），点回起点、双击或按 Enter 封口，再点「切割」。Backspace 退回一点，Esc 取消；右键转视角，中键平移', 'ok');
}

export function leaveCutMode() {
  if (draft) cancelDraft();
}

export function isDrawingCut() { return !!draft; }

function clearHover() {
  if (!draft || (!draft.hover && !draft.rubber.length && !draft.closable)) return;
  draft.hover = null;
  draft.rubber = [];
  draft.closable = false;
  redraw();
}

export function clearCutHover() { clearHover(); }

export function moveCutLine(e) {
  if (!draft || busy || !state.mesh) return;
  ensureBakedDisplay();
  const view = viewOf(e);
  const h = pickRay(pointerRay(e));
  if (!h) { clearHover(); return; }
  const loc = localFaceOf(h.fi);
  if (!loc || loc.part.id !== draft.partId) { clearHover(); return; }
  const hp = makePt(h.fi, h.point);
  if (!hp) { clearHover(); return; }
  const last = draft.ctrl[draft.ctrl.length - 1];
  draft.closable = nearFirst(view);
  const target = draft.closable ? draft.ctrl[0] : hp;
  draft.hover = target;
  draft.rubber = legBetween(last, target, view, draft.partId);
  redraw();
}

/** 左键按下。返回 true 表示这次点击归画线（scene.js 据此拦住别的处理） */
export function downCutLine(e) {
  if (busy || !state.mesh) return true;
  ensureBakedDisplay();
  const view = viewOf(e);
  const h = pickRay(pointerRay(e));
  if (!h) return true;
  const loc = localFaceOf(h.fi);
  if (!loc) return true;
  const now = performance.now();
  const dbl = now - lastDown < DBL_MS;
  lastDown = now;
  if (!draft) {
    const pt = makePt(h.fi, h.point);
    if (!pt) return true;
    draft = { partId: loc.part.id, ctrl: [pt], legs: [], hover: pt, rubber: [], closable: false, orig: null };
    activeId = null;
    redraw();
    emitState();
    return true;
  }
  if (loc.part.id !== draft.partId) {
    toast('画线要在同一件模型上，这一点落在另一件上');
    return true;
  }
  const pt = makePt(h.fi, h.point);
  if (!pt) return true;
  const last = draft.ctrl[draft.ctrl.length - 1];
  // 封口：点回起点附近，或在最后一个点上快速双击
  if (draft.ctrl.length >= 3 && (nearFirst(view) || (dbl && dist(last, pt) < 1))) {
    closeDraft(view);
    return true;
  }
  if (dist(last, pt) < 0.4) return true;   // 同一处再点：双击的第二下、或手抖
  draft.legs.push(legBetween(last, pt, view, draft.partId));
  draft.ctrl.push(pt);
  draft.hover = null;
  draft.rubber = [];
  draft.closable = false;
  redraw();
  emitState();
  return true;
}

/** 封口：起点到最后一点补一段，存成一条保留的线并选中。起点转到背面看不见时按直线连 */
function closeDraft(view) {
  if (!draft || draft.ctrl.length < 3) { toast('至少点 3 个点才能围成一圈'); return; }
  const first = draft.ctrl[0];
  const last = draft.ctrl[draft.ctrl.length - 1];
  let leg;
  if (visibleFrom(view, first)) leg = legBetween(last, first, view, draft.partId);
  else {
    leg = [last, first];
    toast('起点在背面，封口那一段按直线连接');
  }
  draft.legs.push(leg);
  const d = draft;
  draft = null;
  let line = d.orig;
  if (line) {
    line.ctrl = d.ctrl;
    line.legs = d.legs;
    line.closed = true;
    line.cut = false;
    line.cutPids = [];
    line.editing = false;
  } else {
    line = { id: ++lineSeq, name: `切割线 ${++nameSeq}`, closed: true, visible: true, cut: false, cutPids: [], editing: false, ctrl: d.ctrl, legs: d.legs, alive: true, partId: d.partId, fit: null };
    state.cutLines.push(line);
  }
  activeId = line.id;
  refresh();
  const f = line.fit;
  const follow = params.cutSurface !== 'plane';
  if (curvedCut(line) && line.geo.tangled) {
    log('切割线已封口，但线在切面方向上自己交叉了（绕成「8」字或重叠），没法让切口沿线走。请重画一圈，或把「切面」改成「平面」', 'warn');
  } else if (follow && f && f.dev > FLAT_TOL) {
    log(`切割线已封口：线有起伏（偏离拟合平面最大 ${f.dev.toFixed(2)} mm），切口会沿画线走，点「切割」`, 'ok');
  } else if (f && f.dev > Math.max(0.5, f.span * 0.03)) {
    log(`切割线已封口。线不在同一平面上（最大偏离 ${f.dev.toFixed(2)} mm），按「平面」切的是最佳拟合平面，切口与画线有出入`, 'warn');
  } else {
    log(`切割线已封口${f ? `（拟合切面偏差 ${f.dev.toFixed(2)} mm）` : ''}，点「切割」沿这一圈切开`, 'ok');
  }
}

function cancelDraft() {
  if (!draft) return;
  if (draft.orig) draft.orig.editing = false;
  draft = null;
  refresh();
}

export function cancelCutDraft() { cancelDraft(); }

/** 退回上一个点 */
function undoLastPoint() {
  if (!draft) return;
  if (draft.ctrl.length <= 1) { cancelDraft(); return; }
  draft.ctrl.pop();
  draft.legs.pop();
  draft.hover = null;
  draft.rubber = [];
  draft.closable = false;
  redraw();
  emitState();
}

/** 画线模式下的键盘。返回 true 表示已处理（scene.js 随后拦住事件） */
export function cutKey(e) {
  const k = (e.key || '').toLowerCase();
  if (k === 'escape') {
    if (!draft) return false;   // 没在画：交给 manipulate 退出模式
    cancelDraft();
    return true;
  }
  if (k === 'enter') {
    if (draft) { closeDraft(viewNow()); return true; }
    const line = state.cutLines.find(l => l.id === activeId);
    if (line && line.alive && line.closed && !busy) {
      runCutLine().catch(err => log(`画线切割失败：${err && err.message ? err.message : err}`, 'warn'));
      return true;
    }
    return false;
  }
  if (k === 'backspace') {
    if (!draft) return false;
    undoLastPoint();
    return true;
  }
  if (k === 'delete') {
    // 画线模式下 Delete 只管线，不误删选中的模型
    if (draft) cancelDraft();
    else if (activeId != null) removeCutLine(activeId);
    else toast('没有选中的切割线。要删模型请先退出画线切割');
    return true;
  }
  return false;
}

/* ---------- 保留的线 ---------- */

export function selectCutLine(id) {
  activeId = state.cutLines.some(l => l.id === id) ? id : null;
  refresh();
}

export function setCutLineVisible(id, on) {
  const line = state.cutLines.find(l => l.id === id);
  if (!line) return;
  line.visible = on == null ? !line.visible : !!on;
  refresh();
}

export function removeCutLine(id) {
  const i = state.cutLines.findIndex(l => l.id === id);
  if (i < 0) return;
  state.cutLines.splice(i, 1);
  if (activeId === id) activeId = state.cutLines.length ? state.cutLines[state.cutLines.length - 1].id : null;
  refresh();
}

export function clearCutLines() {
  if (draft) cancelDraft();
  state.cutLines.length = 0;
  activeId = null;
  refresh();
}

/** 继续编辑：把封好的线重新打开，去掉封口那一段，接着点（回车 / 点回起点再封口）。进画线模式 */
export function editCutLine(id) {
  const line = state.cutLines.find(l => l.id === id);
  if (!line) return;
  if (draft) { toast('先封口或取消正在画的线'); return; }
  if (!line.alive) { toast('这条线锚着的模型已不在板上，没法继续编辑'); return; }
  if (line.cut) { toast('这条线已经切过了，留着只作标记。要改请先撤回，或另画一条'); return; }
  line.editing = true;
  line.visible = true;
  draft = { partId: line.partId, ctrl: line.ctrl.slice(), legs: line.legs.slice(0, -1), hover: null, rubber: [], closable: false, orig: line };
  activeId = line.id;
  if (state.mode !== 'cut') setMode('cut');
  refresh();
  toast('已展开这条线，接着点或按 Enter 再封口');
}

/** 当前连接件设置 → 内核的 pin 参数（null = 只切不加销） */
export function cutPinSpec() {
  if (params.cutPin !== 'trapezoid') return null;
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    size: num(params.cutPinSize, 2, 40, PIN_DEFAULTS.size),
    depth: num(params.cutPinDepth, 2, 40, PIN_DEFAULTS.depth),
    clear: num(params.cutPinClear, 0, 1, PIN_DEFAULTS.clear),
    taper: PIN_DEFAULTS.taper,
    aspect: PIN_DEFAULTS.aspect,
  };
}

/* ---------- 切割 ---------- */

/** 点 (px,py,pz) 到三角形（顶点在 t[o..o+8]）的最近点，返回距离²，重心坐标写进 out（Ericson 5.1.5） */
function closestBary(px, py, pz, t, o, out) {
  const ax = t[o], ay = t[o + 1], az = t[o + 2];
  const abx = t[o + 3] - ax, aby = t[o + 4] - ay, abz = t[o + 5] - az;
  const acx = t[o + 6] - ax, acy = t[o + 7] - ay, acz = t[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u, v;
  const bpx = px - t[o + 3], bpy = py - t[o + 4], bpz = pz - t[o + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  const cpx = px - t[o + 6], cpy = py - t[o + 7], cpz = pz - t[o + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
  if (d1 <= 0 && d2 <= 0) { u = 0; v = 0; }
  else if (d3 >= 0 && d4 <= d3) { u = 1; v = 0; }
  else if (vc <= 0 && d1 >= 0 && d3 <= 0) { u = d1 / (d1 - d3); v = 0; }
  else if (d6 >= 0 && d5 <= d6) { u = 0; v = 1; }
  else if (vb <= 0 && d2 >= 0 && d6 <= 0) { u = 0; v = d2 / (d2 - d6); }
  else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 1 - w; v = w; }
  else { const den = 1 / (va + vb + vc); u = vb * den; v = vc * den; }
  out[0] = u;
  out[1] = v;
  const qx = ax + abx * u + acx * v - px, qy = ay + aby * u + acy * v - py, qz = az + abz * u + acz * v - pz;
  return qx * qx + qy * qy + qz * qz;
}

const REBIND_R = 1;       // 点接到切块上，离最近的三角形不超过这么远（mm）；点本来就贴着表面，正常几乎是 0
const NORMAL_W = 0.02;    // 距离相近时偏向法线接近的三角形：每差 1 的法线点积折合 0.02 mm² 的距离²（约 0.14 mm）

/**
 * 一串点各自接到若干零件上离得最近的三角形。只看外接盒与这串点外接盒（外扩 r）相交的三角形，离得超过 r 的点算接不上。
 * 距离相近（共面 / 共边）时偏向法线与点原来法线接近的三角形：切缝上的点既落在侧壁的三角形上、也落在切面（盖）的三角形上，
 * 接到盖上会让线沿盖的法线抬出去，悬在半空。返回与 pts 同序的锚点 [{ pid, f, u, v, nf }]；有任何一点接不上返回 null。
 */
function nearestAnchors(pts, parts, r) {
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  x0 -= r; y0 -= r; z0 -= r; x1 += r; y1 += r; z1 += r;
  const r2 = r * r;
  const bary = [0, 0];
  const best = new Float64Array(pts.length).fill(Infinity);
  const picks = new Array(pts.length).fill(null);
  for (const part of parts) {
    const n = triCount(part);
    for (let f = 0; f < n; f++) {
      const t = partTriangle(part, f, _tri);
      if (!t) continue;
      // 三角形外接盒与这串点的外接盒不相交：不可能有点接到它
      if (Math.max(t[0], t[3], t[6]) < x0 || Math.min(t[0], t[3], t[6]) > x1) continue;
      if (Math.max(t[1], t[4], t[7]) < y0 || Math.min(t[1], t[4], t[7]) > y1) continue;
      if (Math.max(t[2], t[5], t[8]) < z0 || Math.min(t[2], t[5], t[8]) > z1) continue;
      const abx = t[3] - t[0], aby = t[4] - t[1], abz = t[5] - t[2];
      const acx = t[6] - t[0], acy = t[7] - t[1], acz = t[8] - t[2];
      let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const d2 = closestBary(p.x, p.y, p.z, t, 0, bary);
        if (d2 > r2) continue;
        const dn = Math.max(-1, Math.min(1, p.nx * nx + p.ny * ny + p.nz * nz));
        const score = d2 + NORMAL_W * (1 - dn);
        if (score < best[i]) { best[i] = score; picks[i] = { pid: part.id, f, u: bary[0], v: bary[1], nf: n }; }
      }
    }
  }
  return picks.every(Boolean) ? picks : null;
}

/**
 * 切开之后把线锚到 A 件的切缝上：每个点接到 A 上离得最近的三角形（切缝上的点落在 A 的侧壁与切面交线上）。
 * 新锚点排在最前；撤回时 A 不在了，会退回到原来的锚点（原零件回来），不丢。
 */
function rebind(line, part) {
  const pts = linePts(line);
  const picks = nearestAnchors(pts, [part], REBIND_R);
  if (!picks) return false;
  pts.forEach((p, i) => p.anchors.unshift(picks[i]));
  return true;
}

/**
 * 被切开的这一件上还有别的线（先画好几条、再逐条切）：切完把它们的点各自接到切出来的两件上离得最近的三角形，
 * 线还能接着切、跟着搬。新锚点排在最前；撤回时两件被摘掉，自动退回原零件上的锚点。
 * 离不到 1 mm 以内的点（切面处的数值缝）让这一条放弃，它照旧成为虚线，不乱接。
 * 切之前就已切过的线（spent）把新两件的编号并进 cutPids：再切一刀之后「已切」不会掉成未切，撤回 / 重做也跟得上。
 */
function rebindOthers(oldId, pieces, spent, except) {
  for (const l of state.cutLines) {
    if (l === except || l.partId !== oldId) continue;
    const pts = linePts(l);
    const picks = nearestAnchors(pts, pieces, REBIND_R);
    if (!picks) continue;
    pts.forEach((p, i) => p.anchors.unshift(picks[i]));
    if (spent.has(l.id)) l.cutPids = l.cutPids.concat(pieces.map(p => p.id));
  }
}

/** 沿这条线切开它锚着的那件模型。没传 id 就用选中的；正在画且点够了先封口 */
export async function runCutLine(id) {
  if (busy) return { ok: false, reason: '正在切割，请稍候' };
  if (draft) {
    if (draft.ctrl.length < 3) { toast('至少点 3 个点才能围成一圈'); return { ok: false, reason: '线还没画完' }; }
    closeDraft(viewNow());
  }
  const line = state.cutLines.find(l => l.id === (id != null ? id : activeId));
  if (!line) { toast('先在模型表面画一圈切割线'); return { ok: false, reason: '没有切割线' }; }
  if (!line.alive) { toast('这条线锚着的模型已不在板上（已切开或已删除），没法再切'); return { ok: false, reason: '模型不在了' }; }
  if (line.cut) { toast('这条线已经切过了。要重切请先撤回，或另画一条线'); return { ok: false, reason: '这条线已经切过' }; }
  busy = true;
  emitState();
  const oldId = line.partId;
  // 这一件上、切之前就已经切过的线：切完它们的「已切」要跟到新两件上
  const spent = new Set(state.cutLines.filter(l => l !== line && l.partId === oldId && l.cut).map(l => l.id));
  try {
    const loop = chain(line.legs, true).map(p => ({ x: p.x, y: p.y, z: p.z }));
    const res = await requestCutPart(line.partId, loop, { pin: cutPinSpec(), surface: params.cutSurface === 'plane' ? 'plane' : 'line' });
    if (res.ok) {
      line.cut = true;
      line.cutPids = res.ids.slice();   // 「已切」跟着切出来的两件走：撤回后它们不在了，线回到原零件上、恢复成没切过
      const pieces = res.ids.map(i => state.parts.find(p => p.id === i)).filter(Boolean);
      if (pieces[0]) rebind(line, pieces[0]);
      rebindOthers(oldId, pieces, spent, line);
    } else if (!res.cancelled) {
      toast('画线切割没成功', { tone: 'danger', description: res.reason });
      log(`画线切割没成：${res.reason}`, 'warn');
    }
    return res;
  } finally {
    busy = false;
    refresh();
  }
}

/* ---------- 场景里画出来 ---------- */

function canvasSize() {
  const cv = getCanvas();
  return { w: cv ? Math.max(cv.clientWidth, 1) : 1, h: cv ? Math.max(cv.clientHeight, 1) : 1 };
}

function dropGroup() {
  if (!group) return;
  clearChildren(group);
  if (group.parent) group.parent.remove(group);
  group = null;
}

function clearChildren(g) {
  while (g.children.length) {
    const child = g.children.pop();
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  }
}

function ensureGroup() {
  if (group && group.parent === scene) return group;
  dropGroup();
  group = new THREE.Group();
  group.name = 'cutLines';
  scene.add(group);
  return group;
}

/** 点列 → 一条屏幕像素宽度的线。points 为点对象，沿各自法线抬出表面；orphan 画成半透明虚线 */
function addStroke(g, pts, closed, color, width, orphan) {
  if (pts.length < 2) return;
  const lift = raiseH();
  const arr = [];
  for (const p of pts) arr.push(p.x + p.nx * LIFT, p.y + p.ny * LIFT + lift, p.z + p.nz * LIFT);
  if (closed) arr.push(arr[0], arr[1], arr[2]);
  const { w, h } = canvasSize();
  const mat = new LineMaterial({ color, linewidth: width, depthTest: true, depthWrite: false, worldUnits: false, transparent: !!orphan, opacity: orphan ? 0.6 : 1 });
  mat.toneMapped = false;
  mat.fog = false;
  mat.resolution.set(w, h);
  if (orphan) { mat.dashed = true; mat.dashSize = 1.2; mat.gapSize = 0.8; }
  const geom = new LineGeometry();
  geom.setPositions(arr);
  const line = new Line2(geom, mat);
  if (orphan) line.computeLineDistances();
  line.raycast = () => {};
  line.renderOrder = 4;
  g.add(line);
}

let dotTex = null;
/** 控制点用的圆点贴图（白心 + 深色细边，浅色 / 深色视口底上都看得清）。全局共用一张，不随点集释放 */
function dotTexture() {
  if (dotTex) return dotTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fillStyle = '#2a2d33'; g.fill();
  g.beginPath(); g.arc(32, 32, 23, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill();
  dotTex = new THREE.CanvasTexture(cv);
  return dotTex;
}

/** 控制点：小圆点；起点可封口时亮绿 */
function addNodes(g, pts, firstGreen) {
  if (!pts.length) return;
  const lift = raiseH();
  const pos = [];
  const col = [];
  const c = new THREE.Color();
  pts.forEach((p, i) => {
    pos.push(p.x + p.nx * LIFT, p.y + p.ny * LIFT + lift, p.z + p.nz * LIFT);
    c.set(i === 0 && firstGreen ? C_CLOSE : 0xffffff);
    col.push(c.r, c.g, c.b);
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: firstGreen ? 11 : 9, sizeAttenuation: false, vertexColors: true, map: dotTexture(), alphaTest: 0.5, transparent: true, depthTest: true, depthWrite: false });
  mat.toneMapped = false;
  const nodes = new THREE.Points(geom, mat);
  nodes.raycast = () => {};
  nodes.renderOrder = 5;
  g.add(nodes);
}

/** 选中的封口线：画出拟合切面（半透明圆盘 + 圆环），看得出这一刀会从哪里切过 */
function addPlane(g, line) {
  const f = line.fit;
  if (!f || !line.closed) return;
  const R = Math.min(80, Math.max(4, f.span * 0.8));   // 比画线略大一圈：看得出切面朝向和位置，又不盖住整个模型
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(f.n[0], f.n[1], f.n[2]));
  const at = new THREE.Vector3(f.c[0], f.c[1] + raiseH(), f.c[2]);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 72), new THREE.MeshBasicMaterial({ color: C_LINE, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
  disc.position.copy(at);
  disc.quaternion.copy(q);
  disc.scale.set(R, R, R);
  disc.raycast = () => {};
  disc.renderOrder = 2;
  g.add(disc);
  const ringPts = [];
  for (let i = 0; i < 96; i++) { const a = (i / 96) * Math.PI * 2; ringPts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0)); }
  const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineBasicMaterial({ color: C_LINE, transparent: true, opacity: 0.4, depthWrite: false }));
  ring.position.copy(at);
  ring.quaternion.copy(q);
  ring.scale.set(R, R, R);
  ring.raycast = () => {};
  ring.renderOrder = 2;
  g.add(ring);
}

/* ---------- 切面预览：沿画线时画出真正的切面 ----------
   线有起伏时切口是一张穿过画线的曲面，画一块半透明的平面就骗人了。预览里用与切割同一种膜（画线围成的一圈上张开、
   内部取调和插值）画出画线圈里的那一块：半透明的面 + 稀疏的网线（透视，穿过模型也看得见），一眼看出切口会怎么起伏。
   线在切面方向上自己交叉时没有这样的曲面，不画。 */

/**
 * 这条线在自己的最佳拟合平面局部系里的样子：{ key, fr, L, tangled, sheet }。缓存在 line.geo，线的形状没变就沿用
 * （key 只取决于形状，不含位置：整件平移时只更新 fr，不重算）。sheet 为预览曲面，用到才算（ensureSheet）。
 */
function lineLocal(line) {
  const f = line.fit;
  if (!f || !line.closed) { line.geo = null; return null; }
  const fr = frameOf(f.c, f.n);
  const flat = [];
  for (const p of chain(line.legs, true)) flat.push(p.x, p.y, p.z);
  const L = loopToLocal(flat, fr);
  let sig = L.length;
  for (let i = 0; i < L.length; i++) sig += (L[i][0] * 1.37 + L[i][1] * 2.11 + L[i][2] * 3.07) * ((i % 7) + 1);
  const key = sig.toFixed(3);
  if (line.geo && line.geo.key === key) {
    line.geo.fr = fr;
    return line.geo;
  }
  line.geo = { key, fr, L, tangled: loopTangled(L), sheet: null };
  return line.geo;
}

/** earcut 三角化（three 自带）：主线程没有 manifold，预览膜的初始三角形用它 */
const earcut2 = P2 => THREE.ShapeUtils.triangulateShape(P2.map(p => new THREE.Vector2(p[0], p[1])), []);

/**
 * 预览曲面：与切割时同一种膜（画线围成的一圈上张开，内部高度取调和插值，见 cutSeam.js 的 previewMembrane），
 * 加 u、v 两向各 11 条网线。局部系坐标，画的时候再摆进场景
 */
function ensureSheet(geo) {
  if (geo.sheet !== null) return geo.sheet;
  geo.sheet = false;
  const M = previewMembrane(geo.L, earcut2);
  if (!M) return false;
  const { P, T, heightAt } = M;
  const vs = new Float32Array(P.length * 3);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  P.forEach((p, i) => {
    vs[i * 3] = p[0]; vs[i * 3 + 1] = p[1]; vs[i * 3 + 2] = p[2];
    if (p[0] < u0) u0 = p[0]; if (p[0] > u1) u1 = p[0];
    if (p[1] < v0) v0 = p[1]; if (p[1] > v1) v1 = p[1];
  });
  const tri = new Uint32Array(T.length * 3);
  T.forEach((t, i) => { tri[i * 3] = t[0]; tri[i * 3 + 1] = t[1]; tri[i * 3 + 2] = t[2]; });
  /* 网线：两向各取等距的几条线，沿线细步取膜上的高度，两端都落在膜上的小段才画 */
  const net = [];
  const LINES = 12, STEPS = 120;
  for (let axis = 0; axis < 2; axis++) {
    const a0 = axis ? v0 : u0, a1 = axis ? v1 : u1, b0 = axis ? u0 : v0, b1 = axis ? u1 : v1;
    for (let k = 1; k < LINES; k++) {
      const a = a0 + ((a1 - a0) * k) / LINES;
      let prev = null;
      for (let s = 0; s <= STEPS; s++) {
        const b = b0 + ((b1 - b0) * s) / STEPS;
        const u = axis ? b : a, v = axis ? a : b;
        const w = heightAt(u, v);
        const cur = Number.isFinite(w) ? [u, v, w] : null;
        if (prev && cur) net.push(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]);
        prev = cur;
      }
    }
  }
  geo.sheet = { vs, tri, net: Float32Array.from(net) };
  return geo.sheet;
}

/** 局部系 [u, v, w, ...] → 场景坐标（网格局部系 + 抬高）写进 out */
function sheetToScene(local, fr, lift, out) {
  for (let i = 0; i < local.length; i += 3) {
    const u = local[i], v = local[i + 1], w = local[i + 2];
    out[i] = fr.c[0] + u * fr.u[0] + v * fr.v[0] + w * fr.n[0];
    out[i + 1] = fr.c[1] + u * fr.u[1] + v * fr.v[1] + w * fr.n[1] + lift;
    out[i + 2] = fr.c[2] + u * fr.u[2] + v * fr.v[2] + w * fr.n[2];
  }
  return out;
}

function addSheet(g, geo) {
  const sh = ensureSheet(geo);
  if (!sh) return;
  const lift = raiseH();
  const patch = new THREE.Mesh(
    new THREE.BufferGeometry()
      .setAttribute('position', new THREE.BufferAttribute(sheetToScene(sh.vs, geo.fr, lift, new Float32Array(sh.vs.length)), 3))
      .setIndex(new THREE.BufferAttribute(sh.tri, 1)),
    new THREE.MeshBasicMaterial({ color: C_LINE, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
  );
  patch.raycast = () => {};
  patch.renderOrder = 2;
  g.add(patch);
  if (sh.net.length) {
    const net = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(sheetToScene(sh.net, geo.fr, lift, new Float32Array(sh.net.length)), 3)),
      new THREE.LineBasicMaterial({ color: C_LINE_ON, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false }),
    );
    net.raycast = () => {};
    net.renderOrder = 3;
    g.add(net);
  }
}

/** 这条线会走曲面切：「切面」没选「平面」、线有起伏（偏离拟合平面超过 FLAT_TOL；很平的线内核直接按平面切） */
function curvedCut(line) {
  return params.cutSurface !== 'plane' && !!line.fit && line.fit.dev > FLAT_TOL && !!line.geo;
}

/** 这条线按「随画线」切：走曲面，且线在切面方向上不自交（自交的线围不出一张曲面，内核会拒绝） */
function followsLine(line) {
  return curvedCut(line) && !line.geo.tangled;
}

function redraw() {
  const shown = state.cutLines.filter(l => l.visible && !l.editing);
  if (!state.mesh || (!shown.length && !draft)) { dropGroup(); return; }
  const g = ensureGroup();
  clearChildren(g);
  for (const line of shown) {
    const on = line.id === activeId;
    addStroke(g, chain(line.legs, true), true, on ? C_LINE_ON : C_LINE, on ? 3.4 : 2.4, !line.alive);
    if (on) {
      addNodes(g, line.ctrl, false);
      if (!line.cut && line.alive) {
        if (followsLine(line)) addSheet(g, line.geo);
        else if (!(curvedCut(line) && line.geo.tangled)) addPlane(g, line);
      }
    }
  }
  if (draft) {
    const path = chain(draft.legs, false);
    const tail = draft.rubber.length ? draft.rubber : [];
    const all = path.slice();
    for (const p of tail) if (!all.length || dist(all[all.length - 1], p) > 0.02) all.push(p);
    if (!all.length) all.push(draft.ctrl[0]);
    addStroke(g, all, false, C_DRAFT, 2.6, false);
    addNodes(g, draft.ctrl, draft.closable);
  }
}

/* ---------- 刷新 / 对外状态 ---------- */

function summary() {
  const byId = partMap();
  return {
    active: activeId,
    busy,
    drafting: draft ? { points: draft.ctrl.length, edit: !!draft.orig, closable: draft.ctrl.length >= 3 } : null,
    lines: state.cutLines.map(l => {
      const part = byId.get(l.partId);
      return {
        id: l.id, name: l.name, closed: l.closed, visible: l.visible, alive: !!l.alive, cut: !!l.cut,
        points: l.ctrl.length, part: part ? part.name : '',
        dev: l.fit ? Math.round(l.fit.dev * 100) / 100 : null,
        span: l.fit ? Math.round(l.fit.span * 10) / 10 : null,
        tangled: !!(l.geo && l.geo.tangled),
      };
    }),
  };
}

export function cutLinesState() { return summary(); }

function emitState() {
  const s = summary();
  const key = JSON.stringify(s);
  if (key === lastSummary) return;
  lastSummary = key;
  bus.emit('cutLines', s);
}

/** 零件姿态变了 / 模型换了：按零件现在的位置重新求线点，重画，更新面板 */
function refresh() {
  const lines = state.cutLines;
  if (!lines.length && !draft) {
    pruneFlag = false;
    dropGroup();
    emitState();
    return;
  }
  const byId = partMap();
  if (pruneFlag) {
    pruneFlag = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!linePts(lines[i]).every(p => liveAnchor(p, byId))) lines.splice(i, 1);
    }
    if (!lines.some(l => l.id === activeId)) activeId = lines.length ? lines[lines.length - 1].id : null;
    if (draft && !draft.ctrl.every(p => liveAnchor(p, byId))) dropDraft();
  }
  for (const line of lines) {
    const pts = linePts(line);
    line.cut = line.cutPids.some(id => byId.has(id));
    line.alive = pts.length > 0 && evalPts(pts, byId);
    if (line.alive) {
      line.partId = line.ctrl[0].pid;
      line.fit = fitPlane(chain(line.legs, true));
      lineLocal(line);
    }
  }
  if (draft && !evalPts(uniquePts(draft.ctrl, draft.legs), byId)) dropDraft();
  redraw();
  emitState();
}

/** 草稿作废（锚着的零件没了）：正在编辑的那条线恢复显示 */
function dropDraft() {
  if (draft && draft.orig) draft.orig.editing = false;
  draft = null;
}

bus.on('displayMesh', refresh);
bus.on('modelInfo', refresh);
bus.on('lift', refresh);
bus.on('frameShift', refresh);   // 平移拖动中：零件位姿已更新，线跟着走
bus.on('modelsReplaced', () => { pruneFlag = true; });
bus.on('param', k => { if (k === 'cutSurface' && group) redraw(); });   // 切面预览（曲面 / 平面圆盘）跟着「切面」开关换
if (typeof window !== 'undefined') window.addEventListener('resize', () => { if (group) redraw(); });

/* ---------- 工程页签：整盘摘下 / 挂回 ---------- */

/** 切走工程时摘下这一盘的线（草稿作废） */
export function takeCutLines() {
  if (draft) { if (draft.orig) draft.orig.editing = false; draft = null; }
  const pack = { lines: state.cutLines, activeId };
  state.cutLines = [];
  activeId = null;
  pruneFlag = false;
  dropGroup();
  lastSummary = '';
  emitState();
  return pack;
}

/** 切回工程时挂回线（调用前零件应已就位） */
export function putCutLines(pack) {
  state.cutLines = pack && pack.lines ? pack.lines : [];
  activeId = pack && pack.activeId != null ? pack.activeId : null;
  pruneFlag = false;
  lastSummary = '';
  refresh();
}
