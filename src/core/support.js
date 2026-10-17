/* ================================================================
   支撑生成总控
   数据流：支撑点（可编辑数据 state.supportPoints）→ 结构生成（rebuildStructure）
   - 支撑点：LDI 栅格悬空点 + 陡峭面（大三角形细分采样）+ 孤岛关键点，经区域面积过滤 /
     六角均匀布点（目标为设定间距，最近可收到约 0.68×，空洞补到覆盖半径 0.85× 以内；
     覆盖锥仅同一悬空区域，水平半径封顶 1.25×）/ 贴面·已托住·保护面过滤；每点带被托面外法线 n
   - 结构：支撑塔（格架塔，supportTower.js）
   手动增删的是支撑点，结构由点集整体重建——格架的杆件互相连接，不能逐根增删
   避让：一律基于模型 BVH 的胶囊体净空判定（collide.js），取代旧实现的单条竖直射线
================================================================ */
import * as THREE from 'three';
import { state, params, bus, log, toast, setProgress, nextFrame } from '../store.js';
import { supportGroup, supMat, supMatAnchor, supMatBase, supMatGlass, supMatAnchorGlass } from './scene.js';
import { ldiGapAt } from './slicer.js';
import { baseY, raiseH, placeModelAtLift, updateRaft, setRaftVisible, localFaceOf, supportTargetPart, partAtWorld } from './model.js';
import { drawLayer, shiftAnalysisY } from './inspect.js';
import { joinLiftWanted, joinPlateHeight } from './joinPlate.js';
import { buildBVH, raycast, ldiInside } from './collide.js';
import { buildEStageTowers } from './supportTower.js';
import { layoutAsync } from './geomClient.js';
import { mergeParts } from './supportKit.js';

const PROT_R = 1.0;          // 保护面抑制半径：接触点（及模型锚点）1mm 内有任一保护面即不放
const WALL_R = 0.8;          // 贴壁根部判据半径：水平这么远内有一面从下方竖直上来的墙，该点是悬臂根部（< 1mm 可自支撑），不放支撑
const MAX_POINTS = 3000;     // 支撑点上限（格架会合并分支，点数可比旧的独立 pin 多）

/* ---------- 状态 ---------- */
let pointMesh = null;
const POINT_R = 0.55;   // 支撑点小球半径（mm）：中心在接触点上，一半埋进模型，看起来贴在表面上

function clearPointMarkers() {
  if (!pointMesh) return;
  supportGroup.remove(pointMesh);
  pointMesh.geometry.dispose();
  pointMesh.material.dispose();
  pointMesh = null;
}
function clearMeshes() {
  for (const s of state.supports) { supportGroup.remove(s.mesh); s.mesh.geometry.dispose(); }
  state.supports = [];
  clearPointMarkers();
}

const SEL_COLOR = 0xff3df2;   // 框选 / 点选中的支撑点：洋红，和落板黑灰、短小支撑红、失败亮红都分开

function pointColor(p, selected) {
  if (selected) return SEL_COLOR;
  if (p.state === 'ground') return supMat.color.getHex();
  if (p.state === 'mesh' || p.state === 'micro') return supMatAnchor.color.getHex();
  if (p.state === 'nohead' || p.state === 'unroutable') return 0xff4d4d;
  return 0x8ec8ff;
}

export function supportSelection() {
  return state.supportSel instanceof Set ? state.supportSel : (state.supportSel = new Set());
}

/* 每个支撑 mesh 的材质按「模式 + 部件 + 顶点色状态」键控克隆——prepareSupportColors 会给材质开
   vertexColors 写高亮，模式切换（半透明）时两边互不覆盖；键没变就不重复克隆。 */
function applyViewMat(s, v) {
  const m = s.mesh;
  const hasVC = !!(m.geometry.attributes && m.geometry.attributes.color);
  const isN = v === 'needle' && s.part === 'needle';
  const kindKey = isN ? 'n' : (s.kind === 'anchor' ? 'a' : s.kind === 'base' ? 'b' : 'g');
  const key = kindKey + (hasVC ? 'V' : '');
  if (m.userData.matKey === key) return;
  const base = isN ? (s.kind === 'anchor' ? supMatAnchorGlass : supMatGlass)
    : (s.kind === 'anchor' ? supMatAnchor : s.kind === 'base' ? supMatBase : supMat);
  const mat = base.clone();
  // 实心视图用顶点色（黑灰 / 红）。连接体半透明视图不用顶点色，否则黑灰乘上透明度后融进背景
  if (hasVC && !isN) { mat.vertexColors = true; mat.color.setHex(0xffffff); }
  m.material = mat;
  m.userData.matKey = key;
}

/* 支撑显示三模式（2026-10-14，对照黑格手动支撑栏「全部支撑 / 连接体 / 接触点」三视图）：
   full = 全部支撑（格架塔 + 连接体针 + 兜底件）；needle = 仅连接体（针凸包 + 兜底件，隐藏格架塔；
   针改用半透明材质，2026-10-14 用户定）；point = 仅接触点（结构全隐藏，放附着在模型上的小球）。 */
export function syncSupportView() {
  clearPointMarkers();
  const v = state.supView || 'full';
  for (const s of state.supports) {
    s.mesh.visible = v === 'full' ? true : (v === 'needle' ? s.part === 'needle' : false);
    applyViewMat(s, v);
  }
  setRaftVisible(v === 'full');   // 自动底板不是支撑本体：连接体 / 接触点模式下与格架一起隐藏
  if (v !== 'point') return;
  const pts = state.supportPoints || [];
  if (!pts.length) return;
  const geo = new THREE.SphereGeometry(POINT_R, 10, 8);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  pointMesh = new THREE.InstancedMesh(geo, mat, pts.length);
  pointMesh.userData.kind = 'points';
  pointMesh.frustumCulled = false;
  paintPointMarkers(pts);
  supportGroup.add(pointMesh);
}

function paintPointMarkers(pts) {
  if (!pointMesh) return;
  const sel = supportSelection();
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  pts.forEach((p, i) => {
    const on = sel.has(i);
    dummy.position.set(p.x, p.y, p.z);
    dummy.scale.setScalar(on ? 1.55 : 1);
    dummy.updateMatrix();
    pointMesh.setMatrixAt(i, dummy.matrix);
    pointMesh.setColorAt(i, color.setHex(pointColor(p, on)));
  });
  pointMesh.instanceMatrix.needsUpdate = true;
  if (pointMesh.instanceColor) pointMesh.instanceColor.needsUpdate = true;
}

/** 命中点落在哪根支撑上。杆身用水平距离认接触点正下方的那根，不再限定必须点在头部 5mm 内。 */
export function supportIndexNearHit(x, y, z) {
  const pts = state.supportPoints || [];
  let best = -1, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const horiz = Math.hypot(p.x - x, p.z - z);
    const spatial = Math.hypot(p.x - x, p.y - y, p.z - z);
    const d = y <= p.y + 1.5 ? Math.min(horiz, spatial) : spatial;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** 顶点色底色，与场景材质同一来源（落板黑灰 / 短小支撑红） */
function bodyRgb(mat) {
  const c = mat.color;
  return [c.r, c.g, c.b];
}
const BODY_SEL = [0xff / 255, 0x3d / 255, 0xf2 / 255];
let pointGrid = null;

function buildPointGrid(pts) {
  const cell = 8;
  const map = new Map();
  for (let i = 0; i < pts.length; i++) {
    const k = Math.floor(pts[i].x / cell) + ',' + Math.floor(pts[i].z / cell);
    let a = map.get(k);
    if (!a) map.set(k, a = []);
    a.push(i);
  }
  return { map, cell, pts };
}

function supportOwnerFast(x, y, z, grid) {
  const { map, cell, pts } = grid;
  const ix = Math.floor(x / cell), iz = Math.floor(z / cell);
  let best = -1, bd = Infinity;
  const consider = (i) => {
    const p = pts[i];
    const horiz = (p.x - x) ** 2 + (p.z - z) ** 2;
    const spatial = horiz + (p.y - y) ** 2;
    const d = y <= p.y + 1.5 ? Math.min(horiz, spatial) : spatial;
    if (d < bd) { bd = d; best = i; }
  };
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const a = map.get((ix + dx) + ',' + (iz + dz));
    if (a) for (let n = 0; n < a.length; n++) consider(a[n]);
  }
  if (best < 0 || bd > cell * cell * 4) {
    for (let i = 0; i < pts.length; i++) consider(i);
  }
  return best < 0 ? 0 : best;
}

function writeTris(geom, tris, rgb, span) {
  const col = geom.attributes.color;
  const index = geom.index;
  const at = (t, k) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  const arr = col.array;
  for (let n = 0; n < tris.length; n++) {
    const t = tris[n];
    for (let k = 0; k < 3; k++) {
      const v = at(t, k);
      const o = v * 3;
      arr[o] = rgb[0]; arr[o + 1] = rgb[1]; arr[o + 2] = rgb[2];
      if (v < span.min) span.min = v;
      if (v > span.max) span.max = v;
    }
  }
}

/** 生成支撑后就把三角形归到各自的支撑点上，并写好底色。第一次点选不再整网重算。
 *  底色当场写好；三角形归属（几十万个三角形逐个找最近的支撑点，环面结塔约 0.45 秒）分片算，
 *  每 ~24ms 让出主线程一次——生成刚结束时界面不再卡这一下。算完前点选只是暂不高亮。
 *  返回 Promise（全部网格算完）；同一网格正在算时复用那一份，不重复算 */
export function prepareSupportColors() {
  const pts = state.supportPoints || [];
  if (!pts.length) { pointGrid = null; return Promise.resolve(); }
  pointGrid = buildPointGrid(pts);
  const grid = pointGrid, jobs = [];
  for (const s of state.supports) {
    if (s.kind !== 'ground' && s.kind !== 'anchor') continue;
    const mesh = s.mesh;
    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    if (!pos) continue;
    if (geom.userData.triOf && geom.userData.ownerPts === pts.length && geom.attributes.color) continue;
    if (geom.userData.triOfJob && geom.userData.ownerPts === pts.length) { jobs.push(geom.userData.triOfJob); continue; }
    const index = geom.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    if (mesh.material === supMat || mesh.material === supMatAnchor || mesh.material === supMatBase
      || mesh.material === supMatGlass || mesh.material === supMatAnchorGlass) {
      mesh.material = mesh.material.clone();
    }
    mesh.material.vertexColors = true;
    mesh.material.color.setHex(0xffffff);
    const base = bodyRgb(s.kind === 'anchor' ? supMatAnchor : supMat);
    const col = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
    const arr = col.array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] = base[0]; arr[i + 1] = base[1]; arr[i + 2] = base[2];
    }
    geom.setAttribute('color', col);
    geom.userData.triOf = null;
    geom.userData.ownerPts = pts.length;
    const job = (async () => {
      const tick = makeYielder();
      const triOf = Array.from({ length: pts.length }, () => []);
      const pa = pos.array;
      const ia = index ? index.array : null;
      for (let t = 0; t < triCount; t++) {
        if ((t & 2047) === 0) {
          await tick();
          if (!state.supports.some(x => x.mesh === mesh)) return;   // 这期间结构已经重建：放弃
        }
        let a, b, c;
        if (ia) { const o = t * 3; a = ia[o]; b = ia[o + 1]; c = ia[o + 2]; }
        else { a = t * 3; b = a + 1; c = a + 2; }
        const a3 = a * 3, b3 = b * 3, c3 = c * 3;
        const x = (pa[a3] + pa[b3] + pa[c3]) / 3;
        const y = (pa[a3 + 1] + pa[b3 + 1] + pa[c3 + 1]) / 3;
        const z = (pa[a3 + 2] + pa[b3 + 2] + pa[c3 + 2]) / 3;
        triOf[supportOwnerFast(x, y, z, grid)].push(t);
      }
      geom.userData.triOf = triOf;
      geom.userData.painted = [];
      geom.userData.triOfJob = null;
      col.needsUpdate = true;
      if (supportSelection().size) paintSupportBodies();      // 算的这段时间里已经点选了：补上高亮
    })();
    geom.userData.triOfJob = job;
    jobs.push(job);
  }
  return Promise.all(jobs);
}

