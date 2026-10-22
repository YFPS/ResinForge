import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, Check, Frame, Flame, Menu, UploadCloud } from 'lucide-react';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { Select } from '@/components/arc/select/select';
import { Button } from '@/components/arc/button/button';
import { Tooltip } from '@/components/arc/tooltip/tooltip';
import { Drawer, DrawerContent } from '@/components/arc/drawer/drawer';
import Toast from '@/components/arc/toast/toast';
import { Switch } from '@/components/arc/switch/switch';
import { NumberField } from '@/components/arc/number-field/number-field';
import { state, params } from '../store.js';
import { useBus, useBusState, useBusValue, useParams, useToasts, pushToast, dismissToast } from '../demo/bridge.js';
import { goStep, STEPS, useDone, useUI } from '../demo/ui.js';
import { BUILTIN_MACHINES, CUSTOM_ID, currentMachine, machineLabel, selectMachine, useMachine } from '../demo/machines.js';
import { camera, getControls, initScene, setMode } from '../core/scene.js';

/* ---------------------------------------------------------------
   品牌标记：模型底面（上）+ 三角格架（下）+ 一滴树脂（青）
   --------------------------------------------------------------- */
export function Mark() {
  return (
    <svg viewBox="0 0 28 28" width="26" height="26" fill="none" aria-hidden="true" focusable="false">
      <path d="M4.5 11 14 4.6 23.5 11" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M7.4 14v9.2M14 14v9.2M20.6 14v9.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M9.8 17.6 18.2 22.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".45" />
      <circle cx="14" cy="25.2" r="1.7" fill="var(--rf-accent)" />
    </svg>
  );
}

/* ---------------------------------------------------------------
   步骤导航
   --------------------------------------------------------------- */
const NAV_LABELS = { model: '模型', orient: '朝向', analyze: '逐层分析', support: '支撑', export: '导出' };

