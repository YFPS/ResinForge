import React, { useMemo, useRef, useState } from 'react';
import { Box, Boxes, Eye, EyeOff, FolderOpen, Layers, PackagePlus, Plus, Search, Trash2 } from 'lucide-react';
import Button from '@/components/arc/button/button';
import Tooltip from '@/components/arc/tooltip/tooltip';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import Progress from '@/components/arc/progress/progress';
import { useBusLatest } from '../../demo/bridge.js';
import { goStep } from '../../demo/ui.js';
import { focusModel } from '../../demo/actions.js';
import { state } from '../../store.js';
import ParamPanel, { hasParamPanel } from '../../studio/ParamPanel.jsx';
import ResinHud from '../../studio/ResinHud.jsx';
import BedPlate from '../../studio/bedPlate.jsx';
import { BottomProgress, SearchBtn, StageNext, StagePill, ThemeBtn, ViewportDock } from '../../studio/pieces.jsx';
import { metaOf } from '../engine.js';
import { addFolder, addToLibrary, insertFiles, removePart, useApp } from '../appStore.js';
import { MachineChip, MaterialChip } from './JobChips.jsx';
import { AddToLibraryDialog } from './dialogs.jsx';
import { DRAG_PART, Empty, MoreMenu, Thumb, dragPart, templateName } from './common.jsx';
import { useUI } from '../../demo/ui.js';
import { BrandMark } from '../../demo/components/TopBar.jsx';

/* 窗口标题栏（方案二、三）：桌面版本来就有一条 36px 的自绘标题栏（TitleBar.jsx），方案一由标签条顶替。
   左 = 品牌 + start，正中 = center（当前工程），右端留给演示用的方案切换 */
export function TitleBar({ start, center }) {
  return (
    <header className="pdTitle">
      <span className="pdTabsBrand"><BrandMark /></span>
      {start}
      {center ? <div className="pdTitleCenter">{center}</div> : null}
    </header>
  );
}

/* 工作区：真实 Studio 的浮动卡片外壳（照 studio/shells/ShellC.jsx 的结构），多出这些插槽：
   barStart（顶栏最前，比如工程菜单）、barEnd（保存）、left（左侧卡片）、bottom（底部胶片条等）。
   顶栏里原来的机器选择器换成「机器」「材料」两个选择器（JobChips）。 */

