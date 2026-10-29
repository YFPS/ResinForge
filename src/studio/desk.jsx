/* 首页、工程、零件库。版式参考 BPS 的三页：横幅、入口卡、缩略图网格。
   每一张可点的文件都用 Arc Card（media + title + status）。几何仍走 archive。 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown, ArrowUp, Box, FolderPlus, MoreHorizontal, Plus, Search, Star, Upload,
} from 'lucide-react';
import Button from '@/components/arc/button/button';
import { Card } from '@/components/arc/card/card';
import { Checkbox } from '@/components/arc/checkbox/checkbox';
import { Drawer, DrawerContent } from '@/components/arc/drawer/drawer';
import DropdownMenu from '@/components/arc/dropdown-menu/dropdown-menu';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import { Input } from '@/components/arc/input/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/arc/popover/popover';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { params, state, toast, bus } from '../store.js';
import { setParam } from '../demo/bridge.js';
import { goStep, getUI } from '../demo/ui.js';
import { pickSTL } from '../demo/actions.js';
import { BUILTIN_MACHINES, selectMachine, setMachineParam, machineSelection } from '../demo/machines.js';
import { parkLive, restoreLive, discardLive } from './liveSession.js';
import { applyProjectParts, appendArchivedPart, bakePartRotation, syncPlateMesh } from '../core/model.js';
import { captureViewThumb } from '../core/scene.js';
import { rebuildStructure } from '../core/support.js';
import { runSliceAnalysis } from '../core/inspect.js';
import { joinLiftWanted } from '../core/joinPlate.js';
import {
  deleteLibraryItem, deleteProject, listLibrary, listProjects, newId, readLibraryItem, readProject,
  saveLibraryItem, saveProject, updateLibraryThumb, updateProjectThumb,
} from './archive.js';
import { renderProjectThumb } from './thumb.js';

const STAR_KEY = 'resinforge:stars.v1';
const FOLDER_KEY = 'resinforge:lib-folders.v1';

function machineIdNow() {
  const hit = [...BUILTIN_MACHINES].find(m => m.plateX === params.plateX && m.plateZ === params.plateZ && m.pixelUm === params.pixelUm);
  return hit ? hit.id : null;
}

function when(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const TIME_RANGES = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'year', label: '今年' },
];

function timeCutoff(range) {
  if (range === 'all') return 0;
  const now = Date.now();
  if (range === '7d') return now - 7 * 864e5;
  if (range === '30d') return now - 30 * 864e5;
  const d = new Date(now);
  if (range === 'today') d.setHours(0, 0, 0, 0);
  else if (range === 'year') {
    d.setMonth(0, 1);
    d.setHours(0, 0, 0, 0);
  }
  return d.getTime();
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function loadStars() {
  const raw = readJson(STAR_KEY, { projects: [], library: [] });
  return {
    projects: new Set(raw.projects || []),
    library: new Set(raw.library || []),
  };
}

function writeStars(stars) {
  localStorage.setItem(STAR_KEY, JSON.stringify({
    projects: [...stars.projects],
    library: [...stars.library],
  }));
}

function selectedParts() {
  const ids = state.selectedIds || [];
  const picked = ids.length ? state.parts.filter(p => ids.includes(p.id)) : [];
  if (picked.length) return picked;
  if (state.parts.length === 1) return state.parts.slice();
  const one = state.parts.find(p => p.id === state.activePartId);
  return one ? [one] : [];
}

function captureParts(parts, withPoints) {
  for (const p of parts) bakePartRotation(p);
  syncPlateMesh({ faces: true });
  const indexOf = new Map(parts.map((p, i) => [p.id, i]));
  const points = withPoints
    ? (state.supportPoints || []).filter(p => indexOf.has(p.partId) || parts.length === state.parts.length).map(p => ({
      x: p.x, y: p.y, z: p.z,
      ax: p.ax, ay: p.ay, az: p.az,
      n: p.n ? [p.n[0], p.n[1], p.n[2]] : [0, -1, 0],
      manual: true,
      partIndex: indexOf.has(p.partId) ? indexOf.get(p.partId) : 0,
    }))
    : [];
  return {
    parts: parts.map(p => ({
      name: p.name,
      positions: new Float32Array(p.geom.attributes.position.array),
      ox: p.ox, oy: p.oy || 0, oz: p.oz,
      q: [p.q.x, p.q.y, p.q.z, p.q.w],
      nf: p.nf,
    })),
    points,
    faces: parts.reduce((s, p) => s + (p.nf || 0), 0),
  };
}

function cardThumbAspect() {
  const well = document.querySelector('.stuDesk .stuWell');
  if (well) {
    const r = well.getBoundingClientRect();
    if (r.width > 8 && r.height > 8) return r.width / r.height;
  }
  return 200 / 148;
}

function viewThumb() {
  try { return captureViewThumb(640, cardThumbAspect()); } catch { return ''; }
}

/* 只有「当前打开且已经存档」的工程才用现场镜头更新卡片。
   刷新后现场是没有支撑的新演示模型，按名字去对最近一条会把存好的镜头图盖掉，支撑就从卡片上消失。 */
