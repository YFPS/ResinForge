/* ================================================================
   连接底板高度（框架无关，core 层，不 import React）
   ----------------------------------------------------------------
   支撑塔开「连接底板」时，立板沿底层墙线铺在支撑下面，模型只抬一个板高。
   板顶就是最低支撑的落点：模型底面离板顶 = 用户抬高（默认 4 mm），最短支撑 4 mm。
   板顶之上的实心肩等于基础带高（仍在这 4 mm 之内）。开孔上沿离板顶至少一个杆宽，
   格架圆头不会贴进孔里（2026-10-16 靠把肩加到两倍杆宽躲开，肩不再随杆宽加高）。
   supportTower.js（板高 / 肩高）与 model.js（模型抬高）共用这里的公式，两边不会走样。
================================================================ */

const num = (v, d) => (Number.isFinite(v) ? v : d);

/** 连接底板高（mm）= 基础带高 + 0.85 × 竖直半格，不低于 1.5；竖直半格 = 菱形宽 × tan(菱形角) / 2，菱形角不低于自支撑临界角 */
export function joinPlateHeight(P) {
  const w = Math.max(1, num(P.esCell, 3.5));
  const crit = Math.max(10, Math.min(80, num(P.selfAngle, 45))) * Math.PI / 180;
  const ang = Math.max(crit, Math.max(20, Math.min(85, num(P.esDiamAngle, 55))) * Math.PI / 180);
  const hs = w * Math.tan(ang) / 2;
  return Math.max(Math.max(0, num(P.esFoundH, 1)) + hs * 0.85, 1.5);
}

/** 自动底板实际板厚（mm）。低于 0.4 按 0.4，与底板几何、支撑落点同一口径 */
export function autoPlateThickness(P) {
  const v = Number(P && P.apHeight);
  return Math.max(0.4, Number.isFinite(v) ? v : 1.3);
}

/** 连接底板顶上的实心肩高（mm）。格架从这块实心带的顶上才开孔。
    肩 = 基础带高。开孔上沿离板顶至少一个杆宽（supportTower 的 skirtHoles），
    粗杆的圆形接头不会贴进孔里。2026-10-16 肩只有基础带那么薄时圆头贴进孔沿，当时改取两倍杆宽；
    肩算在模型抬高里，粗档格架起步几乎顶到模型，现不再随杆宽加高。 */
export function joinShoulder(P) {
  return Math.max(0, num(P.esFoundH, 1));
}

/** 当前参数下模型应额外抬高多少（mm）：连接底板抬一个板高，自动底板抬一个板厚，其余不抬。
    板顶是最低支撑的落点，模型底面离板顶 = 用户抬高（默认 4 mm）；实心肩与基础带都在这 4 mm 之内。 */
export function joinLiftWanted(P) {
  if (P.baseJoin) return joinPlateHeight(P);
  if (P.autoPlateOn) return autoPlateThickness(P);
  return 0;
}

/** 柱高（mm）= 柱高宽比 × 格宽。格架要在起步面上方一个柱高内才会开始展宽，supportTower.js 的 Dcol 同此口径 */
export function columnHeight(P) {
  return Math.max(1, num(P.esColRatio, 2)) * Math.max(1, num(P.esCell, 3.5));
}
