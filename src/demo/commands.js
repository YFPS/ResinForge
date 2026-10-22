/* 命令面板的命令清单。每条命令 { id, title, group, hint?, keywords?, icon, run() }。
   会产生结果的命令顺带把侧栏切到对应步骤，进度与结果就出现在用户眼前。 */
import React from 'react';
import {
  ArrowRight, Box, Compass, Download, Eraser, Flame, FolderOpen, FolderPlus, Grid3x3, Info, Layers, Moon, MousePointer2,
  Paintbrush, Palette, Plus, RefreshCw, ScanLine, ShieldAlert, Sparkles, Spline, Sun, SunMoon,
  Trash2, Minus, Crosshair,
} from 'lucide-react';
import { setMode, clearProtectedFaces } from '../core/scene.js';
import { setHeat } from '../core/heat.js';
import { pushToast } from './bridge.js';
import {
  DEMOS, doLoadDemo, doOrient, doAnalyze, doGenSupports, doRebuild, doClearSupports, doExport,
  doCycleSupView, pickSTL, setBaseType,
} from './actions.js';
import { state } from '../store.js';
import { STEPS, goStep, runTask } from './ui.js';
import { ACCENTS, THEME_MODES, setAccent, setThemeMode } from './theme.js';

const ic = Icon => React.createElement(Icon, { size: 16, strokeWidth: 1.75 });

