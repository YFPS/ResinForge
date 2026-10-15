/* ================================================================
   支撑模板：按支撑粗细套用一组支撑塔参数（框架无关，core 层，不 import React）
   来源：HeyGears 工艺包导出 support_params_PAP10_family_flat.csv（pp_id 可回查原表）。
   换算口径（HeyGears 界面的 r2d 规则）：表内 diameter / sphereRadius / tipRadius 是半径口径，
   界面显示值 = 表内值 × 2。所以「主干直径」（界面 Trunk Diameter，即连接体直径）= 2 × diameter，
   「接触点直径」= 2 × sphereRadius，「连接体尖部直径」= 2 × tipRadius。
   取档：细 = UltraCraft Reflex · Miniature · 30 µm（主干 0.60，即界面截图里的那一行）；
         中细 / 中粗 / 粗 = UltraCraft Reflex 2 · General Purpose · 50 µm 中主干 0.75 / 0.85 / 0.95 的三行（主干递增，同一工艺）。
   密度不照抄原表，按主干直径缩放（2026-10-12 定）：
     支撑间距 = max(3.3 × 主干直径, 2.5 × (主干直径 + 0.4))：
       前一项是等强度（每根承担 间距² 的面积，承载能力 ∝ 直径²，所以间距 ∝ 直径）；
       后一项防粘连（布点实测相邻两点的最近中心距 ≈ 0.4 × 间距，要求它不小于 主干直径 + 0.4 mm 的净距）；
       细 0.6 → 2.5，中细 0.75 → 2.9，中粗 0.85 → 3.1，粗 0.95 → 3.4；
     格宽 = 5.8 × 主干直径（细 3.5 / 中细 4.4 / 中粗 4.9 / 粗 5.5），孔格竖高 = 1.4 × 格宽。
   底部疏密（2026-10-12 定，用户：细支撑要底部矩形密集才托得住，粗支撑少所以底部可以稀）：
     壳层缩减 esHullRed 决定底部孔格大小——细 / 中细 = 0 级，底部与上部同为格宽 w（最密）；
     中粗 / 粗 = 1 级，每下降一个柱高内部孔格放大一倍（底部约 2w）。
     连接数不变（同一批支撑点都接得上），只改底部几何；代价是 0 级的杆件约为 1 级的 2～3 倍，生成更慢。
   针最大长（2026-10-12 定）：= 10 × 主干直径（细 6 / 中细 7.5 / 中粗 8.5 / 粗 9.5 mm），长细比不变。
     格宽随直径放大后格架节点变稀，针仍固定 6 mm、方向偏差仍限 25° 时，粗模板环面结 180 点里 69 点接不上格架；
     放到 9 mm 后 31 点。
   原表的粗档间距（1.5）反而比细档（2.0）更密，与等强度判断相反，这里不采用。
   模板不改切片层厚（层厚请在分析步骤里设置），也不改模型抬高（统一以 4 mm 为准）和临界角（统一以 45° 为准）。
================================================================ */

/* 表内取值（单位 mm，半径口径，界面显示 ×2）。键即模板 id，对象顺序即界面顺序（细 → 粗）。
   间距与格宽不从表里取，见 toParams */
const SOURCES = {
  fine: {
    label: '细', ppId: '1720324258973949965', source: '黑格 PAP10',
    diameter: 0.3, embeddedDepth: 0.15, sphereRadius: 0.125,
    tipRadius: 0.1, connectionLength: 1.5,
    boundaryOffset: 0.5, awayFromWall: 0.6, baseHeight: 1.2, hullRed: 0,
  },
  'mid-fine': {
    label: '中细', ppId: '2005905103973912580', source: '黑格工艺包 主干 0.75',
    diameter: 0.375, embeddedDepth: 0.2, sphereRadius: 0.15,
    tipRadius: 0.12, connectionLength: 1.5,
    boundaryOffset: 0.5, awayFromWall: 0.6, baseHeight: 1.0, hullRed: 0,
  },
  'mid-coarse': {
    label: '中粗', ppId: '1976519320312893442', source: '黑格工艺包 主干 0.85',
    diameter: 0.425, embeddedDepth: 0.2, sphereRadius: 0.16,
    tipRadius: 0.12, connectionLength: 1.5,
    boundaryOffset: 0.5, awayFromWall: 0.6, baseHeight: 1.0, hullRed: 1,
  },
  coarse: {
    label: '粗', ppId: '1963879732640530440', source: '粗档指定参数',
    diameter: 0.475, embeddedDepth: 0.28, sphereRadius: 0.22,
    tipRadius: 0.15, connectionLength: 1.5,
    boundaryOffset: 0.5, awayFromWall: 0.6, baseHeight: 1.0, hullRed: 1,
    // 2026-10-16 用户指定粗档界面值。接触直径 1.0 就是球头直径，接触深度 0.6。
    ui: { trunk: 1.5, tip: 1.0, pen: 0.6, taper: 3.0, spacing: 4.0, gap: 0.6 },
  },
};

