/* ================================================================
   支撑生成总控
   数据流：支撑点（可编辑数据 state.supportPoints）→ 结构生成（rebuildStructure）
   - 支撑点：LDI 栅格悬空点 + 陡峭面（大三角形细分采样）+ 孤岛关键点，经区域面积过滤 / 泊松盘 /
     覆盖锥（仅同一悬空区域）/ 贴面·已托住·保护面过滤；每点带被托面外法线 n
   - 结构：两种几何体系择一（params.supMode）
     · 'tree'  树状支撑：PrusaSlicer branching tree（supportTree.js）
     · 'tower' 支撑塔：Materialise e-Stage 菱形格架支撑塔（supportTower.js，依据 e-Stage 专利 US8903533B2 与官方实拍）
   与 PrusaSlicer 一致：手动增删的是支撑点，结构由点集整体重建——树/格架的分支互相连接，不能逐根增删
   避让：一律基于模型 BVH 的胶囊体净空判定（collide.js），取代旧实现的单条竖直射线
================================================================ */
import * as THREE from 'three';
import { state, params, bus, log, toast, setProgress, nextFrame } from '../store.js';
import { supportGroup, supMat, supMatAnchor, supMatBase } from './scene.js';
import { ldiGapAt } from './slicer.js';
import { baseY } from './model.js';
import { drawLayer } from './inspect.js';
import { buildBVH, raycast, ldiInside } from './collide.js';
import { buildBranchingTree } from './supportTree.js';
import { buildEStageTowers } from './supportTower.js';

const PROT_R = 1.0;          // 保护面抑制半径：接触点（及模型锚点）1mm 内有任一保护面即不放
const MAX_POINTS = 3000;     // 支撑点上限（树状/格架会合并分支，点数可比旧的独立 pin 多）

/* ---------- 状态 ---------- */
function clearMeshes() {
  for (const s of state.supports) { supportGroup.remove(s.mesh); s.mesh.geometry.dispose(); }
  state.supports = [];
}
export function clearSupports(refresh = true) {
  clearMeshes();
  state.supportPoints = [];
  state.supportStats = null;
  if (refresh) { updateSupStats(); if (state.analysis) drawLayer(); }
}
export function updateSupStats() {
  const s = state.supportStats;
  bus.emit('supStats', s ? { ...s, prot: state.protectedFaces.size } : { mode: params.supMode, points: state.supportPoints.length, prot: state.protectedFaces.size });
}

