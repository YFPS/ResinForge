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
  plateZ: 85,         // 板面 Z（mm）
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
  raiseH: 4,          // 模型抬高（mm）
  minIslArea: 0.5,    // 孤岛最小面积（mm²）
  minAttach: 1,       // 最小附着面积（mm²）
  /* 支撑几何 */
  tipD: 0.3,          // 顶部球头直径（接触模型的球头）
  pen: 0.2,           // 球头嵌入深度（扎入模型表面）
  midD: 0.8,          // 中段直径（中部球头与主干）
  headLen: 0.7,       // 锥头长度（两球心距）
  headTopD: 0.3,      // 锥头顶宽（默认同顶部球头直径）
  headBotD: 0.8,      // 锥头底宽（默认同中段直径）
  baseD: 3,           // 底盘直径
  spacing: 3,         // 支撑间距
  minSupArea: 2,      // 最小悬空区域面积（mm²）
  shortSup: true,     // 短小支撑（锚定模型表面）
  /* gusset 加强筋板（e-Stage 风格：柱顶放射三角筋板连接主干 → 接触区） */
  gussetOn: true,     // 顶部放射筋板（所有支撑）
  gussetBase: true,   // 底部放射筋板替代锥底（仅落板支撑）
  gussetN: 4,         // 每端筋板数量（放射均布）
  gussetH: 2,         // 筋板高度（mm）
  gussetL: 1.5,       // 筋板外展长度（mm）
  gussetT: 0.4,       // 筋板厚度（mm）
  /* 支撑塔模式（e-Stage 块状格架单元：底座 + 四角主柱镂空晶格塔 + 顶部放射接触杆） */
  towerOn: false,     // 支撑塔模式开关（落板支撑聚类为格架塔，替代独立 pin）
  towerW: 6,          // 塔截面边长（mm，方形 W=D）
  towerPostR: 0.5,    // 角柱半径（mm）
  towerCellH: 4,      // 晶格层高（mm）
  rodR: 0.5,          // 接触杆底部半径（mm，尖径 = 顶部球头半径）
  baseT: 1,           // 底座高度（mm）
  /* 脚手架（菱形格架，参考 e-Stage 开放菱形 + TANGO V-Support 墙片） */
  scaffoldOn: true,   // 启用脚手架格架（相邻落板立柱间连续菱形格）
  crossD: 0.5,        // 格架梁直径（mm）
  crossStartH: 3,     // 格架起始高度（mm，相对平台）
  crossZStep: 5,      // 菱形格高度（mm）
  crossMaxXY: 8,      // 柱距上限（mm）
  /* 筏层 */
  raftOn: false,      // 实心筏层开关（厚 1.2mm，默认关闭）
  raftMargin: 3,      // 筏层边距（mm）
  /* 网格底板（e-Stage 风格多孔底板：X/Z 交叉梁格，树脂从孔中排出） */
  gridRaftOn: false,  // 网格底板开关（与实心筏层互斥）
  gridT: 0.8,         // 网格板厚度（mm）
  gridBar: 0.8,       // 网格梁宽（mm）
  gridStep: 3,        // 网格梁间距（mm，孔 = 间距 − 梁宽）
};

/* 应用状态（对应旧 main.js 的 state；faces 为原模块级变量——完整面数据 {nrm,area,cent}，随几何重建） */
export const state = {
  mesh: null,               // 模型 Mesh（非索引 geometry，底部贴 y=0）
  protectedFaces: new Set(),
  supports: [],             // {mesh,x,z,y}
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