/** 只改刚选中或刚取消的那几根支撑的颜色。 */
function paintSupportBodies() {
  const sel = supportSelection();
  const baseOf = (kind) => bodyRgb(kind === 'anchor' ? supMatAnchor : supMat);
  for (const s of state.supports) {
    if (s.kind !== 'ground' && s.kind !== 'anchor') continue;
    const geom = s.mesh.geometry;
    const triOf = geom.userData.triOf;
    if (!triOf || !geom.attributes.color) continue;
    const prev = geom.userData.painted || [];
    const now = [];
    const span = { min: Infinity, max: -1 };
    for (let n = 0; n < prev.length; n++) {
      const i = prev[n];
      if (!sel.has(i)) writeTris(geom, triOf[i] || [], baseOf(s.kind), span);
    }
    for (const i of sel) {
      now.push(i);
      if (prev.indexOf(i) < 0) writeTris(geom, triOf[i] || [], BODY_SEL, span);
    }
    if (span.min <= span.max) {
      const col = geom.attributes.color;
      col.clearUpdateRanges();
      col.addUpdateRange(span.min * 3, (span.max - span.min + 1) * 3);
      col.needsUpdate = true;
    }
    geom.userData.painted = now;
  }
}

/** 删支撑模式下的选中集合。传入索引数组，框选和点选都走这里。 */
export function setSupportSelection(indices) {
  const sel = supportSelection();
  sel.clear();
  const pts = state.supportPoints || [];
  for (const i of indices || []) if (i >= 0 && i < pts.length) sel.add(i);
  if (pointMesh && pointMesh.count === pts.length) paintPointMarkers(pts);
  else if ((state.supView || 'full') === 'point') syncSupportView();
  paintSupportBodies();
}

/** 切换支撑显示：'full' 全部 / 'needle' 仅连接体 / 'point' 仅接触点（黑格三视图的按钮版） */
export function setSupportView(v) {
  state.supView = v === 'needle' || v === 'point' ? v : 'full';
  syncSupportView();
  bus.emit('supView', state.supView);
  log(state.supView === 'full'
    ? '已显示全部支撑（格架 + 连接体 + 接触点）'
    : state.supView === 'needle' ? '仅显示支撑连接体（针 / 兜底件）' : '仅显示支撑接触点');
}

/** 兼容旧入口：只显示支撑点开 / 关 */
export function setPointsOnly(on) { setSupportView(on ? 'point' : 'full'); }
export function clearSupports(refresh = true) {
  buildSeq++;                                         // 正在后台算的重建作废
  clearMeshes();
  state.supportPoints = [];
  if (state.supportSel) state.supportSel.clear();
  state.supportStats = null;
  updateRaft();                                       // 结构没了 → 自动底板随结构消失（无结构时不出板）
  if (refresh) { updateSupStats(); if (state.analysis) drawLayer(); }
}
export function updateSupStats() {
  const s = state.supportStats;
  bus.emit('supStats', s ? { ...s, prot: state.protectedFaces.size } : { mode: 'tower', points: state.supportPoints.length, prot: state.protectedFaces.size });
}

/** 孤岛有没有被托住。图上标了孤岛的节点：有支撑点且至少一点生成了结构（ground / mesh / micro）算托住；
 *  有点但全失败记 fail，一个点都没有记 noPoint。open 是两者之和，统计卡用它决定还要不要警告。 */
function islandCoverage() {
  const nodes = (state.analysis && state.analysis.graph && state.analysis.graph.nodes) || [];
  const ok = new Set(), any = new Set();
  for (const p of state.supportPoints || []) {
    if (p.island == null) continue;
    any.add(p.island);
    if (p.state === 'ground' || p.state === 'mesh' || p.state === 'micro') ok.add(p.island);
  }
  let fail = 0, noPoint = 0;
  for (const nd of nodes) {
    if (!nd.island) continue;
    if (ok.has(nd.id)) continue;
    if (any.has(nd.id)) fail++;
    else noPoint++;
  }
  return { fail, noPoint, open: fail + noPoint };
}

/* 参数快照（结构生成器只读快照，缺省值兜底） */
function paramSnapshot() {
  const p = params, num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    selfAngle: num(p.selfAngle, 45), shortSup: !!p.shortSup, spacing: num(p.spacing, 2.5),
    pen: num(p.pen, 0.2),                                          // 渗透长度（针尖扎入模型）
    // 支撑塔（格架塔）
    esCell: num(p.esCell, 3.5), esDiamAngle: num(p.esDiamAngle, 55), esMidBars: p.esMidBars !== false,
    esBarW: num(p.esBarW, 0.6), esBarT: num(p.esBarT, 0.6), esGap: num(p.esGap, 1.2),
    esColRatio: num(p.esColRatio, 7), esTowerMaxR: num(p.esTowerMaxR, 4), esHullRed: num(p.esHullRed, 0),
    esConnW: num(p.esConnW, 0.6), esNeedleT: num(p.esNeedleT, 0.6), esTipW: num(p.esTipW, 0.3), esTopD: num(p.esTopD, num(p.esTipW, 0.3)), esBotD: num(p.esBotD, num(p.esBarW, 0.6)), tipBall: p.tipBall !== false, esContactMargin: num(p.esContactMargin, 0), esTaper: num(p.esTaper, 1.5), esNeedleMax: num(p.esNeedleMax, 6), smallScale: num(p.smallScale, 0.8),
    esFoundH: num(p.esFoundH, 1), esNotchH: num(p.esNotchH, 0.5), baseJoin: !!p.baseJoin, baseChamfer: !!p.baseChamfer, baseFlush: !!p.baseFlush, baseHole: !!p.baseHole, autoPlateOn: !!p.autoPlateOn,
  };
}

/* 生成上下文：模型 BVH（复用逐层分析的世界系顶点 A.p，随分析缓存）+ LDI + 面法线 + 保护面近邻查询 */
function makeCtx() {
  const A = state.analysis;
  if (!A._bvh) A._bvh = buildBVH(A.p);
  let protNear = null;
  if (state.protectedFaces.size) {
    const cell = 2, hash = new Map(), p = A.p;
    const key = (i, j, k) => `${i},${j},${k}`;
    for (const f of state.protectedFaces) {
      const i = f * 9;
      const c = [(p[i] + p[i + 3] + p[i + 6]) / 3, (p[i + 1] + p[i + 4] + p[i + 7]) / 3, (p[i + 2] + p[i + 5] + p[i + 8]) / 3];
      const k = key(Math.floor(c[0] / cell), Math.floor(c[1] / cell), Math.floor(c[2] / cell));
      let arr = hash.get(k); if (!arr) hash.set(k, arr = []); arr.push(c);
    }
    protNear = pt => {
      const ci = Math.floor(pt.x / cell), cj = Math.floor(pt.y / cell), ck = Math.floor(pt.z / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const arr = hash.get(key(ci + a, cj + b, ck + c));
        if (arr) for (const q of arr) if ((q[0] - pt.x) ** 2 + (q[1] - pt.y) ** 2 + (q[2] - pt.z) ** 2 < PROT_R * PROT_R) return true;
      }
      return false;
    };
  }
  const bb = state.mesh.geometry.boundingBox;
  return { bvh: A._bvh, ld: A.ld, groundY: baseY(), faces: state.faces, protNear, cx: (bb.min.x + bb.max.x) / 2, cz: (bb.min.z + bb.max.z) / 2, topY: A.grid.minY + A.metrics.height };
}

/* Halton 低差异序列（大三角形内均匀采样） */
function halton(i, b) { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }

/* ================================================================
   支撑点生成（边缘环 + 内部按覆盖补点）
   ----------------------------------------------------------------
   最早：全局（对齐世界原点）的水平六角网格，每格取离格心最近的候选，再按距离补洞。网格与悬空区域的轮廓无关——
   跨在边上的格子随便取一个候选，边缘点到边的距离在 0～间距之间乱跳；高度按间距分层，曲面底部上翘处同一格出两层点；
   覆盖锥按高差吃掉一片候选，曲面上忽多忽少（用户截图：环面结底面「边缘不够均匀」「整体不够均匀」）。
   第二版（等距环，环距死按间距）边缘齐了，但条带宽度不是环距整数倍时中间那一排出不来（用户截图「内部又没支撑了」）。
   现在：
   1. 支撑区域 = 顶点法线越过自支撑角的那一片，沿等值线切开（不再整张三角面；尖棱两侧法线不平均），去掉保护面与「已托住」面
      （切开后那一块的重心正下方 0.8mm 内有材料），悬空的顶点连成片；投影面积小于「最小悬空面积」的片不布点（孤岛另有关键点）。
   2. 图块：每片再按投影拆开——自下而上生长，若新面落在图块已占的 XZ 格子上、高差超过 1.5mm（同一片曲面在投影里绕回来
      压到自己，例如环面结管底带的交叉处），就另起图块。每个图块在同一 XZ 位置只有一层曲面。
   3. 布点在几何后台线程里算（manifoldKit.layoutPoints）：图块投影轮廓内缩「边缘距离」（默认 1.0mm）得到边缘环，沿环按弧长
      均分放点；内部按覆盖补点——任一处离最近支撑点不超过 0.6 × 间距，哪里最空先补哪里，再 Lloyd 松弛到均匀。
      点数由覆盖决定，条带宽度不是行距整数倍时内部各排自动收紧，不死按间距；窄条点吸到中线上。
   4. 二维点抬回所在图块的曲面（XZ 内找到所在三角形、按重心插值高度），逐点校验（贴面 / 已托住 / 贴壁根部 / 保护面），
      与已放的点保持 ≥ 0.4 × 间距（只去掉孤岛种子、图块接缝处几乎重合的点；布点本身已经均匀）。
   5. 孤岛关键点：全岛最低点最先放（孤岛必须从最低点托起）；周界点（按间距降采样）放到布点之后，同一高度附近已有支撑
      就不放——平底孤岛的边交给边缘环按「边缘距离」内缩，薄沿孤岛（伞缘：布点都在它上方）的周界照放。
   6. 补点只作兜底：区域面上离所有支撑都超过 max(0.85 × 间距, 边缘距离 + 半间距) 的地方才补——不会把边缘带补满、破坏内缩。
   其余修复要点（均经实测复现）：栅格悬空点不截断（slicer.js）；孤岛种子的「已托住」阈值 0.25mm（孤岛与下方不相连）；
   保护面：接触面本身或 1mm 内任一保护面即抑制；大三角形按面积细分采样补点候选。
================================================================ */
const CHART_CELL = 0.5;          // 图块投影栅格（mm）
const CHART_DY = 1.5;            // 同一 XZ 格子上高差超过它，视为曲面在投影里绕回来压到自己
const CREASE_COS = Math.cos(50 * Math.PI / 180);   // 相邻面法线夹角小于 50° 才并成同一顶点法线；平底对侧壁约 90°，不平均

