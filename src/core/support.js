/* ================================================================
   支撑生成总控
   数据流：支撑点（可编辑数据 state.supportPoints）→ 结构生成（rebuildStructure）
   - 支撑点：LDI 栅格悬空点 + 陡峭面（大三角形细分采样）+ 孤岛关键点，经区域面积过滤 /
     六角均匀布点（目标为设定间距，最近可收到约 0.68×，空洞补到覆盖半径 0.85× 以内；
     覆盖锥仅同一悬空区域，水平半径封顶 1.25×）/ 贴面·已托住·保护面过滤；每点带被托面外法线 n
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
import { crossGroundPosts } from './supportOptimize.js';
import { mergeParts } from './supportKit.js';

const PROT_R = 1.0;          // 保护面抑制半径：接触点（及模型锚点）1mm 内有任一保护面即不放
const MAX_POINTS = 3000;     // 支撑点上限（树状/格架会合并分支，点数可比旧的独立 pin 多）

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

const SEL_COLOR = 0xff3df2;   // 框选 / 点选中的支撑点：洋红，和落地绿、锚定琥珀、失败红都分开

function pointColor(p, selected) {
  if (selected) return SEL_COLOR;
  if (p.state === 'ground') return 0x3ee0a2;
  if (p.state === 'mesh' || p.state === 'micro') return 0xffb020;
  if (p.state === 'nohead' || p.state === 'unroutable') return 0xff4d4d;
  return 0x8ec8ff;
}

export function supportSelection() {
  return state.supportSel instanceof Set ? state.supportSel : (state.supportSel = new Set());
}

/* 只有「只显示支撑点」打开时才放小球。删支撑本身不额外把点画出来。 */
export function syncPointMarkers() {
  clearPointMarkers();
  const only = !!state.viewPointsOnly;
  for (const s of state.supports) s.mesh.visible = !only;
  if (!only) return;
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

const BODY_GROUND = [0x38 / 255, 0xd9 / 255, 0x96 / 255];
const BODY_ANCHOR = [0xff / 255, 0xb0 / 255, 0x20 / 255];
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

/** 生成支撑后就把三角形归到各自的支撑点上，并写好底色。第一次点选不再整网重算。 */
export function prepareSupportColors() {
  const pts = state.supportPoints || [];
  if (!pts.length) { pointGrid = null; return; }
  pointGrid = buildPointGrid(pts);
  for (const s of state.supports) {
    if (s.kind !== 'ground' && s.kind !== 'anchor') continue;
    const mesh = s.mesh;
    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    if (!pos) continue;
    const index = geom.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    if (geom.userData.triOf && geom.userData.ownerPts === pts.length && geom.attributes.color) continue;
    if (mesh.material === supMat || mesh.material === supMatAnchor || mesh.material === supMatBase) {
      mesh.material = mesh.material.clone();
    }
    mesh.material.vertexColors = true;
    mesh.material.color.setHex(0xffffff);
    const base = s.kind === 'anchor' ? BODY_ANCHOR : BODY_GROUND;
    const col = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
    const arr = col.array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i] = base[0]; arr[i + 1] = base[1]; arr[i + 2] = base[2];
    }
    geom.setAttribute('color', col);
    const triOf = Array.from({ length: pts.length }, () => []);
    const pa = pos.array;
    const ia = index ? index.array : null;
    for (let t = 0; t < triCount; t++) {
      let a, b, c;
      if (ia) { const o = t * 3; a = ia[o]; b = ia[o + 1]; c = ia[o + 2]; }
      else { a = t * 3; b = a + 1; c = a + 2; }
      const a3 = a * 3, b3 = b * 3, c3 = c * 3;
      const x = (pa[a3] + pa[b3] + pa[c3]) / 3;
      const y = (pa[a3 + 1] + pa[b3 + 1] + pa[c3 + 1]) / 3;
      const z = (pa[a3 + 2] + pa[b3 + 2] + pa[c3 + 2]) / 3;
      const id = supportOwnerFast(x, y, z, pointGrid);
      triOf[id].push(t);
    }
    geom.userData.triOf = triOf;
    geom.userData.ownerPts = pts.length;
    geom.userData.painted = [];
    col.needsUpdate = true;
  }
}

/** 只改刚选中或刚取消的那几根支撑的颜色。 */
function paintSupportBodies() {
  const sel = supportSelection();
  const baseOf = (kind) => (kind === 'anchor' ? BODY_ANCHOR : BODY_GROUND);
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
  else if (state.viewPointsOnly) syncPointMarkers();
  paintSupportBodies();
}

