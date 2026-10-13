/* ================================================================
   全局存储：参数 / 状态 / 事件总线（框架无关，core 模块与 React 外壳共用）
   - params：全部工艺参数的单一事实来源（默认值与旧 index.html 的 input 默认值逐一对应）
   - state：对应旧 main.js 的 state 对象（另并入原模块级 faces——随几何重建的完整面数据）
   - bus：迷你 pub/sub，core 的 UI 副作用全部经此发事件，React 组件订阅渲染
================================================================ */

/* 打印工艺参数（世界系 = 打印系：平台顶面 y=0，模型底面抬高 raiseH，筏层厚 RAFT_T=1.2） */
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
  supOptimize: true,  // 支撑优化：底板没连上的单个支撑，用交叉两岸（剪刀撑）接到邻近支撑
  minIslArea: 0.5,    // 孤岛最小面积（mm²）
  minAttach: 1,       // 最小附着面积（mm²）
  /* 支撑点（两种结构共用） */
  spacing: 2.5,       // 支撑间距（mm；默认与细档一致：间距 = max(3.3 × 主干直径, 2.5 × (主干直径 + 0.4))，粗支撑要按直径放大）：等距环上的点距；环与环之间的行距为间距 × √3/2（相邻环错开半步，近似正六角）
  edgeInset: 1.5,     // 边缘距离（mm）：支撑区域投影轮廓内缩这么多放第一圈（边缘环），边缘支撑离边处处一致
  minSupArea: 2,      // 最小悬空区域面积（mm²）
  shortSup: true,     // 短小支撑：竖直下方被模型挡住时允许锚到模型表面
  shortKind: 'tree',  // 短小支撑样式：'tree' 树状细尖 / 'tower' 支撑塔模式为十字贴面短连接（两端收到接触宽），树状模式为单片桥板
  supMode: 'tree',    // 支撑结构：'tree' 树状（PrusaSlicer branching）/ 'tower' 支撑塔（Materialise e-Stage 菱形格架）
  tipMode: 'normal',  // 接触朝向：'normal' 沿法线（钳制到接触最大倾角）/ 'vertical' 竖直 / 'fixed' 固定倾角（沿法线方位）
  tipTilt: 45,        // 接触最大倾角（°，接触端与竖直方向夹角；针身 / 分支仍受自支撑角约束）
  /* 树状支撑（PrusaSlicer branching tree，默认值取 PrusaSlicer branchingsupport_*） */
  tipD: 0.4,          // 前端球直径（head_front_diameter，接触模型）
  pen: 0.2,           // 嵌入深度（head_penetration）
  headLen: 1.0,       // 支撑头长度（前后球心距 = r_pin + head_width + r_back）
  midD: 0.6,          // 分支起始直径（pillar_diameter，后端球 / 叶分支）
  anchorD: 0.6,       // 锚点直径：落在模型表面的接触端（锚定支撑头肩部 / 短锚细颈）直径，独立于分支直径
  maxBranchD: 2.0,    // 分支最大直径（负载加粗上限）
  widening: 0.5,      // 加宽系数（pillar_widening_factor：分支半径随负载线性增长的斜率）
  baseD: 3,           // 底座直径（base_diameter）
  baseH: 1,           // 底座高度（base_height）
  maxBridgeLen: 5,    // 最大桥接长度（落地避让斜段上限，max_bridge_length）
  maxBranchLen: 10,   // 最大分支长度（合并距离 / 单段下行上限，max_pillar_link_distance）
  maxWeightOnModel: 10, // 模型上支撑最大负载（max_weight_on_model：分支累计长度超过则不锚到模型）
  /* 支撑塔（Materialise e-Stage 菱形格架；参数名对齐 e-Stage 7.0 手册 Grid / Top connection / Foundation） */
  esCell: 3.5,        // 菱形宽（Diamond width：格架最小菱形宽 = 墙距）
  esDiamAngle: 55,    // 菱形角（Diamond angle：菱形斜边仰角，不低于自支撑临界角）
  esBarW: 0.6,        // 边宽（Edge width：菱形边在墙面内的宽度）
  esBarT: 0.6,        // 边厚（Edge thickness：墙厚；默认与边宽相等，杆件截面为方形，不做扁板条）
  esMidBars: true,    // 菱形竖直对角线（墙上每半格一根竖杆，专利「vertical diagonal」）
  esGap: 1.2,         // 离模净距（Margin to part：格架与模型保持的最小净距，针不受此限）
  esColRatio: 2,      // 柱高宽比（Column height to width ratio：展宽前柱内菱形数；手册推荐 7，但支撑只有十几毫米高，7 时第一级在 30 mm 以上，整座塔看不到分级，默认改为 2）
  esTowerMaxR: 4,     // 最大展宽（每侧格数：每下降一个柱高向四周展宽一格，最多展宽这么多格）
  esHullRed: 0,       // 壳层缩减等级（Hull reduction level：向下每柱高宽比个菱形允许菱形宽翻倍；0=底部全密，与「细」模板一致；中粗 / 粗模板为 1，底部稀）
  esConnW: 0.6,       // 连接宽（Connection width：十字针针身板宽；默认同边宽，竖直针即格架竖杆的延伸）
  esNeedleT: 0.6,     // 针板厚（十字针「+」截面板厚；默认与连接宽相等，针身截面为方形）
  esTipW: 0.3,        // 接触宽（Contact width：针尖接触模型处的宽度）
  esContactMargin: 0, // 接触边距（Contact margin：贴模型前保持接触宽的细直段长；0 = 针头为纯梯形，过渡段直接到接触点）
  esTaper: 1.5,       // 过渡段长（连接宽 → 接触宽 的渐缩长度；与黑格连接体长度一致，PAP10 / PAU10 / PARP10 / PAWR10 全部为 1.5 mm）
  esNeedleMax: 6,     // 针最大长度（格架节点到接触点）
  esFallback: 'tree', // 连不上格架的点：'tree' 树状兜底（默认，按短小支撑样式生成，会与格架混在一起，避免留下悬空）/ 'none' 标红不生成（这些点没有支撑，只适合纯塔调试）
  esShortKind: 'tower', // 支撑塔模式的短小支撑样式（先于树状兜底）：'tower' 十字短杆（默认，两端收到接触宽，接到下方表面或平台）/ 'tree' 不用十字短杆、直接交给树状兜底
  esFoundH: 1,        // 基础带最大高（Foundation → Maximum height）
  esNotchH: 0.5,      // 基础带最大缺口高（Foundation → Maximum notch height）
  baseJoin: true,     // 连接底板：支撑塔底部的锯齿收成一条实心立板（默认开）
  baseChamfer: false, // 栅角：连接条贴台面的底角斜切一小截（高 0.6mm）
  baseFlush: true,    // 去掉外伸：交叉墙的底板收到外墙齐平，不再往外吐出（默认开）
  baseHole: true,     // 底板开孔：连接条上按格架打菱形孔，少用材料（默认开）
  /* 筏层 */
  raftOn: false,      // 实心筏层开关（厚 1.2mm，默认关闭）
  raftMargin: 3,      // 筏层边距（mm）
  /* 网格底板（e-Stage 风格多孔底板：X/Z 交叉梁格，树脂从孔中排出） */
  gridRaftOn: false,  // 网格底板开关（与实心筏层互斥）
  gridT: 0.8,         // 网格板厚度（mm）
  gridBar: 0.8,       // 网格梁宽（mm）
  gridStep: 3,        // 网格梁间距（mm，孔 = 间距 − 梁宽）
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
  viewPointsOnly: false,    // 隐藏支撑结构，只显示附着在模型上的球形支撑点
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