/** 每个角的悬空标量 s = −ny − cos(自支撑角)。ny 来自「同一位置、法线够接近」的那些面，按面积加权。
 *  同一条边上两侧用的是同一个数，等值线交点才对得齐。s > 0 需要支撑。 */
function overhangScalars(p, nrm, area, cosv) {
  const nf = area.length, Q = 1e4;
  const vmap = new Map(), cornerVid = new Int32Array(nf * 3);
  let nvid = 0;
  for (let f = 0; f < nf; f++) {
    const i = f * 9;
    for (let k = 0; k < 3; k++) {
      const o = i + k * 3;
      const key = `${Math.round(p[o] * Q)},${Math.round(p[o + 1] * Q)},${Math.round(p[o + 2] * Q)}`;
      let id = vmap.get(key);
      if (id === undefined) { id = nvid++; vmap.set(key, id); }
      cornerVid[f * 3 + k] = id;
    }
  }
  const vFaces = Array.from({ length: nvid }, () => []);
  for (let c = 0; c < nf * 3; c++) vFaces[cornerVid[c]].push(c);
  const s = new Float64Array(nf * 3);
  const find = (par, a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (let v = 0; v < nvid; v++) {
    const list = vFaces[v], m = list.length;
    const par = new Int32Array(m);
    for (let i = 0; i < m; i++) par[i] = i;
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
      const a = (list[i] / 3) | 0, b = (list[j] / 3) | 0;
      const d = nrm[a * 3] * nrm[b * 3] + nrm[a * 3 + 1] * nrm[b * 3 + 1] + nrm[a * 3 + 2] * nrm[b * 3 + 2];
      if (d < CREASE_COS) continue;
      const ra = find(par, i), rb = find(par, j);
      if (ra !== rb) par[rb] = ra;
    }
    const acc = new Map();
    for (let i = 0; i < m; i++) {
      const r = find(par, i), f = (list[i] / 3) | 0;
      let g = acc.get(r);
      if (!g) acc.set(r, g = [0, 0, 0]);
      const w = area[f] || 0;
      g[0] += nrm[f * 3] * w; g[1] += nrm[f * 3 + 1] * w; g[2] += nrm[f * 3 + 2] * w;
    }
    for (let i = 0; i < m; i++) {
      const g = acc.get(find(par, i));
      const len = Math.hypot(g[0], g[1], g[2]) || 1;
      s[list[i]] = -(g[1] / len) - cosv;
    }
  }
  return s;
}

/** 三角形裁到 s ≥ 0。全在内侧原样返回，全在外侧返回空，被等值线切开时返回 1 或 2 个三角形（每个 9 个数 xyz）。 */
function clipOverhangTri(xyz, ss) {
  const EPS = 1e-6;
  let any = false, all = true;
  for (let k = 0; k < 3; k++) { if (ss[k] > EPS) any = true; if (ss[k] < -EPS) all = false; }
  if (!any) return [];
  if (all) return [xyz.slice()];
  const poly = [];
  for (let k = 0; k < 3; k++) poly.push({ x: xyz[k * 3], y: xyz[k * 3 + 1], z: xyz[k * 3 + 2], s: ss[k] });
  const out = [];
  for (let i = 0; i < 3; i++) {
    const a = poly[i], b = poly[(i + 1) % 3];
    const ain = a.s >= -EPS, bin = b.s >= -EPS;
    if (ain && bin) out.push(b);
    else if (ain !== bin) {
      const t = a.s / (a.s - b.s);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, s: 0 });
      if (bin) out.push(b);
    }
  }
  if (out.length < 3) return [];
  const tris = [];
  const pack = (i, j, k) => {
    const tri = [out[i].x, out[i].y, out[i].z, out[j].x, out[j].y, out[j].z, out[k].x, out[k].y, out[k].z];
    const area = Math.abs((tri[3] - tri[0]) * (tri[8] - tri[2]) - (tri[6] - tri[0]) * (tri[5] - tri[2])) * 0.5;
    if (area > 1e-8) tris.push(tri);
  };
  pack(0, 1, 2);
  if (out.length >= 4) pack(0, 2, 3);
  return tris;
}

function triXZArea(t) {
  return Math.abs((t[3] - t[0]) * (t[8] - t[2]) - (t[6] - t[0]) * (t[5] - t[2])) * 0.5;
}

/* LDI 列里离 (x, y, z) 最近的下方材料顶面有多远（并集语义；下方没有材料返回 Infinity，交给射线 / 板面判断）。
   射线法从接触点下 0.15mm 才开始找（跳过自身所在的面），拼装件之间不到 0.15mm 的缝里，下面那个零件的顶面被跳过，
   缝上方的面被当成悬空：支撑点放进缝里，整棵树长进下面那个零件里面（500 个零件实测：完整手办拼缝处 5940 个结构顶点埋在模型实体里，竖直方向最深 39mm） */
function ldiGapBelow(ld, x, y, z) {
  if (!ld) return Infinity;
  const i = Math.floor((x - ld.x0) / ld.sx), j = Math.floor((z - ld.z0) / ld.sz);
  if (i < 0 || j < 0 || i >= ld.W || j >= ld.H) return Infinity;
  const c = j * ld.W + i, b = ld.offs[c], e = b + ld.nInt[c];
  let top = -Infinity;
  for (let k = b; k < e; k++) { const y1 = ld.ys[2 * k + 1]; if (y1 <= y + 0.02 && y1 > top) top = y1; }
  return top === -Infinity ? Infinity : Math.max(0, y - top);
}

/* 多模型时只支撑选中的那一件。只有一个模型时返回 null，表示不按零件过滤。 */
function supportTargetId() {
  const t = supportTargetPart();
  if (!t || state.parts.length <= 1) return null;
  return t.id;
}
function facePartId(f) {
  const loc = localFaceOf(f);
  return loc ? loc.part.id : null;
}
function partIdOfPoint(p) {
  if (p.partId != null) return p.partId;
  const A = state.analysis;
  if (A && A._bvh) {
    const hit = raycast(A._bvh, p.x, p.y + 0.8, p.z, 0, -1, 0, 0, 4);
    if (hit && hit.f >= 0) {
      const id = facePartId(hit.f);
      if (id != null) return id;
    }
  }
  const part = partAtWorld(p.x, p.z);
  return part ? part.id : null;
}
function islandOnTarget(nd, A, bvh, targetId) {
  const pix = nd.pixels;
  if (!pix || !pix.length) return false;
  const { W: GW } = A.grid;
  const cc = pix[0];
  const ci = cc % GW, cj = (cc / GW) | 0;
  const x = A.grid.x0 + (ci + 0.5) * A.grid.sx;
  const z = A.grid.z0 + (cj + 0.5) * A.grid.sz;
  const hit = raycast(bvh, x, nd.y + 0.8, z, 0, -1, 0, 0, 4);
  if (hit && hit.f >= 0) return facePartId(hit.f) === targetId;
  const part = partAtWorld(x, z);
  return !!(part && part.id === targetId);
}

