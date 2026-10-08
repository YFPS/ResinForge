/* 新界面的 UI 状态层：当前步骤、侧栏开合、进行中的任务、各步完成情况。
   模块级 store + useSyncExternalStore，顶栏 / 侧栏 / 命令面板共用同一份，
   这样从命令面板触发的操作也能让侧栏跳到对应步骤、让按钮显示进行中。 */
import { useSyncExternalStore } from 'react';
import { bus, state } from '../store.js';
import { pushToast } from './bridge.js';

/* ---------- 流程步骤 ---------- */

export const STEPS = [
  { id: 'model', label: '模型', title: '载入模型', desc: '打开 STL 文件，或先用演示模型试一试。' },
  { id: 'orient', label: '朝向', title: '优化朝向', desc: '找一个支撑更少、孤岛更少的摆放方向。可以跳过。' },
  { id: 'analyze', label: '分析', title: '逐层分析', desc: '逐层切片，找出孤岛和需要支撑的悬空。' },
  { id: 'support', label: '支撑', title: '生成支撑', desc: '先布置支撑点，再按选定的结构生成。' },
  { id: 'export', label: '导出', title: '导出 STL', desc: '选择底板，导出给切片软件。' },
];

export const stepIndex = id => STEPS.findIndex(s => s.id === id);

/* ---------- 通用小 store ---------- */

function createStore(initial) {
  let snap = initial;
  const subs = new Set();
  return {
    get: () => snap,
    set(patch) {
      const next = { ...snap, ...patch };
      if (Object.keys(next).every(k => next[k] === snap[k])) return;
      snap = next;
      subs.forEach(fn => fn());
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

const useStore = store => useSyncExternalStore(store.subscribe, store.get);

/* ---------- 界面：当前步骤 / 侧栏开合 / 进行中的任务 ---------- */

/* 窄屏（≤ 900px）侧栏是浮在画布上的抽屉，默认收起 */
const narrowMedia = window.matchMedia('(max-width: 900px)');
export const useNarrow = () => useSyncExternalStore(
  fn => { narrowMedia.addEventListener('change', fn); return () => narrowMedia.removeEventListener('change', fn); },
  () => narrowMedia.matches,
);

const ui = createStore({ step: 'model', sidebarOpen: !narrowMedia.matches, busy: '' });
export const useUI = () => useStore(ui);
export const getUI = ui.get;

/** 切到某一步；侧栏收起时顺带展开（点步骤就是想看这一步的参数） */
export function goStep(step) { ui.set({ step, sidebarOpen: true }); }
export function setSidebarOpen(open) { ui.set({ sidebarOpen: open }); }
export function toggleSidebar() { ui.set({ sidebarOpen: !ui.get().sidebarOpen }); }

/** 统一的任务执行：同一时间只跑一个长任务，按钮按 key 显示进行中，异常转成提示 */
export async function runTask(key, fn) {
  if (ui.get().busy) { pushToast('请稍候', '上一个任务还在进行'); return; }
  ui.set({ busy: key });
  try {
    await fn();
  } catch (err) {
    console.error(err);
    pushToast('执行失败', String(err && err.message ? err.message : err));
  } finally {
    ui.set({ busy: '' });
  }
}

/* ---------- 流程完成情况 ----------
   模型 / 分析 / 支撑直接读 core 的 state；朝向与导出没有对应状态，由操作层打标记。
   任何会让结果失效的事件（换模型、分析清空、支撑变化）都会重算一次。 */

const flags = { oriented: false, exported: false };

const readDone = () => ({
  model: !!state.mesh,
  orient: flags.oriented,
  analyze: !!state.analysis,
  support: (state.supportPoints || []).length > 0,
  export: flags.exported,
});

const done = createStore(readDone());
export const useDone = () => useStore(done);
const refresh = () => done.set(readDone());

bus.on('modelInfo', () => { flags.oriented = false; flags.exported = false; refresh(); });
bus.on('sliceStats', s => { if (!s) flags.exported = false; refresh(); });
bus.on('supStats', () => { flags.exported = false; refresh(); });
bus.on('orientResults', refresh);

export function markOriented() { flags.oriented = true; refresh(); }
export function markExported() { flags.exported = true; refresh(); }