function liveProjectId(rows) {
  if (currentProjectId && rows.some(r => r.id === currentProjectId)) return currentProjectId;
  return '';
}

/** 把当前摄影机画面写进已经打开的这条存档。没对上存档就不写，避免刷新后的空场景盖掉支撑。 */
export async function snapshotCurrentProject() {
  if (!state.parts.length) return '';
  const thumb = viewThumb();
  if (!thumb) return '';
  const rows = await listProjects();
  const id = liveProjectId(rows);
  if (!id) return '';
  await updateProjectThumb(id, thumb);
  return thumb;
}

function makeThumb(parts, points, raiseH = params.raiseH) {
  try {
    return renderProjectThumb(parts, points, raiseH);
  } catch {
    return '';
  }
}

function restoreParams(saved) {
  if (!saved) return;
  for (const [k, v] of Object.entries(saved)) {
    if (!(k in params) || v == null || typeof v === 'object') continue;
    setParam(k, v);
  }
}

let currentProjectId = null;
let openTabs = [];
/* 已经打开过的工程。页签切走时把支撑网格留在这里，切回来直接挂上。 */
const sessions = new Map();
let switchGen = 0;

function discardSession(id) {
  const sess = sessions.get(id);
  if (!sess) return;
  sessions.delete(id);
  discardLive(sess.live);
}

function parkCurrentSession() {
  if (!currentProjectId) return;
  /* 场上已经空了，说明这份现场刚摘下去。不要用空场盖掉它。 */
  if (sessions.has(currentProjectId) && !state.parts.length && !state.mesh) return;
  const existing = sessions.get(currentProjectId);
  if (existing) discardLive(existing.live);
  const step = getUI().step;
  const machineId = machineSelection();
  sessions.set(currentProjectId, { live: parkLive(), step, machineId });
}

function emitTabs() {
  bus.emit('openTabs', { tabs: openTabs.map(t => ({ ...t })), current: currentProjectId });
}

function rememberTab(id, name) {
  if (!id) return;
  const title = name || '未命名';
  const i = openTabs.findIndex(t => t.id === id);
  if (i >= 0) openTabs[i] = { ...openTabs[i], name: title };
  else openTabs = [...openTabs, { id, name: title }];
  emitTabs();
}

/** 顶栏保存和项目页共用。已打开的工程会覆盖原记录，否则新建一条。 */
export async function saveCurrentProject(name, opts) {
  const parts = state.parts.slice();
  if (!parts.length) { toast('板上还没有可保存的模型'); return null; }
  const cap = captureParts(parts, true);
  const title = (name && name.trim()) || (parts.length === 1 ? parts[0].name : `${parts.length} 个零件`);
  const id = currentProjectId || newId();
  /* 保存时拍下当前摄影机画面（含支撑、底板）。刷新后卡片用这张，不再按几何重渲。 */
  const shot = viewThumb();
  let thumb = shot;
  if (!thumb && currentProjectId) {
    const prev = await readProject(currentProjectId);
    thumb = (prev && prev.thumb) || '';
  }
  await saveProject({
    id,
    name: title,
    savedAt: Date.now(),
    faces: cap.faces,
    partCount: cap.parts.length,
    pointCount: cap.points.length,
    machine: `${params.plateX}×${params.plateZ}`,
    machineId: machineIdNow(),
    params: JSON.parse(JSON.stringify(params)),
    parts: cap.parts,
    points: cap.points,
    /* 支撑点的 y 已经含这两项。打开时要原样提交，不能再加一次。 */
    joinLift: state.joinLift || 0,
    supportLiftOn: !!state.supportLiftOn,
    ...(thumb ? { thumb } : {}),
  });
  currentProjectId = id;
  rememberTab(id, title);
  if (!opts || !opts.quiet) toast(`已保存工程「${title}」`);
  bus.emit('archive');
  return id;
}

async function persistOpenProject() {
  if (!state.parts.length) return;
  try { await saveCurrentProject(undefined, { quiet: true }); } catch { /* 切换失败不挡住下一个工程 */ }
}

/** 切到一个已经打开的页签：有现场就挂回去，没有才读存档并重建支撑。 */
async function activateProject(id, gen) {
  const sess = sessions.get(id);
  if (sess) {
    sessions.delete(id);
    if (gen != null && gen !== switchGen) {
      sessions.set(id, sess);
      return;
    }
    currentProjectId = id;
    const tab = openTabs.find(t => t.id === id);
    rememberTab(id, (tab && tab.name) || '未命名');
    restoreLive(sess.live, { machineId: sess.machineId, step: sess.step });
    emitTabs();
    return;
  }
  await loadProjectFromArchive(id, null, gen);
}