/** 支撑区域 → 图块。返回 { faces（候选面的全局面号）, charts: [{ reg, faces（候选序号）, tris2 }], rep } */
async function buildCharts(ctx, tick) {
  const A = state.analysis, p = A.p, { bvh, groundY } = ctx;
  const rep = { heldFaces: 0, protFaces: 0, regions: 0, charts: 0, areaPruned: 0 };
  // 1. 候选面：顶点法线越过自支撑角的部分，沿等值线切开。整张三角面收进来时，斜边界就变成台阶。
  const faces = [], clips = [], cyArr = [], areaArr = [], cutArr = [];
  const targetId = supportTargetId();
  const nf = p.length / 9;
  const fd = state.faces;
  const cosv = Math.cos((Number.isFinite(params.selfAngle) ? params.selfAngle : 45) * Math.PI / 180);
  const scalars = fd && fd.nrm && fd.nrm.length / 3 === nf && fd.area && fd.area.length === nf
    ? overhangScalars(p, fd.nrm, fd.area, cosv) : null;
  const consider = (f, parts, cut) => {
    if (!parts.length) return;
    if (targetId != null && facePartId(f) !== targetId) return;
    if (state.protectedFaces.has(f)) { rep.protFaces++; return; }
    let cx = 0, cy = 0, cz = 0, n = 0, area = 0;
    for (const t of parts) {
      area += triXZArea(t);
      for (let k = 0; k < 9; k += 3) { cx += t[k]; cy += t[k + 1]; cz += t[k + 2]; n++; }
    }
    cx /= n; cy /= n; cz /= n;
    const hit = raycast(bvh, cx, cy - 0.05, cz, 0, -1, 0, 0.1, 1e9);
    if (Math.min(hit ? hit.t + 0.05 : cy - groundY, ldiGapBelow(A.ld, cx, cy, cz)) < 0.8) { rep.heldFaces++; return; }
    faces.push(f); clips.push(parts); cyArr.push(cy); areaArr.push(area); cutArr.push(cut ? 1 : 0);
  };
  if (scalars) {
    for (let f = 0; f < nf; f++) {
      if ((f & 1023) === 0) await tick();
      const ss = [scalars[f * 3], scalars[f * 3 + 1], scalars[f * 3 + 2]];
      if (ss[0] <= 1e-4 && ss[1] <= 1e-4 && ss[2] <= 1e-4) continue;
      const i = f * 9;
      consider(f, clipOverhangTri(
        [p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5], p[i + 6], p[i + 7], p[i + 8]], ss),
      ss[0] < 1e-4 || ss[1] < 1e-4 || ss[2] < 1e-4);
    }
  } else if (A.steepPts) {
    const seen = new Set();
    for (const sp of A.steepPts) {
      const f = sp.f;
      if (f === undefined || seen.has(f)) continue;
      seen.add(f);
      const i = f * 9;
      consider(f, [[p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5], p[i + 6], p[i + 7], p[i + 8]]], false);
    }
  }
  // 2. 共享顶点连成片。只焊悬空那一侧的角：安全侧的顶点要是也拿来连，一张大半在安全区的三角形会把两块不相连的悬空粘成一片
  const Q = 1e4, vmap = new Map(), fv = new Int32Array(faces.length * 3).fill(-1);
  for (let n = 0; n < faces.length; n++) {
    const f = faces[n], i = f * 9;
    for (let k = 0; k < 3; k++) {
      if (scalars && scalars[f * 3 + k] < -1e-4) continue;
      const o = i + k * 3;
      const key = `${Math.round(p[o] * Q)},${Math.round(p[o + 1] * Q)},${Math.round(p[o + 2] * Q)}`;
      let id = vmap.get(key);
      if (id === undefined) { id = vmap.size; vmap.set(key, id); }
      fv[n * 3 + k] = id;
    }
  }
  const vFaces = Array.from({ length: vmap.size }, () => []);
  for (let n = 0; n < faces.length; n++) for (let k = 0; k < 3; k++) if (fv[n * 3 + k] >= 0) vFaces[fv[n * 3 + k]].push(n);
  const par = new Int32Array(faces.length);
  for (let n = 0; n < par.length; n++) par[n] = n;
  const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  for (const list of vFaces) for (let j = 1; j < list.length; j++) { const a = find(list[0]), b = find(list[j]); if (a !== b) par[b] = a; }
  const cyOf = n => cyArr[n];
  const regionOf = new Map(), regions = [];
  for (let n = 0; n < faces.length; n++) {
    const r = find(n);
    let reg = regionOf.get(r);
    if (!reg) { reg = { id: regions.length, faces: [], area: 0 }; regionOf.set(r, reg); regions.push(reg); }
    reg.faces.push(n);
    reg.area += areaArr[n];   // 切开之后的 XZ 投影面积
  }
  rep.regions = regions.length;
  // 3. 图块：自下而上生长，投影里绕回来压到自己的面另起图块
  const minA = Math.max(0.1, params.minSupArea || 2);
  const raster = new Map();                        // 格子键 → [图块号, y, 图块号, y, ...]
  const cellsOf = n => {
    const g = CHART_CELL, out = [], seen = new Set();
    const add = (ax, az, bx, bz, cx, cz) => {
      const d = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
      const gi0 = Math.floor(Math.min(ax, bx, cx) / g), gi1 = Math.floor(Math.max(ax, bx, cx) / g);
      const gj0 = Math.floor(Math.min(az, bz, cz) / g), gj1 = Math.floor(Math.max(az, bz, cz) / g);
      for (let gi = gi0; gi <= gi1; gi++) for (let gj = gj0; gj <= gj1; gj++) {
        if (Math.abs(d) > 1e-12) {
          const px = (gi + 0.5) * g, pz = (gj + 0.5) * g;
          const w1 = ((px - ax) * (cz - az) - (cx - ax) * (pz - az)) / d, w2 = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / d;
          if (w1 < -1e-9 || w2 < -1e-9 || w1 + w2 > 1 + 1e-9) continue;
        }
        const key = `${gi},${gj}`;
        if (seen.has(key)) continue;
        seen.add(key); out.push(key);
      }
      const ci = `${Math.floor((ax + bx + cx) / 3 / g)},${Math.floor((az + bz + cz) / 3 / g)}`;
      if (!seen.has(ci)) { seen.add(ci); out.push(ci); }   // 小三角形至少占一格
    };
    for (const t of clips[n]) add(t[0], t[2], t[3], t[5], t[6], t[8]);
    return out;
  };
  const charts = [], chartOf = new Int32Array(faces.length).fill(-1);
  for (const reg of regions) {
    if (reg.area < minA) { rep.areaPruned++; continue; }
    const order = reg.faces.slice().sort((a, b) => cyOf(a) - cyOf(b));
    for (const seed of order) {
      if (chartOf[seed] >= 0) continue;
      const cid = charts.length, ch = { reg: reg.id, faces: [] };
      const tryAdd = n => {
        const y = cyOf(n), cells = cellsOf(n);
        for (const c of cells) {
          const e = raster.get(c);
          if (e) for (let j = 0; j < e.length; j += 2) if (e[j] === cid && Math.abs(e[j + 1] - y) > CHART_DY) return false;
        }
        for (const c of cells) { let e = raster.get(c); if (!e) raster.set(c, e = []); e.push(cid, y); }
        chartOf[n] = cid; ch.faces.push(n);
        return true;
      };
      if (!tryAdd(seed)) continue;
      charts.push(ch);
      const stack = [seed];
      while (stack.length) {
        const n = stack.pop();
        for (let k = 0; k < 3; k++) {
          const id = fv[n * 3 + k];
          if (id < 0) continue;
          for (const m of vFaces[id]) {
            if (chartOf[m] >= 0 || find(m) !== find(seed)) continue;
            if (tryAdd(m)) stack.push(m);
          }
        }
      }
      await tick();
    }
  }
  for (const ch of charts) {
    let nTri = 0;
    for (const n of ch.faces) nTri += clips[n].length;
    const t2 = new Float64Array(nTri * 6), ty = new Float64Array(nTri * 3), src = new Int32Array(nTri);
    let j = 0;
    for (const n of ch.faces) for (const t of clips[n]) {
      t2[j * 6] = t[0]; t2[j * 6 + 1] = t[2];
      t2[j * 6 + 2] = t[3]; t2[j * 6 + 3] = t[5];
      t2[j * 6 + 4] = t[6]; t2[j * 6 + 5] = t[8];
      ty[j * 3] = t[1]; ty[j * 3 + 1] = t[4]; ty[j * 3 + 2] = t[7];   // 各顶点高度：布点按曲面上的三维距离与面积松弛
      src[j] = faces[n];
      j++;
    }
    ch.tris2 = t2; ch.ty = ty; ch.src = src;
    // 图块的边界边（切开后只出现一次的边，含 45° 等值线）：兜底补点用来量「离边多远」
    const cnt = new Map(), seg = [];
    const pk = (x, y, z) => `${Math.round(x * Q)},${Math.round(y * Q)},${Math.round(z * Q)}`;
    const addEdge = (ax, ay, az, bx, by, bz) => {
      const ka = pk(ax, ay, az), kb = pk(bx, by, bz);
      const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      cnt.set(key, (cnt.get(key) || 0) + 1);
      if (cnt.get(key) === 1) seg.push(key, ax, az, bx, bz);
    };
    for (let t = 0; t < nTri; t++) {
      const o = t * 6, m = t * 3;
      const xyz = [
        t2[o], ty[m], t2[o + 1], t2[o + 2], ty[m + 1], t2[o + 3], t2[o + 4], ty[m + 2], t2[o + 5],
      ];
      addEdge(xyz[0], xyz[1], xyz[2], xyz[3], xyz[4], xyz[5]);
      addEdge(xyz[3], xyz[4], xyz[5], xyz[6], xyz[7], xyz[8]);
      addEdge(xyz[6], xyz[7], xyz[8], xyz[0], xyz[1], xyz[2]);
    }
    const bnd = [];
    for (let i = 0; i < seg.length; i += 5) if (cnt.get(seg[i]) === 1) bnd.push(seg[i + 1], seg[i + 2], seg[i + 3], seg[i + 4]);
    ch.bnd = Float64Array.from(bnd);
  }
  rep.charts = charts.length;
  rep.cutFaces = 0;
  for (const ch of charts) for (const n of ch.faces) rep.cutFaces += cutArr[n] || 0;
  return { faces, charts, rep };
}

/** 二维点 (x, z) 抬回图块曲面：在图块的投影三角形里找到所在的那个，按重心插值高度；返回 { y, f } 或 null */
function makeLifter(faces, ch) {
  const p = state.analysis.p, B = 2, bins = new Map();
  ch.faces.forEach((n, j) => {
    const i = faces[n] * 9;
    const x0 = Math.floor(Math.min(p[i], p[i + 3], p[i + 6]) / B), x1 = Math.floor(Math.max(p[i], p[i + 3], p[i + 6]) / B);
    const z0 = Math.floor(Math.min(p[i + 2], p[i + 5], p[i + 8]) / B), z1 = Math.floor(Math.max(p[i + 2], p[i + 5], p[i + 8]) / B);
    for (let a = x0; a <= x1; a++) for (let b = z0; b <= z1; b++) { const k = `${a},${b}`; let arr = bins.get(k); if (!arr) bins.set(k, arr = []); arr.push(j); }
  });
  return (x, z) => {
    const arr = bins.get(`${Math.floor(x / B)},${Math.floor(z / B)}`);
    if (!arr) return null;
    let best = null, bestOut = 0.05;                 // 落在三角形外 0.05mm 以内也算（轮廓偏置的数值误差）
    for (const j of arr) {
      const i = faces[ch.faces[j]] * 9;
      const ax = p[i], az = p[i + 2], bx = p[i + 3], bz = p[i + 5], cx = p[i + 6], cz = p[i + 8];
      const d = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
      if (Math.abs(d) < 1e-12) continue;
      const w1 = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / d, w2 = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / d, w0 = 1 - w1 - w2;
      const outBy = -Math.min(w0, w1, w2) * Math.sqrt(Math.abs(d));   // 粗略的出界距离
      if (outBy <= 0) return { y: w0 * p[i + 1] + w1 * p[i + 4] + w2 * p[i + 7], f: faces[ch.faces[j]] };
      if (outBy < bestOut) {
        bestOut = outBy;
        const c0 = Math.max(0, w0), c1 = Math.max(0, w1), c2 = Math.max(0, w2), s = c0 + c1 + c2 || 1;
        best = { y: (c0 * p[i + 1] + c1 * p[i + 4] + c2 * p[i + 7]) / s, f: faces[ch.faces[j]] };
      }
    }
    return best;
  };
}

