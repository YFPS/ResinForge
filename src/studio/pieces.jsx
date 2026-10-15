import React from 'react';
import {
  Box, Check, CircleHelp, Donut, FolderOpen, FolderPlus, Layers, PersonStanding, Search, Shapes, Umbrella,
} from 'lucide-react';
import Button from '@/components/arc/button/button';
import { NumberField } from '@/components/arc/number-field/number-field';
import { Slider } from '@/components/arc/slider/slider';
import { Tooltip } from '@/components/arc/tooltip/tooltip';
import { DropdownMenu } from '@/components/arc/dropdown-menu/dropdown-menu';
import { Dock } from '@/components/arc/dock/dock';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/arc/popover/popover';
import { Progress } from '@/components/arc/progress/progress';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import { ThemeSwitch } from '@/components/arc/theme-switch/theme-switch';
import { state } from '../store.js';
import { setMode, frameParts } from '../core/scene.js';
import { setTransformTool } from '../core/manipulate.js';
import { setHeat } from '../core/heat.js';
import { useBusLatest, useParams } from '../demo/bridge.js';
import { DEMOS, doLoadDemo, doSetSupView, focusModel, pickSTL, splitModelName } from '../demo/actions.js';
import { STEPS, runTask, useDone } from '../demo/ui.js';
import { NextButton } from '../demo/components/StepPanel.jsx';
import { switchThemeWithTransition, useTheme } from '../demo/theme.js';
import Simplifier from '../demo/components/Simplifier.jsx';
import { Grid, Num, SwitchRow } from '../demo/components/fields.jsx';
import {
  AddIcon, BoxesIcon, DelIcon, DotIcon, FrameIcon, GaugeIcon, MoveIcon, PolyIcon,
  OrbitIcon, RotateIcon, ScaleIcon, ShrinkIcon, SplineIcon, WandIcon,
} from './toolIcons.jsx';
import { fmt1, fmtInt } from './kit.js';

export function OpenModelButton() {
  return (
    <Button variant="primary" size="sm" onClick={() => pickSTL(false)}>
      <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />
      打开模型文件
    </Button>
  );
}

export function ModelMenu() {
  const info = useBusLatest('modelInfo', null);
  const { name, demo } = splitModelName(info && info.name);
  return (
    <DropdownMenu
      label={name || '未载入模型'}
      icon={<Box size={15} strokeWidth={1.75} />}
      items={[
        { label: '打开模型文件…', icon: <FolderOpen size={16} strokeWidth={1.75} />, onSelect: () => pickSTL(false) },
        { label: '追加模型文件…', icon: <FolderPlus size={16} strokeWidth={1.75} />, onSelect: () => pickSTL(true) },
        ...DEMOS.map((d, i) => ({
          label: `演示：${d.label}`,
          icon: demo && d.label === name ? <Check size={16} strokeWidth={1.75} /> : <Shapes size={16} strokeWidth={1.75} />,
          separatorBefore: i === 0,
          onSelect: () => runTask('demo', () => doLoadDemo(d.kind)),
        })),
      ]}
    />
  );
}

export function ThemeBtn() {
  const { resolved } = useTheme();
  return (
    <ThemeSwitch
      theme={resolved}
      variant="rise"
      iconOnly
      label={resolved === 'dark' ? '切换到浅色外观' : '切换到深色外观'}
      onThemeChange={next => switchThemeWithTransition(next)}
    />
  );
}

export function SearchBtn({ onOpenPalette }) {
  return (
    <Button variant="secondary" size="sm" className="stuSearch" aria-label="打开命令面板" onClick={onOpenPalette}>
      <Search size={15} strokeWidth={1.75} aria-hidden="true" />
    </Button>
  );
}

