/* ================================================================
   支撑热力图（heat.js）
   在模型表面用颜色梯度显示「哪里需要支撑、需要多强」：
   - 热度 = 悬空角超出量（越过自支撑角的程度，越接近竖直朝下越热）
           × 悬空高差调制（有精分析 LDI 时：下方 <0.8mm 有材料 = 已托住不热；
             高差越大越热，8mm 封顶——与支撑生成的「已托住豁免」口径一致）
   - 无分析数据时退化为纯角度
   **平滑实现**：热度直接在「平滑顶点法线」上计算（非索引几何的重复顶点按位置合并，
   邻接面法线按面积加权平均成连续法线场）——热度场天生光滑，不做「面热度→顶点平均」
   的二次平滑（那会沿三角拓扑扩散出波浪纹）。最后仅 1 轮轻度邻域扩散去毛刺。
   配色：亮灰蓝(无需支撑) → 青 → 绿 → 黄 → 橙红 → 红(强需求)；保护面在热力图模式下用紫色，
   避免与红色热点混淆（关闭后恢复红色）。
   联动：分析完成 / 换模型 / 保护面变更 时若开关开着则自动重算重绘。
================================================================ */
import { state, params, bus, log } from '../store.js';
import { ldiGapAt } from './slicer.js';
import { baseY, raiseH, displayPosePending, ensureBakedDisplay } from './model.js';

let heatOn = false;
export const isHeatOn = () => heatOn;

/* 热力色带：t∈[0,1]，亮灰蓝 → 青 → 绿 → 黄 → 橙红 → 红 */
const STOPS = [
  [0.00, [0.36, 0.47, 0.62]],   // 无需支撑：亮灰蓝（保持模型体积感，顶点色乘算会压暗）
  [0.08, [0.10, 0.62, 0.95]],   // 青（弱需求很快显色）
  [0.30, [0.15, 0.80, 0.42]],   // 绿
  [0.55, [1.00, 0.85, 0.10]],   // 黄
  [0.80, [1.00, 0.30, 0.08]],   // 橙红
  [1.00, [1.00, 0.05, 0.05]],   // 纯红
];
function heatRGB(t, out) {
  for (let s = 1; s < STOPS.length; s++) {
    if (t <= STOPS[s][0] || s === STOPS.length - 1) {
      const [t0, c0] = STOPS[s - 1], [t1, c1] = STOPS[s];
      const k = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
      out[0] = c0[0] + (c1[0] - c0[0]) * k;
      out[1] = c0[1] + (c1[1] - c0[1]) * k;
      out[2] = c0[2] + (c1[2] - c0[2]) * k;
      return out;
    }
  }
  return out;
}

const PROT_HOT = [0.80, 0.30, 0.95];   // 热力图模式下的保护面：紫
const PROT_STD = [1, 0.38, 0.38];      // 常规模式保护面：红
const protColor = () => heatOn ? PROT_HOT : PROT_STD;

/* 顶点热度计算（平滑法线场 + LDI 高差）：
   输出 state.vertHeat = { vid, vh }——vid: 渲染顶点 → 唯一顶点；vh: 唯一顶点热度 0..1 */