async function collectContactPoints(ctx, islandsOnly) {
  const A = state.analysis;
  const { bvh, ld, faces, groundY, protNear } = ctx;
  const spacing = Math.max(0.5, params.spacing);
  // 防粘连：相邻支撑的中心距不小于 主干直径 + 0.4 mm（净距），粗支撑即使间距按比例放大，也不能被布点挤到几乎贴在一起
  const clearD = params.esBarW + 0.4;
  const edgeInset = Math.max(0, Number.isFinite(params.edgeInset) ? params.edgeInset : 1.0);
  const rep = { regions: 0, charts: 0, edgePts: 0, innerPts: 0, areaPruned: 0, heldFaces: 0, protFaces: 0, seeds: 0, low: 0, flush: 0, held: 0, wall: 0, prot: 0, pack: 0, filled: 0, capped: 0, islands: 0, islandsNoPoint: 0, maskBad: 0, seedSwap: 0 };
  const tick = makeYielder();

  // 1. 孤岛关键点：周界像素按 spacing 体素降采样（每体素取最低）+ 全岛最低点
  const seeds = [];
  if (A.graph && ld) {
    const floorY = A.grid.minY - A.raiseH, { W: GW, H: GH, layerH } = A.grid;
    const vkey = (x, y, z) => `${Math.floor(x / spacing)},${Math.floor(y / spacing)},${Math.floor(z / spacing)}`;
    const targetId = supportTargetId();
    for (const nd of A.graph.nodes) {
      if (!nd.island || !nd.pixels) continue;
      if (targetId != null && !islandOnTarget(nd, A, bvh, targetId)) continue;
      rep.islands++;
      const pix = new Set(nd.pixels);
      const peri = new Map(), cells = new Map();          // 像素号 → 点
      let minY = Infinity;
      for (const cc of nd.pixels) {
        const ci = cc % GW, cj = (cc / GW) | 0;
        const gr = ldiGapAt(ld, cc, nd.y, floorY);
        // 只取区间入口落在本层附近的像素：与下层重叠的少数像素，入口在下方别的结构上（旧实现会把「最低点」放到那里）
        if (!gr || gr.surfY < nd.y - layerH * 1.5) continue;
        const pt = { x: A.grid.x0 + (ci + 0.5) * A.grid.sx, y: gr.surfY, z: A.grid.z0 + (cj + 0.5) * A.grid.sz, island: nd.id };
        cells.set(cc, pt);
        if (pt.y < minY) minY = pt.y;
        const edge = ci + 1 >= GW || !pix.has(cc + 1) || ci - 1 < 0 || !pix.has(cc - 1) || cj + 1 >= GH || !pix.has(cc + GW) || cj - 1 < 0 || !pix.has(cc - GW);
        if (edge) { const k = vkey(pt.x, pt.y, pt.z); if (!peri.has(k) || pt.y < peri.get(k).y) peri.set(k, pt); }
      }
      // 最低点：一样低（差不到一层）的像素里取离这片「最低区」边界最远的那个——平底孤岛（底座、悬臂下表面、立柱底盘）整面一样低，
      // 旧实现取扫描到的第一个，正好是角上 / 边上的格子（用户截图：底座角上、悬臂尖上、底盘边上各一个贴边的点）；尖底仍落在尖上
      if (cells.size) {
        const tolY = Math.max(layerH, 0.05), low = new Map();
        for (const [cc, pt] of cells) if (pt.y <= minY + tolY) low.set(cc, 0);
        const queue = [];
        for (const cc of low.keys()) {
          const ci = cc % GW;
          if (ci + 1 >= GW || !low.has(cc + 1) || ci < 1 || !low.has(cc - 1) || !low.has(cc + GW) || !low.has(cc - GW)) { low.set(cc, 1); queue.push(cc); }
        }
        let maxD = 0;
        for (let qi = 0; qi < queue.length; qi++) {
          const cc = queue[qi], d = low.get(cc), ci = cc % GW;
          if (d > maxD) maxD = d;
          for (const nb of [ci + 1 < GW ? cc + 1 : -1, ci > 0 ? cc - 1 : -1, cc + GW, cc - GW]) {
            if (nb >= 0 && low.get(nb) === 0) { low.set(nb, d + 1); queue.push(nb); }
          }
        }
        // 最深的格子可能连成一溜（长条底面的中线）：取这一溜里离它们重心最近的那个，落在正中，不落在一头
        let sx = 0, sz = 0, nTop = 0;
        for (const [cc, d] of low) if (d === maxD) { sx += cc % GW; sz += (cc / GW) | 0; nTop++; }
        sx /= nTop; sz /= nTop;
        let best = queue[0], bd = Infinity;
        for (const [cc, d] of low) if (d === maxD) { const dd = (cc % GW - sx) ** 2 + (((cc / GW) | 0) - sz) ** 2; if (dd < bd) { bd = dd; best = cc; } }
        const lowest = cells.get(best);
        lowest.low = true;
        lowest.lowSet = low;                               // 最低区像素（第 7 步判断「这片最低区里是否已有支撑」）
        peri.set('low', lowest);
      }
      for (const pt of peri.values()) seeds.push(pt);
    }
  }
  rep.seeds = seeds.length;

  // 2. 逐点有效性：贴面 / 已托住 / 贴壁根部 / 保护面；同时取被托面法线
  // 贴壁根部：水平 WALL_R 圆周上某列有一段实体同时覆盖 [接触点下 1.0, 接触点下 0.1]——即紧邻一面从下方竖直上来的侧壁，
  // 该点是悬臂根部，悬臂 < 1mm 可自支撑（Formlabs 1mm 悬臂规则 / HeyGears meshAreaBoundaryOffset）。孤岛种子不适用。半径见文件头 WALL_R
  const colCovers = (x, z, y0, y1) => {
    const ci = Math.floor((x - ld.x0) / ld.sx), cj = Math.floor((z - ld.z0) / ld.sz);
    if (ci < 0 || cj < 0 || ci >= ld.W || cj >= ld.H) return false;
    const c = cj * ld.W + ci, b = ld.offs[c], e = b + ld.nInt[c];
    for (let k = b; k < e; k++) if (ld.ys[2 * k] <= y0 && ld.ys[2 * k + 1] >= y1) return true;
    return false;
  };
  const wallRoot = c => {
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4;
      if (colCovers(c.x + WALL_R * Math.cos(a), c.z + WALL_R * Math.sin(a), c.y - 1.0, c.y - 0.1)) return true;
    }
    return false;
  };
  // 放不了点的原因（null = 可以放）：低于底板 / 贴面（尖端正下方已是实体）/ 已托住（孤岛只豁免极小间隙）/ 贴壁根部。
  // 布点前按同一套判据给图块铺「禁放」格（第 5 步），布点绕开这些地方；布完再逐点校验一遍
  const badReason = (c, isSeed) => {
    if (c.y < groundY + 0.25) return 'low';
    if (ld && ldiInside(ld, c.x, c.y - 0.15, c.z)) return 'flush';
    const hit = raycast(bvh, c.x, c.y - 0.05, c.z, 0, -1, 0, 0.1, 1e9);
    const below = Math.min(hit ? hit.t + 0.05 : c.y - groundY, ldiGapBelow(ld, c.x, c.y, c.z));
    if (below < (isSeed ? 0.25 : 0.8)) return 'held';
    if (!isSeed && ld && wallRoot(c)) return 'wall';
    return null;
  };
  const validate = (c, isSeed) => {
    const why = badReason(c, isSeed);
    if (why) { rep[why]++; return null; }
    let f = c.f;
    if (f === undefined) { const pr = raycast(bvh, c.x, c.y + 0.05, c.z, 0, -1, 0, 0.005, 0.35); f = pr ? pr.f : -1; }
    if (f >= 0 && state.protectedFaces.has(f)) { rep.prot++; return null; }
    if (protNear && protNear(c)) { rep.prot++; return null; }
    const n = f >= 0 ? [faces.nrm[f * 3], faces.nrm[f * 3 + 1], faces.nrm[f * 3 + 2]] : [0, -1, 0];
    const partId = f >= 0 ? facePartId(f) : supportTargetId();
    return { x: c.x, y: c.y, z: c.z, n, island: c.island !== undefined ? c.island : null, reg: c.reg, partId };
  };

  // 3. 最近距离（哈希格）与接受
  // 与已放点的最近距离下限：同一图块里的点布点时已经排匀（布点里任意两点 ≥ 0.8 × 间距），只去掉几乎重合的。
  // 接缝：布点时已把先布好的图块在接缝那边的点当钉（manifoldKit），接缝两侧在布点里就排开了；这里与其他图块、孤岛种子
  // 之间只去掉几乎重合的（0.6 × 间距）——按 0.8 × 去重会把台阶两侧各自需要的点删掉一个（实测手办左手：两面高差 1.2mm，
  // 布点当成两片面各自排，这里却当一片删掉一个，留下空当）。都不低于 clearD（防粘连）
  const PACK = Math.max(spacing * 0.6, clearD), PACK_SAME = Math.max(spacing * 0.4, clearD);
  const HOLE = Math.max(spacing * 0.85, edgeInset + spacing * 0.5);   // 兜底补点阈值：边缘带不补，内缩不被破坏
  const out = [];
  const existing = state.supportPoints;
  const hCell = spacing / Math.sqrt(3);
  const hReach = Math.max(2, Math.ceil(Math.max(PACK, HOLE) / hCell));
  const hash = new Map();
  const hk = (x, y, z) => `${Math.floor(x / hCell)},${Math.floor(y / hCell)},${Math.floor(z / hCell)}`;
  // 哈希里存 { x, y, z, ch }：ch = 来自哪个图块的布点（孤岛种子、已有点、兜底补点为 -1）
  const regPt = (pt, ch = -1) => { const k = hk(pt.x, pt.y, pt.z); let a = hash.get(k); if (!a) hash.set(k, a = []); a.push({ x: pt.x, y: pt.y, z: pt.z, ch }); };
  const unregPt = pt => {
    const a = hash.get(hk(pt.x, pt.y, pt.z));
    const i = a ? a.findIndex(q => q.x === pt.x && q.y === pt.y && q.z === pt.z) : -1;
    if (i >= 0) a.splice(i, 1);
  };
  let nearSame = Infinity;                         // closestD 顺带给出：同一图块（ch ≥ 0 且相同）里最近的距离
  const closestD = (pt, ch = -1) => {
    const i = Math.floor(pt.x / hCell), j = Math.floor(pt.y / hCell), k = Math.floor(pt.z / hCell);
    let best = Infinity;
    nearSame = Infinity;
    for (let a = -hReach; a <= hReach; a++) for (let b = -hReach; b <= hReach; b++) for (let c = -hReach; c <= hReach; c++) {
      const arr = hash.get(`${i + a},${j + b},${k + c}`);
      if (!arr) continue;
      for (const q of arr) {
        const dxz = Math.hypot(q.x - pt.x, q.z - pt.z), dy = Math.abs(q.y - pt.y), d = Math.hypot(dxz, dy);
        if (ch >= 0 && q.ch === ch) { if (d < nearSame) nearSame = d; continue; }
        // 连线比 45° 还陡的两点是上下叠着的两层曲面（支撑区域的坡度不超过 45°，同一片曲面上相邻两点的连线不会更陡）：
        // 各要各的支撑，只防粘连（clearD），不按间距去重——按 0.8 × 间距去重会把下面那层的点删掉（实测手办左手两层手指之间留空当）
        const eff = dy > dxz ? (d < clearD ? 0 : Infinity) : d;
        if (eff < best) best = eff;
      }
    }
    return best;                                   // 不含同一图块的点；上下叠着的另一层只在近于 clearD 时算
  };
  for (const q of existing) regPt(q);
  // 孤岛种子落到支撑附近时，把孤岛编号记到这个点上（结构失败才能报「该孤岛将悬空」）
  const seedCell = Math.max(spacing, 1);
  const seedHash = new Map();
  const sk = (x, y, z) => `${Math.floor(x / seedCell)},${Math.floor(y / seedCell)},${Math.floor(z / seedCell)}`;
  for (const s of seeds) { const k = sk(s.x, s.y, s.z); let a = seedHash.get(k); if (!a) seedHash.set(k, a = []); a.push(s); }
  const islandHit = new Set();
  const tagIsland = v => {
    if (v.island !== null && v.island !== undefined) { islandHit.add(v.island); return; }
    const i = Math.floor(v.x / seedCell), j = Math.floor(v.y / seedCell), k = Math.floor(v.z / seedCell);
    let best = null, bd = HOLE * HOLE;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const arr = seedHash.get(`${i + a},${j + b},${k + c}`);
      if (!arr) continue;
      for (const s of arr) { const d = (s.x - v.x) ** 2 + (s.y - v.y) ** 2 + (s.z - v.z) ** 2; if (d <= bd) { bd = d; best = s; } }
    }
    if (best) { v.island = best.island; islandHit.add(best.island); }
  };
  const tryPlace = (c, isSeed, filled, pack = PACK) => {
    if (out.length + existing.length >= MAX_POINTS) { rep.capped++; return false; }
    const ch = c.chart === undefined ? -1 : c.chart;
    if (closestD(c, ch) < pack || nearSame < PACK_SAME) { rep.pack++; return false; }
    const v = validate(c, isSeed);
    if (!v) return false;
    tagIsland(v);
    out.push(v); regPt(v, ch);
    if (filled) rep.filled++;
    return true;
  };

  // 同一高度（不高于 y + 0.3）水平 HOLE 以内是否已有支撑
  const supportedAtLevel = sd => {
    const i = Math.floor(sd.x / hCell), j = Math.floor(sd.y / hCell), k = Math.floor(sd.z / hCell);
    for (let a = -hReach; a <= hReach; a++) for (let b = -hReach; b <= 1; b++) for (let c = -hReach; c <= hReach; c++) {
      const arr = hash.get(`${i + a},${j + b},${k + c}`);
      if (arr) for (const q of arr) if (q.y <= sd.y + 0.3 && Math.hypot(q.x - sd.x, q.z - sd.z) < HOLE) return true;
    }
    return false;
  };

  // 4. 孤岛关键点放到布点之后（第 6、8 步）：先放的话，小平底孤岛正中的最低点会把四周边缘环的点全挤掉（离它都不到去重距离），
  //    角上只好再补贴边的点（实测 6mm 见方的立柱底）

  let cb = null, masks = null;
  if (!islandsOnly) {
    // 5. 支撑区域 → 图块 → 布点（后台线程：边缘环与内部点一起松弛，按曲面上的三维距离与面积）→ 抬回曲面
    setProgress(0.3, '支撑区域与图块…');
    cb = await buildCharts(ctx, tick);
    Object.assign(rep, cb.rep);
    // 禁放格：图块投影上按 ≈ 间距/8 铺格，格心抬到曲面上，按逐点校验的判据（低于底板 / 贴面 / 已托住 / 贴壁根部 / 保护面附近）判一遍，
    // 放不了的格子交给布点从区域里减掉——布点绕开它们，在它们周围照样留边缘距离，不再布完点再删出空当。
    // 原先布完才逐点校验：模板边缘距离 0.5 < 贴壁根部 0.8，贴墙那段边缘环整排被删（2026-10-17 实测戒指 / 手办臀部每次 8～10 个），
    // 兜底补点又在墙边反复试；大三角形扇面盖住的已托住区域（双层平台的立柱顶）先铺满点再整片删掉，留下一块不规则的空当
    const maskOf = ch => {
      const t2 = ch.tris2, ty = ch.ty;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, area = 0;
      for (let k = 0; k + 5 < t2.length; k += 6) {
        for (let v = 0; v < 6; v += 2) { x0 = Math.min(x0, t2[k + v]); x1 = Math.max(x1, t2[k + v]); z0 = Math.min(z0, t2[k + v + 1]); z1 = Math.max(z1, t2[k + v + 1]); }
        area += Math.abs((t2[k + 2] - t2[k]) * (t2[k + 5] - t2[k + 1]) - (t2[k + 4] - t2[k]) * (t2[k + 3] - t2[k + 1])) / 2;
      }
      const g = Math.max(0.2, spacing / 8, Math.sqrt(area / 60000));
      const nx = Math.max(1, Math.ceil((x1 - x0) / g) + 1), nz = Math.max(1, Math.ceil((z1 - z0) / g) + 1);
      const bits = new Uint8Array(nx * nz), done = new Uint8Array(nx * nz);
      let bad = 0;
      for (let k = 0, m = 0; k + 5 < t2.length; k += 6, m += 3) {
        const ax = t2[k], az = t2[k + 1], bx = t2[k + 2], bz = t2[k + 3], qx = t2[k + 4], qz = t2[k + 5];
        const d = (bx - ax) * (qz - az) - (qx - ax) * (bz - az);
        if (Math.abs(d) < 1e-12) continue;
        const c0 = Math.max(0, Math.ceil((Math.min(ax, bx, qx) - x0) / g)), c1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, qx) - x0) / g));
        const r0 = Math.max(0, Math.ceil((Math.min(az, bz, qz) - z0) / g)), r1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, qz) - z0) / g));
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          const j = r * nx + c;
          if (done[j]) continue;
          const x = x0 + c * g, z = z0 + r * g;
          const w1 = ((x - ax) * (qz - az) - (qx - ax) * (z - az)) / d, w2 = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / d, w0 = 1 - w1 - w2;
          if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
          done[j] = 1;
          const c3 = { x, y: w0 * ty[m] + w1 * ty[m + 1] + w2 * ty[m + 2], z };
          if (badReason(c3, false) || (protNear && protNear(c3))) { bits[j] = 1; bad++; }
        }
      }
      rep.maskBad += bad * g * g;
      return { x0, z0, g, nx, nz, bits };
    };
    masks = [];
    for (const ch of cb.charts) { masks.push(maskOf(ch)); await tick(); }
    // 孤岛最低点落在哪个图块的曲面上，就先交给那个图块的布点当「钉」：布点绕着它排开，旁边不会再挤出一对
    // （布点后再放最低点，最近的一两个布点离它常只有 0.4～0.75 × 间距，换掉一个、第二个仍挨着）。最低点本身仍由第 6 步放
    const lifters = cb.charts.map(ch => makeLifter(cb.faces, ch));
    const pinsOf = cb.charts.map(() => []);
    for (const sd of seeds) {
      if (!sd.low) continue;
      for (let ci = 0; ci < cb.charts.length; ci++) {
        const at = lifters[ci](sd.x, sd.z);
        if (at && Math.abs(at.y - sd.y) <= 0.5) { pinsOf[ci].push(sd.x, sd.z); sd.pinned = true; break; }
      }
    }
    setProgress(0.45, '布点（后台线程）…');
    const rings = cb.charts.length ? await layoutAsync(cb.charts.map((ch, ci) => ({ t2: ch.tris2, ty: ch.ty, mask: masks[ci], pins: Float64Array.from(pinsOf[ci]) })), { edgeInset, spacing }) : [];
    setProgress(0.55, '抬回曲面、逐点校验…');
    const cand = [];
    cb.charts.forEach((ch, ci) => {
      const lift = lifters[ci], r = rings[ci];
      for (let i = 0; i + 2 < r.length; i += 3) {
        const at = lift(r[i], r[i + 1]);
        if (!at) continue;
        cand.push({ x: r[i], y: at.y, z: r[i + 1], f: at.f, reg: ch.reg, ring: r[i + 2], chart: ci });
        if (r[i + 2]) rep.innerPts++; else rep.edgePts++;
      }
    });
    // 边缘环先放（用户要的那一圈），再放内部；同类按生成顺序（内部点按最空先补的顺序）
    cand.sort((a, b) => a.ring - b.ring);
    for (let i = 0; i < cand.length; i++) {
      if ((i & 255) === 0) await tick();
      tryPlace(cand[i], false, false);
    }
  }
  // 6. 孤岛最低点（最先打印的就是这一点，必须托住）：这片最低区（一样低的那些像素）里已经有支撑点（平底孤岛的边缘环 / 内部点）就不放；
  //    否则放（尖底、锥尖、薄沿）。附近 0.8 × 间距内已有布点时，用最低点替换最近的那一个，而不是再加一个——两者都留就挤成一对
  //    （2026-10-17 实测真实件近点对约一半来自这里：旁边 1.2mm、几乎同高的布点因为不在「最低区」像素里不算数）。
  //    只换最近的一个：一次换掉几个，窄条上会少一个点、留下空当（实测手办左手）。放在兜底补点之前：替换后若留下空当，兜底补点会补上
  const gx0 = A.grid.x0, gz0 = A.grid.z0, gsx = A.grid.sx, gsz = A.grid.sz, GWd = A.grid.W;
  const lowTouched = sd => {
    const tolY = Math.max(A.grid.layerH, 0.05) + 0.3;
    for (const q of out) {
      if (Math.abs(q.y - sd.y) > tolY) continue;
      const ci = Math.floor((q.x - gx0) / gsx), cj = Math.floor((q.z - gz0) / gsz);
      if (ci >= 0 && ci < GWd && sd.lowSet.has(cj * GWd + ci)) return true;
    }
    return false;
  };
  for (const sd of seeds.filter(q => q.low).sort((a, b) => a.y - b.y)) {
    // 布点时当过「钉」的最低点：旁边的布点已经让开，直接放（不再看最低区里有没有点——那个位置是给它留的）
    if (sd.pinned) { if (tryPlace(sd, true, false, Math.max(spacing * 0.3, clearD))) out[out.length - 1].seed = true; continue; }
    if (lowTouched(sd)) continue;
    let near = null, nd = 0.8 * spacing;
    for (const q of out) { if (q.seed) continue; const d = Math.hypot(q.x - sd.x, q.y - sd.y, q.z - sd.z); if (d < nd) { nd = d; near = q; } }
    near = near ? [near] : [];
    for (const q of near) { out.splice(out.indexOf(q), 1); unregPt(q); }
    if (tryPlace(sd, true, false, Math.max(spacing * 0.3, clearD))) {
      out[out.length - 1].seed = true;
      rep.seedSwap += near.length;
    } else for (const q of near) { out.push(q); regPt(q); }   // 最低点放不下（贴面 / 保护面）：原来的布点放回去（此后的种子与兜底补点都按「其他图块」口径查距离，图块号不再要紧）
  }
  if (!islandsOnly) {
    // 7. 兜底补点：区域面上的采样（面重心 + 大三角形 Halton 细分），离所有支撑都超过 HOLE 才补
    const maxA = spacing * spacing * 0.5, probes = [];
    // 探针打在切开后的三角形上。打在整张原面上的话，等值线外侧（本来能自支撑的那一截）会被当成空当补上点
    for (const ch of cb.charts) {
      const t2 = ch.tris2, ty = ch.ty, src = ch.src;
      for (let j = 0; j < src.length; j++) {
        const f = src[j], o = j * 6, m = j * 3;
        const x0 = t2[o], z0 = t2[o + 1], y0 = ty[m];
        const x1 = t2[o + 2], z1 = t2[o + 3], y1 = ty[m + 1];
        const x2 = t2[o + 4], z2 = t2[o + 5], y2 = ty[m + 2];
        const a2 = Math.abs((x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0)) / 2;
        const nS = Math.min(64, Math.max(1, Math.ceil(a2 / maxA)));
        for (let k = 0; k < nS; k++) {
          let u = k ? halton(k, 2) : 1 / 3, v = k ? halton(k, 3) : 1 / 3;
          if (u + v > 1) { u = 1 - u; v = 1 - v; }
          probes.push({
            x: x0 + u * (x1 - x0) + v * (x2 - x0),
            y: y0 + u * (y1 - y0) + v * (y2 - y0),
            z: z0 + u * (z1 - z0) + v * (z2 - z0),
            f,
          });
        }
      }
    }
    // 区域面积过滤过的片不补
    const keptFace = new Set();
    for (const ch of cb.charts) for (const n of ch.faces) keptFace.add(cb.faces[n]);
    probes.sort((a, b) => a.y - b.y);
    // 补在空当中间：把这块空当里（HOLE 以内、离所有支撑都超过 HOLE）的探针取重心，点放在离重心最近的探针上——
    // 直接放在第一个探到的位置，往往就贴着图块边（尖尾、接缝、拐角）
    // 离支撑多远：同一块曲面上的点按投影距离量（与布点同口径），别的曲面上的点按三维距离——陡坡上同样两个点三维距离比投影长 1/cos，
    // 按三维量会把布点认为已盖住的边缘带当成空当，补出贴边的点（实测手办底座两头的斜面）
    const holeD = c => {
      const ny = Math.abs(faces.nrm[c.f * 3 + 1]), tanA = Math.sqrt(Math.max(0, 1 - ny * ny)) / Math.max(ny, 0.2);
      const i = Math.floor(c.x / hCell), j = Math.floor(c.y / hCell), k = Math.floor(c.z / hCell);
      let best = Infinity;
      for (let a = -hReach; a <= hReach; a++) for (let b = -hReach; b <= hReach; b++) for (let d = -hReach; d <= hReach; d++) {
        const arr = hash.get(`${i + a},${j + b},${k + d}`);
        if (arr) for (const q of arr) {
          const dxz = Math.hypot(q.x - c.x, q.z - c.z), dy = Math.abs(q.y - c.y);
          const dd = dy <= dxz * tanA + 0.3 ? dxz : Math.hypot(dxz, dy);
          if (dd < best) best = dd;
        }
      }
      return best;
    };
    // 探针离所在图块边界的投影距离（边界边按 2mm 格分桶，查到边缘距离为止）
    const faceChart = new Map();
    cb.charts.forEach((ch, ci) => { for (const n of ch.faces) faceChart.set(cb.faces[n], ci); });
    // 落在禁放格里的探针不试：布点有意绕开了那里（贴壁根部 / 已托住 / 贴面 / 保护面附近），试了也是被逐点校验拒掉
    const inMask = q => {
      const ci = faceChart.get(q.f), m = ci === undefined ? null : masks[ci];
      if (!m) return false;
      const c = Math.round((q.x - m.x0) / m.g), r = Math.round((q.z - m.z0) / m.g);
      return c >= 0 && r >= 0 && c < m.nx && r < m.nz && m.bits[r * m.nx + c] === 1;
    };
    const BB = 2, segBins = cb.charts.map(ch => {
      const m = new Map(), b = ch.bnd;
      for (let i = 0; i + 3 < b.length; i += 4) {
        const x0 = Math.floor(Math.min(b[i], b[i + 2]) / BB), x1 = Math.floor(Math.max(b[i], b[i + 2]) / BB), z0 = Math.floor(Math.min(b[i + 1], b[i + 3]) / BB), z1 = Math.floor(Math.max(b[i + 1], b[i + 3]) / BB);
        for (let a = x0; a <= x1; a++) for (let d = z0; d <= z1; d++) { const k = a + ',' + d; let arr = m.get(k); if (!arr) m.set(k, arr = []); arr.push(i); }
      }
      return m;
    });
    const edgeDistOf = q => {
      const ci = faceChart.get(q.f);
      if (ci === undefined) return 0;
      const b = cb.charts[ci].bnd, m = segBins[ci], gx0 = Math.floor(q.x / BB), gz0 = Math.floor(q.z / BB), R = Math.ceil(edgeInset / BB) + 1;
      let best = Infinity;
      for (let a = -R; a <= R; a++) for (let d = -R; d <= R; d++) {
        const arr = m.get((gx0 + a) + ',' + (gz0 + d));
        if (arr) for (const i of arr) {
          const dx = b[i + 2] - b[i], dz = b[i + 3] - b[i + 1], L2 = dx * dx + dz * dz;
          let u = L2 ? ((q.x - b[i]) * dx + (q.z - b[i + 1]) * dz) / L2 : 0; u = Math.max(0, Math.min(1, u));
          const dd = Math.hypot(q.x - b[i] - u * dx, q.z - b[i + 1] - u * dz);
          if (dd < best) best = dd;
        }
      }
      return best;
    };
    const PB = HOLE, pbin = new Map(), pk = (x, y, z) => `${Math.floor(x / PB)},${Math.floor(y / PB)},${Math.floor(z / PB)}`;
    for (const c of probes) { if (!keptFace.has(c.f)) continue; const k = pk(c.x, c.y, c.z); let a = pbin.get(k); if (!a) pbin.set(k, a = []); a.push(c); }
    // 一块空当按「离图块边远、靠近空当中间」的顺序试放：被拒的原因——贴壁根部、贴面、已托住——都是局部的，挪开半毫米往往就能放。
    // 被拒的位置连同它 FILL_SEP 以内的探针记为试过（以后不再试、也不再当起点）；一轮最多试 FILL_TRIES 处，没试到的留给后面的起点
    // 接着试，整块空当都试过了才整块放弃。
    // 不记的话每个探针都重新收集整块空当、把同一个最深的位置再试一遍（实测 10 万面的裙摆件：3242 次被「贴壁根部」拒掉，兜底补点
    // 空转 80 秒；500 个零件里 4 个因此超时）；只试一两处就整块放弃又会漏补（实测 228 个零件的兜底补点少了 15%，手办部件 10 个只剩 0 个）
    const FILL_TRIES = 24, FILL_SEP = 0.5;
    const tried = new Set();
    for (let i = 0; i < probes.length; i++) {
      if ((i & 1023) === 0) await tick();
      if (out.length + existing.length >= MAX_POINTS) { rep.capped++; break; }
      const c = probes[i];
      if (tried.has(c)) continue;
      // 触发线放宽 10%：边缘带里刚过阈值的空当布点那一步（后台线程，守边缘距离）已经按 0.98 × 阈值补过，这里只管明显的漏洞——
      // 两边一个按 0.2mm 采样格量、一个按精确位置量，卡同一条线会为了超出零点几毫米补一个贴边的点（实测手办部件 2.91～3.05mm）
      if (!keptFace.has(c.f) || inMask(c) || holeD(c) <= HOLE * 1.1) continue;
      const gap = [];
      const bi = Math.floor(c.x / PB), bj = Math.floor(c.y / PB), bk = Math.floor(c.z / PB);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
        const arr = pbin.get(`${bi + a},${bj + b},${bk + d}`);
        if (arr) for (const q of arr) if ((q.x - c.x) ** 2 + (q.y - c.y) ** 2 + (q.z - c.z) ** 2 <= HOLE * HOLE && !inMask(q) && holeD(q) > HOLE) gap.push(q);
      }
      let gx = 0, gy = 0, gz = 0;
      for (const q of gap) { gx += q.x; gy += q.y; gz += q.z; }
      gx /= gap.length; gy /= gap.length; gz /= gap.length;
      // 空当里先试离图块边最远的那个（够到边缘距离即可，同样深就挑靠近空当中间的）——空当常是贴边的一条细缝，取重心也贴着边
      const order = [];
      for (const q of gap) if (!tried.has(q)) order.push({ q, sc: Math.min(edgeDistOf(q), edgeInset) - 0.05 * Math.hypot(q.x - gx, q.y - gy, q.z - gz) });
      order.sort((a, b) => b.sc - a.sc);
      let placed = false, n = 0;
      for (const { q } of order) {
        if (tried.has(q)) continue;
        if (tryPlace(q, false, true)) { placed = true; break; }
        for (const g of gap) if ((g.x - q.x) ** 2 + (g.y - q.y) ** 2 + (g.z - q.z) ** 2 < FILL_SEP * FILL_SEP) tried.add(g);
        tried.add(q);
        if (++n >= FILL_TRIES) break;
      }
      if (!placed && n < FILL_TRIES) { for (const q of gap) tried.add(q); tried.add(c); }
    }
  }
  // 8. 孤岛周界点：同一高度附近（水平 HOLE 内、不高于它 0.3mm）已有支撑就不放——平底孤岛（雕像底座）的边由边缘环按
  //    「边缘距离」负责，不再贴边放一圈；薄沿孤岛（伞缘）的布点都在它上方，周界点照放（最先打印的就是这一圈）
  for (const sd of seeds.filter(q => !q.low).sort((a, b) => a.y - b.y)) {
    if (!supportedAtLevel(sd)) tryPlace(sd, true, false);
  }
  for (const s of seeds) {
    if (!islandHit.has(s.island) && closestD(s) <= HOLE + 1e-6) islandHit.add(s.island);
  }
  rep.islandsNoPoint = Math.max(0, rep.islands - islandHit.size);
  return { points: out, rep };
}