/* 进度盖在底栏工具坞上，和这排图标同一个位置、同一块大小。 */
export function BottomProgress() {
  const progress = useBusLatest('progress', null);
  if (!progress || progress.p == null) return null;
  const pct = Math.round(progress.p * 100);
  return (
    <div className="stuDockProgress" role="status" aria-live="polite">
      <span className="stuDockProgressText">{progress.text || '处理中'}</span>
      <Progress className="stuDockProgressBar" value={pct} aria-label={progress.text || '处理中'} />
      <span className="stuDockProgressPct tnum">{pct}%</span>
    </div>
  );
}

const I = { size: 18, strokeWidth: 1.75 };

/* 四个演示模型各配一个形状对得上的图标：托盘里只露图标，名字在悬停提示里 */
const DEMO_ICONS = { knot: Donut, mushroom: Umbrella, platform: Layers, statue: PersonStanding };
const demoIcon = kind => {
  const Shape = DEMO_ICONS[kind] || Shapes;
  return <Shape {...I} />;
};

/* 保护面的开关与笔刷参数：参数卡里这一节和工具栏的保护面格重复，
   改挂在保护面格上方的浮层里（和简化条同一处，内容按当前打开的那一格切换）。 */
/* 多线段的接触点间距。选中多线段时浮在这一格上方。 */
function PolyGapIcon() {
  return (
    <svg className="polyGapIcon" viewBox="0 0 28 28" aria-hidden="true">
      <rect x="1" y="1" width="26" height="26" rx="6" fill="none" stroke="currentColor" strokeWidth="1.25" />
      {[8, 14, 20].map(x => (
        <g key={x}>
          <line x1={x} y1="19" x2={x} y2="11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx={x} cy="8.2" r="1.7" fill="#3ee06a" />
        </g>
      ))}
    </svg>
  );
}

function PolyGapPanel() {
  const [p, setParam] = useParams();
  const value = Math.min(10, Math.max(0.1, Number(p.polySpacing) || 2));
  const set = n => setParam('polySpacing', Math.round(Math.min(10, Math.max(0.1, Number(n) || 0)) * 10) / 10);
  return (
    <div className="polyGap">
      <PolyGapIcon />
      <span className="polyGapLabel">接触点间距</span>
      <div className="polyGapNum">
        <NumberField label="接触点间距" value={value} min={0.1} max={10} step={0.1} suffix="mm" size="sm" onValueChange={set} />
      </div>
      <div className="polyGapSlider">
        <Slider label="接触点间距" showValue={false} min={0.1} max={10} step={0.1} value={value} onValueChange={set} />
      </div>
      <Tooltip content="接触点之间的距离。数值越大，点与点隔得越开。">
        <button type="button" className="polyGapHelp" aria-label="接触点间距说明">
          <CircleHelp size={16} strokeWidth={1.75} />
        </button>
      </Tooltip>
    </div>
  );
}

function BrushPanel() {
  const mode = useBusLatest('mode', 'orbit');
  return (
    <div className="stuBrush">
      <SwitchRow
        label="涂画保护面"
        desc="在模型上按住拖动。涂过的面不长支撑，朝向评分也会避开它。"
        checked={mode === 'paint'}
        onChange={on => setMode(on ? 'paint' : 'orbit')}
      />
      <Grid>
        <Num k="brushR" label="笔刷半径" min={0.5} max={12} step={0.5} unit="mm" />
        <Num k="protW" label="评分权重" min={0} max={30} step={1} unit="×" />
      </Grid>
    </div>
  );
}

/* 下方工具栏：一条 Dock。视口模式和变换工具共用一个选中态，变换是从坞里长出来的托盘。
   图标两态跟 icon-morph 一样由弹簧驱动：选中、托盘打开、热力图、简化面板各管各的。 */
