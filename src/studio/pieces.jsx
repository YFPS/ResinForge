import React from 'react';
import {
  Box, Check, CircleHelp, Copy, Donut, Eye, EyeOff, FolderOpen, Layers, LayoutGrid, Library, MousePointerClick, Pencil, PersonStanding, Save, Scissors, Search, Shapes, Trash2, Umbrella,
} from 'lucide-react';
import Button from '@/components/arc/button/button';
import { NumberField } from '@/components/arc/number-field/number-field';

import { Tooltip } from '@/components/arc/tooltip/tooltip';
import { Dock } from '@/components/arc/dock/dock';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/arc/popover/popover';
import { Progress } from '@/components/arc/progress/progress';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import { ThemeSwitch } from '@/components/arc/theme-switch/theme-switch';
import { RippleLoader } from '../demo/components/TitleBar.jsx';
import { state, toast } from '../store.js';
import { setMode, frameParts } from '../core/scene.js';
import { runCutLine, selectCutLine, setCutLineVisible, editCutLine, removeCutLine, CUT_FLAT_TOL } from '../core/cutLine.js';
import { clearClonePreview, cloneParts, layoutAllParts, showClonePreview } from '../core/model.js';
import { setTransformTool } from '../core/manipulate.js';
import { setHeat } from '../core/heat.js';
import { useBusLatest, useParams } from '../demo/bridge.js';
import { DEMOS, doLoadDemo, doSetSupView, focusModel, pickSTL, splitModelName } from '../demo/actions.js';
import { STEPS, runTask, useDone } from '../demo/ui.js';
import { NextButton } from '../demo/components/StepPanel.jsx';
import { switchThemeWithTransition, useTheme } from '../demo/theme.js';
import Simplifier from '../demo/components/Simplifier.jsx';
import { Switch } from '@/components/arc/switch/switch';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import {
  AddIcon, BoxesIcon, DelIcon, DotIcon, FrameIcon, GaugeIcon, MoveIcon, PolyIcon,
  OrbitIcon, RotateIcon, ScaleIcon, ShrinkIcon, SplineIcon, WandIcon,
} from './toolIcons.jsx';
import { fmt1, fmtInt } from './kit.js';
import { saveCurrentProject } from './desk.jsx';

/* 底栏上方留给工具提示的空：提示距栏顶 8px，提示本身约 28px，再留 8px 缝。
   缩放 / 旋转面板和简化浮层都按这个高度让开，提示才不会被切掉。 */
const DOCK_TIP_BAND = 44;

export function SaveProjectButton() {
  return (
    <Button variant="primary" size="sm" className="stuSaveBtn" onClick={() => saveCurrentProject().catch(() => {})}>
      <Save size={16} strokeWidth={1.75} aria-hidden="true" />
      保存
    </Button>
  );
}

export function OpenModelButton() {
  return (
    <Button variant="primary" size="sm" onClick={() => pickSTL(false)}>
      <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />
      打开模型文件
    </Button>
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
      <RippleLoader />
      <Progress className="stuDockProgressBar" value={pct} aria-label={progress.text || '处理中'} />
      <span className="stuDockProgressPct tnum">{pct}%</span>
    </div>
  );
}

const I = { size: 18, strokeWidth: 1.75 };

/* 演示模型各配一个形状对得上的图标：托盘里只露图标，名字在悬停提示里 */
const DEMO_ICONS = { knot: Donut, mushroom: Umbrella, platform: Layers, statue: PersonStanding, cube: Box };
const demoIcon = kind => {
  const Shape = DEMO_ICONS[kind] || Shapes;
  return <Shape {...I} />;
};

/* 保护面的开关与笔刷参数：参数卡里这一节和工具栏的保护面格重复，
   改挂在保护面格上方的浮层里（和简化条同一处，内容按当前打开的那一格切换）。 */
/* 多线段的接触点间距。和保护面同一套横条，居中放在底栏上方。 */
function PolyGapPanel() {
  const [p, setParam] = useParams();
  const value = Math.min(10, Math.max(0.1, Number(p.polySpacing) || 2));
  const set = n => setParam('polySpacing', Math.round(Math.min(10, Math.max(0.1, Number(n) || 0)) * 10) / 10);
  return (
    <div className="stuBrush stuBrushPoly">
      <span className="stuBrushBrand">接触点间距</span>
      <span className="stuBrushSep" aria-hidden="true" />
      <span className="stuBrushLabel">间距</span>
      <div className="stuBrushNum">
        <NumberField label="接触点间距" value={value} min={0.1} max={10} step={0.1} suffix="mm" size="sm" scrub onValueChange={set} />
      </div>
      <Tooltip content="接触点之间的距离。数值越大，点与点隔得越开。">
        <button type="button" className="polyGapHelp" aria-label="接触点间距说明">
          <CircleHelp size={16} strokeWidth={1.75} />
        </button>
      </Tooltip>
    </div>
  );
}