export function setPointsOnly(on) {
  state.viewPointsOnly = !!on;
  syncPointMarkers();
  bus.emit('pointsOnly', state.viewPointsOnly);
  log(state.viewPointsOnly ? '已隐藏支撑结构，只显示附着在模型上的支撑点' : '已恢复支撑结构显示');
}
export function clearSupports(refresh = true) {
  clearMeshes();
  state.supportPoints = [];
  if (state.supportSel) state.supportSel.clear();
  state.supportStats = null;
  state.groundPosts = null;
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
    shortKind: p.shortKind === 'tower' ? 'tower' : 'tree',
    tipMode: p.tipMode || 'normal', tipTilt: num(p.tipTilt, 45),   // 接触朝向 / 接触最大倾角（两套结构共用）
    // 树状（PrusaSlicer branching 默认值）
    tipD: num(p.tipD, 0.4), pen: num(p.pen, 0.2), headLen: num(p.headLen, 1.0), midD: num(p.midD, 0.65),
    anchorD: num(p.anchorD, 0.65),
    maxBranchD: num(p.maxBranchD, 2.0), widening: num(p.widening, 0.5), baseD: num(p.baseD, 3), baseH: num(p.baseH, 1),
    maxBridgeLen: num(p.maxBridgeLen, 5), maxBranchLen: num(p.maxBranchLen, 10), maxWeightOnModel: num(p.maxWeightOnModel, 10),
    // 支撑塔（e-Stage 菱形格架）
    esCell: num(p.esCell, 3.5), esDiamAngle: num(p.esDiamAngle, 45), esMidBars: p.esMidBars !== false,
    esBarW: num(p.esBarW, 0.45), esBarT: num(p.esBarT, 0.35), esGap: num(p.esGap, 1.2),
    esColRatio: num(p.esColRatio, 7), esTowerMaxR: num(p.esTowerMaxR, 4), esHullRed: num(p.esHullRed, 1),
    esConnW: num(p.esConnW, 0.45), esNeedleT: num(p.esNeedleT, 0.35), esTipW: num(p.esTipW, 0.3), esContactMargin: num(p.esContactMargin, 0.5), esTaper: num(p.esTaper, 1), esNeedleMax: num(p.esNeedleMax, 6),
    esFoundH: num(p.esFoundH, 1), esNotchH: num(p.esNotchH, 0.5), baseJoin: !!p.baseJoin, baseChamfer: !!p.baseChamfer, baseFlush: !!p.baseFlush, baseHole: !!p.baseHole,
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
   - 布点是水平六角网格，目标间距就是设定值。比设定更密可以（最近不低于约 0.68×，用来补圆边和对不齐的缝），
     表面上没被覆盖锥盖住的位置，离最近支撑超过 0.85× 就再补一点，避免空洞把间距拉到设定值的两倍以上。
     孤岛周界并进同一张网格，不再单独用 0.3mm 去重（那会让外圈挤成一团，内侧再空一环）
   - 覆盖锥水平半径封顶为设定间距的 1.25 倍：低处一圈仍能按自支撑角吃掉正上方的点，但吃不穿整片底面
   - 保护面：接触面本身或 1mm 内任一保护面即抑制（旧实现只看「最近一个面」，且不检查锚点）
   - 陡峭面：大三角形按面积细分采样（旧实现每面只取重心，低模大三角形斜面一面仅一个候选）
================================================================ */
async function collectContactPoints(ctx, islandsOnly) {
  const A = state.analysis;
  const { bvh, ld, faces, groundY, protNear } = ctx;
  const spacing = Math.max(0.5, params.spacing);
  const cellArea = A.grid.sx * A.grid.sz;
  const rep = { pool: 0, areaPruned: 0, seeds: 0, low: 0, flush: 0, held: 0, wall: 0, prot: 0, covered: 0, filled: 0, capped: 0, islands: 0, islandsNoPoint: 0 };

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

  // 5. 均匀布点。设定间距是六角网格的目标，不是扫描线泊松的最小半径：
  //    · 最近距离下限 PACK（0.68×）：圆边对不齐时可以更密，但不再出现 0.3mm 挤团
  //    · 覆盖半径 HOLE（0.85×）：没被覆盖锥盖住的表面，离最近支撑超过这一圈就补点。
  //      六角格心到顶点约 0.58×，低于 HOLE，平整底面不会被补成双倍密度；
  //      补点之后支撑彼此大约落在 0.68×～1.7× 设定间距之间
  //    · 覆盖锥水平半径封顶 CONE_CAP（1.25×），只吃掉正上方，不把低处一圈的内侧掏空
  const PACK = spacing * 0.68;
  const HOLE = spacing * 0.85;
  const CONE_CAP = spacing * 1.25;
  // 独立取整后的格子角离格心约 0.67×（比正六角的 0.58×略大），跳过整格时按这个半径算
  const CELL_R = spacing * 0.72;
  const rowH = spacing * Math.sqrt(3) / 2;
  const out = [];
  const existing = state.supportPoints;
  const hCell = spacing / Math.sqrt(3);
  const hReach = Math.max(2, Math.ceil(Math.max(PACK, HOLE) / hCell));
  const hash = new Map();
  const hk = (x, y, z) => `${Math.floor(x / hCell)},${Math.floor(y / hCell)},${Math.floor(z / hCell)}`;
  const regPt = pt => { const k = hk(pt.x, pt.y, pt.z); let a = hash.get(k); if (!a) hash.set(k, a = []); a.push(pt); };
  const closestD = pt => {
    const i = Math.floor(pt.x / hCell), j = Math.floor(pt.y / hCell), k = Math.floor(pt.z / hCell);
    let best = Infinity;
    for (let a = -hReach; a <= hReach; a++) for (let b = -hReach; b <= hReach; b++) for (let c = -hReach; c <= hReach; c++) {
      const arr = hash.get(`${i + a},${j + b},${k + c}`);
      if (!arr) continue;
      for (const q of arr) {
        const d = Math.hypot(q.x - pt.x, q.y - pt.y, q.z - pt.z);
        if (d < best) best = d;
      }
    }
    return best;
  };
  for (const q of existing) regPt(q);
  const cot = 1 / Math.tan(Math.max(10, Math.min(80, params.selfAngle)) * Math.PI / 180);
  const cov = new Map();
  const covCell = 3;
  const covReach = Math.max(2, Math.ceil(CONE_CAP / covCell));
  const covKey = (x, z) => `${Math.floor(x / covCell)},${Math.floor(z / covCell)}`;
  const covReg = pt => { const k = covKey(pt.x, pt.z); let a = cov.get(k); if (!a) cov.set(k, a = []); a.push(pt); };
  const coneCovered = c => {
    const i = Math.floor(c.x / covCell), k = Math.floor(c.z / covCell);
    for (let a = -covReach; a <= covReach; a++) for (let b = -covReach; b <= covReach; b++) {
      const arr = cov.get(`${i + a},${k + b}`);
      if (!arr) continue;
      for (const p of arr) {
        if (p.reg !== c.reg || p.y > c.y + 0.05) continue;
        const dy = c.y - p.y;
        if (dy > 12) continue;
        const rc = Math.min(dy * cot * 0.9, CONE_CAP);
        if ((p.x - c.x) ** 2 + (p.z - c.z) ** 2 <= rc * rc) return true;
      }
    }
    return false;
  };
  for (const q of existing) if (q.reg !== undefined && q.reg !== null) covReg(q);

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
      for (const s of arr) {
        const d = (s.x - v.x) ** 2 + (s.y - v.y) ** 2 + (s.z - v.z) ** 2;
        if (d <= bd) { bd = d; best = s; }
      }
    }
    if (best) { v.island = best.island; islandHit.add(best.island); }
  };
  const accept = (v, filled) => {
    if (out.length + existing.length >= MAX_POINTS) { rep.capped++; return false; }
    tagIsland(v);
    out.push(v); regPt(v); covReg(v);
    if (filled) rep.filled++;
    return true;
  };
  const oddRow = row => Math.abs(row % 2) === 1;
  const hexOf = (x, y, z) => {
    const row = Math.round(z / rowH);
    const col = Math.round((x - (oddRow(row) ? spacing * 0.5 : 0)) / spacing);
    const layer = Math.round(y / spacing);
    return { col, row, layer, key: `${col},${row},${layer}` };
  };
  const hexCenter = (col, row, layer) => ({
    x: col * spacing + (oddRow(row) ? spacing * 0.5 : 0),
    y: layer * spacing,
    z: row * rowH,
  });
  // 格内排序：离格心水平距离，同距取更低的（先托住先打印的那一面）
  const xz2 = (p, o) => (p.x - o.x) ** 2 + (p.z - o.z) ** 2;
  const closestN = (pts, center, n) => {
    const best = [];
    for (const p of pts) {
      const d = xz2(p, center);
      let k = best.length;
      while (k > 0) {
        const q = best[k - 1];
        if (d > q.d + 1e-8 || (Math.abs(d - q.d) <= 1e-8 && p.y >= q.p.y)) break;
        k--;
      }
      if (k === best.length && best.length === n) continue;
      best.splice(k, 0, { p, d });
      if (best.length > n) best.pop();
    }
    return best.map(e => e.p);
  };

  const cells = new Map();
  for (const c of kept.concat(seeds)) {
    const h = hexOf(c.x, c.y, c.z);
    let cell = cells.get(h.key);
    if (!cell) cells.set(h.key, cell = { ...h, pts: [], y0: Infinity });
    cell.pts.push(c);
    if (c.y < cell.y0) cell.y0 = c.y;
  }
  const reps = [...cells.values()].sort((a, b) => a.y0 - b.y0 || a.col - b.col || a.row - b.row);
  const total = reps.length || 1;
  let step = 0;
  for (const cell of reps) {
    if (++step % 400 === 0) { setProgress(0.3 + 0.22 * step / total, '布点（均匀网格）…'); await nextFrame(); }
    if (out.length + existing.length >= MAX_POINTS) { rep.capped++; break; }
    const center = hexCenter(cell.col, cell.row, cell.layer);
    cell.center = center;
    const tries = closestN(cell.pts, center, 8);
    let placed = false, sawCone = false;
    for (const c of tries) {
      if (closestD(c) < PACK) continue;
      if (coneCovered(c)) { sawCone = true; continue; }
      const v = validate(c, c.island !== undefined);
      if (!v) continue;
      if (!accept(v, false)) break;
      placed = true;
      break;
    }
    if (!placed && sawCone) rep.covered++;
  }

  // 补洞：格心附近已经有点的整格跳过；其余格里，离现有支撑 ≥ HOLE 且没被锥盖住的表面补一点
  if (out.length + existing.length < MAX_POINTS) {
    step = 0;
    for (const cell of reps) {
      if (++step % 400 === 0) { setProgress(0.54 + 0.2 * step / total, '补均匀间距…'); await nextFrame(); }
      if (out.length + existing.length >= MAX_POINTS) { rep.capped++; break; }
      // 探针放在这一格最低的候选高度上：格心的层高是取整后的，和真实表面会差半格
      if (closestD({ x: cell.center.x, y: cell.y0, z: cell.center.z }) + CELL_R < HOLE) continue;
      const failed = new Set();
      for (let n = 0; n < 4; n++) {
        let pick = null, pickD = 0;
        for (const c of cell.pts) {
          if (failed.has(c)) continue;
          if (coneCovered(c)) continue;
          const d = closestD(c);
          if (d < HOLE) continue;
          if (d > pickD) { pick = c; pickD = d; }
        }
        if (!pick) break;
        const v = validate(pick, pick.island !== undefined);
        if (!v) { failed.add(pick); continue; }
        if (!accept(v, true)) break;
      }
    }
  }
  for (const s of seeds) {
    if (!islandHit.has(s.island) && closestD(s) <= HOLE + 1e-6) islandHit.add(s.island);
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
  if (state.supportSel) state.supportSel.clear();
  setProgress(0.8, '生成支撑结构（避让 / 合并）…'); await nextFrame();
  const t0 = performance.now();
  const ctx = makeCtx();
  clearMeshes();
  const P = paramSnapshot();
  const mode = params.supMode === 'tower' ? 'tower' : 'tree';
  const pts = state.supportPoints;
  const res = mode === 'tower' ? buildEStageTowers(ctx, pts, P) : buildBranchingTree(ctx, pts, P);
  state.groundPosts = res.posts || null;
  if (params.supOptimize !== false && res.posts && res.posts.length) {
    const opt = crossGroundPosts(ctx, res.posts, P);
    if (opt.geom) res.geomGround = mergeParts([res.geomGround, opt.geom].filter(Boolean));
    res.stats.optRibs = opt.ribs;
    res.stats.optGussets = opt.gussets;
    res.stats.optIsolated = opt.isolated;
    res.stats.optSkipped = opt.skipped;
  }
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
  syncPointMarkers();
  prepareSupportColors();
  setProgress(null);
  updateSupStats();
  drawLayer();
  if (res.stats.optIsolated) {
    log(`支撑优化：单个底座 ${res.stats.optIsolated} 处，交叉两岸 ${res.stats.optRibs || 0} 组（${res.stats.optGussets || 0} 根斜杆）${res.stats.optSkipped ? `，${res.stats.optSkipped} 处过远或会穿模已跳过` : ''}`, 'ok');
  }
  return res;
}

