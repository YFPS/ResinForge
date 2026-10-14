/* ================================================================
   详细切片分析 + 层检查器：runSliceAnalysis（旧 btnSlice.onclick）/ sliceAt / drawLayer。
   与旧 main.js 的差异：sliceStats/inspector 显隐/层标签改发 bus 事件；
   layerCanvas 由 React 提供元素引用（setLayerCanvas 注册），canvas 绘制保留在本模块。
================================================================ */
import * as THREE from 'three';
import { state, params, bus, log, toast, setProgress, nextFrame } from '../store.js';
import { analyze, steepFaces, sampleLDILayer, rasterizeSection } from './slicer.js';
import { raiseH, ensureBakedDisplay } from './model.js';

let layerCanvas = null;   // React 层检查器的 canvas（256×256）
let curLayer = 1;         // 当前滑块层（1-based；旧代码读 $('layerSlider').value）
export function setLayerCanvas(cv) { layerCanvas = cv; }
export function getCurLayer() { return curLayer; }

export function showInspector(layers, firstIsland) {
  curLayer = firstIsland;
  bus.emit('inspector', { show: true, layers, firstIsland });
}
export function hideInspector() { bus.emit('inspector', { show: false }); }

export async function runSliceAnalysis() {
  if (!state.mesh) return toast('请先载入模型');
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
  const r = analyze(pos, idQ, {
    gridRes: 288, layerH, gapThresh, detail: true, raiseH: rh,
    minIslArea: params.minIslArea, minAttachArea: params.minAttach
  });
  setProgress(0.85, '陡峭悬空面分析…');
  await nextFrame();
  const sf = steepFaces(state.faces, idQ, selfAngle, state.protectedFaces, 1, true);
  if (rh > 0) for (const pt of sf.pts) pt.y += rh;   // 面重心为局部坐标，抬到世界系
  r.steepPts = sf.pts;
  r.protSteep = sf.protHit;
  state.analysis = r;
  setProgress(null);
  const m = r.metrics;
  const totIslandArea = r.islands.reduce((s, i) => s + i.area, 0);
  bus.emit('sliceStats', {
    layers: m.layers,
    raiseText: `${rh}mm / ${params.autoPlateOn ? `底板 ${+(params.apHeight || 1.3).toFixed(2)}mm` : params.baseJoin ? `连接底板 ${+(state.joinLift || 0).toFixed(2)}mm` : '关'}`,
    islandCount: r.islands.length,
    totIslandArea,
    steepArea: sf.steepArea,
    protHit: sf.protHit,
    supportVol: m.supportVol,
    maxFill: m.maxFill,
  });
  log(`逐层分析完成：${m.layers} 层 · 孤岛 ${r.islands.length} 处 · ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'ok');
  // 日志框逐层输出孤岛数量（仅列出存在孤岛的层）
  if (r.islands.length) {
    const byLayer = new Map();
    for (const isl of r.islands) {
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
  const firstIsland = r.islands.length ? Math.max(1, r.islands[0].layer + 1) : 1;
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
  // 孤岛高亮：本层连通域与下层接触面积不足阈值（阈值来自逐层分析，已按像素面积换算）
  const visited = new Uint8Array(W * H);
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
      if (islandMask[id]) { img.data[id * 4] = 235; img.data[id * 4 + 1] = 70; img.data[id * 4 + 2] = 70; }
      else { img.data[id * 4] = 62; img.data[id * 4 + 1] = 110; img.data[id * 4 + 2] = 200; }
      img.data[id * 4 + 3] = 235;
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
    // 支撑点叠加：绿 = 已生成结构，琥珀 = 锚定模型/微型短柱，红 = 头部无法放置/无法路由
    const spanX = W * sx, spanZ = H * szg;
    const col = { ground: 'rgba(56,217,150,.95)', mesh: 'rgba(255,176,32,.95)', micro: 'rgba(255,176,32,.95)' };
    for (const s of state.supportPoints || []) {
      ctx.fillStyle = col[s.state] || 'rgba(255,72,72,.95)';
      const px = (s.x - x0) / spanX * cv.width, pz = (s.z - z0) / spanZ * cv.height;
      ctx.beginPath(); ctx.arc(px, pz, 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  const z = A.grid.minY + (l - 0.5) * A.grid.layerH;
  bus.emit('layerLabel', `层 ${l}/${A.grid.layers} · y=${z.toFixed(2)}mm · 本层孤岛 ${islandCount} 处 · 支撑点 ${(state.supportPoints || []).length}`);
}