function CloneLayoutThumb({ plan, plateX, plateZ }) {
  const W = 280;
  const H = 132;
  if (!plan || !plan.ok) {
    return <div className="stuCloneThumb empty">先选中要复制的模型</div>;
  }
  const cells = plan.cells || [];
  let minX = -plateX / 2;
  let maxX = plateX / 2;
  let minZ = -plateZ / 2;
  let maxZ = plateZ / 2;
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.x + c.w > maxX) maxX = c.x + c.w;
    if (c.z < minZ) minZ = c.z;
    if (c.z + c.d > maxZ) maxZ = c.z + c.d;
  }
  const spanX = Math.max(1, maxX - minX);
  const spanZ = Math.max(1, maxZ - minZ);
  const pad = 10;
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanZ);
  const ox = (W - spanX * scale) / 2;
  const oz = (H - spanZ * scale) / 2;
  const X = x => ox + (x - minX) * scale;
  const Z = z => oz + (maxZ - z) * scale;
  return (
    <svg className="stuCloneThumb" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="布局预览">
      <rect className="plate" x={X(-plateX / 2)} y={Z(plateZ / 2)} width={plateX * scale} height={plateZ * scale} />
      {cells.map(c => (
        <rect
          key={`${c.i}-${c.j}-${c.k}`}
          x={X(c.x) + c.k * 3}
          y={Z(c.z + c.d) - c.k * 3}
          width={Math.max(2, c.w * scale)}
          height={Math.max(2, c.d * scale)}
          className={c.origin ? 'origin' : c.overflow ? 'bad' : 'copy'}
        />
      ))}
    </svg>
  );
}

const NEST_ALIGN = [
  { value: 'left', label: '左对齐' },
  { value: 'center', label: '居中' },
  { value: 'right', label: '右对齐' },
];

function NestPanel() {
  const [p, setParam] = useParams();
  const gap = Math.min(40, Math.max(0, Number(p.nestGap) || 0));
  const margin = Math.min(40, Math.max(0, Number(p.nestMargin) || 0));
  const align = p.nestAlign === 'center' || p.nestAlign === 'right' ? p.nestAlign : 'left';
  const setGap = n => setParam('nestGap', Math.round(Math.min(40, Math.max(0, Number(n) || 0)) * 10) / 10);
  const setMargin = n => setParam('nestMargin', Math.round(Math.min(40, Math.max(0, Number(n) || 0)) * 10) / 10);
  return (
    <div className="stuBrush stuBrushNest">
      <span className="stuBrushBrand">排版</span>
      <span className="stuBrushSep" aria-hidden="true" />
      <span className="stuBrushLabel">对齐</span>
      <SegmentedControl
        className="stuNestAlign"
        label="对齐"
        options={NEST_ALIGN}
        value={align}
        onValueChange={v => setParam('nestAlign', v)}
      />
      <span className="stuBrushLabel" data-field="edge">离板边</span>
      <div className="stuBrushNum" data-field="edge">
        <NumberField label="离板边" value={margin} min={0} max={40} step={0.5} suffix="mm" size="sm" scrub onValueChange={setMargin} />
      </div>
      <span className="stuBrushLabel" data-field="gap">模型间距</span>
      <div className="stuBrushNum" data-field="gap">
        <NumberField label="模型间距" value={gap} min={0} max={40} step={0.5} suffix="mm" size="sm" scrub onValueChange={setGap} />
      </div>
      <Button size="sm" className="stuNestGo" onClick={() => layoutAllParts()}>开始排版</Button>
      <Tooltip content="左对齐、右对齐沿这一排的两头挪，整排贴着前面的板边。居中只放在左右中间。关掉支撑重叠时按模型和支撑的外沿，已生成边框且关掉边框可重叠时改按边框外沿。">
        <button type="button" className="polyGapHelp" aria-label="排版说明">
          <CircleHelp size={16} strokeWidth={1.75} />
        </button>
      </Tooltip>
      <span className="stuNestBreak" aria-hidden="true" />
      <span className="stuBrushLabel">支撑重叠</span>
      <Switch checked={!!p.nestSupportOverlap} onCheckedChange={on => setParam('nestSupportOverlap', !!on)} aria-label="支撑重叠" />
      <span className="stuBrushLabel">边框可重叠</span>
      <Switch checked={!!p.nestFrameOverlap} onCheckedChange={on => setParam('nestFrameOverlap', !!on)} aria-label="边框可重叠" />
    </div>
  );
}