/* ================================================================
   结构重建：从支撑点集生成支撑塔格架几何
================================================================ */
const STATE_TEXT = { ground: '落地', mesh: '锚定模型', micro: '微型短柱', nohead: '头部无法放置', unroutable: '无法路由' };

/* 让出主线程：长循环里每 ~24ms 让一次，浏览器有机会处理输入、画一帧。
   用 MessageChannel 宏任务而不是 rAF——rAF 在后台标签页里会停摆，生成就挂住了 */
const yieldWaiters = [];
let yieldChan = null;
function macrotask() {
  return new Promise(resolve => {
    if (typeof MessageChannel === 'undefined') { setTimeout(resolve, 0); return; }
    if (!yieldChan) {
      yieldChan = new MessageChannel();
      yieldChan.port1.onmessage = () => { const f = yieldWaiters.shift(); if (f) f(); };
    }
    yieldWaiters.push(resolve);
    yieldChan.port2.postMessage(0);
  });
}
function makeYielder(budget = 24) {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < budget) return;
    await macrotask();
    last = performance.now();
  };
}

/* 重建序号：每次重建 / 清空自增。支撑塔的实体化在后台线程里算，这期间用户还能加点、删点、改参数、换模型——
   算完时若已不是最新一次，结果作废，不覆盖更新的状态 */