export function NavList({ onPick }) {
  const { step } = useUI();
  const done = useDone();
  return (
    <nav className="rf-nav" aria-label="流程">
      {STEPS.map(s => (
        <button
          key={s.id}
          type="button"
          className="rf-navRow"
          aria-current={step === s.id ? 'step' : undefined}
          onClick={() => { goStep(s.id); onPick?.(); }}
        >
          <span>{NAV_LABELS[s.id]}</span>
          {done[s.id] ? (
            <span className="rf-navTick" title="已完成">
              <Check size={13} strokeWidth={2.1} aria-hidden="true" />
              <span className="sr">已完成</span>
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}

/* ---------------------------------------------------------------
   机型
   --------------------------------------------------------------- */
export function MachineBlock() {
  const m = useMachine();
  const current = currentMachine(m);
  const options = [
    ...m.saved.map(x => ({ value: x.id, label: x.name })),
    ...BUILTIN_MACHINES.map(x => ({ value: x.id, label: machineLabel(x) })),
    { value: CUSTOM_ID, label: '自定义…' },
  ];
  return (
    <div className="rf-machine">
      <Select label="机型" value={m.selectedId} options={options} onValueChange={selectMachine} />
      <div className="rf-spec" style={{ marginTop: 8 }}>
        <span>{params.plateX} × {params.plateZ} mm</span>
        <span>{params.pixelUm} µm</span>
      </div>
      <div className="rf-spec" style={{ marginTop: 2 }}>
        <span>打印高 {params.plateY} mm</span>
        <span>{current ? '预设' : '自定义'}</span>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="rf-side" aria-label="工作台">
      <div className="rf-brand">
        <span className="rf-mark"><Mark /></span>
        <div className="rf-brandText">
          <span className="rf-word">ResinForge</span>
          <span className="rf-scope">光固化支撑 · 工作台</span>
        </div>
      </div>
      <NavList />
      <div className="rf-sideRule" />
      <div className="rf-sideBlock">
        <span className="rf-sideLabel">视口</span>
        <div className="rf-keyRow"><span>右键拖动</span><span>平移</span></div>
        <div className="rf-keyRow"><span>中键拖动</span><span>旋转</span></div>
        <div className="rf-keyRow"><span>滚轮</span><span>缩放</span></div>
      </div>
      <div className="rf-sideBlock">
        <span className="rf-sideLabel">支撑步骤</span>
        <div className="rf-keyRow rf-keyRowKeys"><kbd className="rf-kbd">A</kbd><span>加点</span></div>
        <div className="rf-keyRow rf-keyRowKeys"><kbd className="rf-kbd">D</kbd><span>删点</span></div>
        <div className="rf-keyRow rf-keyRowKeys"><kbd className="rf-kbd">V</kbd><span>切换支撑显示</span></div>
      </div>
      <div className="rf-sideFoot">
        <div className="rf-sideRule" />
        <MachineBlock />
        <p className="rf-note">全部计算在本机完成，模型不上传。</p>
        <div className="rf-spec"><span>Studio</span><span>0.4.0</span></div>
      </div>
    </aside>
  );
}

export function MobileMenu({ open, onOpenChange }) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent title="ResinForge" description="光固化支撑 · 工作台" side="left" className="rf-menuDrawer">
        <NavList onPick={() => onOpenChange(false)} />
        <div className="rf-drawerFoot">
          <MachineBlock />
          <p className="rf-note">全部计算在本机完成，模型不上传。</p>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/* ---------------------------------------------------------------
   顶栏：模型名 + 尺寸 + 状态 + 这一盘最要紧的一句话
   --------------------------------------------------------------- */
export function TopBar({ info, status, finding, onOpenFile, onMenu }) {
  return (
    <header className="rf-top">
      <button type="button" className="rf-menuBtn" onClick={onMenu} aria-label="打开流程菜单">
        <Menu size={16} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <span className="rf-mobileMark" aria-hidden="true"><Mark /></span>
      <div className="rf-title">
        <h1>{info ? info.title : '空盘'}</h1>
        <span className="rf-titleMeta">{info ? info.meta : '打开一份 STL 开始'}</span>
      </div>
      <span className="rf-state" data-tone={status.tone}>
        <i aria-hidden="true" />
        {status.label}
      </span>
      <div className="rf-find">
        <p>{finding.text}</p>
        {finding.action ? (
          <button type="button" className="rf-link" onClick={finding.action.run}>{finding.action.label}</button>
        ) : null}
      </div>
      <Button variant="secondary" size="sm" onClick={onOpenFile}>打开文件</Button>
    </header>
  );
}

/* ---------------------------------------------------------------
   画布 + 视口工具 + 高度梯
   --------------------------------------------------------------- */
const MODE_OPTIONS = [
  { value: 'orbit', label: '浏览' },
  { value: 'add', label: '加点' },
  { value: 'del', label: '删点' },
  { value: 'protect', label: '保护面' },
];

export function Stage({ mode, heat, onToggleHeat }) {
  const canvasRef = useRef(null);
  const dropHint = useBusState('dropHint', false);
  const lastParts = useRef('');
  const [, setTick] = useState(0);

  /* core 的 framePart 收零件对象（读 ox / oz / size），且给高模型的余量偏紧；这里按外接球自己装框，
     并给右侧高度梯留出位置——模型不贴边、不被裁掉。 */
  const frameActive = () => {
    const controls = getControls();
    const mesh = state.mesh;
    const geom = mesh && mesh.geometry;
    if (!controls || !geom) { setTick(t => t + 1); return; }
    if (!geom.boundingSphere) geom.computeBoundingSphere();
    const bs = geom.boundingSphere;
    const center = bs.center.clone().add(mesh.position);
    const R = Math.max(bs.radius, 8);
    const fov = (camera.fov * Math.PI) / 180;
    const aspect = Math.max(camera.aspect || 1, .2);
    const vFit = R / Math.sin(fov / 2);
    const hFit = R / Math.sin(Math.atan(Math.tan(fov / 2) * aspect));
    const dist = Math.max(vFit, hFit) * 1.35;
    const dir = { x: .52, y: .34, z: .78 };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    camera.position.copy(center);
    camera.position.x += (dir.x / len) * dist;
    camera.position.y += (dir.y / len) * dist;
    camera.position.z += (dir.z / len) * dist;
    controls.target.copy(center);
    controls.update();
  };

  useEffect(() => {
    initScene(canvasRef.current);
    const host = canvasRef.current?.parentElement;
    if (!host) return undefined;
    /* core 只监听 window resize；纸张随窗口与面板变化，这里补发一次 */
    const ro = new ResizeObserver(() => window.dispatchEvent(new Event('resize')));
    ro.observe(host);
    /* 首帧的画布尺寸要等纸张排好；稍后再按真实视口对一次焦 */
    const t = setTimeout(frameActive, 420);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, []);

  /* 换模型（零件集合变了）才重新对焦；选中别的零件不动镜头 */
  useBus('modelInfo', payload => {
    if (!payload || !payload.parts) return;
    const sig = payload.parts.map(p => p.id).join('|');
    if (!sig || sig === lastParts.current) return;
    lastParts.current = sig;
    setTimeout(frameActive, 100);
  });

  /* 套用朝向会换掉模型的长宽高，按新外接球重新装框 */
  useBus('orientResults', list => {
    if (list && list.some(it => it.applied)) setTimeout(frameActive, 140);
  });

  const hints = {
    orbit: ['右键平移', '中键旋转', '滚轮缩放'],
    add: ['点击朝下的表面加支撑点', 'V 切换支撑显示'],
    del: ['点击或框选支撑点', 'Del 删除'],
    protect: ['按住左键涂画保护面', `笔刷半径 ${params.brushR} mm`],
  }[mode] || [];

  const fit = frameActive;

  return (
    <div className="rf-stage">
      <canvas ref={canvasRef} aria-label="三维视口：左键选择，右键平移，中键旋转" />
      <div className="rf-viewbar">
        <SegmentedControl
          label="视口操作"
          options={MODE_OPTIONS}
          value={MODE_OPTIONS.some(o => o.value === mode) ? mode : 'orbit'}
          onValueChange={setMode}
        />
      </div>
      <div className="rf-canvasTools">
        <Tooltip content={heat ? '关闭支撑热力图' : '支撑热力图'} side="bottom">
          <button type="button" className="rf-iconBtn" aria-pressed={!!heat} aria-label="支撑热力图" onClick={onToggleHeat}>
            <Flame size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip content="对准当前模型" side="bottom">
          <button type="button" className="rf-iconBtn" aria-label="对准当前模型" onClick={fit}>
            <Frame size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <LayerLadder />
      <div className="rf-stageHint">
        {hints.map(h => <span key={h}>{h}</span>)}
      </div>
      <AnimatePresence>
        {dropHint ? (
          <motion.div className="rf-drop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .14 }}>
            <span className="rf-dropInner"><UploadCloud size={22} strokeWidth={1.7} aria-hidden="true" />松开以载入模型</span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/* 高度梯：把这一盘的高度摊成一把尺子。红灯是仍悬空的孤岛，青线是已落下的支撑点。 */
export function LayerLadder() {
  const [readout, setReadout] = useState('');
  /* 分析 / 支撑结果不在 React 状态里，靠 bus 事件推动重绘 */
  useBusValue(['sliceStats', 'supStats', 'modelInfo'], () => `${state.analysis?.islands?.length || 0}:${(state.supportPoints || []).length}`);

  const mesh = state.mesh;
  const bb = mesh && mesh.geometry.boundingBox;
  const top = mesh && bb ? (mesh.position?.y || 0) + (bb.max.y - bb.min.y) : 0;
  const scale = Math.max(top, 1);
  const islands = (state.analysis?.islands) || [];
  const points = state.supportPoints || [];
  const pct = y => `${Math.max(0, Math.min(100, (y / scale) * 100))}%`;

  const ticks = [];
  for (let mm = 10; mm < scale; mm += 10) ticks.push({ mm, label: mm % 20 === 0 });

  return (
    <div className="rf-ladder" aria-label="打印高度与悬空分布">
      <div className="rf-ladderHead">
        <span>高度</span>
        <b>{readout || (top ? `${top.toFixed(1)} mm` : '—')}</b>
      </div>
      <div className="rf-ladderTrack" onMouseLeave={() => setReadout('')}>
        <span className="rf-ladderRail" aria-hidden="true" />
        {ticks.map(t => (
          <span key={t.mm} className="rf-tick" style={{ bottom: pct(t.mm) }} aria-hidden={!t.label}>
            {t.label ? <span>{t.mm}</span> : null}
          </span>
        ))}
        {points.map((p, i) => (
          <span
            key={`s${i}`}
            className="rf-supMark"
            style={{ bottom: pct(p.y) }}
            title={`支撑点 ${p.y.toFixed(1)} mm`}
            onMouseEnter={() => setReadout(`支撑 ${p.y.toFixed(1)} mm`)}
          />
        ))}
        {islands.map((isl, i) => (
          <span
            key={`i${i}`}
            className="rf-island"
            style={{ bottom: pct(isl.y) }}
            title={`孤岛 ${isl.y.toFixed(1)} mm · ${isl.area.toFixed(2)} mm²`}
            onMouseEnter={() => setReadout(`${isl.y.toFixed(1)} mm · ${isl.area.toFixed(2)} mm²`)}
          />
        ))}
      </div>
      <div className="rf-ladderLegend">
        <span><i style={{ background: 'var(--rf-negative)' }} />孤岛 {islands.length}</span>
        <span><i style={{ background: 'var(--rf-accent)' }} />支撑 {points.length}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   底部状态条：这一盘一直在看的几个数
   --------------------------------------------------------------- */
export function StatusBar({ info, slice, progress }) {
  /* 支撑点以 state 为准：换朝向 / 改参数后结构可能已清空，bus 里最后一条统计会过期 */
  const points = (state.supportPoints || []).length;
  const running = progress && progress.p != null;
  const layer = Number.isFinite(params.layerH) ? params.layerH : null;
  return (
    <div className="rf-statusbar" role="status" aria-live="polite" data-running={running ? 'true' : undefined}>
      <div className="rf-metric">
        <span>层数</span>
        <b>{slice ? slice.layers.toLocaleString('en-US') : '—'}{slice ? <small>层</small> : null}</b>
      </div>
      <div className="rf-metric">
        <span>层厚</span>
        <b>{layer != null ? layer.toLocaleString('en-US', { maximumFractionDigits: 3 }) : '—'}<small>mm</small></b>
      </div>
      <div className="rf-metric">
        <span>孤岛</span>
        <b className={slice ? undefined : 'dash'}>{slice ? slice.islandCount : '—'}{slice ? <small>处</small> : null}</b>
      </div>
      <div className="rf-metric">
        <span>孤岛面积</span>
        <b className={slice ? undefined : 'dash'}>{slice ? slice.totIslandArea.toFixed(1) : '—'}{slice ? <small>mm²</small> : null}</b>
      </div>
      <div className="rf-metric">
        <span>支撑点</span>
        <b>{points.toLocaleString('en-US')}<small>个</small></b>
      </div>
      <div className="rf-metric">
        <span>外形</span>
        <b className={info ? 'dim' : 'dash'}>{info ? info.metaSize : '—'}</b>
      </div>
      <div className="rf-statRight">
        {running ? (
          <>
            <span>{progress.text || '处理中'}</span>
            <span className="num">{Math.round((progress.p || 0) * 100)}%</span>
          </>
        ) : (
          <span>本地计算 · 不上传模型</span>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   检查器积木
   --------------------------------------------------------------- */
export function Section({ title, aside, note, children }) {
  return (
    <section className="rf-sec">
      <div className="rf-secHead">
        <h3>{title}</h3>
        {aside ? <span>{aside}</span> : null}
      </div>
      {note ? <p className="rf-secNote">{note}</p> : null}
      {children}
    </section>
  );
}

export function SwitchRow({ label, hint, checked, onChange, disabled }) {
  return (
    <div className="rf-row">
      <div className="rf-rowText">
        <span className="rf-rowLabel">{label}</span>
        {hint ? <span className="rf-rowHint">{hint}</span> : null}
      </div>
      <Switch checked={!!checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

export function Num({ k, label, min = 0, max = 100, step = 1, unit = '', onChange, disabled }) {
  const [p, setParam] = useParams();
  return (
    <NumberField
      size="sm"
      scrub
      label={label}
      value={p[k]}
      min={min}
      max={max}
      step={step}
      suffix={unit ? ` ${unit}` : ''}
      disabled={disabled}
      limitHint={(edge, limit) => `${edge === 'max' ? '最大' : '最小'} ${limit}`}
      onValueChange={v => { setParam(k, v); onChange?.(v); }}
    />
  );
}

export function KV({ rows }) {
  return (
    <dl className="rf-kv">
      {rows.map(([label, value, unit]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}{unit ? <small>{unit}</small> : null}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyBox({ children }) {
  return <p className="rf-empty">{children}</p>;
}

export function ControlRow({ label, children }) {
  return (
    <div className="rf-controlRow">
      <span className="rf-label">{label}</span>
      {children}
    </div>
  );
}

export function Legend({ items }) {
  return (
    <div className="rf-legend">
      {items.map(it => (
        <span key={it.label}><i style={{ background: it.color }} />{it.label}</span>
      ))}
    </div>
  );
}

export const HEAT_COLORS = ['#5c789e', '#1a9ef2', '#26cc6b', '#ffd91a', '#ff4d14', '#ff0d0d'];

export function HeatScale() {
  return (
    <div className="rf-heatScale" aria-label="热力图：蓝为不需要支撑，红为最需要">
      <span>弱</span>
      <span className="bar" aria-hidden="true">
        {HEAT_COLORS.map(c => <i key={c} style={{ background: c }} />)}
      </span>
      <span>强</span>
    </div>
  );
}

/* ---------------------------------------------------------------
   core 的 toast 队列（Arc Toast）
   --------------------------------------------------------------- */
export function RedesignToasts() {
  const toasts = useToasts();
  useBus('toast', msg => pushToast(msg));
  return (
    <div className="rf-toasts">
      {toasts.map(t => (
        <Toast
          key={t.id}
          title={t.title}
          description={t.description}
          duration={t.duration || 3000}
          onOpenChange={open => { if (!open) setTimeout(() => dismissToast(t.id), 360); }}
        />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------
   主操作按钮（保持每屏一个近黑主按钮）
   --------------------------------------------------------------- */
export function NextButton({ to, label }) {
  const { step } = useUI();
  const idx = STEPS.findIndex(s => s.id === step);
  const target = to || (STEPS[idx + 1] && STEPS[idx + 1].id);
  if (!target) return null;
  return (
    <button type="button" className="rf-next" onClick={() => goStep(target)}>
      {label || `下一步：${NAV_LABELS[target]}`}
      <ArrowRight size={13} strokeWidth={1.9} aria-hidden="true" />
    </button>
  );
}