export function ensureLiveTab(name) {
  if (!currentProjectId) currentProjectId = `draft-${newId()}`;
  const hit = openTabs.find(t => t.id === currentProjectId);
  if (hit && hit.name !== '未命名') return;
  rememberTab(currentProjectId, name || (hit && hit.name) || '未命名');
}

export async function switchOpenProject(id) {
  if (!id || id === currentProjectId) return;
  const gen = ++switchGen;
  await persistOpenProject();
  if (gen !== switchGen) return;
  parkCurrentSession();
  await activateProject(id, gen);
}

export async function closeOpenProject(id) {
  const gen = ++switchGen;
  const was = currentProjectId === id;
  if (was && state.parts.length && !String(id).startsWith('draft-')) await persistOpenProject();
  if (gen !== switchGen) return;
  openTabs = openTabs.filter(t => t.id !== id);
  if (!was) {
    discardSession(id);
    emitTabs();
    return;
  }
  discardLive(parkLive());
  discardSession(id);
  const next = openTabs[openTabs.length - 1];
  currentProjectId = null;
  emitTabs();
  if (!next) {
    goStep('model');
    return;
  }
  await activateProject(next.id, gen);
}

export async function openBlankProject() {
  const gen = ++switchGen;
  await persistOpenProject();
  if (gen !== switchGen) return;
  parkCurrentSession();
  const id = `draft-${newId()}`;
  currentProjectId = id;
  rememberTab(id, '未命名');
  goStep('model');
}

async function saveAsNew(name) {
  const prev = currentProjectId;
  currentProjectId = null;
  try {
    const id = await saveCurrentProject(name);
    if (!id) currentProjectId = prev;
    return id;
  } catch (e) {
    currentProjectId = prev;
    throw e;
  }
}

async function openProject(id, onOpened) {
  const gen = ++switchGen;
  const prev = currentProjectId;
  /* 从列表再打开：丢掉这份内存现场，按存档重新生成支撑。 */
  if (prev === id) {
    if (state.parts.length && !String(id).startsWith('draft-')) await persistOpenProject();
    if (gen !== switchGen) return;
    discardLive(parkLive());
    discardSession(id);
  } else if (prev) {
    await persistOpenProject();
    if (gen !== switchGen) return;
    parkCurrentSession();
    discardSession(id);
  }
  const ok = await loadProjectFromArchive(id, onOpened, gen);
  if (!ok && gen === switchGen && prev && prev !== id && sessions.has(prev)) {
    await activateProject(prev, gen);
  }
}

async function loadProjectFromArchive(id, onOpened, gen) {
  let applied = false;
  try {
    const row = await readProject(id);
    if (gen != null && gen !== switchGen) return false;
    if (!row || !row.parts || !row.parts.length) {
      if (!row && !openTabs.some(t => t.id === id)) {
        toast('这个工程已经不在了');
        return false;
      }
      currentProjectId = id;
      const tab = openTabs.find(t => t.id === id);
      rememberTab(id, (row && row.name) || (tab && tab.name) || '未命名');
      emitTabs();
      goStep('model');
      if (onOpened) onOpened();
      return true;
    }
    if (row.machineId) selectMachine(row.machineId);
    else if (row.params) {
      for (const key of ['plateX', 'plateY', 'plateZ', 'pixelUm']) {
        if (Number.isFinite(row.params[key])) setMachineParam(key, row.params[key]);
      }
    }
    restoreParams(row.params);
    /* 支撑点按保存时的世界高度记下。当时「模型抬高」已经生效，连接底板的板高也加在 y 上。
       新开会话这两项都是 0：模型会贴回平台，接着重建又按当前板高把点再抬一次，针尖就离开模型。
       这里先按存档提交同一套抬高，后面的分析和重建看到的高度和点一致，不会再叠一层。
       旧存档没有这两项时，有支撑点就视为抬高已开，板高按当前参数推。 */
    if (row.points && row.points.length) {
      state.supportLiftOn = row.supportLiftOn != null ? !!row.supportLiftOn : true;
      state.joinLift = Number.isFinite(row.joinLift) ? row.joinLift : joinLiftWanted(params);
    }
    const n = applyProjectParts(row.parts, row.points);
    if (!n) { toast('工程里没有模型'); return false; }
    applied = true;
    currentProjectId = id;
    rememberTab(id, row.name);
    goStep('model');
    if (onOpened) onOpened();
    if (row.points && row.points.length) {
      await runSliceAnalysis();
      if (gen != null && gen !== switchGen) return true;
      await rebuildStructure();
    }
    return true;
  } finally {
    if (applied && gen != null && gen !== switchGen) discardSession(id);
  }
}