let buildSeq = 0;
let genSeq = 0;   // 生成支撑点的序号：布点期间又发起新一次生成时，旧的结果作废
const disposeResult = res => {
  if (!res) return;
  for (const k of ['geomGround', 'geomGround2', 'geomAnchor', 'geomBase']) if (res[k]) res[k].dispose();
};

/* 底板要求的模型抬高（joinPlate.js 的 joinLiftWanted：连接底板高 / 自动底板厚）变了——切换连接底板 / 自动底板、改自动底板板厚、切换结构、模板或格宽等改了板高：
   提交新抬高（state.joinLift，model.js 的 raiseH 读它），模型挪过去，已有支撑点（含手动加的点与锚点）同步平移。
   分析结果与世界系只差一个 y 平移，逐字段平移，不重跑逐层分析。相对模型一切不变，所以支撑点不必重新布。返回是否有变化。
   自动底板的抬高等于板厚：支撑落点在底板顶面（baseY），板厚垫在支撑下面。 */
let liftSync = null;
export async function syncModelLift() {
  while (liftSync) await liftSync;                    // 正在同步：等它做完再判断
  const want = joinLiftWanted(params), cur = state.joinLift || 0;
  if (Math.abs(want - cur) < 1e-9) return false;
  liftSync = (async () => {
    const dy = want - cur;
    state.joinLift = want;
    placeModelAtLift();
    for (const p of state.supportPoints || []) { p.y += dy; if (p.ay !== undefined) p.ay += dy; }
    const auto = !!params.autoPlateOn && !params.baseJoin;
    log(want
      ? (auto
        ? `自动底板：模型按板厚抬高 ${+want.toFixed(2)}mm（底面离平台 ${+raiseH().toFixed(2)}mm，离底板顶面 ${+(raiseH() - want).toFixed(2)}mm，即最短支撑），支撑从底板顶面往上生成`
        : `连接底板：模型随之抬高 ${+want.toFixed(2)}mm（底面离平台 ${+raiseH().toFixed(2)}mm，离板顶 ${+(raiseH() - joinPlateHeight(params)).toFixed(2)}mm，即最短支撑），支撑从板顶往上生成`)
      : `底板抬高已撤：模型回到离平台 ${+raiseH().toFixed(2)}mm`, 'ok');
    // 分析结果与世界系只差一个 y 平移（模型整体挪 dy）：逐字段平移，不重跑逐层分析（约 0.6s 主线程）
    if (state.analysis && state.mesh) shiftAnalysisY(dy);
  })();
  try { await liftSync; } finally { liftSync = null; }
  return true;
}