export function WorkspaceShell({ barStart, barEnd, left, bottom, overlay }) {
  const { step } = useUI();
  const [panelOpen, setPanelOpen] = useState(true);
  const [leftOpen, setLeftOpen] = useState(true);
  const hasPanel = hasParamPanel(step);
  const allOpen = leftOpen && (panelOpen || !hasPanel);
  return (
    <div className="stuShell pdShell">
      <ResinHud />
      <div className="stuFloatBar pdBar">
        {barStart}
        <StagePill stage={step} onPick={goStep} />
        <span className="stuFloatSep" aria-hidden="true" />
        <MachineChip />
        <MaterialChip />
        {barEnd}
        <SearchBtn onOpenPalette={() => window.dispatchEvent(new CustomEvent('pd:palette'))} />
        <ThemeBtn />
        <Tooltip content={allOpen ? '全部收起，把画布让干净' : '展开全部浮层'} side="bottom">
          <Button variant="ghost" size="sm" className="stuIconBtn" aria-label={allOpen ? '全部收起' : '展开全部'}
            onClick={() => { const v = !allOpen; setLeftOpen(v); setPanelOpen(v); }}>
            {allOpen ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
          </Button>
        </Tooltip>
      </div>

      <div className="stuFloatLeft pdLeft">{leftOpen ? left : null}</div>

      <div className="stuFloatRight">
        {panelOpen && hasPanel ? (
          <div className="stuCard stuCard--panel">
            <div className="stuCardBody"><ParamPanel stage={step} /></div>
          </div>
        ) : null}
      </div>

      <div className="stuToolsRow">
        <BedPlate />
        <div className="stuDockSlot">
          <ViewportDock trailing={<StageNext stage={step} />} />
          <BottomProgress />
        </div>
      </div>
      {bottom}
      {overlay}
    </div>
  );
}

/* ---------- 工程里的对象（照 Studio 模型卡的行样式，多出支撑点数、来源与菜单） ---------- */

export function ObjectsList({ emptyHint }) {
  const app = useApp();
  const info = useBusLatest('modelInfo', null);
  useBusLatest('supStats', null);
  const [adding, setAdding] = useState(null);
  const parts = state.parts;
  const sel = info && info.selectedIds && info.selectedIds.length ? info.selectedIds : [];
  const counts = useMemo(() => {
    const c = new Map();
    for (const p of state.supportPoints || []) c.set(p.partId, (c.get(p.partId) || 0) + 1);
    return c;
  }, [info, state.supportPoints, state.supportPoints?.length]);   // eslint-disable-line react-hooks/exhaustive-deps
  const libById = useMemo(() => new Map(app.library.map(l => [l.id, l])), [app.library]);

  if (!parts.length) return <Empty icon={<Box size={18} />} title="工程里还没有零件">{emptyHint}</Empty>;
  return (
    <>
      <ScrollArea className="stuPartsScroll pdObjScroll" viewportClassName="stuPartsViewport" fade={20}>
        <div className="stuParts" role="list" aria-label="工程里的零件">
          {parts.map((p, i) => {
            const meta = metaOf(p);
            const lib = meta.libId ? libById.get(meta.libId) : null;
            const n = counts.get(p.id) || 0;
            return (
              <div key={p.id} role="listitem" className={'stuPart pdObj' + (sel.includes(p.id) ? ' on' : '')}
                onClick={() => focusModel(p.id)} title={p.name}>
                {lib?.thumb ? <Thumb src={lib.thumb} className="pdObjThumb" /> : <span className="pdObjIcon"><Box size={14} strokeWidth={1.75} /></span>}
                <span className="stuPartMain">
                  <span className="stuPartName">{p.name}</span>
                  <span className="stuPartMeta tnum">{n ? `${n} 个支撑点` : '还没有支撑'} · {lib ? '来自零件库' : '文件'}</span>
                </span>
                <MoreMenu label={`${p.name} 的操作`} items={[
                  { label: '加入零件库…', icon: <PackagePlus size={15} />, onSelect: () => setAdding({ index: i, name: p.name, points: n }) },
                  { label: '从工程移除', icon: <Trash2 size={15} />, destructive: true, separatorBefore: true, onSelect: () => removePart(i) },
                ]} />
              </div>
            );
          })}
        </div>
      </ScrollArea>
      <AddToLibraryDialog
        open={!!adding}
        part={adding}
        folders={app.partFolders}
        onAddFolder={name => addFolder('part', name)}
        onCancel={() => setAdding(null)}
        onConfirm={opts => { const a = adding; setAdding(null); addToLibrary(a.index, opts); }}
      />
    </>
  );
}

/** 打开模型文件直接放进当前工程 */
export function OpenFileButton({ label = '打开文件' }) {
  const ref = useRef(null);
  return (
    <>
      <Button variant="ghost" size="sm" className="pdCardBtn" onClick={() => ref.current?.click()}><FolderOpen size={15} />{label}</Button>
      <input ref={ref} type="file" accept=".stl" multiple hidden onChange={e => { insertFiles(e.target.files); e.target.value = ''; }} />
    </>
  );
}

/* ---------- 零件库取用（放进当前工程）：搜索 + 文件夹 + 磁贴；点一下放进去，或拖进视口 ---------- */

export function useLibraryFilter(library) {
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('all');
  const list = useMemo(() => {
    let l = library;
    if (folder === 'sup') l = l.filter(e => e.sup);
    else if (folder !== 'all') l = l.filter(e => e.folder === folder);
    const s = q.trim().toLowerCase();
    if (s) l = l.filter(e => `${e.name} ${(e.tags || []).join(' ')}`.toLowerCase().includes(s));
    return l;
  }, [library, folder, q]);
  return { q, setQ, folder, setFolder, list };
}

export function FolderChips({ folders, value, onChange, withSupported = true }) {
  const opts = [{ id: 'all', name: '全部' }, ...(withSupported ? [{ id: 'sup', name: '带支撑' }] : []), ...folders];
  return (
    <div className="pdChips" role="tablist" aria-label="文件夹">
      {opts.map(f => (
        <button key={f.id} type="button" role="tab" aria-selected={value === f.id} className={value === f.id ? 'is-on' : ''} onClick={() => onChange(f.id)}>{f.name}</button>
      ))}
    </div>
  );
}

export function SearchField({ value, onChange, placeholder = '搜索' }) {
  return (
    <label className="pdSearch">
      <Search size={14} strokeWidth={1.8} />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
    </label>
  );
}

export function PartTile({ entry, onInsert, size = 'md' }) {
  return (
    <button type="button" className={'pdTile pdTile--' + size} onClick={() => onInsert(entry)} title={`${entry.name}：点一下放进工程，或拖进视口`} {...dragPart(entry)}>
      <Thumb src={entry.thumb} className="pdTileThumb" />
      <span className="pdTileName">{entry.name}</span>
      <span className="pdTileMeta">{entry.sup ? <><Layers size={11} />{templateName(entry.sup.template)} · {entry.sup.points.length} 点</> : '只有模型'}</span>
      <span className="pdTileAdd" aria-hidden="true"><Plus size={14} strokeWidth={2.2} /></span>
    </button>
  );
}

/* ---------- 打开 / 重建时的进度卡（盖在视口中间） ---------- */

const STEPS4 = ['读取工程文件', '载入零件', '逐层分析', '重建支撑结构'];

export function LoadingCard() {
  const app = useApp();
  const L = app.loading;
  if (!L) return null;
  const steps = L.steps === 4 ? STEPS4 : STEPS4.slice(0, 2);
  const cur = Math.max(0, steps.indexOf(L.label));
  return (
    <div className="pdLoading" role="status" aria-live="polite">
      <div className="pdLoadingCard">
        <b className="pdLoadingTitle">{L.title}</b>
        <ol className="pdLoadingSteps">
          {steps.map((s, i) => (
            <li key={s} className={i < cur ? 'is-done' : i === cur ? 'is-on' : ''}><span>{i + 1}</span>{s}</li>
          ))}
        </ol>
        <Progress value={Math.round((L.p || 0) * 100)} label="进度" />
        {L.steps === 4 ? <p>支撑结构不存进工程文件：打开时按保存的支撑点和参数重建。</p> : null}
      </div>
    </div>
  );
}

/* ---------- 视口拖放：零件库磁贴拖进来放到落点；文件拖进来直接放进工程 ---------- */

export function useStageDrop({ enabled, onPart, onFiles }) {
  const [hint, setHint] = useState(false);
  const handlers = {
    onDragOver: e => {
      if (!enabled) return;
      const types = [...e.dataTransfer.types];
      if (!types.includes(DRAG_PART) && !types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();   // 不让 core 挂在 window 上的拖放把它当成「载入模型」
      e.dataTransfer.dropEffect = 'copy';
      setHint(types.includes(DRAG_PART) ? 'part' : 'file');
    },
    onDragLeave: e => { if (e.currentTarget === e.target) setHint(false); },
    onDrop: e => {
      if (!enabled) return;
      e.preventDefault();
      e.stopPropagation();
      setHint(false);
      const id = e.dataTransfer.getData(DRAG_PART);
      if (id) onPart(id, e);
      else if (e.dataTransfer.files?.length) onFiles(e.dataTransfer.files);
    },
  };
  return { hint, handlers };
}

export { Boxes };
