/* ================================================================
   连接底板高度（框架无关，core 层，不 import React）
   ----------------------------------------------------------------
   支撑塔开「连接底板」时，立板沿底层墙线铺在支撑下面，模型只抬一个板高。
   板顶就是最低支撑的落点：模型底面离板顶 = 用户抬高（默认 4 mm），最短支撑 4 mm。
   杆比基础带粗时，板顶上再加一截实心肩（仍在这 4 mm 之内），格架圆头和斜杆下沿才不会插进开孔上沿。
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
    至少是基础带高。杆宽的两倍更高时用杆宽的两倍——否则粗杆的圆形接头（半径 = 杆宽/2）
    和斜杆下沿会贴进开孔上沿，近看就像支撑挤在连接板里（2026-10-16 粗支撑，杆宽 1.5、基础带 1）。 */
export function joinShoulder(P) {
  const foundH = Math.max(0, num(P.esFoundH, 1));
  const bar = Math.max(0.15, num(P.esBarW, 0.6));
  return Math.max(foundH, bar * 2);
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