function ClonePanel() {
  const [cols, setCols] = React.useState(2);
  const [rows, setRows] = React.useState(1);
  const [layers, setLayers] = React.useState(1);
  const [gap, setGap] = React.useState(2);
  const [plan, setPlan] = React.useState(null);
  const info = useBusLatest('modelInfo', null);
  const [p] = useParams();
  const idsRef = React.useRef(null);
  const committed = React.useRef(false);
  if (!idsRef.current && info && info.parts && info.parts.length) {
    const picked = info.selectedIds && info.selectedIds.length ? info.selectedIds : info.parts.map(part => part.id);
    idsRef.current = picked;
  }
  const poseKey = info && info.parts ? info.parts.map(part => `${part.id}:${part.ox}:${part.oy}:${part.oz}`).join('|') : '';
  React.useEffect(() => { committed.current = false; }, [cols, rows, layers, gap]);
  React.useEffect(() => {
    if (committed.current) return undefined;
    const next = showClonePreview({ cols, rows, layers, gap, ids: idsRef.current || undefined });
    setPlan(next);
    return () => clearClonePreview();
  }, [cols, rows, layers, gap, poseKey]);
  const n = plan && plan.ok ? plan.copies : Math.max(0, cols * rows * layers - 1);
  const place = () => {
    const made = cloneParts({ cols, rows, layers, gap, ids: idsRef.current || undefined });
    if (made) {
      committed.current = true;
      idsRef.current = null;
      clearClonePreview();
      setPlan(null);
    }
  };
  return (
    <div className="stuClone">
      <div className="stuCloneHead">
        <span>布局预览</span>
        <small>{plan && plan.ok ? `${n} 个副本${plan.overflow ? ` · ${plan.overflow} 处超出板面` : ''}` : '板上会先显示半透明副本'}</small>
      </div>
      <CloneLayoutThumb plan={plan} plateX={p.plateX || 150} plateZ={p.plateZ || 85} />
      <div className="stuBrush stuBrushClone">
        <span className="stuBrushBrand">复制</span>
        <span className="stuBrushSep" aria-hidden="true" />
        <span className="stuBrushLabel">列</span>
        <div className="stuBrushNum">
          <NumberField label="列" value={cols} min={1} max={12} step={1} size="sm" onValueChange={v => setCols(Math.round(v))} />
        </div>
        <span className="stuBrushLabel">行</span>
        <div className="stuBrushNum">
          <NumberField label="行" value={rows} min={1} max={12} step={1} size="sm" onValueChange={v => setRows(Math.round(v))} />
        </div>
        <span className="stuBrushLabel">层</span>
        <div className="stuBrushNum">
          <NumberField label="层" value={layers} min={1} max={8} step={1} size="sm" onValueChange={v => setLayers(Math.round(v))} />
        </div>
        <span className="stuBrushLabel">间距</span>
        <div className="stuBrushNum">
          <NumberField label="间距" value={gap} min={0} max={80} step={0.5} suffix="mm" size="sm" scrub onValueChange={setGap} />
        </div>
        <Button size="sm" disabled={n < 1} onClick={place}>
          复制 {n > 0 ? n : ''}
        </Button>
      </div>
    </div>
  );
}

function BrushPanel() {
  const mode = useBusLatest('mode', 'orbit');
  const [p, setParam] = useParams();
  const radius = Math.min(12, Math.max(0.5, Number(p.brushR) || 0.5));
  const weight = Math.min(30, Math.max(0, Number(p.protW) || 0));
  return (
    <div className="stuBrush">
      <span className="stuBrushBrand">涂画保护面</span>
      <Switch
        checked={mode === 'paint'}
        onCheckedChange={on => setMode(on ? 'paint' : 'orbit')}
        aria-label="涂画保护面"
      />
      <span className="stuBrushSep" aria-hidden="true" />
      <span className="stuBrushLabel" data-field="r">笔刷半径</span>
      <div className="stuBrushNum" data-field="r">
        <NumberField label="笔刷半径" value={radius} min={0.5} max={12} step={0.5} suffix="mm" size="sm" scrub onValueChange={n => setParam('brushR', n)} />
      </div>
      <span className="stuBrushLabel" data-field="w">评分权重</span>
      <div className="stuBrushNum" data-field="w">
        <NumberField label="评分权重" value={weight} min={0} max={30} step={1} suffix="×" size="sm" scrub onValueChange={n => setParam('protW', n)} />
      </div>
      <Tooltip content="在模型上按住拖动。涂过的面不长支撑，朝向评分也会避开它。">
        <button type="button" className="polyGapHelp" aria-label="保护面说明">
          <CircleHelp size={16} strokeWidth={1.75} />
        </button>
      </Tooltip>
    </div>
  );
}

