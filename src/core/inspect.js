/* ================================================================
   详细切片分析 + 层检查器：runSliceAnalysis（旧 btnSlice.onclick）/ sliceAt / drawLayer。
   与旧 main.js 的差异：sliceStats/inspector 显隐/层标签改发 bus 事件；
   layerCanvas 由 React 提供元素引用（setLayerCanvas 注册），canvas 绘制保留在本模块。
================================================================ */
import * as THREE from 'three';
import { state, params, bus, log, toast, setProgress, nextFrame } from '../store.js';
import { analyze, steepFaces, sampleLDILayer, rasterizeSection } from './slicer.js';
import { raiseH, ensureBakedDisplay, supportScopeIds, supportScopeNote, localFaceOf, partAtWorld } from './model.js';
import { autoPlateThickness } from './joinPlate.js';
import { supMat, supMatAnchor } from './scene.js';
import { buildBVH, raycast } from './collide.js';

let layerCanvas = null;   // React 层检查器的 canvas（256×256）
let curLayer = 1;         // 当前滑块层（1-based；旧代码读 $('layerSlider').value）
export function setLayerCanvas(cv) { layerCanvas = cv; }
export function getCurLayer() { return curLayer; }

export function showInspector(layers, firstIsland) {
  curLayer = firstIsland;
  bus.emit('inspector', { show: true, layers, firstIsland });
}
export function hideInspector() { bus.emit('inspector', { show: false }); }

function ensureAnalysisBvh(A) {
  if (!A._bvh) A._bvh = buildBVH(A.p);
  return A._bvh;
}

/* 孤岛落在哪个零件上。射线从岛心向下，命中面优先，对不上再按底面外接框。 */
function ownerAt(A, x, y, z) {
  const hit = raycast(ensureAnalysisBvh(A), x, y + 0.8, z, 0, -1, 0, 0, 4);
  if (hit && hit.f >= 0) {
    const loc = localFaceOf(hit.f);
    if (loc) return loc.part.id;
  }
  const part = partAtWorld(x, z);
  return part ? part.id : null;
}

function tagIslandOwners(A) {
  if (!A || !A.graph || (state.parts || []).length <= 1) return;
  for (const nd of A.graph.nodes) {
    if (!nd.island || nd.owner !== undefined) continue;
    let x = nd.cx, z = nd.cz;
    if (nd.pixels && nd.pixels.length) {
      const cc = nd.pixels[0];
      const ci = cc % A.grid.W, cj = (cc / A.grid.W) | 0;
      x = A.grid.x0 + (ci + 0.5) * A.grid.sx;
      z = A.grid.z0 + (cj + 0.5) * A.grid.sz;
    }
    nd.owner = ownerAt(A, x, nd.y, z);
  }
}

/* 当前选中范围内的孤岛。只有一个模型时就是全部。 */
function islandsInScope(A) {
  const scope = supportScopeIds();
  const all = (A && A.islands) || [];
  if (!scope) return all;
  tagIslandOwners(A);
  return all.filter(isl => {
    const nd = A.graph && A.graph.nodes[isl.node];
    return !!(nd && scope.has(nd.owner));
  });
}

/* 把分析结果按当前选中范围发出去。换选中时只改孤岛和陡峭面积，不重跑切片。
   scopeOnly 告诉热力图：高差没变，只重画哪些面着色。 */
function emitSliceStats(scopeOnly) {
  const r = state.analysis;
  if (!r) { bus.emit('sliceStats', null); return []; }
  const scope = supportScopeIds();
  const islands = islandsInScope(r);
  const m = r.metrics;
  const rh = r.raiseH;
  let steepArea = r.steepArea || 0;
  let protHit = r.protSteep || 0;
  if (scope && r.steepPts) {
    steepArea = 0;
    protHit = 0;
    for (const pt of r.steepPts) {
      const loc = localFaceOf(pt.f);
      if (!loc || !scope.has(loc.part.id)) continue;
      steepArea += pt.area || 0;
      if (state.protectedFaces.has(pt.f)) protHit += pt.area || 0;
    }
  }
  const totIslandArea = islands.reduce((s, i) => s + i.area, 0);
  bus.emit('sliceStats', {
    layers: m.layers,
    raiseText: `${rh}mm / ${params.autoPlateOn ? `底板顶 ${+autoPlateThickness(params).toFixed(2)}mm` : params.baseJoin ? `连接底板 ${+(state.joinLift || 0).toFixed(2)}mm` : '关'}`,
    islandCount: islands.length,
    totIslandArea,
    steepArea,
    protHit,
    supportVol: m.supportVol,
    maxFill: m.maxFill,
    scopeOnly: !!scopeOnly,
  });
  return islands;
}

