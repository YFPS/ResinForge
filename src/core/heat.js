/* ================================================================
   支撑热力图（heat.js）
   在模型表面用颜色梯度显示「哪里需要支撑、需要多强」：
   - 热度 = 悬空角超出量（越过自支撑角的程度，越接近竖直朝下越热）
           × 悬空高差调制（有精分析 LDI 时：下方 <0.8mm 有材料 = 已托住不热；
             高差越大越热，8mm 封顶——与支撑生成的「已托住豁免」口径一致）
   - 无分析数据时退化为纯角度
   **按面涂色**：用这个三角形自己的法线，三个顶点同色。平面底盖整面是红，不会被侧壁法线抹成中间一点红。
   配色：蓝(无需支撑) → 橙 → 红(朝下底面)。开热力图时仍用和模型一样的受光材质，只把表面换成热力色，形体的明暗还在。保护面在热力图模式下用紫色，
   避免与红色热点混淆（关闭后恢复红色）。
   联动：分析完成 / 换模型 / 保护面变更 时若开关开着则自动重算重绘。
================================================================ */
import * as THREE from 'three';
import { state, params, bus, log } from '../store.js';
import { ldiGapAt } from './slicer.js';
import { baseY, raiseH, displayPosePending, ensureBakedDisplay, syncPartTint, setHeatActiveReader, setSelectedPainter } from './model.js';
import { modelMat } from './scene.js';

let heatOn = false;
export const isHeatOn = () => heatOn;
setHeatActiveReader(() => heatOn);

/* 热力色带：不需要支撑的面是蓝，过了自支撑角先橙再红。
   颜色比纯色略压暗，仍走和模型一样的光照，管子的起伏还在。 */
const STOPS = [
  [0.00, [0.18, 0.36, 0.86]],   // 无需支撑：蓝
  [0.34, [1.00, 0.55, 0.06]],   // 刚过临界角：橙
  [0.68, [0.94, 0.20, 0.05]],   // 更朝下：红橙
  [1.00, [0.86, 0.05, 0.04]],   // 朝下底面：红
];
const HEAT_DIM = 0.88;   // 和模型一样只压暗一点点，灯光仍在，形体不会变成一块平色
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

/* 位置相同的顶点合成一个。热度取四周各面里最热的一面，不做法线平均。
   平底端盖边缘的点也会拿到盖面的红；球面上相邻面差不多热，渐变仍然顺。 */
export function computeVertHeat() {
  if (!state.mesh || !state.faces) return null;
  const pos = state.mesh.geometry.attributes.position;
  const n = pos.count;
  const nf = n / 3;
  const { nrm } = state.faces;
  const cosv = Math.cos(params.selfAngle * Math.PI / 180);
  const span = Math.max(1e-4, 1 - cosv);
  const ld = state.analysis && state.analysis.ld ? state.analysis.ld : null;
  const raise = state.analysis ? state.analysis.raiseH : raiseH();
  const floorY = baseY();
  const vid = new Int32Array(n);
  const map = new Map();
  let nu = 0;
  for (let v = 0; v < n; v++) {
    const key = Math.round(pos.getX(v) * 1e4) + '_' + Math.round(pos.getY(v) * 1e4) + '_' + Math.round(pos.getZ(v) * 1e4);
    let id = map.get(key);
    if (id === undefined) { id = nu++; map.set(key, id); }
    vid[v] = id;
  }
  const vh = new Float32Array(nu);
  const faceH = new Float32Array(nf);
  for (let f = 0; f < nf; f++) {
    const ny = nrm[f * 3 + 1];
    const nx = nrm[f * 3], nz = nrm[f * 3 + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    const sny = ny / len;
    let h = 0;
    if (sny < -cosv) {
      const e = Math.min(1, (-sny - cosv) / span);
      h = Math.pow(e, 0.8);
      if (ld) {
        const v = f * 3;
        const wy = (pos.getY(v) + pos.getY(v + 1) + pos.getY(v + 2)) / 3 + raise;
        const wx = (pos.getX(v) + pos.getX(v + 1) + pos.getX(v + 2)) / 3;
        const wz = (pos.getZ(v) + pos.getZ(v + 1) + pos.getZ(v + 2)) / 3;
        const ci = Math.min(ld.W - 1, Math.max(0, Math.floor((wx - ld.x0) / ld.sx)));
        const cj = Math.min(ld.H - 1, Math.max(0, Math.floor((wz - ld.z0) / ld.sz)));
        const info = ldiGapAt(ld, cj * ld.W + ci, wy - 0.02, floorY) || ldiGapAt(ld, cj * ld.W + ci, wy, floorY);
        if (info && info.gap < 0.8) h = 0;
        else if (info) h *= 0.9 + 0.1 * Math.min(1, info.gap / 8);
      }
    }
    faceH[f] = h;
    const v = f * 3;
    for (let k = 0; k < 3; k++) {
      const id = vid[v + k];
      if (h > vh[id]) vh[id] = h;
    }
  }
  state.vertHeat = { vid, vh, faceH };
  state.faceHeat = faceH;
  return state.vertHeat;
}

/* 顶点色按各自热度写。保护面覆盖为紫。 */
export function applyHeatColors() {
  if (!state.mesh || !state.vertHeat) return;
  if (state.mesh.material !== modelMat) state.mesh.material = modelMat;
  const ca = state.mesh.geometry.attributes.color;
  const { faceH } = state.vertHeat;
  const prot = state.protectedFaces;
  const nf = faceH.length;
  const rgb = [0, 0, 0];
  for (let f = 0; f < nf; f++) {
    const v = f * 3;
    const c = prot.has(f) ? PROT_HOT : heatRGB(faceH[f], rgb);
    for (let k = 0; k < 3; k++) ca.setXYZ(v + k, c[0] * HEAT_DIM, c[1] * HEAT_DIM, c[2] * HEAT_DIM);
  }
  ca.needsUpdate = true;
}

/* 关掉热力图：有选中就涂热力图的蓝，否则回到带光照的灰。保护面仍盖红。 */
export function restoreColors() {
  syncPartTint();
}

function refresh() {
  if (!state.mesh) return;
  ensureBakedDisplay();
  computeVertHeat();
  applyHeatColors();
}

/* 热力图和普通模型用同一套光照。材质保持受光，顶点色只负责蓝橙红，所以管子的明暗还在。 */
export function syncHeatMaterial() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  modelMat.color.set(heatOn ? 0xffffff : (light ? 0x717b88 : 0xa7b0bd));
  modelMat.envMapIntensity = 0.95;
  modelMat.metalness = 0.15;
  modelMat.roughness = 0.55;
  if (state.mesh) state.mesh.material = modelMat;
}

