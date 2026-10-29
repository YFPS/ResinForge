/* ================================================================
   画线切割 · 沿画线的曲面切（调度）
   ----------------------------------------------------------------
   纯计算：主线程、Web Worker、Node 通用。平面切（拟合平面）见 cutKit.js；画线不平时走 cutCurved。
   2026-10-28 起曲面切全部交给 cutSeam.js：切面 = 穿过画线的窄带 + 画线往里收一圈后张开的膜，切口就落在画线上，
   切面整片在材料里面（取代旧的「沿网格拓扑切 + 扇形封盖」与「膜片棱柱 / 高度场切刀」：前者接缝离画线最多 1.7 mm、
   封盖会伸出模型外面成飞边，后者会在悬檐下、画线圈外顺带切到别处）。
   本文件留下：画线 → 局部折线（loopToLocal）。切面预览与「画线自交」判断也改用 cutSeam.js 的膜
   （previewMembrane / loopTangled），旧的反距离加权高度场预览已删除。
================================================================ */
import { fail } from './cutGeom.js';
import { cutSeam } from './cutSeam.js';

export const FLAT_TOL = 0.2;       // 画线各点到拟合平面都不超过这么远（mm）就按平面切，超过才走曲面

/* ---------- 画线 → 局部折线 ---------- */

/** 世界系画线（xyz 平铺）→ 切面局部系的闭合折线 [[u, v, w]]（去掉重合点） */
export function loopToLocal(loopFlat, fr) {
  const L = [];
  for (let i = 0; i < loopFlat.length; i += 3) {
    const d0 = loopFlat[i] - fr.c[0], d1 = loopFlat[i + 1] - fr.c[1], d2 = loopFlat[i + 2] - fr.c[2];
    const p = [
      d0 * fr.u[0] + d1 * fr.u[1] + d2 * fr.u[2],
      d0 * fr.v[0] + d1 * fr.v[1] + d2 * fr.v[2],
      d0 * fr.n[0] + d1 * fr.n[1] + d2 * fr.n[2],
    ];
    const q = L[L.length - 1];
    if (q && Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-4) continue;
    L.push(p);
  }
  if (L.length > 2 && Math.hypot(L[0][0] - L[L.length - 1][0], L[0][1] - L[L.length - 1][1], L[0][2] - L[L.length - 1][2]) < 1e-4) L.pop();
  return L;
}

/**
 * 沿画线的曲面切。ctx = { Mp, bb, fr, loop, spec, T, ms, warn }（Mp 已在局部系，loop 为世界系平铺坐标）。
 * 返回 { upper, lower, pin, islands, picked, iou, area, merged, comps, sheet } 或 { err }，见 cutSeam.js。
 */
export function cutCurved(MF, ctx) {
  const L = loopToLocal(ctx.loop, ctx.fr);
  if (L.length < 3) return { err: fail('LINE_FLAT', '画线至少要有三个点') };
  return cutSeam(MF, ctx, L);
}
