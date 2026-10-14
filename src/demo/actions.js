/* 集中操作层：顶栏 / 侧栏 / 命令面板共用同一套动作，避免各写一遍。
   每个动作只在 core 调用前后做最小的参数同步，重活留给 core。 */
import { params, state, log, toast } from '../store.js';
import { loadDemo, loadSTLBuffers, handleRaftOnChange, setActivePart, simplifySelection } from '../core/model.js';
import { runOrient, applyCandidate } from '../core/orient.js';
import { runSliceAnalysis } from '../core/inspect.js';
import { runGenSup, rebuildStructure, clearSupports, setPointsOnly, syncModelLift } from '../core/support.js';
import { exportSTL } from '../core/stl.js';
import { SUPPORT_TEMPLATES, getSupportTemplate, templateParams } from '../core/supportTemplates.js';
import { markOriented, markExported } from './ui.js';

export const hasSupports = () => (state.supportPoints || []).length > 0;

export const DEMOS = [
  { kind: 'knot', label: '环面结', hint: '自交曲面' },
  { kind: 'mushroom', label: '蘑菇', hint: '伞盖悬垂' },
  { kind: 'tier', label: '双层平台', hint: '2mm 窄间隙' },
  { kind: 'statue', label: '悬臂雕像', hint: '悬臂与球顶' },
];

/** core 给演示模型起的名字带「(演示)」后缀，界面上拆成名字 + 标记 */
export function splitModelName(name) {
  const m = /^(.*)\(演示\)$/.exec(name || '');
  return m ? { name: m[1], demo: true } : { name: name || '', demo: false };
}

export function doLoadDemo(kind) {
  return loadDemo(kind);
}

/** 打开系统文件选择器。可多选；append 为真时追加到板上并重新排版 */
export function pickSTL(append = false) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.stl,.obj,.3mf';
  input.multiple = true;
  input.onchange = async () => {
    const files = [...(input.files || [])];
    if (!files.length) return;
    const items = await Promise.all(files.map(async f => ({ buf: await f.arrayBuffer(), name: f.name })));
    loadSTLBuffers(items, { append: append === true });
  };
  input.click();
}

export function focusModel(id) {
  setActivePart(id);
}

/** 简化选中的模型。mode 为 fidelity（保真度 1～10）或 ratio（留下的三角形比例 0.01～0.9999） */
export function doSimplify(opts) {
  return simplifySelection(opts);
}

export function doTogglePoints(on) {
  setPointsOnly(on);
}

/** 当前生效的支撑模板 id：模板写入的全部键值都与 params 一致才算（数值容差 1e-6）；默认参数或手动改过任一项返回 null */
export function activeSupportTemplate(p = params) {
  for (const t of SUPPORT_TEMPLATES) {
    const ok = Object.entries(templateParams(t)).every(([k, v]) => (typeof v === 'number' ? Math.abs(p[k] - v) < 1e-6 : p[k] === v));
    if (ok) return t.id;
  }
  return null;
}

/** 套用支撑模板：写入模板的一组支撑塔参数。模型抬高（标准 4 mm）与临界角（标准 45°）不在模板里，保持当前值。
    有支撑时一律按新参数重新布点（保留手动加的点）再生成结构——与「重新生成」走同一条路（runGenSup），只多保留手动点。
    旧实现只在间距 / 边缘距离变了时才重新布点、否则只重建结构：布点还取决于主干直径（防粘连净距 = 主干直径 + 0.4），
    两者恰好没变时沿用旧粗细布的点、配上新粗细的结构（实测环面结：间距 3.4 / 边缘距离 0.5、主干 0.6 时生成，再套粗模板 181 点，重新生成 180 点） */
export function applySupportTemplate(id, setParam) {
  const tpl = getSupportTemplate(id);
  if (!tpl) return Promise.resolve();
  for (const [k, v] of Object.entries(templateParams(tpl))) setParam(k, v);
  log(`已套用「${tpl.name}」支撑模板（支撑杆直径 ${tpl.diameter} mm，支撑间距 ${tpl.spacing} mm，${tpl.source}；切片层厚请在分析步骤设置）`, 'ok');
  toast(`已套用「${tpl.name}」模板`);
  if (!hasSupports()) return syncModelLift();      // 板高随格宽 / 基础带高变：开着连接底板时模型跟着挪
  return doGenSupports({ keepManual: true });
}

export function doOrient() {
  return runOrient();
}

export async function doApplyCandidate(idx) {
  await applyCandidate(idx);
  markOriented();
}

export function doAnalyze() {
  return runSliceAnalysis();
}

/** 支撑依赖逐层分析：没分析过就先分析，一次点击走完，不再让人回头补一步 */
async function ensureAnalysis() {
  if (!state.analysis) await runSliceAnalysis();
  return !!state.analysis;
}

export async function doGenSupports(opts = {}) {
  await syncModelLift();                           // 先按连接底板挪好模型：没分析过时，下面的分析直接在新高度上做（不白算一遍）
  if (!(await ensureAnalysis())) return;
  await runGenSup(opts);
}

export async function doRebuild() {
  await syncModelLift();
  if (!(await ensureAnalysis())) return;
  await rebuildStructure();
}

export function doClearSupports() {
  clearSupports();
}

export async function doExport(includeModel) {
  // core 返回是否真的写出了文件（桌面版取消保存对话框、没有内容都算没导出）；只在写出时把这一步记为完成
  const ok = await exportSTL(includeModel, true, includeModel ? 'model_with_supports.stl' : 'supports_only.stl');
  if (ok) markExported();
}

/** 连接底板：支撑塔底部锯齿收成一条立板，模型同步抬高一个板高（joinPlate.js）。已有支撑时立刻重算；没有支撑也立刻挪模型 */
export function setBaseJoin(v, setParam) {
  setParam('baseJoin', !!v);
  if (hasSupports()) return rebuildStructure();
  return syncModelLift();
}

/** 底板开孔：连接条上打菱形孔。已有支撑时立刻重算。 */
export function setBaseHole(v, setParam) {
  setParam('baseHole', !!v);
  if (hasSupports()) return rebuildStructure();
  return Promise.resolve();
}

/** 去掉外伸：交叉墙底板收到外墙齐平。已有支撑时立刻重算。 */
export function setBaseFlush(v, setParam) {
  setParam('baseFlush', !!v);
  if (hasSupports()) return rebuildStructure();
  return Promise.resolve();
}

/** 栅角：连接条两端按格架角度斜切。已有支撑时立刻重算。 */
export function setBaseChamfer(v, setParam) {
  setParam('baseChamfer', !!v);
  if (hasSupports()) return rebuildStructure();
  return Promise.resolve();
}

/** 底板三态（互斥）；变更后提示重新生成支撑 */
export function setBaseType(v, setParam) {
  setParam('raftOn', v === 'raft');
  setParam('gridRaftOn', v === 'grid');
  handleRaftOnChange();
}

export const currentBaseType = () => (params.gridRaftOn ? 'grid' : params.raftOn ? 'raft' : 'none');