/** 换回已打开的工程时，把留下的分析结果重新发给界面。 */
export function publishSliceStats() {
  return emitSliceStats(false);
}

let sliceSeq = 0;
/** 换工程时作废还没写回的逐层分析，免得结果落到下一盘上。 */
export function invalidateSlice() { sliceSeq++; }

export async function runSliceAnalysis(opts = {}) {
  if (!state.mesh) return toast('请先载入模型');
  const seq = ++sliceSeq;
  // all：复制 / 删除之后整板重算，不因为当前没选中就停住
  const scope = opts.all ? null : supportScopeIds();
  if (scope && scope.size === 0) return toast('先选中模型，再运行分析');
  const layerH = params.layerH;
  const gapThresh = params.gapThresh;
  const selfAngle = params.selfAngle;
  setProgress(0.05, '逐层切片中…');
  await nextFrame();
  ensureBakedDisplay();
  const pos = state.mesh.geometry.attributes.position.array;
  const t0 = performance.now();
  const idQ = new THREE.Quaternion();
  const rh = raiseH();
  const r = await analyze(pos, idQ, {
    gridRes: 288, layerH, gapThresh, detail: true, raiseH: rh,
    minIslArea: params.minIslArea, minAttachArea: params.minAttach
  });
  if (seq !== sliceSeq) { setProgress(null); return; }
  setProgress(0.85, '陡峭悬空面分析…');
  await nextFrame();
  if (seq !== sliceSeq) { setProgress(null); return; }
  const sf = steepFaces(state.faces, idQ, selfAngle, state.protectedFaces, 1, true);
  if (rh > 0) for (const pt of sf.pts) pt.y += rh;   // 面重心为局部坐标，抬到世界系
  r.steepPts = sf.pts;
  r.protSteep = sf.protHit;
  r.steepArea = sf.steepArea;
  state.analysis = r;
  setProgress(null);
  const m = r.metrics;
  const islands = emitSliceStats(false);
  log(`逐层分析完成${supportScopeNote('只分析')}：${m.layers} 层 · 孤岛 ${islands.length} 处 · ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'ok');
  // 日志框逐层输出孤岛数量（只列选中模型上的孤岛）
  if (islands.length) {
    const byLayer = new Map();
    for (const isl of islands) {
      const e = byLayer.get(isl.layer) || { n: 0, area: 0, y: isl.y };
      e.n++; e.area += isl.area;
      byLayer.set(isl.layer, e);
    }
    for (const [layer, e] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
      log(`孤岛 @ 层 ${layer + 1}/${m.layers} · y=${e.y.toFixed(2)}mm · ${e.n} 处 · 面积 ${e.area.toFixed(1)}mm²`, 'warn');
    }
  }
  // 分析格与机器像素关系提示：格子粗于 2 个机器像素时，薄壁/细柱悬空可能漏检
  const pxMm = (params.pixelUm || 24) / 1000;
  const cellMm = Math.max(r.grid.sx, r.grid.sz);
  if (cellMm > pxMm * 2) log(`⚠ 分析格 ${cellMm.toFixed(2)}mm ≈ ${(cellMm / pxMm).toFixed(0)}× 机器像素（${(pxMm * 1000).toFixed(0)}µm），细于 ${(pxMm * 2).toFixed(2)}mm 的悬空结构可能漏检`, 'warn');
  // 层检查器
  const firstIsland = islands.length ? Math.max(1, islands[0].layer + 1) : 1;
  showInspector(m.layers, firstIsland);
  drawLayer(firstIsland);
}

/* 模型整体上移 / 下移（连接底板抬高与撤回，support.js 的 syncModelLift）时同步已有分析结果：
   分析内容只取决于旋转后的几何，整体平移只是把所有世界系 y 加同一个偏移——逐字段平移即可，
   不必重跑逐层分析（环面结约 0.6s 主线程，实测切换连接底板开关的卡顿来源）。
   覆盖 analyze 输出中全部含世界系 y 的字段 + steepFaces 的面重心 + 惰性构建的 BVH 包围盒。
   不含 y 的（bins 层桶、graph 拓扑、metrics 尺寸、栅格 XZ 参数）不动。 */
export function shiftAnalysisY(dy) {
  const A = state.analysis;
  if (!A || !dy) return;
  const p = A.p;
  for (let i = 1; i < p.length; i += 3) p[i] += dy;
  if (A.ld) { const ys = A.ld.ys; for (let i = 0; i < ys.length; i++) ys[i] += dy; }
  if (A.overhang) for (const o of A.overhang) o.y += dy;
  if (A.islands) for (const it of A.islands) it.y += dy;
  if (A.graph) for (const n of A.graph.nodes) n.y += dy;
  if (A.steepPts) for (const pt of A.steepPts) pt.y += dy;
  A.grid.minY += dy;
  A.raiseH += dy;
  const bvh = A._bvh;
  if (bvh) for (let i = 1; i < bvh.bmin.length; i += 3) { bvh.bmin[i] += dy; bvh.bmax[i] += dy; }
  drawLayer();   // 层检查器标签里的 y 跟着更新（canvas 未挂时只发标签事件）
}

export function sliceAt(layerIdx) {
  const A = state.analysis;
  const nl = A.bins.length;
  // 钳制索引：NaN / 越界 / 空 bins 均回退到安全值，避免 undefined 崩溃
  let li = Number.isFinite(layerIdx) ? layerIdx : 0;
  if (nl === 0) return new Uint8Array(A.grid.W * A.grid.H);
  li = Math.max(0, Math.min(li, nl - 1));
  const z = A.grid.minY + (li + 0.5) * A.grid.layerH + 1e-5;
  const N = A.grid.W * A.grid.H;
  const occ = new Uint8Array(N);
  if (A.ld) sampleLDILayer(A.ld, z, occ);
  else {
    const sl = { arr: new Int32Array(N), n: 0 };
    rasterizeSection(A.p, A.bins[li], z, occ, sl, A.grid, A.rowXs);
  }
  return occ;
}

/* 绘制层检查器。l 缺省时沿用当前层（对应旧代码无参 drawLayer() 读滑块值） */
export function drawLayer(l) {
  const A = state.analysis; if (!A) return;
  if (l != null) curLayer = l;
  l = curLayer;
  const occ = sliceAt(l - 1);
  const occPrev = l > 1 ? sliceAt(l - 2) : null;
  const { W, H, sx, sz: szg, x0, z0 } = A.grid;
  const scope = supportScopeIds();
  const yLayer = A.grid.minY + (l - 0.5) * A.grid.layerH;
  // 孤岛高亮：本层连通域与下层接触面积不足阈值（阈值来自逐层分析，已按像素面积换算）
  const visited = new Uint8Array(W * H);
  const outside = scope ? new Uint8Array(W * H) : null;
  const stack = new Int32Array(W * H);
  const islandMask = new Uint8Array(W * H);
  const lMin = A.raiseH > 0 ? 1 : 2;   // 抬高时首层（滑块 1）悬空于平台（或底板）之上
  let islandCount = 0;
  for (let i = 0; i < W * H; i++) {
    if (!occ[i] || visited[i]) continue;
    let head = 0, tl = 0;
    stack[tl++] = i; visited[i] = 1;
    const comp = [];
    while (head < tl) {
      const c = stack[head++]; comp.push(c);
      const ci = c % W, cj = (c / W) | 0;
      if (ci + 1 < W && occ[c + 1] && !visited[c + 1]) { visited[c + 1] = 1; stack[tl++] = c + 1; }
      if (ci - 1 >= 0 && occ[c - 1] && !visited[c - 1]) { visited[c - 1] = 1; stack[tl++] = c - 1; }
      if (cj + 1 < H && occ[c + W] && !visited[c + W]) { visited[c + W] = 1; stack[tl++] = c + W; }
      if (cj - 1 >= 0 && occ[c - W] && !visited[c - W]) { visited[c - W] = 1; stack[tl++] = c - W; }
    }
    if (outside) {
      const c0 = comp[0];
      const oi = c0 % W, oj = (c0 / W) | 0;
      const owner = ownerAt(A, x0 + (oi + 0.5) * sx, yLayer, z0 + (oj + 0.5) * szg);
      if (owner == null || !scope.has(owner)) {
        for (const c of comp) outside[c] = 1;
        continue;
      }
    }
    if (l >= lMin && comp.length >= A.minIslPx) {
      let ov = 0;
      if (occPrev) for (const c of comp) if (occPrev[c]) ov++;
      if (ov < Math.min(A.attachPx, Math.ceil(comp.length * 0.5))) { islandCount++; for (const c of comp) islandMask[c] = 1; }   // 同 analyze 判据
    }
  }
  // 绘制（叠加显示：红=孤岛，蓝=本层附着材料，暗青=下层残影——直观看出每块材料脚下是否有支撑）
  const img = new ImageData(W, H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const id = j * W + i;
    if (occ[id]) {
      if (outside && outside[id]) {
        img.data[id * 4] = 72; img.data[id * 4 + 1] = 76; img.data[id * 4 + 2] = 82;
        img.data[id * 4 + 3] = 150;
      } else if (islandMask[id]) { img.data[id * 4] = 235; img.data[id * 4 + 1] = 70; img.data[id * 4 + 2] = 70; img.data[id * 4 + 3] = 235; }
      else { img.data[id * 4] = 62; img.data[id * 4 + 1] = 110; img.data[id * 4 + 2] = 200; img.data[id * 4 + 3] = 235; }
    } else if (occPrev && occPrev[id]) {
      img.data[id * 4] = 56; img.data[id * 4 + 1] = 76; img.data[id * 4 + 2] = 70;
      img.data[id * 4 + 3] = 150;
    }
  }
  const cv = layerCanvas;
  if (cv) {
    const ctx = cv.getContext('2d');
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(tmp, 0, 0, cv.width, cv.height);
    // 支撑点叠加：浅灰 = 已生成的落板支撑（实心是黑灰，画在近黑底上提亮才看得见），红 = 短小支撑，亮红 = 无法放置/无法路由
    const spanX = W * sx, spanZ = H * szg;
    const lift = (mat, t) => {
      const c = mat.color;
      const ch = v => Math.round(v * 255 * (1 - t) + 255 * t);
      return `rgba(${ch(c.r)},${ch(c.g)},${ch(c.b)},.95)`;
    };
    const anchorDot = lift(supMatAnchor, 0.15);
    const col = { ground: lift(supMat, 0.62), mesh: anchorDot, micro: anchorDot };
    for (const s of state.supportPoints || []) {
      ctx.fillStyle = col[s.state] || 'rgba(255,72,72,.95)';
      const px = (s.x - x0) / spanX * cv.width, pz = (s.z - z0) / spanZ * cv.height;
      ctx.beginPath(); ctx.arc(px, pz, 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  const z = A.grid.minY + (l - 0.5) * A.grid.layerH;
  bus.emit('layerLabel', `层 ${l}/${A.grid.layers} · y=${z.toFixed(2)}mm · 本层孤岛 ${islandCount} 处 · 支撑点 ${(state.supportPoints || []).length}`);
}

/* 换选中：孤岛数字和层检查器跟着当前模型走，不重跑整板切片。 */
bus.on('selection', () => {
  if (!state.analysis) return;
  emitSliceStats(true);
  drawLayer();
});