export function ViewportDock({ trailing }) {
  const mode = useBusLatest('mode', 'orbit');
  const sel = useBusLatest('selection', { ids: [], tool: null });
  const heat = useBusLatest('heat', false);
  const supView = useBusLatest('supView', 'full');
  const info = useBusLatest('modelInfo', null);
  /* 当前载入的正好是某个演示模型时，这一格显示它的图标、托盘里也点亮那一项 */
  const { name: modelName, demo: isDemo } = splitModelName(info && info.name);
  const demoKind = isDemo ? ((DEMOS.find(d => d.label === modelName) || {}).kind || null) : null;
  const tool = (sel && sel.tool) || null;
  /* 浮层同一时间只开一个：'simplify' 简化条，'brush' 保护面，'poly' 多线段接触点间距 */
  const [pop, setPop] = React.useState(null);
  /* 浮层要落在对应那一格正上方：量出这一格相对坞中心的偏移 */
  const [brushShift, setBrushShift] = React.useState(0);
  const [tray, setTray] = React.useState(null);
  const [pulse, setPulse] = React.useState(0);
  const [live, setLive] = React.useState(false);
  React.useEffect(() => { setLive(true); }, []);
  const tip = { ...I, live };
  const dockValue = tool || mode;
  const view = supView || 'full';
  const manualMode = mode === 'add' || mode === 'poly' || mode === 'del' ? mode : null;
  const manualIcon = manualMode === 'poly'
    ? <PolyIcon {...tip} state={tray === 'manual' || mode === 'poly'} />
    : manualMode === 'del'
      ? <DelIcon {...tip} state={tray === 'manual' || mode === 'del'} />
      : <AddIcon {...tip} state={tray === 'manual' || mode === 'add'} />;
  const displayIcon = view === 'needle'
    ? <SplineIcon {...tip} state={tray === 'supview'} />
    : view === 'point'
      ? <DotIcon {...tip} state={tray === 'supview'} />
      : <BoxesIcon {...tip} state={tray === 'supview'} />;
  const transformIcon = tool === 'rotate'
    ? <RotateIcon {...tip} state={tray === 'xform' || tool === 'rotate'} />
    : tool === 'scale'
      ? <ScaleIcon {...tip} state={tray === 'xform' || tool === 'scale'} />
      : <MoveIcon {...tip} state={tray === 'xform' || tool === 'move'} />;
  const items = [
    { id: 'orbit', label: '旋转视角', icon: <OrbitIcon {...tip} state={dockValue === 'orbit'} /> },
    { id: 'paint', label: '保护面', icon: <WandIcon {...tip} state={dockValue === 'paint'} /> },
    {
      id: 'manual',
      label: '手动支撑',
      active: manualMode || undefined,
      icon: manualIcon,
      items: [
        { id: 'add', label: '添加支撑', icon: <AddIcon {...tip} state={mode === 'add'} /> },
        { id: 'del', label: '删除支撑', icon: <DelIcon {...tip} state={mode === 'del'} /> },
        { id: 'poly', label: '多线段', icon: <PolyIcon {...tip} state={mode === 'poly'} /> },
      ],
    },
    {
      id: 'supview',
      label: '显示',
      active: view,
      icon: displayIcon,
      items: [
        { id: 'full', label: '全部支撑', icon: <BoxesIcon {...tip} state={view === 'full'} /> },
        { id: 'needle', label: '连接体', icon: <SplineIcon {...tip} state={view === 'needle'} /> },
        { id: 'point', label: '接触点', icon: <DotIcon {...tip} state={view === 'point'} /> },
      ],
    },
    {
      id: 'xform',
      label: '变换',
      icon: transformIcon,
      items: [
        { id: 'move', label: '移动', icon: <MoveIcon {...tip} state={tool === 'move'} /> },
        { id: 'rotate', label: '旋转', icon: <RotateIcon {...tip} state={tool === 'rotate'} /> },
        { id: 'scale', label: '缩放', icon: <ScaleIcon {...tip} state={tool === 'scale'} /> },
      ],
    },
    { id: 'simplify', label: '简化', icon: <ShrinkIcon {...I} state={pop === 'simplify'} /> },
    { id: 'heat', label: heat ? '关闭热力图' : '支撑热力图', icon: <GaugeIcon {...tip} state={!!heat} /> },
    { id: 'frame', label: '视角复位', icon: <FrameIcon {...I} pulse={pulse} /> },
    {
      id: 'demo',
      label: '演示模型',
      /* 不占工具栏的选中态：它不是工具，只是「载入哪个」的快捷入口 */
      active: demoKind ? `demo:${demoKind}` : undefined,
      icon: demoKind ? demoIcon(demoKind) : <Shapes {...I} />,
      items: DEMOS.map(d => ({ id: `demo:${d.kind}`, label: d.label, icon: demoIcon(d.kind) })),
    },
  ];

  /* 收起浮层：开的是笔刷浮层时一并退出保护面模式——浮层在，涂画模式就在 */
  const closePop = () => {
    if (pop === 'brush' || pop === 'poly') setMode('orbit');
    setPop(null);
  };

  /* 量出某一格相对坞中心的偏移，浮层落在这一格正上方。贴边时拉回视口内。 */
  const measureShift = (label, popW) => {
    const bar = document.querySelector('[role=toolbar]');
    const btn = bar && [...bar.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '').startsWith(label));
    if (!bar || !btn) return;
    const br = bar.getBoundingClientRect(), gr = btn.getBoundingClientRect();
    const half = popW / 2;
    const keep = Math.max(half + 12, Math.min(window.innerWidth - half - 12, gr.left + gr.width / 2));
    const next = keep - (br.left + br.width / 2);
    setBrushShift(prev => (Math.abs(prev - next) < 0.5 ? prev : next));
  };
  const measurePaintShift = () => measureShift('保护面', Math.min(window.innerWidth <= 860 ? 320 : 400, window.innerWidth - 24));
  const measurePolyShift = () => measureShift('手动支撑', Math.min(420, window.innerWidth - 24));

  /* 窗口尺寸变了，这一格的位置也跟着变 */
  React.useEffect(() => {
    if (pop !== 'brush' && pop !== 'poly') return undefined;
    const measure = pop === 'poly' ? measurePolyShift : measurePaintShift;
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [pop]);

  const onPick = id => {
    /* 托盘里的演示模型：点了就换模型，重复点当前这一个不做任何事 */
    if (id.startsWith('demo:')) {
      const kind = id.slice(5);
      if (kind !== demoKind) runTask('demo', () => doLoadDemo(kind));
      return;
    }
    if (id === 'full' || id === 'needle' || id === 'point') { doSetSupView(id); return; }
    if (id === 'move' || id === 'rotate' || id === 'scale') { setTransformTool(id); return; }
    /* 保护面：进模式的同时把笔刷设置摊在这一格上方，再点一次（或点别处）一起收起 */
    if (id === 'paint') {
      if (pop === 'brush') { closePop(); return; }
      if (tool) setTransformTool(tool);
      setMode('paint');
      measurePaintShift();
      setPop('brush');
      return;
    }
    if (id === 'poly') {
      if (pop === 'poly') { closePop(); return; }
      if (tool) setTransformTool(tool);
      setMode('poly');
      measurePolyShift();
      setPop('poly');
      return;
    }
    if (id === 'orbit' || id === 'add' || id === 'del') {
      if (tool && id !== 'orbit') setTransformTool(tool);
      setMode(id);
      if (pop) setPop(null);
      return;
    }
    /* 简化外观演示打开时，底栏不再叠出原来的白卡片 */
    if (id === 'simplify') {
      if (document.documentElement.dataset.simpProto) return;
      setPop(open => (open === 'simplify' ? null : 'simplify'));
      return;
    }
    if (id === 'heat') { setHeat(!heat); return; }
    if (id === 'frame') {
      setPulse(n => n + 1);
      frameParts(state.parts, { animate: true });
    }
  };

  return (
    <Popover open={!!pop} onOpenChange={open => { if (!open) closePop(); }}>
      <PopoverAnchor asChild>
        <div className="stuDockAnchor">
          <Dock
            label="视口工具"
            items={items}
            value={tool || mode}
            trailing={trailing}
            expandedId={pop === 'simplify' ? 'simplify' : pop === 'brush' ? 'paint' : pop === 'poly' ? 'manual' : null}
            onOpenChange={id => { setTray(id); if (id && pop) closePop(); }}
            onValueChange={onPick}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        className={'stuPop' + (pop === 'brush' ? ' stuPopBrush' : pop === 'poly' ? ' stuPopPoly' : '')}
        side="top"
        align="center"
        style={pop === 'brush' || pop === 'poly' ? { '--stu-brush-shift': `${brushShift}px` } : undefined}
        sideOffset={14}
        onOpenAutoFocus={event => { if (pop === 'poly') event.preventDefault(); }}
        onInteractOutside={event => { if (pop === 'poly') event.preventDefault(); }}
      >
        {pop === 'brush' ? <BrushPanel /> : pop === 'poly' ? <PolyGapPanel /> : <Simplifier compact />}
      </PopoverContent>
    </Popover>
  );
}

