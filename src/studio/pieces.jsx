import React from 'react';
import {
  Box, Check, FolderOpen, FolderPlus, Search, Shapes,
} from 'lucide-react';
import Button from '@/components/arc/button/button';
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
import { useBusLatest } from '../demo/bridge.js';
import { DEMOS, doLoadDemo, doSetSupView, focusModel, pickSTL, splitModelName } from '../demo/actions.js';
import { STEPS, runTask, useDone } from '../demo/ui.js';
import { NextButton } from '../demo/components/StepPanel.jsx';
import { switchThemeWithTransition, useTheme } from '../demo/theme.js';
import Simplifier from '../demo/components/Simplifier.jsx';
import {
  AddIcon, BoxesIcon, DelIcon, DotIcon, FrameIcon, GaugeIcon, MoveIcon,
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

/* 下方工具栏：一条 Dock。视口模式和变换工具共用一个选中态，变换是从坞里长出来的托盘。
   图标两态跟 icon-morph 一样由弹簧驱动：选中、托盘打开、热力图、简化面板各管各的。 */
export function ViewportDock() {
  const mode = useBusLatest('mode', 'orbit');
  const sel = useBusLatest('selection', { ids: [], tool: null });
  const heat = useBusLatest('heat', false);
  const supView = useBusLatest('supView', 'full');
  const tool = (sel && sel.tool) || null;
  const [simpOpen, setSimpOpen] = React.useState(false);
  const [tray, setTray] = React.useState(null);
  const [pulse, setPulse] = React.useState(0);
  const [live, setLive] = React.useState(false);
  React.useEffect(() => { setLive(true); }, []);
  const tip = { ...I, live };
  const dockValue = tool || mode;
  const view = supView || 'full';
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
    { id: 'add', label: '加支撑', icon: <AddIcon {...tip} state={dockValue === 'add'} /> },
    { id: 'del', label: '删支撑', icon: <DelIcon {...tip} state={dockValue === 'del'} /> },
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
    { id: 'simplify', label: '简化', icon: <ShrinkIcon {...I} state={simpOpen} /> },
    { id: 'heat', label: heat ? '关闭热力图' : '支撑热力图', icon: <GaugeIcon {...tip} state={!!heat} /> },
    { id: 'frame', label: '视角复位', icon: <FrameIcon {...I} pulse={pulse} /> },
  ];

  const onPick = id => {
    if (id === 'full' || id === 'needle' || id === 'point') { doSetSupView(id); return; }
    if (id === 'move' || id === 'rotate' || id === 'scale') { setTransformTool(id); return; }
    if (id === 'orbit' || id === 'paint' || id === 'add' || id === 'del') {
      if (tool && id !== 'orbit') setTransformTool(tool);
      setMode(id);
      return;
    }
    /* 简化外观演示打开时，底栏不再叠出原来的白卡片 */
    if (id === 'simplify') {
      if (document.documentElement.dataset.simpProto) return;
      setSimpOpen(open => !open);
      return;
    }
    if (id === 'heat') { setHeat(!heat); return; }
    if (id === 'frame') {
      setPulse(n => n + 1);
      frameParts(state.parts, { animate: true });
    }
  };

  return (
    <Popover open={simpOpen} onOpenChange={setSimpOpen}>
      <PopoverAnchor asChild>
        <div className="stuDockAnchor">
          <Dock
            label="视口工具"
            items={items}
            value={tool || mode}
            expandedId={simpOpen ? 'simplify' : null}
            onOpenChange={id => { setTray(id); if (id) setSimpOpen(false); }}
            onValueChange={onPick}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent className="stuPop" side="top" align="center" sideOffset={14}>
        <Simplifier compact />
      </PopoverContent>
    </Popover>
  );
}

/* 「下一步」独立浮在视口底栏工具坞右侧，参数面板底栏只留这一步的主操作。
   面板里那份由 NextSlotContext 关掉，所以强调口径要在这里重算一次（演示模型不算走完第一步）。 */
export function StageNext({ stage }) {
  const done = useDone();
  const info = useBusLatest('modelInfo', null);
  const { demo } = splitModelName(info && info.name);
  const emphasized = stage === 'model' ? done.model && !demo : !!done[stage];
  const next = STEPS[STEPS.findIndex(s => s.id === stage) + 1];
  if (!next) return null;
  return (
    <div className="stuNextCard">
      <NextButton from={stage} emphasized={emphasized} />
    </div>
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