const LAY_DIRS = [
  { value: 'down', label: '面朝下' },
  { value: 'up', label: '面朝上' },
];

/* 按面放置（对照黑格「选择面」）：方向在这里选，进了模式可以连着点。点中的面转到朝下或朝上，
   整件模型的最低点落到平台，水平位置不动。模型已有支撑时先问一声。 */
function LayPanel() {
  const [p, setParam] = useParams();
  const dir = p.layFace === 'up' ? 'up' : 'down';
  return (
    <div className="stuBrush stuBrushLay">
      <span className="stuBrushBrand">按面放置</span>
      <span className="stuBrushSep" aria-hidden="true" />
      <SegmentedControl
        className="stuLayDir"
        label="放置方向"
        options={LAY_DIRS}
        value={dir}
        onValueChange={v => setParam('layFace', v)}
      />
      <Tooltip content="点模型上朝向你的一个面，把它转到朝下（或朝上），整件模型的最低点落到平台，位置不动。模型已有支撑时会先问你。按 F 开关，Esc 退出。">
        <button type="button" className="polyGapHelp" aria-label="按面放置说明">
          <CircleHelp size={16} strokeWidth={1.75} />
        </button>
      </Tooltip>
    </div>
  );
}

const CUT_PINS = [
  { value: 'trapezoid', label: '梯形插销' },
  { value: 'none', label: '不加销' },
];

const CUT_SURFACES = [
  { value: 'line', label: '随画线' },
  { value: 'plane', label: '平面' },
];

const clampNum = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/* 画线切割：在模型表面点一圈线，把这件模型切成 A、B 两件，默认在切面上加梯形插销
   （公榫长在 B 件，母孔开在 A 件，留装配间隙）。切面「随画线」时切口就是这条线（线有起伏就沿着起伏切），「平面」时切拟合出的最佳平面。
   线是保留的：封口后列在下面，可以隐藏 / 删除 / 继续编辑 / 再切。切割在后台线程里算，进行中界面照常响应。 */