async function insertItem(id, onInserted) {
  const row = await readLibraryItem(id);
  if (!row || !row.parts || !row.parts[0]) { toast('这个零件已经不在了'); return; }
  const added = appendArchivedPart(row.parts[0], row.kind === 'supported' ? row.points : []);
  if (!added) { toast('零件数据不完整'); return; }
  onInserted();
  if (added.points) {
    await runSliceAnalysis();
    await rebuildStructure();
  }
}

let addingLibrary = false;

/** 右键菜单「添加到零件库」：把当前选中的那一件（含它自己的支撑点）存进库。 */
export async function addSelectedPartToLibrary() {
  if (addingLibrary) return;
  const parts = selectedParts();
  if (parts.length !== 1) { toast('先选中一个模型'); return; }
  const part = parts[0];
  addingLibrary = true;
  try {
    const cap = captureParts([part], true);
    const title = part.name || '未命名';
    await saveLibraryItem({
      id: newId(),
      name: title,
      savedAt: Date.now(),
      kind: cap.points.length ? 'supported' : 'part',
      faces: cap.faces,
      partCount: 1,
      pointCount: cap.points.length,
      folderId: '',
      parts: cap.parts,
      points: cap.points,
      thumb: makeThumb([part], cap.points),
    });
    toast(`已加入零件库「${title}」`);
  } catch {
    toast('加入零件库失败', { tone: 'danger' });
  } finally {
    addingLibrary = false;
  }
}

bus.on('addToLibrary', () => { addSelectedPartToLibrary(); });

async function moveLibraryItem(id, folderId) {
  const row = await readLibraryItem(id);
  if (!row) { toast('这个零件已经不在了'); return; }
  await saveLibraryItem({ ...row, folderId: folderId || '' });
}

function useLists() {
  const [projects, setProjects] = useState([]);
  const [library, setLibrary] = useState([]);
  const reload = () => {
    listProjects().then(setProjects).catch(() => setProjects([]));
    listLibrary().then(setLibrary).catch(() => setLibrary([]));
  };
  useEffect(() => {
    reload();
    return bus.on('archive', reload);
  }, []);
  return { projects, library, reload };
}

function useThumbBackfill(kind, rows) {
  const tried = useRef(new Set());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const row of rows.slice(0, 16)) {
        if (cancelled) break;
        /* 正在看的这一条用摄影机快照，不要再用固定机位盖掉。 */
        if (kind === 'projects' && row.id === liveProjectId(rows)) continue;
        if (row.thumb || tried.current.has(row.id)) continue;
        tried.current.add(row.id);
        try {
          const full = kind === 'projects' ? await readProject(row.id) : await readLibraryItem(row.id);
          if (!full?.parts?.length) continue;
          await new Promise(r => setTimeout(r, 16));
          const saved = full.params || {};
          const lift = Math.max(0, Number(saved.raiseH) || 0) + (full.points?.length ? joinLiftWanted(saved) : 0);
          const thumb = makeThumb(full.parts, full.points, lift);
          if (!thumb) continue;
          if (kind === 'projects') await updateProjectThumb(row.id, thumb);
          else await updateLibraryThumb(row.id, thumb);
          await new Promise(r => setTimeout(r, 16));
        } catch {
          /* 缩略图失败不影响列表 */
        }
      }
    })();
    return () => { cancelled = true; };
  }, [kind, rows]);
}

function useStars() {
  const [stars, setStars] = useState(loadStars);
  const toggle = (kind, id) => {
    setStars(prev => {
      const next = { projects: new Set(prev.projects), library: new Set(prev.library) };
      const bag = next[kind];
      if (bag.has(id)) bag.delete(id);
      else bag.add(id);
      writeStars(next);
      return next;
    });
  };
  return { stars, toggle };
}

function sortRows(rows, key, dir) {
  const copy = rows.slice();
  copy.sort((a, b) => {
    if (key === 'name') return a.name.localeCompare(b.name, 'zh') * dir;
    if (key === 'faces') return ((a.faces || 0) - (b.faces || 0)) * dir;
    return ((a.savedAt || 0) - (b.savedAt || 0)) * dir;
  });
  return copy;
}

function matchName(row, q) {
  if (!q) return true;
  return (row.name || '').toLowerCase().includes(q.trim().toLowerCase());
}

function Thumb({ src }) {
  return src
    ? <img className="stuThumb" src={src} alt="" loading="lazy" draggable={false} />
    : <div className="stuThumbFallback" aria-hidden="true"><Box size={24} strokeWidth={1.5} /></div>;
}

const FOLDER_TONES = ['teal', 'silver', 'coral'];

function folderTone(id) {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n + id.charCodeAt(i)) % FOLDER_TONES.length;
  return FOLDER_TONES[n];
}

