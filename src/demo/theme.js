/* 外观主题：浅色 / 深色 / 跟随系统 + 强调色。
   UI 走 `:root[data-theme]`（Arc 的 foundation.css 按此切换全套 token）；
   3D 场景背景与模型材质不读 CSS，这里按主题给两套值同步过去。
   主题是「环境配置」，与机器参数一样持久化到 localStorage。
   侧栏底部的 Arc ThemeSwitch 与命令面板共用这里的 store，任一处切换另一处同步。 */
import { useSyncExternalStore } from 'react';
import { scene, prevScene, modelMat, updateBuildVolume } from '../core/scene.js';
import { syncHeatMaterial } from '../core/heat.js';
import { syncPartTint } from '../core/model.js';

const THEME_KEY = 'resinforge:theme';
const ACCENT_KEY = 'resinforge:accent';

export const ACCENTS = [
  { key: 'neutral', label: '中性' },
  { key: 'violet', label: '紫' },
  { key: 'blue', label: '蓝' },
  { key: 'green', label: '绿' },
  { key: 'amber', label: '琥珀' },
  { key: 'orange', label: '橙' },
  { key: 'coral', label: '珊瑚' },
  { key: 'rose', label: '玫瑰' },
];

export const THEME_MODES = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

const media = window.matchMedia('(prefers-color-scheme: dark)');

function loadThemeMode() {
  try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; }
}

function loadAccent() {
  try { return localStorage.getItem(ACCENT_KEY) || 'neutral'; } catch { return 'neutral'; }
}

const resolveTheme = mode => (mode === 'system' ? (media.matches ? 'dark' : 'light') : mode);

/* three.js 不读 CSS 变量：深色下视口近黑、模型浅灰；浅色下视口浅灰、模型压深一档保持对比 */
const SCENE_COLORS = {
  dark: { bg: 0x101012, model: 0xa7b0bd },
  light: { bg: 0xe6e7ea, model: 0x717b88 },
};

function paint(resolved) {
  document.documentElement.setAttribute('data-theme', resolved);
  const c = SCENE_COLORS[resolved] || SCENE_COLORS.dark;
  scene.background.set(c.bg);
  if (scene.fog) scene.fog.color.set(c.bg);
  prevScene.background.set(c.bg);
  modelMat.color.set(c.model);
  updateBuildVolume();
  syncHeatMaterial();
  syncPartTint();
}

/* ---------- store ---------- */

let snap = { mode: loadThemeMode(), resolved: 'dark', accent: loadAccent() };
snap.resolved = resolveTheme(snap.mode);
const subs = new Set();
const set = patch => { snap = { ...snap, ...patch }; subs.forEach(fn => fn()); };

export const useTheme = () => useSyncExternalStore(fn => { subs.add(fn); return () => subs.delete(fn); }, () => snap);

/** 首帧前调用一次（demo/main.jsx），让 DOM 与 3D 场景按存储值就位 */
export function initTheme() {
  paint(snap.resolved);
  document.documentElement.setAttribute('data-accent', snap.accent);
}

/** 跟随系统时，系统深浅色切换要即时响应 */
media.addEventListener('change', () => {
  if (snap.mode !== 'system') return;
  const resolved = resolveTheme('system');
  paint(resolved);
  set({ resolved });
});

export function setThemeMode(mode) {
  const resolved = resolveTheme(mode);
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* 隐私模式：静默降级 */ }
  paint(resolved);
  set({ mode, resolved });
}

export function setAccent(key) {
  document.documentElement.setAttribute('data-accent', key);
  try { localStorage.setItem(ACCENT_KEY, key); } catch { /* 同上 */ }
  set({ accent: key });
}

/** 侧栏 ThemeSwitch 的页面过渡（rise：新外观自下而上升起）。
    减弱动效或浏览器不支持 View Transitions 时直接切换。 */
export function switchThemeWithTransition(next) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !document.startViewTransition) { setThemeMode(next); return; }
  document.documentElement.dataset.themeTransition = 'rise';
  const t = document.startViewTransition(() => setThemeMode(next));
  t.finished.finally(() => { delete document.documentElement.dataset.themeTransition; });
}
