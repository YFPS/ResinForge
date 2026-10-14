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
     菱形宽 = 5.8 × 主干直径（细 3.5 / 中细 4.4 / 中粗 4.9 / 粗 5.5），菱形竖高 = 1.4 × 菱形宽。
   底部疏密（2026-10-12 定，用户：细支撑要底部矩形密集才托得住，粗支撑少所以底部可以稀）：
     壳层缩减 esHullRed 决定底部菱形大小——细 / 中细 = 0 级，底部与上部同为菱形宽 w（最密）；
     中粗 / 粗 = 1 级，每下降一个柱高内部菱形放大一倍（底部约 2w）。
     连接数不变（同一批支撑点都接得上），只改底部几何；代价是 0 级的杆件约为 1 级的 2～3 倍，生成更慢。
   针最大长（2026-10-12 定）：= 10 × 主干直径（细 6 / 中细 7.5 / 中粗 8.5 / 粗 9.5 mm），长细比不变。
     菱形宽随直径放大后格架节点变稀，针仍固定 6 mm、方向偏差仍限 25° 时，粗模板环面结 180 点里 69 点接不上格架；
     放到 9 mm 后 31 点。
   原表的粗档间距（1.5）反而比细档（2.0）更密，与等强度判断相反，这里不采用。
   模板不改切片层厚（层厚请在分析步骤里设置），也不改模型抬高（统一以 4 mm 为准）和临界角（统一以 45° 为准）。
================================================================ */

/* 表内取值（单位 mm，半径口径，界面显示 ×2）。键即模板 id，对象顺序即界面顺序（细 → 粗）。
   间距与菱形宽不从表里取，见 toParams */
const SOURCES = {
  fine: {
    label: '细', ppId: '1720324258973949965', source: '原表 Miniature 30 µm（UltraCraft Reflex）',
    diameter: 0.3, embeddedDepth: 0.15, sphereRadius: 0.125,
    tipRadius: 0.1, connectionLength: 1.5,
    boundaryOffset: 0.5, awayFromWall: 0.6, baseHeight: 1.2, hullRed: 0,
  },
  'mid-fine': {
    label: '中细', ppId: '2005905103973912580', source: '原表 General Purpose 50 µm（UltraCraft Reflex 2）',
    diameter: 0.375, embeddedDepth: 0.2, sphereRadius: 0.15,
    tipRadius: 0.12, connectionLength: 1.5,
    boundaryOffset: 0.5, awayFromWall: 0.6, baseHeight: 1.0, hullRed: 0,
  },
  'mid-coarse': {
    label: '中粗', ppId: '1976519320312893442', source: '原表 General Purpose 50 µm（UltraCraft Reflex 2）',
    diameter: 0.425, embeddedDepth: 0.2, sphereRadius: 0.16,
    tipRadius: 0.12, connectionLength: 1.5,
    boundaryOffset: 0.5, awayFromWall: 0.6, baseHeight: 1.0, hullRed: 1,
  },
  coarse: {
    label: '粗', ppId: '1963879732640530440', source: '原表 General Purpose 50 µm（UltraCraft Reflex 2）',
    diameter: 0.475, embeddedDepth: 0.28, sphereRadius: 0.22,
    tipRadius: 0.15, connectionLength: 1.5,
    boundaryOffset: 0.5, awayFromWall: 0.6, baseHeight: 1.0, hullRed: 1,
    taper: 2.5,   // 非原表字段：过渡段覆盖值 2.5 mm（用户 2026-10-12 指定，粗档针头比原表 1.5 更长）；缺省取原表连接长
  },
};

/* 表内字段 → 本系统参数（换算规则）
   共用：支撑间距 = max(3.3 × 主干直径, 2.5 × (主干直径 + 0.4)) → spacing（等强度 + 防粘连，见文件头）；
         网格边界偏移 → edgeInset；嵌入深度 → pen（渗透长度）。
   支撑塔：菱形宽 = 5.8 × 主干直径 → esCell，菱形竖高 = 1.4 × 菱形宽 → esDiamAngle（菱形角 = atan 竖高/菱形宽）；
           主干直径 = 2 × diameter → esBarW（边宽）与 esConnW（连接宽）；边厚 = 边宽 → esBarT（墙厚），针板厚 = 连接宽 → esNeedleT（等宽方截面）；
           尖半径 ×2 → esTipW（接触宽）；过渡段 = 原表连接长（黑格「连接体长度」，四个工艺包均为 1.5 mm，不再减 0.5；粗档 taper 覆盖为 2.5 mm），接触边距取 0（针头为纯梯形）；
           离墙距离 → esGap（离模净距）；底座高 → esFoundH（基础带高）。
   未映射（沿用本系统默认）：模型抬高（统一 4 mm）、临界角（统一 45°）、密度、接触形状、壳层类型与壳厚、
   最低点加强、线底宽、顶补偿、曝光时间与功率。 */
function toParams(s) {
  const r1 = x => Math.round(x * 10) / 10;
  const r3 = x => Math.round(x * 1000) / 1000;
  const margin = 0;   // 接触边距：0 = 针头为纯梯形（过渡段直接到接触点），不留接触宽的直段
  const trunk = r3(2 * s.diameter);   // 界面「主干直径」= 表内 diameter × 2
  const spacing = r1(Math.max(3.3 * trunk, 2.5 * (trunk + 0.4)));   // 支撑间距：等强度（∝ 主干直径）与防粘连（最近中心距 ≈ 0.4 × 间距 ≥ 主干直径 + 0.4）取大
  const cell = r1(5.8 * trunk);       // 菱形宽：同样按主干直径缩放，粗档不把格子压得太密
  const cellZ = r1(1.4 * cell);       // 菱形竖高
  return {
    shared: {
      spacing,
      edgeInset: s.boundaryOffset,
      pen: s.embeddedDepth,
    },
    tower: {
      esCell: cell,
      esDiamAngle: r3(Math.atan2(cellZ, cell) * 180 / Math.PI),
      esBarW: trunk,
      esConnW: trunk,
      esTipW: r3(2 * s.tipRadius),
      esTaper: r3(s.taper ?? s.connectionLength),   // 过渡段：缺省 = 原表连接长（连接体长度 1.5，接触边距 0）；粗档由 taper 覆盖为 2.5
      esContactMargin: margin,
      esGap: s.awayFromWall,
      esBarT: trunk,      // 边厚 = 边宽（等宽方截面，不做扁板条）
      esNeedleT: trunk,   // 针板厚 = 连接宽
      esFoundH: s.baseHeight,
      esHullRed: s.hullRed,   // 底部疏密：壳层缩减级数（细 / 中细 0 = 底部全密；中粗 / 粗 1 = 底部每柱高放大一倍）
      esNeedleMax: r1(10 * trunk),   // 针最大长 = 10 × 主干直径（长细比不变）：菱形宽随直径放大后节点变稀，针固定 6 mm 时粗模板近四成的点接不上格架
    },
  };
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