/** 按当前模式从支撑点集重建结构；被更新的重建取代时返回 null */
export async function rebuildStructure() {
  if (!state.analysis || !state.mesh) return null;
  await syncModelLift();                              // 板高 / 连接底板变了：先挪模型、平移支撑点、重跑分析
  if (!state.analysis || !state.mesh) return null;
  if (state.supportSel) state.supportSel.clear();
  const seq = ++buildSeq, A0 = state.analysis, M0 = state.mesh;
  setProgress(0.8, '生成支撑结构（避让 / 合并）…'); await nextFrame();
  if (seq !== buildSeq) return null;
  const t0 = performance.now();
  const ctx = makeCtx();
  ctx.yieldUI = makeYielder();
  ctx.progress = (p, text) => { if (seq === buildSeq) setProgress(p, text); };
  const P = paramSnapshot();
  const pts = state.supportPoints.slice();            // 快照：后台计算期间点集可能被改
  // 支撑点的布点位置（锚点 ax / ay / az）：支撑塔会把点挪到针尖的接触点（≤ 接触宽），每次重建都从布点位置重新算——
  // 多次重建之间不累积漂移
  for (const p of pts) {
    if (p.ax === undefined) { p.ax = p.x; p.ay = p.y; p.az = p.z; }
    else { p.x = p.ax; p.y = p.ay; p.z = p.az; }
  }
  let res;
  try {
    res = await buildEStageTowers(ctx, pts, P);
  } catch (err) {
    if (err && err.aborted) return null;              // 排队时就被更新的请求取代
    if (seq === buildSeq) setProgress(null);
    throw err;
  }
  if (seq !== buildSeq || state.analysis !== A0 || state.mesh !== M0) { disposeResult(res); return null; }
  // 算完再换：旧支撑在计算期间一直留在画面上，不会先消失一两秒
  clearMeshes();
  const add = (g, mat, kind, part) => {
    if (!g) return;
    const m = new THREE.Mesh(g, mat);
    m.userData.kind = kind;
    supportGroup.add(m);
    state.supports.push({ mesh: m, kind, part });      // part：'tower' 格架塔 / 'needle' 连接体（针 / 兜底件）——显示模式分流用
  };
  add(res.geomGround, supMat, 'ground', 'tower');
  add(res.geomNeedle, supMat, 'ground', 'needle');   // 十字针 / 转接块凸包（从格架塔几何里拆出）
  add(res.geomGround2, supMat, 'ground', 'needle');  // 兜底件（十字短杆 / 分叉主干）的落地部分
  add(res.geomAnchor, supMatAnchor, 'anchor', 'needle');
  add(res.geomBase, supMatBase, 'base', 'base');
  pts.forEach((p, k) => { p.state = res.pointState[k] || ''; });
  const ok = pts.filter(p => p.state === 'ground' || p.state === 'mesh' || p.state === 'micro').length;
  const cov = islandCoverage();
  state.supportStats = {
    mode: 'tower', ...res.stats, ok, ms: Math.round(performance.now() - t0),
    islFail: cov.fail, islNoPoint: cov.noPoint, islOpen: cov.open,
  };
  syncSupportView();
  prepareSupportColors();
  setProgress(null);
  updateSupStats();
  drawLayer();
  updateRaft();                                       // 支撑变了 → 自动底板的投影跟着变（其余底板无副作用）
  return res;
}

export async function runGenSup(opts = {}) {
  const islandsOnly = !!opts.islandsOnly;
  if (!state.analysis) return toast('请先运行逐层分析');
  const target = supportTargetPart();
  if (state.parts.length > 1 && !target) return toast('先选中一个模型，再生成支撑');
  await syncModelLift();                              // 先按连接底板挪好模型（已有点同步平移），再布点
  const onlyId = target && state.parts.length > 1 ? target.id : null;
  if (state.analysis && !state.analysis._bvh) state.analysis._bvh = buildBVH(state.analysis.p);
  // 别的模型上已经有的支撑留下。这一件上的手动点在换参数重布时保留。
  const foreign = [];
  const keep = [];
  if (!islandsOnly) {
    for (const p of state.supportPoints || []) {
      const id = partIdOfPoint(p);
      if (onlyId != null && id !== onlyId) foreign.push(p);
      else if (opts.keepManual && p.manual) keep.push(p);
    }
  }
  if (!islandsOnly) clearSupports(false);
  if (!state.supportPoints) state.supportPoints = [];
  if (foreign.length) state.supportPoints.push(...foreign);
  if (keep.length) state.supportPoints.push(...keep);
  setProgress(0.2, '提取支撑点…'); await nextFrame();
  const ctx = makeCtx();
  const gen = ++genSeq;
  const { points, rep } = await collectContactPoints(ctx, islandsOnly);
  // 布点期间又发起了新一次生成（它已清空点集）：旧的结果作废，不再写入——否则两次生成的点叠在一起，点数翻倍
  if (gen !== genSeq) return;
  state.supportPoints.push(...points);
  if (!state.supportPoints.length) {
    setProgress(null); updateSupStats();
    log(islandsOnly ? '自动孤岛支撑：没有需要补打的孤岛' : '没有检测到需要支撑的悬空区域', 'warn');
    return;
  }
  const res = await rebuildStructure();
  if (!res) return;                                   // 计算期间又发起了新的重建，日志交给那一次
  const s = res.stats;
  const scope = onlyId != null && target ? `（只给「${target.name}」）` : '';
  const head = islandsOnly ? `自动孤岛支撑：新增 ${points.length} 个支撑点${scope}` : `支撑点 ${state.supportPoints.length} 个${scope}`;
  log(islandsOnly
    ? `${head}（孤岛种子 ${rep.seeds}，已托住 ${rep.held}，贴面 ${rep.flush}，保护面 ${rep.prot}）`
    : `${head}（支撑区域 ${rep.regions} 片 / 图块 ${rep.charts}，面积滤除 ${rep.areaPruned} 片；边缘环 ${rep.edgePts} 点、内部 ${rep.innerPts} 点、孤岛种子 ${rep.seeds}、兜底补点 ${rep.filled}；`
      + `距离过近去重 ${rep.pack}，已托住 ${rep.held}（面 ${rep.heldFaces}），贴壁根部 ${rep.wall}，贴面 ${rep.flush}，保护面 ${rep.prot}；边缘距离 ${params.edgeInset ?? 1.0}mm`
      + `${rep.cutFaces ? `，等值线切开 ${rep.cutFaces} 个三角面` : ''}`
      + `${rep.maskBad >= 0.5 ? `，布点前避开放不了点的地方 ${rep.maskBad.toFixed(0)}mm²（贴壁根部 / 已托住 / 贴面 / 保护面附近）` : ''}${rep.seedSwap ? `，孤岛最低点替换了 ${rep.seedSwap} 个挨着的布点` : ''}）`, 'ok');
  const al = (s.needlesV || 0) + (s.needlesP || 0);
  if (s.needles) log(`十字针：格架同向 ${al} 根（竖直 ${s.needlesV || 0} · 墙面内斜向 ${s.needlesP || 0}）· 自由直针 ${s.needlesFree || 0} 根${s.needlesNear ? `（其中就近接格架 ${s.needlesNear} 根）` : ''}；同向针的支撑点已挪到接触点（平均 ${al ? (s.shiftSum / al).toFixed(2) : 0}mm、最大 ${(s.shiftMax || 0).toFixed(2)}mm）；针尖沿法线折向 ${s.tipBent || 0} 根；球头 ${params.tipBall !== false ? (s.balls || 0) : 0} 个；顶端长度 ${(params.esTaper || 1.5).toFixed(2)} mm`, 'ok');
  // 连不上格架的点：就近接格架 / 分叉 / 十字短杆之后仍接不上的，标红、不生成结构
  const plateOn = !!params.shortSup;   // 十字短杆（贴面短连接）
  const fb = !s.fallback ? '全部连上格架'
    : (plateOn ? `未接格架的 ${s.fallback} 点里，短杆 ${s.plates || 0} 点${s.forks ? `（分叉 ${s.forks} 对：一主干两头）` : ''}${s.shortBent ? `，针尖沿法线折向 ${s.shortBent} 处${s.shortBentFoot ? `（底部 ${s.shortBentFoot} 处）` : ''}` : ''}，其余 ${s.unconnected || 0} 点未生成（标红）` : `未接格架的 ${s.fallback} 点未生成（标红）`);
  log(`支撑塔：十字针 ${s.needles} 根接入格架，塔块 ${s.towers} 座（格架节点 ${s.nodes}，杆件 ${s.bars}，基础带 ${s.foundRuns} 段${s.bandH ? `，连接底板高 ${s.bandH}mm（模型同步抬高，支撑从板顶往上，基础带到格架起步 ${s.stripH}mm）${s.pads ? `，短杆下补立板 ${s.pads} 块` : ''}${s.slabCuts ? `，立板在模型下方断开 ${s.slabCuts} 处` : ''}` : ''}）；${fb}，${state.supportStats.ms}ms`, 'ok');
  if (s.lowSpace || s.lowBack) log(`低空间单杆：${s.lowSpace || 0} 个点离格架起步面不足一个柱高，不接格架，各自单杆直落到底板 / 平台（最短支撑 = 模型抬高）${s.lowBack ? `；另有 ${s.lowBack} 个低空间点单杆落不下去，改走常规接入` : ''}`, 'ok');
  if (s.capped) log('⚠ 格架节点 / 杆件数达到上限，已截断（可增大菱形宽）', 'warn');
  const bad = (s.noHead || 0) + (s.unroutable || 0);
  if (bad) log(`⚠ 支撑塔结构：${s.noHead || 0} 个点头部无法放置（锥内全部方向碰撞），${s.unroutable || 0} 个点无法落地/锚定——已剔除，不生成悬空几何`, 'warn');
  if (s.unconnected) log(`⚠ ${s.unconnected} 个支撑点连不上格架，已标红、未生成结构（可加点 / 删点）`, 'warn');
  if (rep.islandsNoPoint) log(`⚠ ${rep.islandsNoPoint} 处孤岛没有可放置的支撑点（贴面/保护面/间隙过小），请检查层检查器`, 'warn');
  // 孤岛结构覆盖：有支撑点的孤岛，至少一个点须生成结构，否则该孤岛实际悬空（rebuildStructure 已写入 supportStats）
  const islFail = state.supportStats.islFail || 0;
  if (islFail) log(`⚠ ${islFail} 处孤岛的支撑点全部未能生成结构（该孤岛将悬空），请查看层检查器红点`, 'warn');
  if (rep.capped) log(`⚠ 支撑点达到上限 ${MAX_POINTS}，其余 ${rep.capped} 个候选未放置（可增大支撑间距）`, 'warn');
}

/* 手动加支撑点：点击模型表面 → 加点 → 重建结构 */
export async function addSupportPoint(p, n, partId) {
  if (!state.analysis) { toast('请先运行逐层分析'); return; }
  if (!state.supportPoints) state.supportPoints = [];
  const pt = { x: p.x, y: p.y, z: p.z, n: n || [0, -1, 0], manual: true, island: null, partId: partId != null ? partId : state.manualPartId };
  state.supportPoints.push(pt);
  if (!(await rebuildStructure())) return;            // 被更新的重建取代（连点加点时只有最后一次出日志）
  log(`手动支撑点 @ (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) → ${STATE_TEXT[pt.state] || '未生成'}`, pt.state === 'ground' || pt.state === 'mesh' || pt.state === 'micro' ? 'ok' : 'warn');
}

/* 多线段一次加一串点，只重建一次结构。 */
export async function addSupportPoints(list) {
  if (!state.analysis) { toast('请先运行逐层分析'); return; }
  if (!list || !list.length) return;
  if (!state.supportPoints) state.supportPoints = [];
  for (const p of list) {
    state.supportPoints.push({
      x: p.x, y: p.y, z: p.z, n: p.n || [0, -1, 0], manual: true, island: null, partId: state.manualPartId,
    });
  }
  if (!(await rebuildStructure())) return;
  const start = state.supportPoints.length - list.length;
  let ok = 0;
  for (let i = 0; i < list.length; i++) {
    const pt = state.supportPoints[start + i];
    if (pt && (pt.state === 'ground' || pt.state === 'mesh' || pt.state === 'micro')) ok++;
  }
  log(`多线段支撑点 ${list.length} 个，生成结构 ${ok} 个`, ok ? 'ok' : 'warn');
}

/** 删掉这些支撑点（索引），只重建一次结构。 */
export async function deleteSupportIndices(indices) {
  const pts = state.supportPoints || [];
  const drop = [...new Set(indices)].filter(i => i >= 0 && i < pts.length).sort((a, b) => b - a);
  if (!drop.length) { toast('没有选中的支撑点'); return false; }
  for (const i of drop) pts.splice(i, 1);
  if (state.supportSel) state.supportSel.clear();
  if (state.analysis && state.mesh) await rebuildStructure();
  else { syncSupportView(); updateSupStats(); }
  log(`已删除 ${drop.length} 个支撑点`, 'ok');
  return true;
}
