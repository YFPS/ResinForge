/* ================================================================
   全局存储：参数 / 状态 / 事件总线（框架无关，core 模块与 React 外壳共用）
   - params：全部工艺参数的单一事实来源（默认值与旧 index.html 的 input 默认值逐一对应）
   - state：对应旧 main.js 的 state 对象（另并入原模块级 faces——随几何重建的完整面数据）
   - bus：迷你 pub/sub，core 的 UI 副作用全部经此发事件，React 组件订阅渲染
================================================================ */

/* 打印工艺参数（世界系 = 打印系：平台顶面 y=0，模型底面抬高 raiseH） */
export const params = {
  /* 机器配置 */
  plateX: 150,        // 板面 X（mm）
  plateY: 175,        // 打印高度，切片坐标 Z（mm）。场景里仍是世界 Y
  plateZ: 85,         // 板面另一边，切片坐标 Y（mm）。场景里仍是世界 Z
  pixelUm: 24,        // XY 像素（µm）
  /* 朝向优化 */
  orientQuality: 64,  // 随机采样数（32/64/128）
  selfAngle: 45,      // 自支撑角（°）
  protW: 8,           // 保护面权重（x）
  /* 保护面笔刷 */
  brushR: 3,          // 笔刷半径（mm）
  /* 切片与孤岛分析 */
  layerH: 0.1,        // 层厚（mm）
  gapThresh: 0.35,    // 悬空阈值（mm）
  raiseH: 4,          // 模型抬高（mm）：支撑生成前模型底面离平台的默认高度
  minIslArea: 0.5,    // 孤岛最小面积（mm²）
  minAttach: 1,       // 最小附着面积（mm²）
  /* 支撑点 */
  spacing: 2.5,       // 支撑间距（mm；默认与细档一致：间距 = max(3.3 × 主干直径, 2.5 × (主干直径 + 0.4))，粗支撑要按直径放大）：等距环上的点距；环与环之间的行距为间距 × √3/2（相邻环错开半步，近似正六角）
  polySpacing: 2,     // 多线段接触点间距（mm）：沿画出的折线落点，不跟自动布点的支撑间距走
  edgeInset: 1.5,     // 边缘距离（mm）：支撑区域投影轮廓内缩这么多放第一圈（边缘环），边缘支撑离边处处一致
  minSupArea: 2,      // 最小悬空区域面积（mm²）
  shortSup: true,     // 短小支撑：竖直下方被模型挡住时允许锚到模型表面
  /* 支撑塔（格架塔；参数名原对齐 e-Stage 7.0 手册 Grid / Top connection / Foundation） */
  pen: 0.2,           // 渗透长度（Penetration length）：针尖沿针轴扎入模型的深度
  esCell: 3.5,        // 格宽（墙距；原无孔式格架的手册 Diamond width）
  esDiamAngle: 55,    // 斜边角（斜边仰角，不低于自支撑临界角；原手册 Diamond angle）
  esBarW: 0.6,        // 边宽（Edge width：斜边在墙面内的宽度）
  esBarT: 0.6,        // 边厚（Edge thickness：墙厚；默认与边宽相等，杆件截面为方形，不做扁板条）
  esMidBars: true,    // 墙内竖杆（墙上每半格一根竖杆）
  esGap: 1.2,         // 与模型最小间距（原「离模净距」；Margin to part：格架与模型保持的最小净距，针不受此限）
  smallScale: 0.8,    // 小支撑缩放比例（管短小支撑——十字短杆 / 分叉 / 贴面短连接的中段宽度 = 主干直径 × 该比例，方截面，端部仍收到接触宽；源自黑格表 bracketSupportScalingRatio 0.8。主支撑的针身不受它影响）
  esColRatio: 2,      // 柱高宽比（Column height to width ratio：展宽前柱内格数；手册推荐 7，但支撑只有十几毫米高，7 时第一级在 30 mm 以上，整座塔看不到分级，默认改为 2）
  esTowerMaxR: 4,     // 最大展宽（每侧格数：每下降一个柱高向四周展宽一格，最多展宽这么多格）
  esHullRed: 0,       // 壳层缩减等级（Hull reduction level：向下每柱高宽比个格允许格宽翻倍；0=底部全密，与「细」模板一致；中粗 / 粗模板为 1，底部稀）
  esConnW: 0.6,       // 连接宽（Connection width：十字针针身板宽 = 主干直径；界面由主干直径联动写入）
  esNeedleT: 0.6,     // 针板厚（十字针「+」截面板厚；与连接宽相等，针身截面为方形）
  esTipW: 0.3,        // 接触直径。开球头时就是球的直径；关掉球头时不另出圆球
  esTopD: 0.3,        // 顶端锥的上端直径（靠近模型的一头）
  esBotD: 0.6,        // 顶端锥的底部直径（靠近主干的一头）
  tipBall: true,      // 是否开启球头。关掉则针顶只有顶端那段锥，不加圆球
  esContactMargin: 0, // 接触边距（Contact margin：贴模型前保持接触宽的细直段长；0 = 针头为纯梯形，过渡段直接到接触点）
  esTaper: 1.5,       // 顶端长度（mm）：球头和下面针身之间那一截锥，默认 1.5。几何上即过渡段长
  esNeedleMax: 6,     // 针最大长度（格架节点到接触点）
  esFoundH: 1,        // 基础带最大高（Foundation → Maximum height）
  esNotchH: 0.5,      // 基础带最大缺口高（Foundation → Maximum notch height）
  baseJoin: true,     // 连接底板（底板类型二选一）：支撑塔底部的锯齿收成一条实心立板；选中时模型随板抬高（默认）
  baseChamfer: false, // 栅角：连接条贴台面的底角斜切一小截（高 0.6mm）
  baseFlush: true,    // 去掉外伸：交叉墙的底板收到外墙齐平，不再往外吐出（默认开）
  baseHole: true,     // 底板开孔：连接条上按格架打菱形孔，少用材料（默认开）
  /* 自动底板（底板类型二选一：形状跟随支撑投影的轮廓凸包、向外扩 apOffset；栅角 + 蜂窝孔；算法对照 3DPrintProject/3d 的底板生成器） */
  autoPlateOn: false, // 自动底板（与连接底板互斥；没有落板结构时不生成）
  apOffset: 2,        // 外扩距离（mm）：板轮廓超出支撑投影凸包的距离（圆角）
  apHeight: 1.3,      // 板厚（mm）
  apBorder: 2.5,      // 边框宽（mm）：孔区外圈的实心边
  apHoleR: 4,         // 蜂窝孔外接圆半径（mm；参考默认 8.66 是给 100mm 级大板配的，我们的板 30~60mm，调到 4）
  apWall: 1.5,        // 孔壁厚（mm）
  apChamfer: true,    // 栅角：底面向内收缩，侧壁成斜面
  apChamferAngle: 15, // 栅角角度（°）
  /* 导出 */
  unionExport: true,  // 导出前用 manifold-3d 把支撑各构件布尔并成一张水密外壳（消共面重复面与非流形边；仅导出时算，不进实时回路）
};

