/* 命令面板的命令清单。每条命令 { id, title, group, hint?, keywords?, icon, run() }。
   会产生结果的命令顺带把侧栏切到对应步骤，进度与结果就出现在用户眼前。 */
import React from 'react';
import {
  ArrowRight, Box, Compass, Download, Eraser, Flame, FolderOpen, FolderPlus, Grid3x3, Info, Layers, Moon, MousePointer2,
  Paintbrush, PanelLeft, Palette, Plus, RefreshCw, ScanLine, ShieldAlert, Sparkles, Square, Sun, SunMoon,
  Trash2, TreePine, Building2, ExternalLink, Minus, TerminalSquare, Crosshair,
} from 'lucide-react';
import { setMode, clearProtectedFaces } from '../core/scene.js';
import { setHeat } from '../core/heat.js';
import { pushToast } from './bridge.js';
import {
  DEMOS, doLoadDemo, doOrient, doAnalyze, doGenSupports, doRebuild, doClearSupports, doExport,
  doOptimizeSupports, doTogglePoints, pickSTL, setSupMode, setShortKind, setBaseType,
} from './actions.js';
import { state } from '../store.js';
import { STEPS, goStep, runTask, toggleSidebar } from './ui.js';
import { ACCENTS, THEME_MODES, setAccent, setThemeMode } from './theme.js';

const ic = Icon => React.createElement(Icon, { size: 16, strokeWidth: 1.75 });

/** ctx：{ setParam, heatOn, sidebarOpen, theme: { mode, accent } }，标题随当前状态变化 */
export function buildCommands(ctx) {
  const { setParam, heatOn, sidebarOpen, theme } = ctx;
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
    { id: 'sup-opt', group: '支撑', title: '支撑优化', hint: '孤立底座加交叉两岸', icon: ic(Sparkles), run: () => { goStep('support'); return runTask('sup-opt', doOptimizeSupports); } },
    { id: 'sup-points', group: '支撑', title: state.viewPointsOnly ? '显示支撑结构' : '只显示支撑点', hint: '小球附着在模型上', icon: ic(Crosshair), run: () => { goStep('support'); doTogglePoints(!state.viewPointsOnly); } },
    { id: 'mode-tree', group: '支撑', title: '支撑结构：树状', icon: ic(TreePine), run: () => runTask('sup-mode', () => setSupMode('tree', setParam)) },
    { id: 'mode-tower', group: '支撑', title: '支撑结构：支撑塔', hint: 'e-Stage 菱形格架', icon: ic(Building2), run: () => runTask('sup-mode', () => setSupMode('tower', setParam)) },
    { id: 'short-tree', group: '支撑', title: '短小支撑：树状细尖', hint: '落在模型上的一端收细', icon: ic(TreePine), run: () => { goStep('support'); setParam('shortSup', true); return runTask('sup-short', () => setShortKind('tree', setParam)); } },
    { id: 'short-plate', group: '支撑', title: '短小支撑：支撑塔', hint: '单片竖板，两头细尖', icon: ic(Square), run: () => { goStep('support'); setParam('shortSup', true); return runTask('sup-short', () => setShortKind('tower', setParam)); } },

    { id: 'vmode-orbit', group: '视口', title: '旋转视角', icon: ic(MousePointer2), run: () => setMode('orbit') },
    { id: 'vmode-paint', group: '视口', title: '涂画保护面', icon: ic(Paintbrush), run: () => { goStep('orient'); setMode('paint'); } },
    { id: 'vmode-add', group: '视口', title: '手动加支撑点', icon: ic(Plus), run: () => { goStep('support'); setMode('add'); } },
    { id: 'vmode-del', group: '视口', title: '手动删支撑点', icon: ic(Minus), run: () => { goStep('support'); setMode('del'); } },
    { id: 'heat', group: '视口', title: heatOn ? '关闭支撑热力图' : '打开支撑热力图', icon: ic(Flame), run: () => setHeat(!heatOn) },
    { id: 'sidebar', group: '视口', title: sidebarOpen ? '收起侧栏' : '展开侧栏', icon: ic(PanelLeft), run: toggleSidebar },
    { id: 'log', group: '视口', title: '打开或收起运行日志', icon: ic(TerminalSquare), run: () => window.dispatchEvent(new Event('demo:toggle-log')) },

    { id: 'base-none', group: '导出', title: '底板：无', hint: '支撑直接落在平台', icon: ic(Square), run: () => setBaseType('none', setParam) },
    { id: 'base-raft', group: '导出', title: '底板：实心筏层', icon: ic(Layers), run: () => setBaseType('raft', setParam) },
    { id: 'base-grid', group: '导出', title: '底板：网格底板', icon: ic(Grid3x3), run: () => setBaseType('grid', setParam) },
    { id: 'export-all', group: '导出', title: '导出模型和支撑', hint: 'STL', icon: ic(Download), run: () => doExport(true) },
    { id: 'export-sup', group: '导出', title: '仅导出支撑', hint: 'STL', icon: ic(Download), run: () => doExport(false) },

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
    { id: 'legacy', group: '其它', title: '打开旧版界面', icon: ic(ExternalLink), run: () => { window.location.href = '/index.html'; } },
    { id: 'eraser-protect', group: '其它', title: '清除保护面', icon: ic(Eraser), run: clearProtectedFaces },
  ];
}
