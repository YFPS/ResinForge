/* 集中操作层：顶栏 / 侧栏 / 命令面板共用同一套动作，避免各写一遍。
   每个动作只在 core 调用前后做最小的参数同步，重活留给 core。 */
import { params, state } from '../store.js';
import { loadDemo, loadSTLBuffer, handleRaftOnChange } from '../core/model.js';
import { runOrient, applyCandidate } from '../core/orient.js';
import { runSliceAnalysis } from '../core/inspect.js';
import { runGenSup, rebuildStructure, clearSupports } from '../core/support.js';
import { exportSTL } from '../core/stl.js';
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

/** 打开系统文件选择器载入 STL（拖放由 core 在 window 上统一处理） */
export function pickSTL() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.stl';
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    loadSTLBuffer(await f.arrayBuffer(), f.name);
  };
  input.click();
}

/** 切换结构模式：已有支撑点时立即重建结构（同旧 SupportCard 行为） */
export function setSupMode(v, setParam) {
  setParam('supMode', v);
  if (hasSupports()) return rebuildStructure();
  return Promise.resolve();
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
  if (!(await ensureAnalysis())) return;
  await runGenSup(opts);
}

export async function doRebuild() {
  if (!(await ensureAnalysis())) return;
  await rebuildStructure();
}

export function doClearSupports() {
  clearSupports();
}

export function doExport(includeModel) {
  // 没有可导出的内容时 core 会自己提示；这里只在真的写出了文件时才把导出这一步记为完成
  const empty = !state.mesh || (!includeModel && !hasSupports() && currentBaseType() === 'none');
  exportSTL(includeModel, true, includeModel ? 'model_with_supports.stl' : 'supports_only.stl');
  if (!empty) markExported();
}

/** 底板三态（互斥）；变更后提示重新生成支撑 */
export function setBaseType(v, setParam) {
  setParam('raftOn', v === 'raft');
  setParam('gridRaftOn', v === 'grid');
  handleRaftOnChange();
}

export const currentBaseType = () => (params.gridRaftOn ? 'grid' : params.raftOn ? 'raft' : 'none');