/* 参数快照（结构生成器只读快照，缺省值兜底） */
function paramSnapshot() {
  const p = params, num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    selfAngle: num(p.selfAngle, 45), shortSup: !!p.shortSup,
    tipMode: p.tipMode || 'normal', tipTilt: num(p.tipTilt, 45),   // 接触朝向 / 接触最大倾角（两套结构共用）
    // 树状（PrusaSlicer branching 默认值）
    tipD: num(p.tipD, 0.4), pen: num(p.pen, 0.2), headLen: num(p.headLen, 1.0), midD: num(p.midD, 0.65),
    maxBranchD: num(p.maxBranchD, 2.0), widening: num(p.widening, 0.5), baseD: num(p.baseD, 3), baseH: num(p.baseH, 1),
    maxBridgeLen: num(p.maxBridgeLen, 5), maxBranchLen: num(p.maxBranchLen, 10), maxWeightOnModel: num(p.maxWeightOnModel, 10),
    // 支撑塔（e-Stage 菱形格架）
    esCell: num(p.esCell, 3.5), esDiamAngle: num(p.esDiamAngle, 45), esMidBars: p.esMidBars !== false,
    esBarW: num(p.esBarW, 0.45), esBarT: num(p.esBarT, 0.35), esGap: num(p.esGap, 1.2),
    esColRatio: num(p.esColRatio, 7), esTowerMaxR: num(p.esTowerMaxR, 4), esHullRed: num(p.esHullRed, 1),
    esConnW: num(p.esConnW, 0.45), esNeedleT: num(p.esNeedleT, 0.35), esTipW: num(p.esTipW, 0.3), esContactMargin: num(p.esContactMargin, 0.5), esTaper: num(p.esTaper, 1), esNeedleMax: num(p.esNeedleMax, 6),
    esFoundH: num(p.esFoundH, 1), esNotchH: num(p.esNotchH, 0.5),
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
   支撑点生成
   修复要点（均经实测复现）：
   - 栅格悬空点不再截断（slicer.js 去掉 40000 上限）
   - 覆盖锥只在同一悬空区域内生效（旧实现跨结构误判：不相连的上方悬空面被下方支撑点「覆盖」→ 0 支撑）；
     覆盖外扩率 = cot(临界角)（材料每升高 1mm 最多外扩 cot 倍，旧代码误用 tan，仅 45° 时巧合正确）
   - 孤岛种子的「已托住」阈值 0.25mm（孤岛与下方材料不相连，0.8mm 的桥接豁免对孤岛不成立）
   - 去掉覆盖兜底（旧实现按孤岛质心 2mm 判近，条状/环状孤岛必判失败，在已放种子位置原样重复放置）
   - 保护面：接触面本身或 1mm 内任一保护面即抑制（旧实现只看「最近一个面」，且不检查锚点）
   - 陡峭面：大三角形按面积细分采样（旧实现每面只取重心，低模大三角形斜面一面仅一个候选）
================================================================ */
async function collectContactPoints(ctx, islandsOnly) {
  const A = state.analysis;
  const { bvh, ld, faces, groundY, protNear } = ctx;
  const spacing = Math.max(0.5, params.spacing);
  const cellArea = A.grid.sx * A.grid.sz;
  const rep = { pool: 0, areaPruned: 0, seeds: 0, low: 0, flush: 0, held: 0, wall: 0, prot: 0, covered: 0, capped: 0, islands: 0, islandsNoPoint: 0 };

  // 1. 候选池：栅格悬空点 + 陡峭面（大三角形细分）
  const pool = [];
  if (!islandsOnly) {
    for (const o of A.overhang) pool.push({ x: o.x, y: o.y, z: o.z, area: cellArea });
    const maxA = spacing * spacing * 0.5, p = A.p;
    for (const sp of A.steepPts) {
      pool.push({ x: sp.x, y: sp.y, z: sp.z, area: sp.area, f: sp.f });
      if (sp.f === undefined || sp.area <= maxA) continue;
      const n = Math.min(64, Math.ceil(sp.area / maxA)), i = sp.f * 9;
      for (let k = 1; k <= n; k++) {
        let u = halton(k, 2), v = halton(k, 3);
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        pool.push({
          x: p[i] + u * (p[i + 3] - p[i]) + v * (p[i + 6] - p[i]),
          y: p[i + 1] + u * (p[i + 4] - p[i + 1]) + v * (p[i + 7] - p[i + 1]),
          z: p[i + 2] + u * (p[i + 5] - p[i + 2]) + v * (p[i + 8] - p[i + 2]),
          area: 0, f: sp.f,
        });
      }
    }
  }
  rep.pool = pool.length;

  // 2. 孤岛关键点：周界像素按 spacing 体素降采样（每体素取最低）+ 全岛最低点
  const seeds = [];
  if (A.graph && ld) {
    const floorY = A.grid.minY - A.raiseH, { W: GW, H: GH, layerH } = A.grid;
    const vkey = (x, y, z) => `${Math.floor(x / spacing)},${Math.floor(y / spacing)},${Math.floor(z / spacing)}`;
    for (const nd of A.graph.nodes) {
      if (!nd.island || !nd.pixels) continue;
      rep.islands++;
      const pix = new Set(nd.pixels);
      let lowest = null;
      const peri = new Map();
      for (const cc of nd.pixels) {
        const ci = cc % GW, cj = (cc / GW) | 0;
        const gr = ldiGapAt(ld, cc, nd.y, floorY);
        // 只取区间入口落在本层附近的像素：与下层重叠的少数像素，入口在下方别的结构上（旧实现会把「最低点」放到那里）
        if (!gr || gr.surfY < nd.y - layerH * 1.5) continue;
        const pt = { x: A.grid.x0 + (ci + 0.5) * A.grid.sx, y: gr.surfY, z: A.grid.z0 + (cj + 0.5) * A.grid.sz, island: nd.id };
        if (!lowest || pt.y < lowest.y) lowest = pt;
        const edge = ci + 1 >= GW || !pix.has(cc + 1) || ci - 1 < 0 || !pix.has(cc - 1) || cj + 1 >= GH || !pix.has(cc + GW) || cj - 1 < 0 || !pix.has(cc - GW);
        if (edge) { const k = vkey(pt.x, pt.y, pt.z); if (!peri.has(k) || pt.y < peri.get(k).y) peri.set(k, pt); }
      }
      if (lowest) peri.set('low', lowest);
      for (const pt of peri.values()) seeds.push(pt);
    }
  }
  rep.seeds = seeds.length;

  // 3. 区域聚类（2mm 格 26 邻域并查集，池点与种子一起聚类以共享区域号）+ 区域面积过滤（只滤池点）
  const cq = 2;
  const parent = new Map();
  const ck = (x, y, z) => `${Math.floor(x / cq)},${Math.floor(y / cq)},${Math.floor(z / cq)}`;
  const find = k => { let r = k; while (parent.get(r) !== r) r = parent.get(r); while (parent.get(k) !== r) { const n = parent.get(k); parent.set(k, r); k = n; } return r; };
  const all = pool.concat(seeds);
  for (const pt of all) {
    const i = Math.floor(pt.x / cq), j = Math.floor(pt.y / cq), k = Math.floor(pt.z / cq), key = `${i},${j},${k}`;
    pt._cell = key;
    if (parent.has(key)) continue;
    parent.set(key, key);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      if (!a && !b && !c) continue;
      const nk = `${i + a},${j + b},${k + c}`;
      if (parent.has(nk)) { const ra = find(key), rb = find(nk); if (ra !== rb) parent.set(ra, rb); }
    }
  }
  const regArea = new Map();
  for (const pt of all) { pt.reg = find(pt._cell); regArea.set(pt.reg, (regArea.get(pt.reg) || 0) + (pt.area || 0)); }
  const minA = Math.max(0.1, params.minSupArea || 2);
  const kept = pool.filter(pt => regArea.get(pt.reg) >= minA);
  rep.areaPruned = pool.length - kept.length;

  // 4. 逐点有效性：贴面 / 已托住 / 贴壁根部 / 保护面；同时取被托面法线
  // 贴壁根部：水平 WALL_R 圆周上某列有一段实体同时覆盖 [接触点下 1.0, 接触点下 0.1]——即紧邻一面从下方竖直上来的侧壁，
  // 该点是悬臂根部，悬臂 < 1mm 可自支撑（Formlabs 1mm 悬臂规则 / HeyGears meshAreaBoundaryOffset）。
  // 判据要求实体向下延伸 ≥1mm：倾角 <45° 的悬空斜面在 0.8mm 内高差 <0.8mm，不会被误判（只看单点会把普通斜面全判成贴壁）。
  // 孤岛种子不适用（孤岛与下方不相连）
  const WALL_R = 0.8;
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
  const validate = (c, isSeed) => {
    if (c.y < groundY + 0.25) { rep.low++; return null; }
    if (ld && ldiInside(ld, c.x, c.y - 0.15, c.z)) { rep.flush++; return null; }           // 尖端正下方已是实体
    const hit = raycast(bvh, c.x, c.y - 0.05, c.z, 0, -1, 0, 0.1, 1e9);
    const below = hit ? hit.t + 0.05 : c.y - groundY;
    if (below < (isSeed ? 0.25 : 0.8)) { rep.held++; return null; }                          // 已托住（孤岛只豁免极小间隙）
    if (!isSeed && ld && wallRoot(c)) { rep.wall++; return null; }
    let f = c.f;
    if (f === undefined) { const pr = raycast(bvh, c.x, c.y + 0.05, c.z, 0, -1, 0, 0.005, 0.35); f = pr ? pr.f : -1; }
    if (f >= 0 && state.protectedFaces.has(f)) { rep.prot++; return null; }
    if (protNear && protNear(c)) { rep.prot++; return null; }
    const n = f >= 0 ? [faces.nrm[f * 3], faces.nrm[f * 3 + 1], faces.nrm[f * 3 + 2]] : [0, -1, 0];
    return { x: c.x, y: c.y, z: c.z, n, island: c.island !== undefined ? c.island : null, reg: c.reg };
  };

  // 5. 布点：种子先放（周界允许密于 spacing，仅 0.3mm 去重）→ 池点按高度升序泊松盘 + 覆盖锥（同区域）
  const out = [];
  const existing = state.supportPoints;
  const r2 = spacing * spacing * 0.999, hCell = spacing / Math.sqrt(3);
  const hash = new Map();
  const hk = (x, y, z) => `${Math.floor(x / hCell)},${Math.floor(y / hCell)},${Math.floor(z / hCell)}`;
  const reg = pt => { const k = hk(pt.x, pt.y, pt.z); let a = hash.get(k); if (!a) hash.set(k, a = []); a.push(pt); };
  const near = (pt, rr2) => {
    const i = Math.floor(pt.x / hCell), j = Math.floor(pt.y / hCell), k = Math.floor(pt.z / hCell);
    for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) for (let c = -2; c <= 2; c++) {
      const arr = hash.get(`${i + a},${j + b},${k + c}`);
      if (arr) for (const q of arr) if ((q.x - pt.x) ** 2 + (q.y - pt.y) ** 2 + (q.z - pt.z) ** 2 < rr2) return true;
    }
    return false;
  };
  for (const q of existing) reg(q);
  const cot = 1 / Math.tan(Math.max(10, Math.min(80, params.selfAngle)) * Math.PI / 180);
  const cov = new Map();
  const covKey = (x, z) => `${Math.floor(x / 3)},${Math.floor(z / 3)}`;
  const covReg = pt => { const k = covKey(pt.x, pt.z); let a = cov.get(k); if (!a) cov.set(k, a = []); a.push(pt); };
  const covered = c => {
    const i = Math.floor(c.x / 3), k = Math.floor(c.z / 3);
    for (let a = -4; a <= 4; a++) for (let b = -4; b <= 4; b++) {
      const arr = cov.get(`${i + a},${k + b}`);
      if (!arr) continue;
      for (const p of arr) {
        if (p.reg !== c.reg || p.y > c.y + 0.05) continue;
        const dy = c.y - p.y;
        if (dy > 12) continue;
        const rc = dy * cot * 0.9;
        if ((p.x - c.x) ** 2 + (p.z - c.z) ** 2 <= rc * rc) return true;
      }
    }
    return false;
  };
  const islandHit = new Set();
  let i = 0;
  for (const s of seeds) {
    if (++i % 1500 === 0) await nextFrame();
    if (near(s, 0.09)) continue;                       // 种子间 0.3mm 去重（含与既有支撑点）
    if (islandsOnly && near(s, spacing * spacing * 0.25)) { islandHit.add(s.island); continue; }   // 增量：该处已有支撑点
    const v = validate(s, true);
    if (!v) continue;
    if (out.length + existing.length >= MAX_POINTS) { rep.capped++; continue; }
    out.push(v); reg(v); covReg(v); islandHit.add(s.island);
  }
  const sorted = kept.sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
  i = 0;
  for (const c of sorted) {
    if (++i % 4000 === 0) { setProgress(0.3 + 0.35 * i / sorted.length, '布点（泊松盘 / 覆盖锥）…'); await nextFrame(); }
    if (near(c, r2)) continue;
    if (covered(c)) { rep.covered++; continue; }
    const v = validate(c, false);
    if (!v) continue;
    if (out.length + existing.length >= MAX_POINTS) { rep.capped++; break; }
    out.push(v); reg(v); covReg(v);
  }
  rep.islandsNoPoint = Math.max(0, rep.islands - islandHit.size);
  return { points: out, rep };
}