/** ctx：{ setParam, heatOn, theme: { mode, accent } }，标题随当前状态变化 */
export function buildCommands(ctx) {
  const { setParam, heatOn, theme } = ctx;
  return [
    ...STEPS.map((s, i) => ({
      id: 'go-' + s.id,
      group: '前往步骤',
      title: `${i + 1} · ${s.title}`,
      hint: s.desc,
      keywords: [s.label],
      icon: ic(ArrowRight),
      run: () => goStep(s.id),
    })),

    { id: 'upload', group: '模型', title: '打开模型文件…', hint: 'STL、OBJ、3MF', keywords: ['上传', '载入', '多个', 'stl', 'obj', '3mf'], icon: ic(FolderOpen), run: () => pickSTL(false) },
    { id: 'upload-add', group: '模型', title: '追加模型文件…', hint: 'STL、OBJ、3MF，加到板上并自动排版', keywords: ['多个', '导入', 'stl', 'obj', '3mf'], icon: ic(FolderPlus), run: () => pickSTL(true) },
    ...DEMOS.map(d => ({
      id: 'demo-' + d.kind,
      group: '模型',
      title: `演示模型：${d.label}`,
      hint: d.hint,
      keywords: ['载入', 'demo'],
      icon: ic(Box),
      run: () => runTask('demo', () => doLoadDemo(d.kind)),
    })),

    { id: 'orient', group: '流程', title: '自动朝向优化', hint: '多目标评分选摆放方向', keywords: ['朝向'], icon: ic(Compass), run: () => { goStep('orient'); return runTask('orient', doOrient); } },
    { id: 'analyze', group: '流程', title: '运行逐层分析', hint: '孤岛与悬空统计', keywords: ['分析', '切片'], icon: ic(ScanLine), run: () => { goStep('analyze'); return runTask('analyze', doAnalyze); } },
    { id: 'sup-auto', group: '支撑', title: '生成支撑', hint: '清空后重新布点并生成', icon: ic(Sparkles), run: () => { goStep('support'); return runTask('sup-auto', () => doGenSupports()); } },
    { id: 'sup-isl', group: '支撑', title: '只补孤岛支撑', hint: '保留已有支撑点', icon: ic(ShieldAlert), run: () => { goStep('support'); return runTask('sup-isl', () => doGenSupports({ islandsOnly: true })); } },
    { id: 'sup-rebuild', group: '支撑', title: '按当前参数重建结构', icon: ic(RefreshCw), run: () => { goStep('support'); return runTask('sup-rebuild', doRebuild); } },
    { id: 'sup-clear', group: '支撑', title: '清空支撑', icon: ic(Trash2), run: doClearSupports },
    { id: 'sup-view', group: '支撑', title: `支撑显示：${state.supView === 'needle' ? '连接体' : state.supView === 'point' ? '接触点' : '全部'}`, hint: '快捷键 V 循环（全部 → 连接体 → 接触点）', icon: ic(Crosshair), run: () => { goStep('support'); doCycleSupView(); } },

    { id: 'vmode-orbit', group: '视口', title: '旋转视角', icon: ic(MousePointer2), run: () => setMode('orbit') },
    { id: 'vmode-paint', group: '视口', title: '涂画保护面', icon: ic(Paintbrush), run: () => { goStep('orient'); setMode('paint'); } },
    { id: 'vmode-add', group: '视口', title: '添加 / 拖动支撑', keywords: ['加支撑', '手动支撑', '加点', '拖针尖', '移动支撑'], icon: ic(Plus), run: () => { goStep('support'); setMode('add'); } },
    { id: 'vmode-del', group: '视口', title: '删除支撑', keywords: ['删支撑', '删点'], icon: ic(Minus), run: () => { goStep('support'); setMode('del'); } },
    { id: 'vmode-poly', group: '视口', title: '多线段加支撑', hint: '逐点画折线，双击或回车沿线布点', keywords: ['多线段', 'polyline'], icon: ic(Spline), run: () => { goStep('support'); setMode('poly'); } },
    { id: 'heat', group: '视口', title: heatOn ? '关闭支撑热力图' : '打开支撑热力图', icon: ic(Flame), run: () => setHeat(!heatOn) },
    { id: 'check-update', group: '视口', title: '检查更新', hint: '仅桌面版', keywords: ['升级', '版本', '更新'], icon: ic(RefreshCw), run: () => window.dispatchEvent(new Event('studio:check-update')) },

    { id: 'base-join', group: '导出', title: '底板：连接底板', hint: '塔底连成一条立板，模型随板抬高', icon: ic(Layers), run: () => runTask('base-type', () => setBaseType('join', setParam)) },
    { id: 'base-auto', group: '导出', title: '底板：自动底板', hint: '按支撑投影定尺寸，支撑从底板顶面往上生成', icon: ic(Grid3x3), run: () => runTask('base-type', () => setBaseType('auto', setParam)) },
    { id: 'export-all', group: '导出', title: '导出模型和支撑', hint: 'STL', icon: ic(Download), run: () => runTask('export', () => doExport(true)) },
    { id: 'export-sup', group: '导出', title: '仅导出支撑', hint: 'STL', icon: ic(Download), run: () => runTask('export', () => doExport(false)) },

    ...THEME_MODES.map(t => ({
      id: 'theme-' + t.value,
      group: '外观',
      title: `外观：${t.label}`,
      hint: theme.mode === t.value ? '当前' : undefined,
      keywords: ['主题', '深色', '浅色'],
      icon: ic(t.value === 'light' ? Sun : t.value === 'dark' ? Moon : SunMoon),
      run: () => setThemeMode(t.value),
    })),
    ...ACCENTS.map(a => ({
      id: 'accent-' + a.key,
      group: '外观',
      title: `强调色：${a.label}`,
      hint: theme.accent === a.key ? '当前' : undefined,
      keywords: ['颜色', '配色'],
      icon: ic(Palette),
      run: () => setAccent(a.key),
    })),

    {
      id: 'about', group: '其它', title: '关于 ResinForge', hint: '本地计算，不上传模型', icon: ic(Info),
      run: () => pushToast('ResinForge', '在浏览器里完成切片、朝向、支撑和 STL 导出，文件不会离开这台电脑。'),
    },
    { id: 'eraser-protect', group: '其它', title: '清除保护面', icon: ic(Eraser), run: clearProtectedFaces },
  ];
}
