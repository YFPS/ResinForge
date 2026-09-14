/* ================================================================
   支撑热力图（heat.js）
   在模型表面用颜色梯度显示「哪里需要支撑、需要多强」：
   - 热度 = 悬空角超出量（法线越过自支撑角的程度，越接近竖直朝下越热）
           × 悬空高差调制（有精分析 LDI 时：下方 <0.8mm 有材料 = 已托住不热；
             高差越大越热，8mm 封顶——与支撑生成的「已托住豁免」口径一致）
   - 无分析数据时退化为纯角度判定
   配色：深蓝(无需支撑) → 青 → 绿 → 黄 → 红(强需求)；保护面在热力图模式下用紫色，
   避免与红色热点混淆（关闭后恢复红色）。
   联动：分析完成 / 换模型 / 保护面变更 时若开关开着则自动重算重绘。
================================================================ */
import { state, params, bus, log } from '../store.js';
import { ldiGapAt } from './slicer.js';
import { RAFT_T } from './model.js';

let heatOn = false;
export const isHeatOn = () => heatOn;

/* 热力色带：t∈[0,1]，深蓝 → 青 → 绿 → 黄 → 红 */
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

/* 逐面热度计算：写入 state.faceHeat（Float32Array，0..1；0 = 无需支撑） */
export function computeFaceHeat() {
  const faces = state.faces;
  if (!state.mesh || !faces) return null;
  const { nrm, cent } = faces;
  const nf = nrm.length / 3;
  const heat = new Float32Array(nf);
  const cosv = Math.cos(params.selfAngle * Math.PI / 180);
  const ld = state.analysis && state.analysis.ld ? state.analysis.ld : null;
  const raise = state.analysis ? state.analysis.raiseH : params.raiseH;
  const floorY = params.raftOn ? RAFT_T : 0;   // 与支撑落点口径一致
  for (let f = 0; f < nf; f++) {
    const ny = nrm[f * 3 + 1];
    if (ny >= -cosv) continue;                            // 未越过自支撑角：自支撑，无需支撑
    const e = Math.min(1, (-ny - cosv) / (1 - cosv));     // 角度超出量：阈值处 0 → 全朝下 1
    const e2 = Math.pow(e, 0.6);                          // 低热区提亮（大部分悬面并非全朝下）
    let hFac = 1;                                         // 无分析数据：纯角度
    if (ld) {
      const wx = cent[f * 3], wy = cent[f * 3 + 1] + raise, wz = cent[f * 3 + 2];
      const i = Math.min(ld.W - 1, Math.max(0, Math.floor((wx - ld.x0) / ld.sx)));
      const j = Math.min(ld.H - 1, Math.max(0, Math.floor((wz - ld.z0) / ld.sz)));
      const c = j * ld.W + i;
      // 重心微下沉后查询所在材料区间；取不到（列边沿偏差）则按纯角度处理
      const info = ldiGapAt(ld, c, wy - 0.02, floorY) || ldiGapAt(ld, c, wy, floorY);
      if (info) {
        if (info.gap < 0.8) { heat[f] = 0; continue; }    // 下方 0.8mm 内有材料：已托住
        hFac = 0.35 + 0.65 * Math.min(1, info.gap / 8);   // 高差越大越热，8mm 封顶
      }
    }
    heat[f] = e2 * hFac;
  }
  state.faceHeat = heat;
  return heat;
}

/* 把热度写入顶点色（保护面覆盖为紫） */
export function applyHeatColors() {
  if (!state.mesh || !state.faceHeat) return;
  const ca = state.mesh.geometry.attributes.color;
  const heat = state.faceHeat, prot = state.protectedFaces;
  const rgb = [0, 0, 0];
  for (let f = 0; f < heat.length; f++) {
    const c = prot.has(f) ? PROT_HOT : heatRGB(heat[f], rgb);
    const v = f * 3;
    for (let k = 0; k < 3; k++) ca.setXYZ(v + k, c[0], c[1], c[2]);
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
  computeFaceHeat();
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
bus.on('modelInfo', () => { if (heatOn) refresh(); });
bus.on('protectedChanged', () => { if (heatOn) applyHeatColors(); });
