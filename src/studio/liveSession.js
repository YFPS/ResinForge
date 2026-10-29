/* 已打开工程的现场。页签来回切时整盘摘下再挂上，支撑网格和镜头都留在内存里。
   从工程列表重新打开才走存档，那条路会重新分析和生成支撑，并重新取景。 */
import { params, state, bus, setProgress } from '../store.js';
import { setParam } from '../demo/bridge.js';
import { goStep } from '../demo/ui.js';
import { syncMachineSelection } from '../demo/machines.js';
import { isHeatOn } from '../core/heat.js';
import { exchangeHistory, discardHistoryStacks } from '../core/history.js';
import { exchangeOrient, publishOrientItems } from '../core/orient.js';
import { invalidateSlice, publishSliceStats, hideInspector, showInspector } from '../core/inspect.js';
import {
  detachSupportVisuals, attachSupportVisuals, discardSupportVisuals, updateSupStats,
} from '../core/support.js';
import { takeFrameVisual, putFrameVisual, discardFrameVisual } from '../core/bboxView.js';
import { takeCutLines, putCutLines } from '../core/cutLine.js';
import {
  displayPosePending, ensureBakedDisplay, emitModelInfo, syncActivePreview, syncPartTint,
  updateRaft, scheduleMeshBVH, putRaftMesh, takeRaftMesh,
} from '../core/model.js';
import { modelGroup, updateBuildVolume, frameParts, syncFocusRing, takeView, putView } from '../core/scene.js';

function clonePoint(p) {
  const n = p.n && typeof p.n.slice === 'function' ? p.n.slice() : p.n;
  return { ...p, n };
}

function restoreParams(saved) {
  if (!saved) return;
  for (const [k, v] of Object.entries(saved)) {
    if (!(k in params) || v == null || typeof v === 'object') continue;
    if (params[k] === v) continue;
    setParam(k, v);
  }
}

/** 把当前这一盘从场景摘下来。几何不释放，进行中的分析 / 重建作废。 */
export function parkLive() {
  const view = takeView();
  if (state.mesh && displayPosePending()) ensureBakedDisplay();
  invalidateSlice();
  setProgress(null);
  const supports = detachSupportVisuals();
  const raft = takeRaftMesh();
  const frame = takeFrameVisual();
  const cutLines = takeCutLines();   // 画线切割保留的线：线锚着这一盘的零件，跟着整盘摘下
  const history = exchangeHistory([], []);
  const orient = exchangeOrient(null);
  bus.emit('orientResults', null);

  const mesh = state.mesh;
  if (mesh && mesh.parent) mesh.parent.remove(mesh);
  state.mesh = null;

  const parts = state.parts;
  state.parts = [];
  const protectedFaces = state.protectedFaces;
  state.protectedFaces = new Set();
  const faces = state.faces;
  state.faces = null;
  const supportPoints = (state.supportPoints || []).map(clonePoint);
  state.supportPoints = [];
  const supportStats = state.supportStats;
  state.supportStats = null;
  const supportSel = state.supportSel instanceof Set ? state.supportSel : new Set();
  state.supportSel = new Set();
  const analysis = state.analysis;
  state.analysis = null;
  const joinLift = state.joinLift || 0;
  const supportLiftOn = !!state.supportLiftOn;
  state.joinLift = 0;
  state.supportLiftOn = false;
  const selectedIds = (state.selectedIds || []).slice();
  const activePartId = state.activePartId;
  const focusId = state.focusId;
  const transformTool = state.transformTool;
  const supView = state.supView || 'full';
  state.activePartId = null;
  state.focusId = null;
  state.selectedIds = [];
  state.transformTool = null;
  state.vertHeat = null;
  state.painting = false;
  state.manualPartId = null;
  const savedParams = { ...params };

  syncActivePreview();
  updateSupStats();
  hideInspector();
  bus.emit('sliceStats', null);
  emitModelInfo();
  bus.emit('lift');

  return {
    mesh, parts, faces, protectedFaces, supportPoints, supportStats, supportSel, supports,
    analysis, joinLift, supportLiftOn, selectedIds, activePartId, focusId, transformTool,
    supView, raft, frame, cutLines, history, orient, params: savedParams, view,
  };
}

