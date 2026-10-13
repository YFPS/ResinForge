/* ================================================================
   连接底板高度（框架无关，core 层，不 import React）
   ----------------------------------------------------------------
   支撑塔开「连接底板」时，板条沿底层墙线铺在原来的支撑下面，模型同步抬高同样的高度
   （用户 2026-10-12：「连接底板后模型再往上抬高一些，这高度用连接底板的高度」，并选定「整整一个板高」）：
   板上面的整套支撑（含原来的基础带，开底板时不开三角缺口、与板条连成一条）与不开底板时完全相同，只是整体上移一个板高。
   supportTower.js（板高）与 model.js（模型抬高）共用这里的公式，两边不会走样。
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

/** 当前参数下模型应额外抬高多少：支撑塔模式且开了连接底板才抬（树状模式没有连接底板） */
export function joinLiftWanted(P) {
  return P.baseJoin && P.supMode === 'tower' ? joinPlateHeight(P) : 0;
}