/* 文件夹和零件用同一张卡片：图在媒体区，名字和数量在下面。 */
function FolderCard({ id, tone, name, count, onOpen, menu }) {
  const label = count ? `${count} 个文件` : '空文件夹';
  return (
    <Card
      className="stuTile stuFolderCard"
      data-tone={tone || folderTone(id)}
      title={name}
      status={label}
      role="button"
      tabIndex={0}
      whileTap={{ scale: 0.97 }}
      onClick={onOpen}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      }}
      media={(
        <Well
          tools={menu ? (
            <div className="stuWellBar" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
              <span />
              <span className="stuWellTools">
                <TileMenu label="更多" items={menu} />
              </span>
            </div>
          ) : null}
        >
          <span className="stuFolderArt" aria-hidden="true">
            <span className="stuFolderBody">
              <span className="stuFolderTab" />
            </span>
          </span>
        </Well>
      )}
    />
  );
}

function Well({ children, tools }) {
  return (
    <div className="stuWell">
      {children}
      {tools}
    </div>
  );
}

function TileMenu({ label, items }) {
  return (
    <DropdownMenu
      label={label}
      hideLabel
      hideChevron
      icon={<MoreHorizontal size={16} strokeWidth={1.75} />}
      items={items}
    />
  );
}

function FileTile({ pickId, title, description, thumb, art, selected, starred, showActions = true, onOpen, onToggle, onStar, menu }) {
  const hasBar = Boolean(onToggle || (showActions && (onStar || menu)));
  return (
    <Card
      className="stuTile"
      data-pick-id={pickId || undefined}
      title={title}
      status={description || undefined}
      data-selected={selected || undefined}
      role="button"
      tabIndex={0}
      whileTap={{ scale: 0.97 }}
      onClick={onOpen}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      }}
      media={(
        <Well
          tools={hasBar ? (
            <div className="stuWellBar" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
              {onToggle ? (
                <span className="stuWellPick">
                  <Checkbox aria-label={`选择 ${title}`} checked={selected} onCheckedChange={onToggle} />
                </span>
              ) : <span />}
              {showActions && (onStar || menu) ? (
                <span className="stuWellTools">
                  {onStar ? (
                    <button type="button" className="stuIconBtn" aria-label={starred ? '取消收藏' : '收藏'} aria-pressed={starred} onClick={onStar}>
                      <Star size={14} strokeWidth={1.75} fill={starred ? 'currentColor' : 'none'} />
                    </button>
                  ) : null}
                  {menu ? <TileMenu label="更多" items={menu} /> : null}
                </span>
              ) : null}
            </div>
          ) : null}
        >
          {art || <Thumb src={thumb} />}
        </Well>
      )}
    />
  );
}

function SearchField({ value, onChange, placeholder = '输入' }) {
  return (
    <div className="stuSearch">
      <Search size={15} strokeWidth={1.75} className="stuSearchIcon" aria-hidden="true" />
      <Input label="搜索" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function ProjectBar({ count, sortKey, sortDir, onSort, onDir, filter, onFilter }) {
  const sortName = { savedAt: '时间', name: '名称', faces: '面数' };
  return (
    <div className="stuFileBar">
      <span className="stuFileCount"><b className="tnum">{count}</b> 个文件</span>
      <div className="stuFileTools">
        <SegmentedControl
          className="stuFileSeg"
          label="筛选"
          value={filter}
          onValueChange={onFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'supported', label: '有支撑' },
            { value: 'plain', label: '无支撑' },
          ]}
        />
        <SegmentedControl
          className="stuFileSeg"
          label="排序，再点当前项切换升降"
          value={sortKey}
          onValueChange={key => { if (key === sortKey) onDir(); else onSort(key); }}
          options={['savedAt', 'name', 'faces'].map(key => ({
            value: key,
            label: sortName[key],
            accessory: key === sortKey
              ? (sortDir < 0 ? <ArrowDown size={12} strokeWidth={1.75} aria-hidden="true" /> : <ArrowUp size={12} strokeWidth={1.75} aria-hidden="true" />)
              : null,
          }))}
        />
      </div>
    </div>
  );
}