/* 表内字段 → 本系统参数（换算规则）
   共用：支撑间距 = max(3.3 × 主干直径, 2.5 × (主干直径 + 0.4)) → spacing（等强度 + 防粘连，见文件头）；
         网格边界偏移 → edgeInset；嵌入深度 → pen（接触深度）。
   支撑塔：格宽 = 5.8 × 主干直径 → esCell，孔格竖高 = 1.4 × 格宽 → esDiamAngle（斜边角 = atan 竖高/格宽）；
           主干直径 = 2 × diameter → esBarW（边宽），边厚 = 边宽 → esBarT（方截面）；
           主力针身（十字针）宽度 = 主干直径 → esConnW（连接宽），针板厚 = 连接宽 → esNeedleT（方截面）；
           短小支撑（十字短杆 / 分叉 / 贴面短连接）的中段宽度 = 主干直径 × smallScale（界面「小支撑缩放比例」，表内 bracketSupportScalingRatio 0.8）——生成时由 supportTower 直接计算，不占独立参数；
           开球头时接触直径 = 接触点球半径 ×2 → esTipW；上端直径 = 尖半径 ×2 → esTopD；
           顶端长度 = 原表连接长（黑格连接体长度，细 / 中细 / 中粗为 1.5 mm；粗档按用户指定 3.0 mm），接触边距取 0；
           离墙距离 → esGap（界面「与模型最小间距」）；底座高 → esFoundH（基础带高）。
   未映射（沿用本系统默认）：模型抬高（统一 4 mm）、临界角（统一 45°）、密度、接触形状、壳层类型与壳厚、
   最低点加强、线底宽、顶补偿、曝光时间与功率。 */
function toParams(s) {
  const r1 = x => Math.round(x * 10) / 10;
  const r3 = x => Math.round(x * 1000) / 1000;
  const margin = 0;   // 接触边距：0 = 针头为纯梯形（过渡段直接到接触点），不留接触宽的直段
  const trunk = r3(2 * s.diameter);   // 界面「主干直径」= 表内 diameter × 2
  const spacing = r1(Math.max(3.3 * trunk, 2.5 * (trunk + 0.4)));   // 支撑间距：等强度（∝ 主干直径）与防粘连（最近中心距 ≈ 0.4 × 间距 ≥ 主干直径 + 0.4）取大
  const cell = r1(5.8 * trunk);       // 格宽：同样按主干直径缩放，粗档不把格子压得太密
  const cellZ = r1(1.4 * cell);       // 孔格竖高
  const out = {
    shared: {
      spacing,
      edgeInset: s.boundaryOffset,
      pen: s.embeddedDepth,
      smallScale: 0.8,    // 小支撑缩放比例（界面主参数；与表内 bracketSupportScalingRatio 一致）
      tipBall: true,      // 黑格接触形状是球
    },
    tower: {
      esCell: cell,
      esDiamAngle: r3(Math.atan2(cellZ, cell) * 180 / Math.PI),
      esBarW: trunk,
      esConnW: trunk,
      esTipW: r3(2 * s.sphereRadius),   // 接触直径：开球头时就是球的直径
      esTopD: r3(2 * s.tipRadius),      // 上端直径：锥靠近模型的一头（连接体尖部）
      esBotD: trunk,                     // 底部直径：锥靠近主干的一头，默认同主干
      esTaper: r3(s.taper ?? s.connectionLength),   // 顶端长度：缺省 = 原表连接长 1.5；粗档由 ui 覆盖
      esContactMargin: margin,
      esGap: s.awayFromWall,
      esBarT: trunk,      // 边厚 = 边宽（方截面，不做扁板条）
      esNeedleT: trunk,   // 针板厚 = 连接宽（方截面）
      esFoundH: s.baseHeight,
      esHullRed: s.hullRed,   // 底部疏密：壳层缩减级数（细 / 中细 0 = 底部全密；中粗 / 粗 1 = 底部每柱高放大一倍）
      esNeedleMax: r1(10 * trunk),   // 针最大长 = 10 × 主干直径（长细比不变）：格宽随直径放大后节点变稀，针固定 6 mm 时粗模板近四成的点接不上格架
    },
  };
  // 粗档按用户给定的界面值，主干不再用表内 0.95，接触 / 深度 / 顶端长度 / 间距也不走上面的公式
  if (s.ui) {
    const u = s.ui;
    const cellU = r1(5.8 * u.trunk);
    const cellZU = r1(1.4 * cellU);
    out.shared.spacing = u.spacing;
    out.shared.pen = u.pen;
    out.tower.esBarW = u.trunk;
    out.tower.esBarT = u.trunk;
    out.tower.esConnW = u.trunk;
    out.tower.esNeedleT = u.trunk;
    out.tower.esTipW = u.tip;          // 接触直径 = 球头直径
    out.tower.esBotD = u.trunk;
    out.tower.esTaper = u.taper;
    out.tower.esGap = u.gap;
    out.tower.esCell = cellU;
    out.tower.esDiamAngle = r3(Math.atan2(cellZU, cellU) * 180 / Math.PI);
    out.tower.esNeedleMax = r1(10 * u.trunk);
    out.tower.esHullRed = u.trunk > 0.82 ? 1 : 0;
  }
  return out;
}