/* ================================================================
   结构重建：按当前模式从支撑点集生成树状 / 格架几何
================================================================ */
const STATE_TEXT = { ground: '落地', mesh: '锚定模型', micro: '微型短柱', nohead: '头部无法放置', unroutable: '无法路由' };

export async function rebuildStructure() {
  if (!state.analysis || !state.mesh) return null;
  setProgress(0.8, '生成支撑结构（避让 / 合并）…'); await nextFrame();
  const t0 = performance.now();
  const ctx = makeCtx();
  clearMeshes();
  const P = paramSnapshot();
  const mode = params.supMode === 'tower' ? 'tower' : 'tree';
  const pts = state.supportPoints;
  const res = mode === 'tower' ? buildEStageTowers(ctx, pts, P) : buildBranchingTree(ctx, pts, P);
  const add = (g, mat, kind) => {
    if (!g) return;
    const m = new THREE.Mesh(g, mat);
    m.userData.kind = kind;
    supportGroup.add(m);
    state.supports.push({ mesh: m, kind });
  };
  add(res.geomGround, supMat, 'ground');
  add(res.geomAnchor, supMatAnchor, 'anchor');
  add(res.geomBase, supMatBase, 'base');
  pts.forEach((p, k) => { p.state = res.pointState[k] || ''; });
  const ok = pts.filter(p => p.state === 'ground' || p.state === 'mesh' || p.state === 'micro').length;
  state.supportStats = { mode, ...res.stats, ok, ms: Math.round(performance.now() - t0) };
  setProgress(null);
  updateSupStats();
  drawLayer();
  return res;
}