function CutPanel() {
  const [p, setParam] = useParams();
  const cut = useBusLatest('cutLines', null);
  const lines = (cut && cut.lines) || [];
  const active = lines.find(l => l.id === (cut && cut.active)) || null;
  const drafting = (cut && cut.drafting) || null;
  const busy = !!(cut && cut.busy);
  const surface = p.cutSurface === 'plane' ? 'plane' : 'line';
  const pin = p.cutPin === 'none' ? 'none' : 'trapezoid';
  const size = clampNum(p.cutPinSize, 2, 40, 6);
  const depth = clampNum(p.cutPinDepth, 2, 40, 6);
  const clear = clampNum(p.cutPinClear, 0, 1, 0.1);
  const r1 = n => Math.round(n * 10) / 10;
  /* 沿画线要穿过画线造一张曲面：线在切面方向上自己交叉就造不出来（很平的线内核直接按平面切，不受此限） */
  const tangled = !!(active && active.alive && active.tangled && surface === 'line' && active.dev > CUT_FLAT_TOL);
  const canCut = !busy && !tangled && !!((active && active.alive && active.closed && !active.cut) || (drafting && drafting.points >= 3));
  let status;
  if (busy) status = '正在切割，请稍候…';
  else if (drafting) {
    status = drafting.points >= 3
      ? `已点 ${drafting.points} 个点：点回起点（变绿）、双击或按 Enter 封口`
      : `已点 ${drafting.points} 个点，继续点（至少 3 个）`;
  } else if (active) {
    let how = '';
    if (active.alive && active.dev != null) {
      if (surface === 'plane') how = ` · 按拟合平面切（线偏离平面 ${active.dev.toFixed(2)} mm）`;
      else if (active.dev <= CUT_FLAT_TOL) how = ' · 线很平，按平面切';
      else if (active.tangled) how = ' · 线在切面方向上自己交叉，沿线切不了：重画一圈，或把切面改成「平面」';
      else how = ` · 切口沿画线（线起伏 ${active.dev.toFixed(2)} mm）`;
    }
    status = !active.alive
      ? `${active.name}：锚着的模型已不在板上（虚线），不能再切`
      : `${active.name}${how}${active.cut ? ' · 已切过，不满意可撤回后再切' : ''}`;
  } else status = lines.length ? '选一条线，或在模型表面画新的一圈' : '在模型表面依次点出一圈，封口后点「切割」';
  const go = () => runTask('cut', () => runCutLine());
  return (
    <div className="stuCut">
      <div className="stuCutRow">
        <span className="stuBrushBrand">画线切割</span>
        <span className="stuBrushSep" aria-hidden="true" />
        <SegmentedControl
          className="stuCutPin"
          label="切面"
          options={CUT_SURFACES}
          value={surface}
          onValueChange={v => setParam('cutSurface', v)}
        />
        <SegmentedControl
          className="stuCutPin"
          label="连接件"
          options={CUT_PINS}
          value={pin}
          onValueChange={v => setParam('cutPin', v)}
        />
        {/* 三个数和说明按钮是一组：窄屏折行时整组一起落到下一行，说明按钮不会单独掉队 */}
        <div className="stuCutTail">
          {pin === 'trapezoid' ? (
            <>
              <span className="stuCutNum">
                <span className="stuBrushLabel">宽</span>
                <div className="stuBrushNum">
                  <NumberField label="插销宽" value={size} min={2} max={40} step={0.5} suffix="mm" size="sm" scrub onValueChange={n => setParam('cutPinSize', r1(clampNum(n, 2, 40, 6)))} />
                </div>
              </span>
              <span className="stuCutNum">
                <span className="stuBrushLabel">深</span>
                <div className="stuBrushNum">
                  <NumberField label="插销深度" value={depth} min={2} max={40} step={0.5} suffix="mm" size="sm" scrub onValueChange={n => setParam('cutPinDepth', r1(clampNum(n, 2, 40, 6)))} />
                </div>
              </span>
              <span className="stuCutNum">
                <span className="stuBrushLabel">间隙</span>
                <div className="stuBrushNum">
                  <NumberField label="装配间隙" value={clear} min={0} max={1} step={0.05} suffix="mm" size="sm" scrub onValueChange={n => setParam('cutPinClear', Math.round(clampNum(n, 0, 1, 0.1) * 100) / 100)} />
                </div>
              </span>
            </>
          ) : null}
          <Tooltip content="沿模型表面点一圈线（至少 3 点），把模型切成 A、B 两件。切面选「随画线」时切口落在模型表面的位置就是这条线：线有起伏就沿着起伏切，选中线时画出真正的切面预览；选「平面」则一律切这一圈拟合出的最佳平面。默认在切面上加梯形插销：公榫在 B 件、母孔在 A 件，母孔比公榫每边宽出装配间隙；切面放不下时插销自动缩小。线会保留：封口后列在下面，可隐藏、删除、继续编辑、再切。按 C 开关，Enter 封口 / 切割，Backspace 退一点，Esc 取消。">
            <button type="button" className="polyGapHelp" aria-label="画线切割说明">
              <CircleHelp size={16} strokeWidth={1.75} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="stuCutRow">
        <span className="stuCutStatus" role="status" aria-live="polite">{status}</span>
        <Button size="sm" className="stuCutGo" disabled={!canCut} loading={busy} onClick={go}>切割</Button>
      </div>
      {lines.length ? (
        <div className="stuCutRow stuCutLines" role="list" aria-label="保留的切割线">
          {lines.map(l => (
            <div key={l.id} role="listitem" className="stuCutChip" data-on={l.id === (cut && cut.active) ? 'true' : 'false'} data-dim={l.visible && l.alive ? 'false' : 'true'}>
              <button type="button" className="stuCutChipName" onClick={() => selectCutLine(l.id)} aria-pressed={l.id === (cut && cut.active)}>
                {l.name}{l.cut ? ' · 已切' : ''}{!l.alive ? ' · 脱离' : ''}
              </button>
              <Tooltip content={l.visible ? '隐藏这条线' : '显示这条线'}>
                <button type="button" className="stuCutChipBtn" aria-label={l.visible ? `隐藏${l.name}` : `显示${l.name}`} onClick={() => setCutLineVisible(l.id)}>
                  {l.visible ? <Eye size={14} strokeWidth={1.75} /> : <EyeOff size={14} strokeWidth={1.75} />}
                </button>
              </Tooltip>
              <Tooltip content={l.cut ? '已切过的线只作标记，要改请先撤回' : '继续编辑：展开这条线接着点，再封口'}>
                <button type="button" className="stuCutChipBtn" aria-label={`继续编辑${l.name}`} disabled={!l.alive || l.cut || !!drafting} onClick={() => editCutLine(l.id)}>
                  <Pencil size={14} strokeWidth={1.75} />
                </button>
              </Tooltip>
              <Tooltip content="删除这条线（Delete）">
                <button type="button" className="stuCutChipBtn" aria-label={`删除${l.name}`} onClick={() => removeCutLine(l.id)}>
                  <Trash2 size={14} strokeWidth={1.75} />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      ) : null}
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
  /* 浮层同一时间只开一个：'simplify' 简化条，'brush' 保护面，'poly' 多线段接触点间距。
     关掉时 pop 先变成空，退出动画还在播。内容不能跟着掉进简化条，否则会闪一下简化对话框。 */
  const [pop, setPop] = React.useState(null);
  const popFace = React.useRef(null);
  if (pop) popFace.current = pop;
  const face = pop || popFace.current;
  /* 浮层要落在对应那一格正上方：量出这一格相对坞中心的偏移 */

  const [tray, setTray] = React.useState(null);
  const [pulse, setPulse] = React.useState(0);
  const [live, setLive] = React.useState(false);
  React.useEffect(() => { setLive(true); }, []);
  /* 变换托盘会从底栏上沿长出来。量底板轮廓的最上沿，让缩放 / 旋转面板停在它上面，托盘开合时跟着让。 */
  React.useEffect(() => {
    const root = document.querySelector('.stu');
    const row = document.querySelector('.stuToolsRow');
    if (!root || !row) return undefined;
    let raf = 0;
    const measure = () => {
      const anchor = row.querySelector('.stuDockAnchor > div');
      const plate = anchor && anchor.firstElementChild;
      let top = row.getBoundingClientRect().top;
      if (plate) {
        const box = plate.getBoundingClientRect();
        if (box.height > 8 && box.top < top) top = box.top;
      }
      root.style.setProperty('--dock-clear', `${Math.ceil(window.innerHeight - top + DOCK_TIP_BAND)}px`);
    };
    const kick = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    kick();
    const obs = new ResizeObserver(kick);
    obs.observe(row);
    const plate = row.querySelector('.stuDockAnchor > div');
    const plateEl = plate && plate.firstElementChild;
    if (plateEl) obs.observe(plateEl);
    window.addEventListener('resize', kick);
    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
      window.removeEventListener('resize', kick);
      root.style.removeProperty('--dock-clear');
    };
  }, []);
  /* 简化 / 笔刷 / 多线段浮层和缩放、旋转面板都贴在底栏上方。浮层开着时把变换面板再抬一截，避免叠在一起。 */
  React.useEffect(() => {
    const root = document.querySelector('.stu');
    if (!root) return undefined;
    if (!pop) {
      root.style.setProperty('--dock-pop-lift', '0px');
      return undefined;
    }
    let raf = 0;
    const measure = () => {
      const el = document.querySelector('.stuPop');
      const h = el ? el.getBoundingClientRect().height : 0;
      root.style.setProperty('--dock-pop-lift', `${Math.ceil(h + 12)}px`);
    };
    const kick = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    kick();
    const obs = new ResizeObserver(kick);
    const watch = () => {
      const el = document.querySelector('.stuPop');
      if (el) obs.observe(el);
    };
    watch();
    const later = window.setTimeout(watch, 60);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(later);
      obs.disconnect();
      root.style.setProperty('--dock-pop-lift', '0px');
    };
  }, [pop]);
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
    { id: 'lay', label: '按面放置  F', icon: <MousePointerClick {...I} /> },
    { id: 'cut', label: '画线切割  C', icon: <Scissors {...I} /> },
    {
      id: 'manual',
      label: '手动支撑',
      active: manualMode || undefined,
      icon: manualIcon,
      items: [
        { id: 'add', label: '加点 / 拖针尖', icon: <AddIcon {...tip} state={mode === 'add'} /> },
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
        { id: 'move', label: '移动  M', icon: <MoveIcon {...tip} state={tool === 'move'} /> },
        { id: 'rotate', label: '旋转  R', icon: <RotateIcon {...tip} state={tool === 'rotate'} /> },
        { id: 'scale', label: '缩放  S', icon: <ScaleIcon {...tip} state={tool === 'scale'} /> },
      ],
    },
    { id: 'nest', label: '排版', icon: <LayoutGrid {...I} /> },
    { id: 'clone', label: '复制', icon: <Copy {...I} /> },
    { id: 'library', label: '零件', icon: <Library {...I} /> },
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

  /* 收起浮层：开的是笔刷浮层时一并退出保护面模式——浮层在，涂画模式就在。按面放置同理 */
  const closePop = () => {
    if (pop === 'brush' || pop === 'poly' || pop === 'lay' || pop === 'cut') setMode('orbit');
    setPop(null);
  };

  /* 按面放置、画线切割的浮层跟着视口模式走：进模式就摊开，退出就收起。
     按钮、F / C 键、命令面板、Esc 进出都一样，不用各处记着开关浮层。 */
  React.useEffect(() => {
    if (mode === 'lay') setPop('lay');
    else if (mode === 'cut') setPop('cut');
    else setPop(p => (p === 'lay' || p === 'cut' ? null : p));
  }, [mode]);

  const onPick = id => {
    {
      const parent = { add: 'manual', del: 'manual', poly: 'manual', full: 'supview', needle: 'supview', point: 'supview', move: 'xform', rotate: 'xform', scale: 'xform' }[id];
      if (parent) tabAt.current = parent;
      else if (['orbit', 'paint', 'lay', 'cut', 'manual', 'supview', 'xform', 'simplify', 'frame'].includes(id)) tabAt.current = id;
    }
    /* 托盘里的演示模型：点了就换模型，重复点当前这一个不做任何事 */
    if (id.startsWith('demo:')) {
      const kind = id.slice(5);
      if (kind !== demoKind) runTask('demo', () => doLoadDemo(kind));
      return;
    }
    if (id === 'full' || id === 'needle' || id === 'point') {
      if (pop) setPop(null);
      doSetSupView(id);
      return;
    }
    if (id === 'move' || id === 'rotate' || id === 'scale') {
      if (pop) setPop(null);
      setTransformTool(id);
      return;
    }
    /* 保护面：进模式的同时把笔刷设置摊在这一格上方。再点一次或换别的工具才收起；
       在模型上移动、按住涂画不算点到外面，否则一动手面板就没了。 */
    if (id === 'library') {
      window.dispatchEvent(new Event('resinforge:open-parts'));
      return;
    }
    if (id === 'nest') {
      if (pop === 'nest') { closePop(); return; }
      if (tool) setTransformTool(tool);
      setRevealTray(null);
      setPop('nest');
      return;
    }
    if (id === 'clone') {
      if (pop === 'clone') { closePop(); return; }
      if (tool) setTransformTool(tool);
      setRevealTray(null);
      setPop('clone');
      return;
    }
    if (id === 'lay') {
      if (mode === 'lay') { setMode('orbit'); return; }
      if (tool) setTransformTool(tool);
      if (pop) setPop(null);
      setRevealTray(null);
      setMode('lay');   // 浮层由上面的 effect 跟着模式打开
      return;
    }
    if (id === 'cut') {
      if (mode === 'cut') { setMode('orbit'); return; }
      if (!state.parts.length) { toast('先打开一个模型，再画线切割'); return; }
      if (tool) setTransformTool(tool);
      if (pop) setPop(null);
      setRevealTray(null);
      setMode('cut');   // 浮层由上面的 effect 跟着模式打开
      return;
    }
    if (id === 'paint') {
      if (pop === 'brush') { closePop(); return; }
      if (tool) setTransformTool(tool);
      setMode('paint');
      setRevealTray(null);
      setPop('brush');
      return;
    }
    if (id === 'poly') {
      if (pop === 'poly') { closePop(); return; }
      if (tool) setTransformTool(tool);
      setMode('poly');
      setRevealTray(null);
      setPop('poly');
      return;
    }
    if (id === 'orbit' || id === 'add' || id === 'del') {
      if (tool) setTransformTool(tool);
      setMode(id);
      if (pop) setPop(null);
      return;
    }
    /* 简化外观演示打开时，底栏不再叠出原来的白卡片 */
    if (id === 'simplify') {
      if (document.documentElement.dataset.simpProto) return;
      setRevealTray(null);
      setPop(open => (open === 'simplify' ? null : 'simplify'));
      return;
    }
    if (id === 'heat') { setHeat(!heat); return; }
    if (id === 'frame') {
      if (pop) setPop(null);
      setPulse(n => n + 1);
      frameParts(state.parts, { animate: true });
    }
  };

  /* Tab / Shift+Tab 只在底栏这一排上走。落到有二级菜单的格子时，直接把菜单展开，不改里面当前的功能。
     热力图和演示模型仍跳过。输入框里、以及工具浮层以外的对话框里不抢。 */
  const tabAt = React.useRef(null);
  const [tabSlot, setTabSlot] = React.useState(null);
  const [revealTray, setRevealTray] = React.useState(null);
  const popRef = React.useRef(pop);
  popRef.current = pop;
  const pickRef = React.useRef(onPick);
  pickRef.current = onPick;
  React.useEffect(() => {
    const order = ['orbit', 'paint', 'lay', 'cut', 'manual', 'supview', 'xform', 'simplify', 'frame'];
    const parentOf = { add: 'manual', del: 'manual', poly: 'manual', full: 'supview', needle: 'supview', point: 'supview', move: 'xform', rotate: 'xform', scale: 'xform' };
    const onKey = (e) => {
      if (e.key !== 'Tab' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const dialog = el && el.closest && el.closest('dialog[open], [role="dialog"]');
      if (dialog && !dialog.classList.contains('stuPop') && !dialog.classList.contains('scalePanel')) return;
      e.preventDefault();
      e.stopPropagation();
      const popNow = popRef.current;
      const toolNow = state.transformTool;
      const modeNow = state.mode;
      const inferredRaw = popNow === 'simplify' ? 'simplify'
        : (toolNow || (modeNow === 'paint' || modeNow === 'lay' || modeNow === 'cut' || modeNow === 'add' || modeNow === 'del' || modeNow === 'poly' ? modeNow : 'orbit'));
      const inferred = parentOf[inferredRaw] || inferredRaw;
      const marked = tabAt.current ? (parentOf[tabAt.current] || tabAt.current) : null;
      const cur = marked && order.includes(marked) ? marked : inferred;
      const dir = e.shiftKey ? -1 : 1;
      let i = order.indexOf(cur);
      if (i < 0) i = dir > 0 ? -1 : 0;
      const activate = (id) => {
        if (id === 'manual' || id === 'supview' || id === 'xform') {
          setTabSlot(null);
          if (popNow) setPop(null);
          if (popNow === 'lay' || popNow === 'cut') setMode('orbit');
          setRevealTray(id);
          tabAt.current = id;
          return true;
        }
        setRevealTray(null);
        setTabSlot(id === 'frame' ? 'frame' : null);
        pickRef.current(id);
        return true;
      };
      for (let n = 0; n < order.length; n++) {
        i = (i + dir + order.length) % order.length;
        if (activate(order[i])) return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <Popover open={!!pop} onOpenChange={open => { if (!open) closePop(); }}>
      <PopoverAnchor asChild>
        <div className="stuDockAnchor">
          <Dock
            label="视口工具"
            items={items}
            value={tool || mode}
            trailing={trailing}
            trayClosed={!!pop}
            revealTray={revealTray}
            expandedId={tabSlot === 'supview' || tabSlot === 'frame' ? tabSlot : pop === 'simplify' ? 'simplify' : pop === 'brush' ? 'paint' : pop === 'clone' ? 'clone' : pop === 'nest' ? 'nest' : null}
            onOpenChange={id => { setTray(id); if (id && pop) closePop(); }}
            onValueChange={onPick}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        className={'stuPop' + (face === 'brush' ? ' stuPopBrush' : face === 'poly' ? ' stuPopPoly' : face === 'lay' ? ' stuPopLay' : face === 'cut' ? ' stuPopCut' : face === 'clone' ? ' stuPopClone' : face === 'nest' ? ' stuPopNest' : '')}
        side="top"
        align="center"

        sideOffset={DOCK_TIP_BAND}
        /* 按面放置、画线切割的浮层只是一条工具条，不算对话框：Radix 默认的 role="dialog" 会让撤回、F / C、M / R / S、Delete、Enter 这些快捷键以为有弹窗而停手 */
        {...(face === 'lay' ? { role: 'group', 'aria-label': '按面放置' } : face === 'cut' ? { role: 'group', 'aria-label': '画线切割' } : {})}
        onOpenAutoFocus={event => { if (face === 'poly' || face === 'brush' || face === 'lay' || face === 'cut') event.preventDefault(); }}
        onInteractOutside={event => { if (face === 'poly' || face === 'brush' || face === 'lay' || face === 'cut') event.preventDefault(); }}
      >
        {face === 'brush' ? <BrushPanel /> : face === 'poly' ? <PolyGapPanel /> : face === 'lay' ? <LayPanel /> : face === 'cut' ? <CutPanel /> : face === 'clone' ? <ClonePanel /> : face === 'nest' ? <NestPanel /> : face === 'simplify' ? <Simplifier compact /> : null}
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