/** 四套支撑模板（细 → 粗）。name 为界面显示名；diameter（主干直径，已 ×2）、spacing（支撑间距）与 tipW（接触宽）即粗细的依据，source 为界面说明里的出处 */
export const SUPPORT_TEMPLATES = Object.entries(SOURCES).map(([id, s]) => {
  const { shared, tower } = toParams(s);
  return {
    id,
    name: s.label,
    diameter: tower.esBarW,
    spacing: shared.spacing,
    cell: tower.esCell,
    tipW: tower.esTipW,
    pen: shared.pen,
    taper: tower.esTaper,
    topD: tower.esTopD,
    source: s.source,
    ppId: s.ppId,
    shared, tower,
  };
});

export function getSupportTemplate(id) {
  return SUPPORT_TEMPLATES.find(t => t.id === id) || null;
}

/** 模板要写入 params 的全部键值（共用 + 支撑塔） */
export function templateParams(t) {
  return { ...t.shared, ...t.tower };
}

/** 主干直径联动（2026-10-14 简化设计：界面上只留主参数，其余按比例走）：
    一个直径值推出的整套支撑塔参数（与 toParams 同一套公式）——格架杆 = 直径（边宽 = 边厚）；
    针身（十字针）宽度 = 直径；格宽 = 5.8 × 直径；斜边角 = 格孔竖高 1.4×格宽 反算；
    针最大长 = 10 × 直径；支撑间距 = max(3.3 × 直径, 2.5 × (直径 + 0.4))；
    底部疏密按直径分档（≤ 0.82 → 0 级底部全密，> 0.82 → 1 级，与模板口径一致）。
    短小支撑的宽度 = 直径 × smallScale 由生成端（supportTower）实时计算，不在联动集内。
    界面「主干直径」滑杆写入 esBarW，其余键由调用方一并写入 params。 */
export function trunkLinkage(trunk) {
  const r1 = x => Math.round(x * 10) / 10;
  const r3 = x => Math.round(x * 1000) / 1000;
  const cell = r1(5.8 * trunk);
  const cellZ = r1(1.4 * cell);
  return {
    esBarW: trunk,
    esBarT: trunk,
    esConnW: trunk,
    esNeedleT: trunk,
    esCell: cell,
    esDiamAngle: r3(Math.atan2(cellZ, cell) * 180 / Math.PI),
    esNeedleMax: r1(10 * trunk),
    spacing: r1(Math.max(3.3 * trunk, 2.5 * (trunk + 0.4))),
    esHullRed: trunk > 0.82 ? 1 : 0,
  };
}