function Dashboard({ projects, onOpen, onNew }) {
  const [q, setQ] = useState('');
  const [range, setRange] = useState('all');

  const rows = useMemo(() => {
    const cutoff = timeCutoff(range);
    const needle = q.trim().toLowerCase();
    return projects.filter(p => {
      if (cutoff && (p.savedAt || 0) < cutoff) return false;
      if (!needle) return true;
      return (p.name || '').toLowerCase().includes(needle)
        || when(p.savedAt).toLowerCase().includes(needle);
    });
  }, [projects, q, range]);

  const searching = Boolean(q.trim()) || range !== 'all';
  const visible = useMemo(() => (searching ? rows : rows.slice(0, 8)), [rows, searching]);
  const rangeLabel = TIME_RANGES.find(r => r.value === range)?.label || '全部时间';
  useThumbBackfill('projects', visible);

  return (
    <div className="stuDeskBody">
      <div className="stuPageHead">
        <h2>工程</h2>
        <div className="stuPageActs">
          <SearchField value={q} onChange={setQ} placeholder="搜索工程或日期" />
          <DropdownMenu
            label={rangeLabel}
            items={TIME_RANGES.map(r => ({ label: r.label, onSelect: () => setRange(r.value) }))}
          />
          <Button className="stuBtnAccent" onClick={onNew}>
            <Plus size={15} strokeWidth={1.75} /> 新建工程
          </Button>
        </div>
      </div>
      <div className="stuSectionHead">
        <h3>{searching ? '搜索结果' : '最近项目'}</h3>
        {searching ? <span className="stuSectionMeta">{rows.length} 个工程</span> : null}
      </div>
      {visible.length ? (
        <div className="stuTileGrid">
          {visible.map(p => (
            <FileTile
              key={p.id}
              title={p.name}
              description={when(p.savedAt)}
              thumb={p.thumb}
              selected={false}
              onOpen={() => onOpen(p.id)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title={searching ? '没有符合条件的工程' : '还没有工程'}
          description={searching ? '换个关键词或时间范围。' : '保存当前这一盘，或导入模型后再保存。'}
          action={searching ? null : <Button onClick={onNew}>新建工程</Button>}
        />
      )}
    </div>
  );
}

const MARQUEE_SLOP = 6;
const MARQUEE_IGNORE = 'button, a, input, textarea, select, label, [role="checkbox"], [role="menuitem"], [role="option"]';

function rectsHit(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function picksInBox(root, box) {
  const ids = [];
  root.querySelectorAll('[data-pick-id]').forEach(el => {
    if (rectsHit(el.getBoundingClientRect(), box)) ids.push(el.getAttribute('data-pick-id'));
  });
  return ids;
}

/* 在空白处按住拖出矩形，圈中的工程卡片变成已选。点一下卡片仍是打开，不跟框选抢。 */
function useMarqueePick(rootRef, pickedRef, setPicked) {
  const [box, setBox] = useState(null);
  const skipClick = useRef(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let drag = null;
    const move = e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < MARQUEE_SLOP) return;
      drag.moved = true;
      const rect = {
        left: Math.min(drag.x, e.clientX),
        top: Math.min(drag.y, e.clientY),
        right: Math.max(drag.x, e.clientX),
        bottom: Math.max(drag.y, e.clientY),
      };
      const desk = root.closest('.stuDesk');
      if (desk) {
        const edge = desk.getBoundingClientRect();
        if (e.clientY > edge.bottom - 28) desk.scrollTop += 14;
        else if (e.clientY < edge.top + 28) desk.scrollTop -= 14;
      }
      setBox(rect);
      const next = new Set(drag.base);
      for (const id of picksInBox(root, rect)) next.add(id);
      setPicked(next);
    };
    const up = e => {
      if (!drag) return;
      const was = drag;
      drag = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setBox(null);
      if (was.moved) {
        skipClick.current = true;
        return;
      }
      if (!e.target.closest('.stuTile')) setPicked(new Set());
    };
    const down = e => {
      if (e.button !== 0) return;
      if (e.target.closest(MARQUEE_IGNORE)) return;
      drag = {
        x: e.clientX,
        y: e.clientY,
        moved: false,
        base: e.shiftKey ? new Set(pickedRef.current) : new Set(),
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };
    const eatClick = e => {
      if (!skipClick.current) return;
      skipClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    root.addEventListener('pointerdown', down);
    root.addEventListener('click', eatClick, true);
    return () => {
      drag = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      root.removeEventListener('pointerdown', down);
      root.removeEventListener('click', eatClick, true);
    };
  }, [rootRef, pickedRef, setPicked]);

  return box;
}

function Projects({ projects, onOpen, onImport, onNew }) {
  const [q, setQ] = useState('');
  const [sortKey, setSortKey] = useState('savedAt');
  const [sortDir, setSortDir] = useState(-1);
  const [filter, setFilter] = useState('all');
  const [picked, setPicked] = useState(() => new Set());
  const bodyRef = useRef(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const box = useMarqueePick(bodyRef, pickedRef, setPicked);

  const rows = useMemo(() => {
    let list = projects.filter(p => matchName(p, q));
    if (filter === 'supported') list = list.filter(p => p.points > 0);
    if (filter === 'plain') list = list.filter(p => !p.points);
    return sortRows(list, sortKey, sortDir);
  }, [projects, q, filter, sortKey, sortDir]);
  useThumbBackfill('projects', rows);

  const removePicked = async () => {
    const ids = [...picked];
    for (const id of ids) await deleteProject(id);
    if (picked.has(currentProjectId)) currentProjectId = null;
    setPicked(new Set());
  };
  const toggle = id => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="stuDeskBody" ref={bodyRef} data-marquee={box ? '1' : undefined}>
      <div className="stuPageHead">
        <h2>项目</h2>
        <div className="stuPageActs">
          <SearchField value={q} onChange={setQ} />
          <Button className="stuBtnAccent" onClick={onImport}>
            <Upload size={15} strokeWidth={1.75} /> 导入
          </Button>
          <Button onClick={onNew}>
            <Plus size={15} strokeWidth={1.75} /> 新建
          </Button>
        </div>
      </div>
      <ProjectBar
        count={rows.length}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={setSortKey}
        onDir={() => setSortDir(d => -d)}
        filter={filter}
        onFilter={setFilter}
      />
      {picked.size ? (
        <div className="stuPickBar">
          <span>已选 {picked.size}</span>
          <Button variant="danger" size="sm" onClick={removePicked}>删除</Button>
        </div>
      ) : null}
      {rows.length ? (
        <div className="stuTileGrid">
          {rows.map(p => (
            <FileTile
              key={p.id}
              pickId={p.id}
              title={p.name}
              description={when(p.savedAt)}
              thumb={p.thumb}
              selected={picked.has(p.id)}
              showActions={false}
              onOpen={() => onOpen(p.id)}
              onToggle={() => toggle(p.id)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title={q || filter !== 'all' ? '没有符合的工程' : '还没有工程文件'}
          description={q || filter !== 'all' ? '换个词，或把筛选改回全部。' : '保存当前打印板，卡片会出现在这里。'}
          action={q || filter !== 'all' ? null : <Button onClick={onNew}>新建</Button>}
        />
      )}
      {box ? createPortal(
        <div
          className="stuMarquee"
          style={{ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }}
        />,
        document.body,
      ) : null}
    </div>
  );
}

function Library({ library, stars, onInsert, onStar }) {
  const [q, setQ] = useState('');
  const [folderId, setFolderId] = useState('');
  const [folders, setFolders] = useState(() => {
    const raw = readJson(FOLDER_KEY, []);
    return Array.isArray(raw) ? raw : [];
  });
  const [picked, setPicked] = useState(() => new Set());
  const [folderName, setFolderName] = useState('');
  const [naming, setNaming] = useState(false);

  const persistFolders = next => {
    setFolders(next);
    localStorage.setItem(FOLDER_KEY, JSON.stringify(next));
  };

  const rows = useMemo(() => {
    let list = library.filter(item => matchName(item, q));
    if (folderId) list = list.filter(item => item.folderId === folderId);
    else if (!q) list = list.filter(item => !item.folderId);
    return sortRows(list, 'savedAt', -1);
  }, [library, q, folderId]);
  useThumbBackfill('library', rows);

  const visibleFolders = useMemo(() => {
    if (folderId) return [];
    return folders.filter(f => matchName(f, q)).map(f => {
      return {
        ...f,
        count: library.filter(item => item.folderId === f.id).length,
      };
    });
  }, [folders, library, q, folderId]);

  const openFolder = folders.find(f => f.id === folderId) || null;

  const createFolder = () => {
    const title = folderName.trim();
    if (!title) { toast('先写文件夹名'); return; }
    if (folders.some(f => f.name === title)) { toast('已经有同名文件夹'); return; }
    persistFolders([...folders, { id: newId(), name: title, savedAt: Date.now() }]);
    setFolderName('');
    setNaming(false);
  };

  const removeFolder = async id => {
    const inside = library.filter(item => item.folderId === id);
    for (const item of inside) await moveLibraryItem(item.id, '');
    persistFolders(folders.filter(f => f.id !== id));
    if (folderId === id) setFolderId('');
  };

  const remove = async id => {
    await deleteLibraryItem(id);
    setPicked(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const removePicked = async () => {
    for (const id of picked) await deleteLibraryItem(id);
    setPicked(new Set());
  };

  const toggle = id => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="stuDeskBody">
      <div className="stuPageHead">
        <div className="stuPageLead">
          <h2>零件库</h2>
        </div>
        <div className="stuPageActs">
          <Popover open={naming} onOpenChange={open => { setNaming(open); if (!open) setFolderName(''); }}>
            <PopoverTrigger className="stuIconBtn stuDirBtn" aria-label="新建文件夹">
              <FolderPlus size={15} strokeWidth={1.75} />
            </PopoverTrigger>
            <PopoverContent className="stuFolderPop" side="bottom" align="end">
              <Input
                label="文件夹名称"
                placeholder="例如 手办"
                value={folderName}
                autoFocus
                onChange={e => setFolderName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createFolder(); }}
              />
              <Button size="sm" onClick={createFolder}>创建</Button>
            </PopoverContent>
          </Popover>
          <SearchField value={q} onChange={setQ} />
        </div>
      </div>
      {openFolder ? (
        <p className="stuCrumb">
          <button type="button" onClick={() => setFolderId('')}>零件库</button>
          <span> / {openFolder.name}</span>
        </p>
      ) : null}
      {openFolder ? (
        <div className="stuSectionHead">
          <h3>{openFolder.name}</h3>
        </div>
      ) : null}
      {picked.size ? (
        <div className="stuPickBar">
          <span>已选 {picked.size}</span>
          <Button variant="danger" size="sm" onClick={removePicked}>删除</Button>
        </div>
      ) : null}
      {visibleFolders.length || rows.length ? (
        <div className="stuTileGrid">
          {visibleFolders.map((f, i) => (
            <FolderCard
              key={f.id}
              id={f.id}
              tone={FOLDER_TONES[i % FOLDER_TONES.length]}
              name={f.name}
              count={f.count}
              onOpen={() => setFolderId(f.id)}
              menu={[
                { label: '打开', onSelect: () => setFolderId(f.id) },
                { label: '删除文件夹', destructive: true, separatorBefore: true, onSelect: () => removeFolder(f.id) },
              ]}
            />
          ))}
          {rows.map(p => (
            <FileTile
              key={p.id}
              title={p.name}
              description={`${(p.faces || 0).toLocaleString()} 面`}
              thumb={p.thumb}
              selected={picked.has(p.id)}
              starred={stars.library.has(p.id)}
              onOpen={() => onInsert(p.id)}
              onToggle={() => toggle(p.id)}
              onStar={() => onStar(p.id)}
              menu={[
                { label: '放到板上', onSelect: () => onInsert(p.id) },
                { label: stars.library.has(p.id) ? '取消收藏' : '收藏', onSelect: () => onStar(p.id) },
                ...folders.filter(f => f.id !== p.folderId).map(f => ({
                  label: `移到「${f.name}」`,
                  onSelect: () => moveLibraryItem(p.id, f.id),
                })),
                ...(p.folderId ? [{ label: '移出文件夹', onSelect: () => moveLibraryItem(p.id, '') }] : []),
                { label: '删除', destructive: true, separatorBefore: true, onSelect: () => remove(p.id) },
              ]}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          title={q ? '没有符合的零件' : '库是空的'}
          description={q ? '换个词再找。' : '放到板上用卡片，或从工具栏打开抽屉。'}
        />
      )}
    </div>
  );
}

export function PartDrawer({ open, onOpenChange }) {
  const { library } = useLists();
  useThumbBackfill('library', library);
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent title="零件" description="点一张卡片，放到当前板上。" side="right">
        <div className="stuDrawerList">
          {library.map(p => (
            <Card
              key={p.id}
              className="stuTile stuDrawerCard"
              title={p.name}
              description={`${p.kind === 'supported' ? '带支撑' : '零件'} · ${(p.faces || 0).toLocaleString()} 面`}
              role="button"
              tabIndex={0}
              onClick={() => insertItem(p.id, () => onOpenChange(false))}
              media={<Well><Thumb src={p.thumb} /></Well>}
            />
          ))}
          {!library.length ? <EmptyState title="还没有入库的零件" description="库里还没有零件。" /> : null}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

export default function Desk({ page, onClose, onPage }) {
  const { projects, library } = useLists();
  const { stars, toggle } = useStars();
  const open = id => openProject(id, onClose);
  const startNew = async () => {
    if (!state.parts.length) {
      toast('板上还没有模型，先导入或载入演示模型');
      onClose();
      return;
    }
    try {
      const id = await saveAsNew('');
      if (id) onClose();
    } catch {
      toast('保存失败，模型可能太大', { tone: 'danger' });
    }
  };
  const importModel = () => { pickSTL(false); onClose(); };
  useEffect(() => {
    if (page !== 'projects' && page !== 'home') return;
    snapshotCurrentProject().catch(() => {});
  }, [page]);
  if (!page) return null;
  return (
    <section className="stuDesk" aria-label={page === 'home' ? '首页' : page === 'projects' ? '项目' : '库'}>
      {page === 'home' ? (
        <Dashboard
          projects={projects}
          onOpen={open}
          onNew={startNew}
        />
      ) : null}
      {page === 'projects' ? (
        <Projects
          projects={projects}
          onOpen={open}
          onImport={importModel}
          onNew={() => onPage && onPage('new')}
        />
      ) : null}
      {page === 'library' ? (
        <Library
          library={library}
          stars={stars}
          onInsert={id => insertItem(id, onClose)}
          onStar={id => toggle('library', id)}
        />
      ) : null}
    </section>
  );
}
