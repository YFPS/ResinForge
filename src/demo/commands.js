/* 命令面板的命令清单。每条命令 { id, title, group, hint?, keywords?, icon, run() }。
   会产生结果的命令顺带把侧栏切到对应步骤，进度与结果就出现在用户眼前。 */
import React from 'react';
import {
  ArrowRight, Box, Compass, Download, Eraser, Flame, FolderOpen, FolderPlus, Frame, Grid3x3, Layers, MessageSquareWarning, Moon, MousePointer2,
  MousePointerClick, Paintbrush, Palette, Plus, RefreshCw, ScanLine, Scissors, ShieldAlert, Sparkles, Spline, Sun, SunMoon,
  Trash2, Minus, Crosshair, Copy,
} from 'lucide-react';
import { setMode, clearProtectedFaces, setOrthographic, isOrthographic } from '../core/scene.js';
import { setHeat } from '../core/heat.js';
import {
  DEMOS, doLoadDemo, doOrient, doAnalyze, doGenSupports, doRebuild, doClearSupports, doExport,
  doBuildFrame, doClearFrame, doExportFrame, doToggleFrame,
  doCycleSupView, pickSTL, setBaseType,
} from './actions.js';
import { state, toast } from '../store.js';
import { cloneParts, copySelectedParts, layoutAllParts, pasteParts } from '../core/model.js';
import { runCutLine, clearCutLines } from '../core/cutLine.js';
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

    { id: 'nest', group: '模型', title: '自动排版', hint: '按排版设置把板上的模型排紧', keywords: ['排版', '布局', '装箱', '间距', '边框'], icon: ic(Grid3x3), run: () => layoutAllParts() },
    { id: 'clone', group: '模型', title: '复制模型', hint: '阵列复制：2 列，间距 2 mm', keywords: ['复制', '阵列', '副本', 'clone'], icon: ic(Copy), run: () => cloneParts({ cols: 2, rows: 1, layers: 1, gap: 2 }) },
    { id: 'copy-parts', group: '模型', title: '复制选中模型', hint: 'Ctrl+C，再 Ctrl+V 贴到旁边', keywords: ['复制', '拷贝', 'copy', 'ctrl+c'], icon: ic(Copy), run: () => copySelectedParts() },
    { id: 'paste-parts', group: '模型', title: '粘贴模型', hint: 'Ctrl+V，贴在选中模型旁边', keywords: ['粘贴', 'paste', 'ctrl+v'], icon: ic(Copy), run: () => pasteParts() },
    { id: 'orient', group: '流程', title: '自动朝向优化', hint: '多目标评分选摆放方向', keywords: ['朝向'], icon: ic(Compass), run: () => { goStep('orient'); return runTask('orient', doOrient); } },
    { id: 'analyze', group: '流程', title: '运行逐层分析', hint: '孤岛与悬空统计', keywords: ['分析', '切片'], icon: ic(ScanLine), run: () => { goStep('analyze'); return runTask('analyze', doAnalyze); } },
    { id: 'sup-auto', group: '支撑', title: '生成支撑', hint: '只处理当前选中的模型。还没有支撑的新生成，已经有支撑的再点一次才重做', icon: ic(Sparkles), run: () => { goStep('support'); return runTask('sup-auto', () => doGenSupports()); } },
    { id: 'sup-isl', group: '支撑', title: '只补孤岛支撑', hint: '保留已有支撑点', icon: ic(ShieldAlert), run: () => { goStep('support'); return runTask('sup-isl', () => doGenSupports({ islandsOnly: true })); } },
    { id: 'sup-rebuild', group: '支撑', title: '按当前参数重建结构', icon: ic(RefreshCw), run: () => { goStep('support'); return runTask('sup-rebuild', doRebuild); } },
    { id: 'sup-clear', group: '支撑', title: '清空支撑', icon: ic(Trash2), run: doClearSupports },
    { id: 'sup-view', group: '支撑', title: `支撑显示：${state.supView === 'needle' ? '连接体' : state.supView === 'point' ? '接触点' : '全部'}`, hint: '快捷键 V 循环（全部 → 连接体 → 接触点）', icon: ic(Crosshair), run: () => { goStep('support'); doCycleSupView(); } },

    { id: 'vmode-orbit', group: '视口', title: '旋转视角', icon: ic(MousePointer2), run: () => setMode('orbit') },
    { id: 'vmode-ortho', group: '视口', title: isOrthographic() ? '回到透视视图' : '正交视图', hint: '没有近大远小', keywords: ['正交', 'ortho'], icon: ic(Box), run: () => setOrthographic(!isOrthographic()) },
    { id: 'vmode-paint', group: '视口', title: '涂画保护面', icon: ic(Paintbrush), run: () => { goStep('orient'); setMode('paint'); } },
    { id: 'vmode-lay', group: '视口', title: '按面放置：面朝下', hint: '点一个面，让它朝下、整件最低点落到平台。快捷键 F', keywords: ['朝向', '面朝下', '放置', '选择面', 'bps'], icon: ic(MousePointerClick), run: () => { setParam('layFace', 'down'); goStep('orient'); setMode('lay'); } },
    { id: 'vmode-lay-up', group: '视口', title: '按面放置：面朝上', hint: '点一个面，让它朝上、整件最低点落到平台', keywords: ['朝向', '面朝上', '放置', '选择面', 'bps'], icon: ic(MousePointerClick), run: () => { setParam('layFace', 'up'); goStep('orient'); setMode('lay'); } },
    {
      id: 'vmode-cut', group: '视口', title: '画线切割', hint: '在模型表面画一圈线，沿线切成两件，默认加梯形插销。快捷键 C',
      keywords: ['切割', '画线', '插销', '分割', '拆件', 'cut', 'partcraft'], icon: ic(Scissors),
      run: () => { if (!state.parts.length) { toast('先打开一个模型，再画线切割'); return; } setMode('cut'); },
    },
    { id: 'cut-run', group: '视口', title: '沿选中的切割线切割', hint: '把线锚着的模型沿这一圈切成两件', keywords: ['切割', '执行切割', '插销'], icon: ic(Scissors), run: () => runTask('cut', () => runCutLine()) },
    { id: 'cut-clear', group: '视口', title: '清除全部切割线', keywords: ['切割线', '画线', '清除'], icon: ic(Eraser), run: () => clearCutLines() },
    { id: 'vmode-add', group: '视口', title: '添加 / 拖动支撑', keywords: ['加支撑', '手动支撑', '加点', '拖针尖', '移动支撑'], icon: ic(Plus), run: () => { goStep('support'); setMode('add'); } },
    { id: 'vmode-del', group: '视口', title: '删除支撑', keywords: ['删支撑', '删点'], icon: ic(Minus), run: () => { goStep('support'); setMode('del'); } },
    { id: 'vmode-poly', group: '视口', title: '多线段加支撑', hint: '逐点画折线，双击或回车沿线布点', keywords: ['多线段', 'polyline'], icon: ic(Spline), run: () => { goStep('support'); setMode('poly'); } },
    { id: 'heat', group: '视口', title: heatOn ? '关闭支撑热力图' : '打开支撑热力图', icon: ic(Flame), run: () => setHeat(!heatOn) },


    { id: 'base-join', group: '导出', title: '底板：连接底板', hint: '塔底连成一条立板，模型随板抬高', icon: ic(Layers), run: () => runTask('base-type', () => setBaseType('join', setParam)) },
    { id: 'base-auto', group: '导出', title: '底板：自动底板', hint: '按支撑投影定尺寸，支撑从底板顶面往上生成', icon: ic(Grid3x3), run: () => runTask('base-type', () => setBaseType('auto', setParam)) },
    { id: 'frame-build', group: '边框', title: '生成包围盒边框', hint: '顶梁 + 角立柱', keywords: ['笼架', '边框'], icon: ic(Frame), run: () => { goStep('frame'); return runTask('frame', doBuildFrame); } },
    { id: 'frame-clear', group: '边框', title: '清除包围盒边框', icon: ic(Eraser), run: () => { goStep('frame'); doClearFrame(); } },
    { id: 'frame-toggle', group: '边框', title: '显示或隐藏边框', icon: ic(Frame), run: doToggleFrame },
    { id: 'export-all', group: '导出', title: '导出模型和支撑', hint: 'STL，含已生成的边框', icon: ic(Download), run: () => runTask('export', () => doExport(true)) },
    { id: 'export-sup', group: '导出', title: '仅导出支撑', hint: 'STL', icon: ic(Download), run: () => runTask('export', () => doExport(false)) },
    { id: 'export-frame', group: '导出', title: '仅导出边框', hint: 'STL', keywords: ['包围盒'], icon: ic(Download), run: () => runTask('export-frame', doExportFrame) },

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

    { id: 'feedback', group: '其它', title: '问题反馈', hint: '不上传模型', keywords: ['反馈', 'bug', '问题'], icon: ic(MessageSquareWarning), run: () => window.dispatchEvent(new Event('studio:open-feedback')) },
    { id: 'check-update', group: '其它', title: '检查更新', hint: '版本与最近更新日志', keywords: ['关于', '升级', '版本', '更新', '日志'], icon: ic(RefreshCw), run: () => window.dispatchEvent(new Event('studio:open-about')) },
    { id: 'eraser-protect', group: '其它', title: '清除保护面', icon: ic(Eraser), run: clearProtectedFaces },
  ];
}