export function computeVertHeat() {
  if (!state.mesh || !state.faces) return null;
  const pos = state.mesh.geometry.attributes.position;
  const n = pos.count;
  const { nrm, area } = state.faces;
  const cosv = Math.cos(params.selfAngle * Math.PI / 180);
  const ld = state.analysis && state.analysis.ld ? state.analysis.ld : null;
  const raise = state.analysis ? state.analysis.raiseH : raiseH();   // 有效抬高（含连接底板）
  const floorY = baseY();   // 与支撑落点口径一致（自动底板顶 / 平台）

  // 1) 唯一顶点合并（量化 1e-4mm）+ 平滑顶点法线（邻接面法线按面积加权）
  const vid = new Int32Array(n);
  const map = new Map();
  const accN = [];   // [Σnx·w, Σny·w, Σnz·w]
  const upos = [];   // 唯一顶点局部坐标（首个代表）
  for (let v = 0; v < n; v++) {
    const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    const key = Math.round(x * 1e4) + '_' + Math.round(y * 1e4) + '_' + Math.round(z * 1e4);
    let id = map.get(key);
    if (id === undefined) { id = accN.length; map.set(key, id); accN.push([0, 0, 0]); upos.push(x, y, z); }
    vid[v] = id;
    const f = (v / 3) | 0, w = area[f] || 1;
    accN[id][0] += nrm[f * 3] * w; accN[id][1] += nrm[f * 3 + 1] * w; accN[id][2] += nrm[f * 3 + 2] * w;
  }
  const nu = accN.length;

  // 2) 逐唯一顶点热度：平滑法线 y → 角度超出量（0.6 次幂提亮低热区）× LDI 高差调制
  let vh = new Float32Array(nu);
  for (let i = 0; i < nu; i++) {
    const nx = accN[i][0], ny = accN[i][1], nz = accN[i][2];
    const len = Math.hypot(nx, ny, nz) || 1;
    const sny = ny / len;
    if (sny >= -cosv) continue;                            // 未越过自支撑角：自支撑
    const e = Math.min(1, (-sny - cosv) / (1 - cosv));
    const e2 = Math.pow(e, 0.6);
    let hFac = 1;
    if (ld) {
      const wx = upos[i * 3], wy = upos[i * 3 + 1] + raise, wz = upos[i * 3 + 2];
      const ci = Math.min(ld.W - 1, Math.max(0, Math.floor((wx - ld.x0) / ld.sx)));
      const cj = Math.min(ld.H - 1, Math.max(0, Math.floor((wz - ld.z0) / ld.sz)));
      const c = cj * ld.W + ci;
      const info = ldiGapAt(ld, c, wy - 0.02, floorY) || ldiGapAt(ld, c, wy, floorY);
      if (info) {
        if (info.gap < 0.8) { vh[i] = 0; continue; }       // 下方 0.8mm 内有材料：已托住
        hFac = 0.35 + 0.65 * Math.min(1, info.gap / 8);    // 高差越大越热，8mm 封顶
      }
    }
    vh[i] = e2 * hFac;
  }

  // 3) 1 轮轻度邻域 Jacobi 扩散（0.75 自身 + 0.25 邻域平均）：去 LDI 栅格毛刺，不引入拓扑波浪
  const adj = new Map();
  const link = (a, b) => {
    if (a === b) return;
    let s = adj.get(a); if (!s) adj.set(a, s = new Set());
    s.add(b);
  };
  for (let f = 0; f < n / 3; f++) {
    const a = vid[f * 3], b = vid[f * 3 + 1], c = vid[f * 3 + 2];
    link(a, b); link(b, c); link(c, a);
  }
  {
    const next = new Float32Array(vh);
    for (const [i, s] of adj) {
      let sum = 0;
      for (const j of s) sum += vh[j];
      next[i] = vh[i] * 0.75 + (sum / s.size) * 0.25;
    }
    vh = next;
  }
  state.vertHeat = { vid, vh };
  state.faceHeat = null;   // 兼容字段：顶点模式不再使用逐面热度
  return state.vertHeat;
}

/* 把热度写入顶点色（同一面三个顶点颜色不同，GPU 插值成连续渐变；保护面覆盖为紫） */
export function applyHeatColors() {
  if (!state.mesh || !state.vertHeat) return;
  const ca = state.mesh.geometry.attributes.color;
  const { vid, vh } = state.vertHeat;
  const prot = state.protectedFaces;
  const nf = vid.length / 3;
  const rgb = [0, 0, 0];
  for (let f = 0; f < nf; f++) {
    const v = f * 3;
    if (prot.has(f)) {
      for (let k = 0; k < 3; k++) ca.setXYZ(v + k, PROT_HOT[0], PROT_HOT[1], PROT_HOT[2]);
    } else {
      for (let k = 0; k < 3; k++) {
        const c = heatRGB(vh[vid[v + k]], rgb);
        ca.setXYZ(v + k, c[0], c[1], c[2]);
      }
    }
  }
  ca.needsUpdate = true;
}

/* 恢复常规配色：白 + 保护面红 */
export function restoreColors() {
  if (!state.mesh) return;
  const ca = state.mesh.geometry.attributes.color;
  ca.array.fill(1);
  const pc = protColor();
  for (const f of state.protectedFaces) {
    const v = f * 3;
    for (let k = 0; k < 3; k++) ca.setXYZ(v + k, pc[0], pc[1], pc[2]);
  }
  ca.needsUpdate = true;
}

function refresh() {
  if (!state.mesh) return;
  ensureBakedDisplay();
  computeVertHeat();
  applyHeatColors();
}

export function setHeat(on) {
  heatOn = !!on;
  if (heatOn) {
    if (state.mesh) {
      const hasLDI = !!(state.analysis && state.analysis.ld);
      log(`支撑热力图已开启（${hasLDI ? '悬空角 × LDI 高差' : '纯悬空角，运行逐层分析后更准'}）`);
      refresh();
    }
  } else {
    restoreColors();
    log('支撑热力图已关闭');
  }
  bus.emit('heat', heatOn);
}

/* 联动：分析完成（LDI 可用）/ 更换模型 / 保护面增减 时自动重算重绘 */
bus.on('sliceStats', s => { if (heatOn && s) refresh(); });
// 只平移时显示靠矩阵，顶点还在原处。这时重算热力图既慢又会读到旧坐标，颜色跟着网格走就对。
bus.on('modelInfo', () => { if (heatOn && !displayPosePending()) refresh(); });
bus.on('protectedChanged', () => { if (heatOn) applyHeatColors(); });