/** 对已经生成的落地支撑再跑一遍交叉两岸（不重新布点）。已经加过就不再叠一层。 */
export function optimizeSupports() {
  if (!state.analysis || !state.mesh) { toast('请先生成支撑'); return null; }
  const ground = state.supports.find(s => s.kind === 'ground');
  if (!ground) { toast('没有落到底板的支撑'); return null; }
  if (!state.groundPosts || !state.groundPosts.length) { toast('没有可加交叉撑的竖直落地柱'); return null; }
  if ((state.supportStats || {}).optRibs) { log('交叉撑已经加过，没有再叠一层', 'ok'); return state.supportStats; }
  const ctx = makeCtx();
  const P = paramSnapshot();
  const opt = crossGroundPosts(ctx, state.groundPosts, P);
  if (opt.geom) {
    // mergeParts 会释放传入的几何，返回的新几何直接换上
    ground.mesh.geometry = mergeParts([ground.mesh.geometry, opt.geom]);
  }
  const prev = state.supportStats || {};
  state.supportStats = { ...prev, optRibs: (prev.optRibs || 0) + opt.ribs, optGussets: (prev.optGussets || 0) + opt.gussets, optIsolated: opt.isolated, optSkipped: opt.skipped };
  updateSupStats();
  if (!opt.ribs) log(opt.isolated ? '这些单个底座没能连上（距离超过 70mm，或交叉撑会穿进模型）' : '底板已经连在一起，没有需要再加的交叉撑', 'ok');
  else log(`支撑优化：单个底座 ${opt.isolated} 处，新增交叉两岸 ${opt.ribs} 组（${opt.gussets} 根斜杆）${opt.skipped ? `，跳过 ${opt.skipped}` : ''}`, 'ok');
  prepareSupportColors();
  return opt;
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
  log(`${head}（候选 ${rep.pool}，区域面积滤除 ${rep.areaPruned}，孤岛种子 ${rep.seeds}，覆盖锥滤除 ${rep.covered}，间距补点 ${rep.filled}，已托住 ${rep.held}，贴壁根部 ${rep.wall}，贴面 ${rep.flush}，保护面 ${rep.prot}）`, 'ok');
  if (params.supMode === 'tower') {
    const al = (s.needlesV || 0) + (s.needlesP || 0);
    if (s.needles) log(`十字针：格架同向 ${al} 根（竖直 ${s.needlesV || 0} · 墙面内斜向 ${s.needlesP || 0}，接触点平均偏移 ${al ? (s.shiftSum / al).toFixed(2) : 0}mm、最大 ${(s.shiftMax || 0).toFixed(2)}mm）· 自由直针 ${s.needlesFree || 0} 根`, 'ok');
    const fb = params.shortKind === 'tower' && params.shortSup
      ? `连不上格架的 ${s.fallback || 0} 点里，贴面短连接 ${s.plates || 0}，绕到平台 ${s.ground || 0}`
      : `连不上格架转树状兜底 ${s.fallback} 点（落地 ${s.ground} · 锚定 ${s.anchors} · 微型短柱 ${s.micro}）`;
    log(`e-Stage 支撑塔：十字针 ${s.needles} 根接入格架，塔块 ${s.towers} 座（格架节点 ${s.nodes}，杆件 ${s.bars}，基础带 ${s.foundRuns} 段）；${fb}，${state.supportStats.ms}ms`, 'ok');
    if (s.capped) log('⚠ 格架节点 / 杆件数达到上限，已截断（可增大菱形宽）', 'warn');
  } else {
    log(`树状支撑：支撑头 ${s.heads}，合并 ${s.merges}，桥接 ${s.bridges}，避让下行 ${s.avoid}，落地柱 ${s.ground}，锚定模型 ${s.anchors}${s.shortAnchors ? `（其中短锚 ${s.shortAnchors}：间隙放不下锚头，竖直细颈短柱）` : ''}${s.heavy ? `，超重锚定 ${s.heavy}：负载超过模型最大负载但无路落地` : ''}，微型短柱 ${s.micro}${s.plates ? `，桥板 ${s.plates}` : ''}，${state.supportStats.ms}ms`, 'ok');
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

/** 删掉这些支撑点（索引），只重建一次结构。 */
export async function deleteSupportIndices(indices) {
  const pts = state.supportPoints || [];
  const drop = [...new Set(indices)].filter(i => i >= 0 && i < pts.length).sort((a, b) => b - a);
  if (!drop.length) { toast('没有选中的支撑点'); return false; }
  for (const i of drop) pts.splice(i, 1);
  if (state.supportSel) state.supportSel.clear();
  if (state.analysis && state.mesh) await rebuildStructure();
  else { syncPointMarkers(); updateSupStats(); }
  log(`已删除 ${drop.length} 个支撑点`, 'ok');
  return true;
}
