/* 集中操作层：顶栏 / 侧栏 / 命令面板共用同一套动作，避免各写一遍。
   每个动作只在 core 调用前后做最小的参数同步，重活留给 core。 */
import { params, state, bus, log, toast } from '../store.js';
import { isHeatOn, setHeat } from '../core/heat.js';
import { baseRaiseH, loadDemo, loadModelFiles, placeModelAtLift, raiseH, setActivePart, setSelection, simplifySelection, supportScopeIds, updateRaft } from '../core/model.js';
import { runOrient, applyCandidate } from '../core/orient.js';
import { runSliceAnalysis, shiftAnalysisY } from '../core/inspect.js';
import { runGenSup, rebuildStructure, clearSupports, setSupportView, syncModelLift } from '../core/support.js';
import { exportSTL } from '../core/stl.js';
import { clearFrame, rebuildFrame, resetFrameStack, scheduleFrameRebuild, setFrameVisible, stackFrameParts } from '../core/bboxView.js';
import { SUPPORT_TEMPLATES, getSupportTemplate, templateParams } from '../core/supportTemplates.js';
import { getUI, markOriented, markExported, runTask } from './ui.js';

export { setFrameVisible };

export const hasSupports = () => (state.supportPoints || []).length > 0;

export const DEMOS = [
  { kind: 'knot', label: '环面结', hint: '自交曲面' },
  { kind: 'mushroom', label: '蘑菇', hint: '伞盖悬垂' },
  { kind: 'tier', label: '双层平台', hint: '2mm 窄间隙' },
  { kind: 'statue', label: '悬臂雕像', hint: '悬臂与球顶' },
  { kind: 'cube', label: '正方体', hint: '平底整面悬空' },
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
  input.onchange = () => {
    const files = [...(input.files || [])];
    if (!files.length) return;
    loadModelFiles(files, { append: append === true });
  };
  input.click();
}

/** 点零件列表里的一件：选中它，镜头也跳过去。
 *  只跳镜头不改选中时，支撑按钮仍按上一件显示「重新生成」，一点就把多件当成一整盘重做。 */
export function focusModel(id) {
  setSelection([id]);
  setActivePart(id);
}

/** 简化选中的模型。mode 为 fidelity（保真度 1～10）或 ratio（留下的三角形比例 0.01～0.9999） */
export function doSimplify(opts) {
  return simplifySelection(opts);
}

/** 支撑显示三选一：'full' 全部 / 'needle' 仅连接体 / 'point' 仅接触点 */
export function doSetSupView(mode) {
  setSupportView(mode);
}