/** 挂回先前摘下的一盘。调用前场上应是空的。 */
export function restoreLive(snap, extra) {
  const opt = extra || {};
  const empty = !snap;
  state.parts = empty ? [] : (snap.parts || []);
  state.protectedFaces = empty ? new Set() : (snap.protectedFaces || new Set());
  state.faces = empty ? null : (snap.faces || null);
  state.supportPoints = empty ? [] : (snap.supportPoints || []);
  state.supportStats = empty ? null : (snap.supportStats || null);
  state.supportSel = empty ? new Set() : (snap.supportSel || new Set());
  state.analysis = empty ? null : (snap.analysis || null);
  state.joinLift = empty ? 0 : (snap.joinLift || 0);
  state.supportLiftOn = empty ? false : !!snap.supportLiftOn;
  state.selectedIds = empty ? [] : (snap.selectedIds || []);
  state.activePartId = empty ? null : (snap.activePartId || null);
  state.focusId = empty ? null : (snap.focusId || null);
  state.transformTool = empty ? null : (snap.transformTool || null);
  state.supView = empty ? 'full' : (snap.supView || 'full');
  state.mesh = null;
  if (!empty && snap.mesh) {
    state.mesh = snap.mesh;
    if (!state.mesh.parent) modelGroup.add(state.mesh);
  }
  if (!empty) restoreParams(snap.params);
  syncMachineSelection(opt.machineId);
  updateBuildVolume();
  if (!empty && snap.raft) putRaftMesh(snap.raft);
  else updateRaft();
  putFrameVisual(empty ? null : snap.frame);
  putCutLines(empty ? null : snap.cutLines);
  if (!empty && snap.history) exchangeHistory(snap.history.undo, snap.history.redo);
  else exchangeHistory([], []);
  if (!empty) exchangeOrient(snap.orient);
  else exchangeOrient(null);
  attachSupportVisuals(empty ? [] : snap.supports);
  syncActivePreview();
  scheduleMeshBVH();
  /* 先落到这一盘自己的步骤，再发模型事件。人还停在上一盘的「支撑」时，
     模型事件会误把这一盘抬高。 */
  const step = opt.step || 'model';
  goStep(step);
  /* 这份现场记下过镜头就原样摆回。没有镜头（空场）才按零件重新取景。 */
  if (!empty && snap.view) putView(snap.view);
  else if (state.parts.length) frameParts(state.parts, { animate: false });
  syncFocusRing();
  emitModelInfo();
  publishSliceStats();
  bus.emit('selection', { ids: (state.selectedIds || []).slice(), tool: state.transformTool || null });
  bus.emit('lift');
  if (!isHeatOn()) syncPartTint();
  if (state.analysis && state.analysis.metrics) showInspector(state.analysis.metrics.layers, 1);
  else hideInspector();
  if (step === 'orient') publishOrientItems();
}

/** 关掉页签或从列表重新打开时，释放摘下来的几何。 */
export function discardLive(snap) {
  if (!snap) return;
  for (const p of snap.parts || []) if (p.geom && p.geom.dispose) p.geom.dispose();
  const mesh = snap.mesh;
  if (mesh) {
    if (mesh.parent) mesh.parent.remove(mesh);
    if (mesh.geometry) mesh.geometry.dispose();
  }
  discardSupportVisuals(snap.supports);
  const raft = snap.raft;
  if (raft) {
    if (raft.parent) raft.parent.remove(raft);
    if (raft.geometry) raft.geometry.dispose();
    if (raft.material && raft.material.dispose) raft.material.dispose();
  }
  discardFrameVisual(snap.frame);
  discardHistoryStacks(snap.history);
}