export async function runGenSup(opts = {}) {
  const islandsOnly = !!opts.islandsOnly;
  if (!state.analysis) return toast('请先运行逐层分析');
  if (!islandsOnly) clearSupports(false);
  if (!state.supportPoints) state.supportPoints = [];
  setProgress(0.2, '提取支撑点…'); await nextFrame();
  const ctx = makeCtx();
  const { points, rep } = await collectContactPoints(ctx, islandsOnly);
  state.supportPoints.push(...points);
  if (!state.supportPoints.length) {
    setProgress(null); updateSupStats();
    log(islandsOnly ? '自动孤岛支撑：没有需要补打的孤岛' : '没有检测到需要支撑的悬空区域', 'warn');
    return;
  }
  const res = await rebuildStructure();
  const s = res.stats, mode = params.supMode === 'tower' ? '支撑塔' : '树状';
  const head = islandsOnly ? `自动孤岛支撑：新增 ${points.length} 个支撑点` : `支撑点 ${state.supportPoints.length} 个`;
  log(`${head}（候选 ${rep.pool}，区域面积滤除 ${rep.areaPruned}，孤岛种子 ${rep.seeds}，覆盖锥滤除 ${rep.covered}，已托住 ${rep.held}，贴壁根部 ${rep.wall}，贴面 ${rep.flush}，保护面 ${rep.prot}）`, 'ok');
  if (params.supMode === 'tower') {
    const al = (s.needlesV || 0) + (s.needlesP || 0);
    if (s.needles) log(`十字针：格架同向 ${al} 根（竖直 ${s.needlesV || 0} · 墙面内斜向 ${s.needlesP || 0}，接触点平均偏移 ${al ? (s.shiftSum / al).toFixed(2) : 0}mm、最大 ${(s.shiftMax || 0).toFixed(2)}mm）· 自由直针 ${s.needlesFree || 0} 根`, 'ok');
    log(`e-Stage 支撑塔：十字针 ${s.needles} 根接入格架，塔块 ${s.towers} 座（格架节点 ${s.nodes}，杆件 ${s.bars}，基础带 ${s.foundRuns} 段）；连不上格架转树状兜底 ${s.fallback} 点（落地 ${s.ground} · 锚定 ${s.anchors} · 微型短柱 ${s.micro}），${state.supportStats.ms}ms`, 'ok');
    if (s.capped) log('⚠ 格架节点 / 杆件数达到上限，已截断（可增大菱形宽）', 'warn');
  } else {
    log(`树状支撑：支撑头 ${s.heads}，合并 ${s.merges}，桥接 ${s.bridges}，避让下行 ${s.avoid}，落地柱 ${s.ground}，锚定模型 ${s.anchors}${s.heavy ? `（其中超重锚定 ${s.heavy}：负载超过模型最大负载但无路落地）` : ''}，微型短柱 ${s.micro}，${state.supportStats.ms}ms`, 'ok');
  }
  const bad = (s.noHead || 0) + (s.unroutable || 0);
  if (bad) log(`⚠ ${mode}结构：${s.noHead || 0} 个点头部无法放置（锥内全部方向碰撞），${s.unroutable || 0} 个点无法落地/锚定——已剔除，不生成悬空几何`, 'warn');
  if (rep.islandsNoPoint) log(`⚠ ${rep.islandsNoPoint} 处孤岛没有可放置的支撑点（贴面/保护面/间隙过小），请检查层检查器`, 'warn');
  // 孤岛结构覆盖：有支撑点的孤岛，至少一个点须生成结构，否则该孤岛实际悬空
  const isl = new Map();
  for (const p of state.supportPoints) {
    if (p.island === null || p.island === undefined) continue;
    isl.set(p.island, isl.get(p.island) || ['ground', 'mesh', 'micro'].includes(p.state));
  }
  const islFail = [...isl.values()].filter(v => !v).length;
  if (islFail) log(`⚠ ${islFail} 处孤岛的支撑点全部未能生成结构（该孤岛将悬空），请查看层检查器红点或改用另一种结构`, 'warn');
  if (rep.capped) log(`⚠ 支撑点达到上限 ${MAX_POINTS}，其余 ${rep.capped} 个候选未放置（可增大支撑间距）`, 'warn');
}

/* 手动加支撑点：点击模型表面 → 加点 → 重建结构 */
export async function addSupportPoint(p, n) {
  if (!state.analysis) { toast('请先运行逐层分析'); return; }
  if (!state.supportPoints) state.supportPoints = [];
  const pt = { x: p.x, y: p.y, z: p.z, n: n || [0, -1, 0], manual: true, island: null };
  state.supportPoints.push(pt);
  await rebuildStructure();
  log(`手动支撑点 @ (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) → ${STATE_TEXT[pt.state] || '未生成'}`, pt.state === 'ground' || pt.state === 'mesh' || pt.state === 'micro' ? 'ok' : 'warn');
}

/* 点删：删除离命中点最近的支撑点（5mm 内）→ 重建结构 */
export async function deleteSupportNear(p) {
  const pts = state.supportPoints || [];
  let best = -1, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - p.x, pts[i].y - p.y, pts[i].z - p.z);
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0 || bd > 5) { toast('请点击靠近支撑头部的位置'); return false; }
  pts.splice(best, 1);
  await rebuildStructure();
  return true;
}