/** 循环切换支撑显示（全部 → 连接体 → 接触点 → 全部；快捷键 V / 命令面板） */
export function doCycleSupView() {
  const cur = state.supView || 'full';
  setSupportView(cur === 'full' ? 'needle' : cur === 'needle' ? 'point' : 'full');
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

/** 进支撑步骤时才把「模型抬高」用到模型上。此前底面贴平台。已抬过的不再重复抬。 */
export function engageSupportLift() {
  if (state.supportLiftOn || !state.mesh) return;
  const before = raiseH();
  state.supportLiftOn = true;
  const dy = raiseH() - before;
  placeModelAtLift();
  if (Math.abs(dy) < 1e-6) return;
  for (const p of state.supportPoints || []) {
    p.y += dy;
    if (p.ay !== undefined) p.ay += dy;
  }
  if (state.analysis) shiftAnalysisY(dy);
  log(`进入支撑：模型抬高 ${baseRaiseH()} mm`, 'ok');
}

/** 离开支撑时，还没添加支撑就把模型放回平台。已经有支撑点则保持抬高。 */
export function releaseSupportLift() {
  if (!state.supportLiftOn || !state.mesh) return;
  if ((state.supportPoints || []).length) return;
  const before = raiseH();
  state.supportLiftOn = false;
  const dy = raiseH() - before;
  placeModelAtLift();
  if (Math.abs(dy) < 1e-6) return;
  const settle = () => { if (state.analysis && !state.supportLiftOn) shiftAnalysisY(dy); };
  if (getUI().busy === 'analyze') {
    const off = bus.on('sliceStats', () => { off(); settle(); });
  } else settle();
  log('未添加支撑，模型回到平台', 'ok');
}

/** 进入支撑步骤：热力图直接打开；还没做逐层分析就自动跑完。
    已经有分析结果就不再算。没有模型时只记下热力图开关，不弹「请先载入模型」。
    板上有多件却一个都没选中时，不整盘分析和上色。 */
export function enterSupport() {
  engageSupportLift();
  const scope = supportScopeIds();
  if (scope && scope.size === 0) return;
  if (!isHeatOn()) setHeat(true);
  if (!state.mesh || state.analysis || getUI().busy) return;
  return runTask('analyze', () => runSliceAnalysis());
}

bus.on('enterSupport', () => { enterSupport(); });
/* 人已经在支撑这一步时又载入模型：新模型不能再贴回地板 */
bus.on('modelInfo', () => { if (getUI().step === 'support') engageSupportLift(); });
/* 离开支撑这一步：没加支撑就落回平台；热力图跟着收起。 */
bus.on('leaveSupport', () => {
  releaseSupportLift();
  if (isHeatOn()) setHeat(false);
});

/* 加支撑：只作用于当前选中的模型。没分析过就先跑完（正在分析就等它结束），然后打开热力图。
   进来看到的就是分析完成后的热力色，而不是只有角度、还没高差的一版。 */
bus.on('enterAddSupport', async () => {
  state.manualPartId = null;
  const scope = supportScopeIds();
  if (scope && scope.size === 0) { toast('先选中模型，再添加支撑'); return; }
  if (!state.mesh) return;
  if (!state.analysis) {
    if (getUI().busy && getUI().busy !== 'analyze') return;
    if (!getUI().busy) await runTask('analyze', () => runSliceAnalysis());
    else {
      while (!state.analysis && getUI().busy === 'analyze') {
        await new Promise(r => setTimeout(r, 40));
      }
    }
  }
  // 分析过程中已经退出加支撑的，不再把热力图打开
  if (state.mode === 'add' && state.analysis && !isHeatOn()) setHeat(true);
});
/* 多线段 / 删支撑：已有分析就用，不另外开关热力图。多模型没选中时不整盘分析。 */
bus.on('enterManual', () => {
  state.manualPartId = null;
  const scope = supportScopeIds();
  if (scope && scope.size === 0) {
    if (state.mode === 'poly') toast('先选中模型，再添加支撑');
    return;
  }
  if (!state.mesh || state.analysis || getUI().busy) return;
  return runTask('analyze', () => runSliceAnalysis());
});
/* 退出加支撑 / 多线段 / 删支撑：热力图只在支撑模式里看，离开就关掉。 */
bus.on('leaveManual', () => {
  state.manualPartId = null;
  if (isHeatOn()) setHeat(false);
  else bus.emit('syncTint');
});

export async function doGenSupports(opts = {}) {
  const scope = supportScopeIds();
  if (scope && scope.size === 0) { toast('先选中模型，再生成支撑'); return; }
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

export async function doExportFrame() {
  const ok = await exportSTL(false, false, 'bbox_frame.stl', true);
  if (ok) markExported();
}

export function doBuildFrame() {
  return rebuildFrame();
}

export function doClearFrame() {
  clearFrame(false);
}

export function doToggleFrame() {
  setFrameVisible(params.bfVisible === false);
}

/** 边框已经生成时，改参数就重算。还没生成则只记下参数，等用户点生成。 */
export function onFrameParam() {
  if (state.frame) scheduleFrameRebuild();
}

export function doStackModels() {
  return stackFrameParts();
}

export function doResetStack() {
  return resetFrameStack();
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

/** 底板类型二选一：连接底板（支撑塔底部锯齿收成一条立板，模型随板抬高一个板高）/ 自动底板（按支撑投影的蜂窝板，模型随板厚抬高，支撑从底板顶面往上生成）。
    两种切换都影响支撑结构（模型抬高 / 落点高度）——已有支撑时立刻重算，没有支撑时只同步模型抬高。 */
export function setBaseType(v, setParam) {
  const join = v === 'join';
  setParam('baseJoin', join);
  setParam('autoPlateOn', !join);
  if (hasSupports()) return rebuildStructure();
  return syncModelLift();
}

/* 拖板厚时数值会连着变：先把模型抬到新板厚（便宜），支撑等停稳再从底板顶面重算，避免每一步都重跑整座塔 */
let plateHTimer = 0;
export function onAutoPlateThickness() {
  updateRaft();
  const lift = syncModelLift();
  if (!hasSupports()) return lift;
  clearTimeout(plateHTimer);
  plateHTimer = setTimeout(() => { rebuildStructure(); }, 280);
  return lift;
}

export const currentBaseType = () => (params.autoPlateOn ? 'auto' : 'join');