export function setHeat(on, opts = {}) {
  heatOn = !!on;
  syncHeatMaterial();
  if (heatOn) {
    if (state.mesh) {
      const hasLDI = !!(state.analysis && state.analysis.ld);
      if (!opts.quiet) log(`支撑热力图已开启（${hasLDI ? '悬空角 × LDI 高差' : '纯悬空角，运行逐层分析后更准'}）`);
      refresh();
    }
  } else {
    restoreColors();
    if (!opts.quiet) log('支撑热力图已关闭');
  }
  bus.emit('heat', heatOn);
}

/* 选中模型用热力图的蓝，材质仍受光，所以管子的明暗还在。 */
function paintSelectedBlue() {
  if (!state.mesh) return false;
  const sel = new Set(state.selectedIds || []);
  if (!sel.size) return false;
  modelMat.color.set(0xffffff);
  modelMat.envMapIntensity = 0.95;
  modelMat.metalness = 0.15;
  modelMat.roughness = 0.55;
  state.mesh.material = modelMat;
  const blue = STOPS[0][1];
  const ca = state.mesh.geometry.attributes.color;
  if (!ca) return false;
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  const base = new THREE.Color(light ? 0x717b88 : 0xa7b0bd);
  for (const p of state.parts) {
    const on = sel.has(p.id);
    const start = p.faceStart || 0;
    const n = p.nf || 0;
    for (let f = 0; f < n; f++) {
      const gf = start + f;
      const v = gf * 3;
      const prot = state.protectedFaces.has(gf);
      const r = prot ? 1 : (on ? blue[0] * HEAT_DIM : base.r);
      const g = prot ? 0.38 : (on ? blue[1] * HEAT_DIM : base.g);
      const b = prot ? 0.38 : (on ? blue[2] * HEAT_DIM : base.b);
      ca.setXYZ(v, r, g, b);
      ca.setXYZ(v + 1, r, g, b);
      ca.setXYZ(v + 2, r, g, b);
    }
  }
  ca.needsUpdate = true;
  return true;
}
setSelectedPainter(paintSelectedBlue);

/* 热力图开着就画热力色。关掉后：选中的是受光的蓝，没选中的是灰。 */
function showDisplayColor() {
  if (heatOn) { if (state.vertHeat) applyHeatColors(); return; }
  syncPartTint();
}
bus.on('suspendHeat', () => { if (!heatOn) syncPartTint(); });
bus.on('syncTint', showDisplayColor);
bus.on('displayMesh', showDisplayColor);
/* 取消选中时模型要回到主题灰。顶点涂白之后，材质色必须跟着回到灰，否则会变成一片发白。 */
bus.on('restoreLitModel', () => { if (!heatOn) syncHeatMaterial(); });

/* 联动：分析完成（LDI 可用）/ 更换模型 / 保护面增减 时自动重算重绘 */
bus.on('sliceStats', s => { if (heatOn && s) refresh(); });
bus.on('param', k => { if (heatOn && k === 'selfAngle') refresh(); });
// 只平移时显示靠矩阵，顶点还在原处。这时重算热力图既慢又会读到旧坐标，颜色跟着网格走就对。
bus.on('modelInfo', () => { if (heatOn && !displayPosePending()) refresh(); });
bus.on('protectedChanged', () => { if (heatOn) applyHeatColors(); });