/* 应用状态（对应旧 main.js 的 state；faces 为原模块级变量——完整面数据 {nrm,area,cent}，随几何重建） */
export const state = {
  mesh: null,               // 合并后的模型 Mesh（各零件已写入世界 XZ，底部贴局部 y=0，mesh.position.y = raiseH）
  parts: [],                // 零件 {id,name,demo,geom,size,base,nf,ox,oy,oz,q,faceStart,protected}
  selectedIds: [],          // 视口选中的零件。单击、框选、Ctrl+A；Delete 删除这些模型。Ctrl+Z 撤回移动、旋转、缩放和删除
  transformTool: null,      // 单个模型右键：'move' 沿坐标轴移动 / 'rotate' 拖圆环旋转 / 'scale' 放大缩小 / null 不显示手柄
  activePartId: null,       // 朝向优化 / 当前操作的零件
  focusId: null,            // 摄影机对准的零件（多模型时画选框）
  // 支撑显示：'full' 全部支撑（格架 + 连接体 + 接触点）/ 'needle' 仅连接体（针与兜底件）/ 'point' 仅接触点（小球）
  supView: 'full',          // 快捷键 V 循环（黑格同款三视图）
  protectedFaces: new Set(),
  supports: [],             // 结构网格 {mesh, kind: 'ground'|'anchor'|'base'}
  supportPoints: [],        // 支撑点（可编辑数据）{x,y,z,n,island,manual,state}
  supportStats: null,       // 最近一次结构生成统计
  analysis: null,           // 详细分析结果
  orientResult: null,       // 当前最佳朝向候选
  mode: 'orbit',
  painting: false,
  faces: null,              // 原 main.js 模块级 `let faces`（完整法线面数据）
};

/* 迷你事件总线 */
const _handlers = new Map();
export const bus = {
  on(ev, fn) {
    let s = _handlers.get(ev);
    if (!s) _handlers.set(ev, s = new Set());
    s.add(fn);
    return () => s.delete(fn);
  },
  off(ev, fn) {
    const s = _handlers.get(ev);
    if (s) s.delete(fn);
  },
  emit(ev, payload) {
    const s = _handlers.get(ev);
    if (!s) return;
    for (const fn of [...s]) fn(payload);
  },
};

/* ---------- 旧基础工具的等价物：UI 副作用一律改发事件 ---------- */
export const nextFrame = () => new Promise(r => requestAnimationFrame(r));
export function log(msg, cls = '') { bus.emit('log', { msg, cls }); }
export function toast(msg) { bus.emit('toast', msg); }
export function setProgress(p, text) { bus.emit('progress', { p, text }); }   // p=null 隐藏进度条