/* 「下一步」并进工具坞的尾巴上，参数面板底栏只留这一步的主操作。
   面板里那份由 NextSlotContext 关掉，所以强调口径要在这里重算一次（演示模型不算走完第一步）。 */
export function StageNext({ stage }) {
  const done = useDone();
  const info = useBusLatest('modelInfo', null);
  const { demo } = splitModelName(info && info.name);
  const emphasized = stage === 'model' ? done.model && !demo : !!done[stage];
  const next = STEPS[STEPS.findIndex(s => s.id === stage) + 1];
  if (!next) return null;
  return (
    <>
      <span className="stuDockSep" aria-hidden="true" />
      <NextButton from={stage} emphasized={emphasized} size="sm" />
    </>
  );
}

export function PartsCardBody() {
  const info = useBusLatest('modelInfo', null);
  const parts = (info && info.parts) || [];
  const sel = info && info.selectedIds && info.selectedIds.length ? info.selectedIds : (info ? [info.activeId] : []);
  return (
    <div className="stuPartsCard">
      {parts.length ? (
        /* 列表末端 24px 渐隐：滚到底后渐隐自动归零、完整显示最后一项（Arc ScrollArea 按溢出量计算） */
        <ScrollArea className="stuPartsScroll" viewportClassName="stuPartsViewport" fade={24}>
          <div className="stuParts" role="list" aria-label="已载入的模型">
            {parts.map(p => {
              const { name } = splitModelName(p.name);
              return (
                <button
                  key={p.id}
                  type="button"
                  role="listitem"
                  className={'stuPart' + (sel.includes(p.id) ? ' on' : '')}
                  onClick={() => focusModel(p.id)}
                  title={name}
                >
                  <Box size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span className="stuPartMain">
                    <span className="stuPartName">{name}</span>
                    <span className="stuPartMeta tnum">{fmtInt(p.nf)} 面 · {fmt1(p.sx)} × {fmt1(p.sz)} mm</span>
                  </span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      ) : (
        <p className="stuEmpty">还没有模型。把 STL / OBJ / 3MF 拖进窗口即可导入，顶栏也能打开文件。</p>
      )}
    </div>
  );
}

export function StagePill({ stage, onPick }) {
  const done = useDone();
  return (
    <div className="stuPill" role="tablist" aria-label="流程阶段">
      {STEPS.map((s, i) => (
        <button
          key={s.id}
          type="button"
          role="tab"
          aria-selected={stage === s.id}
          className={'stuPillBtn' + (stage === s.id ? ' on' : '')}
          onClick={() => onPick(s.id)}
        >
          <span className="stuPillMark" data-done={done[s.id] || undefined}>
            {done[s.id] ? <Check size={10} strokeWidth={3} /> : i + 1}
          </span>
          {s.label}
        </button>
      ))}
    </div>
  );
}
