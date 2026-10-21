import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy, Download, FolderInput, FolderOpen, History, Layers, Pencil, Plus, Printer, Sparkles, Star, Trash2, Upload,
} from 'lucide-react';
import Button from '@/components/arc/button/button';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import { MACHINES, MATERIALS, machineById, machineName, materialById } from '../catalog.js';
import {
  addFolder, deleteParts, deleteProjects, duplicateProject, exportProject, importPartFiles, importProjectFile,
  moveParts, moveProjects, partUsage, renamePart, renameProject, toggleFav, toggleStar, useApp,
} from '../appStore.js';
import { createLivePreview, previewInputOf } from '../preview.js';
import { get as dbGet } from '../db.js';
import { ConfirmDialog, MoveDialog, RenameDialog } from './dialogs.jsx';
import { FolderChips, SearchField } from './workspace.jsx';
import { Empty, MoreMenu, PlateGlyph, Swatch, Thumb, fmtInt, relativeTime, templateName } from './common.jsx';

/* 管理视图：工程列表、零件库、机器、材料。方案一的主页和方案三的资源库共用（布局由外层决定）。 */

/* ---------- 工程 ---------- */

export function useProjectActions({ onOpen }) {
  const app = useApp();
  const [dlg, setDlg] = useState(null);
  const menu = p => [
    { label: '打开', icon: <FolderOpen size={15} />, onSelect: () => onOpen(p.id) },
    { label: '重命名…', icon: <Pencil size={15} />, onSelect: () => setDlg({ type: 'rename', p }) },
    { label: '移动到…', icon: <FolderInput size={15} />, onSelect: () => setDlg({ type: 'move', ids: [p.id], folder: p.folder }) },
    { label: p.starred ? '取消星标' : '加星标', icon: <Star size={15} />, onSelect: () => toggleStar(p.id) },
    { label: '复制工程', icon: <Copy size={15} />, onSelect: () => duplicateProject(p.id) },
    { label: '导出 .rfproj', icon: <Download size={15} />, onSelect: () => exportProject(p.id) },
    { label: '删除…', icon: <Trash2 size={15} />, destructive: true, separatorBefore: true, onSelect: () => setDlg({ type: 'delete', ids: [p.id], name: p.name }) },
  ];
  const dialogs = (
    <>
      <RenameDialog open={dlg?.type === 'rename'} title="重命名工程" initial={dlg?.p?.name}
        onCancel={() => setDlg(null)} onConfirm={v => { renameProject(dlg.p.id, v); setDlg(null); }} />
      <MoveDialog open={dlg?.type === 'move'} count={dlg?.ids?.length || 0} folders={app.projectFolders} initial={dlg?.folder}
        onAddFolder={n => addFolder('project', n)} onCancel={() => setDlg(null)}
        onConfirm={f => { moveProjects(dlg.ids, f); setDlg(null); }} />
      <ConfirmDialog open={dlg?.type === 'delete'}
        title={dlg?.ids?.length > 1 ? `删除 ${dlg.ids.length} 个工程？` : `删除「${dlg?.name}」？`}
        description="工程和它的历史版本都会删掉。零件库不受影响；没有别处引用的模型文件随后回收。"
        onCancel={() => setDlg(null)} onConfirm={() => { deleteProjects(dlg.ids); setDlg(null); }} />
    </>
  );
  return { menu, dialogs, setDlg };
}

export function ProjectMeta({ p }) {
  const m = machineById(p.machineId);
  const mat = materialById(p.materialId);
  return (
    <span className="pdMetaLine">
      <Swatch material={mat} size={11} />
      <span className="pdMetaItem">{m ? m.model : '自定义机器'}</span>
      <span className="pdMetaItem">{mat.name} {p.layerUm} µm</span>
    </span>
  );
}

export function RecentTiles({ projects, onOpen, isDirty }) {
  if (!projects.length) return null;
  return (
    <div className="pdRecent">
      {projects.map(p => (
        <button key={p.id} type="button" className="pdRecentTile" onClick={() => onOpen(p.id)}>
          <Thumb src={p.thumb} className="pdRecentThumb" />
          <span className="pdRecentBody">
            <b>{p.name}{isDirty?.(p.id) ? <i className="pdDirtyDot" aria-label="有未保存的修改" /> : null}</b>
            <ProjectMeta p={p} />
            <small>{p.stats?.points ? `${fmtInt(p.stats.points)} 个支撑点` : '还没有支撑'} · {relativeTime(p.openedAt || p.updatedAt)}</small>
          </span>
        </button>
      ))}
    </div>
  );
}

export function ProjectRows({ projects, onOpen, selected, onToggle, menu, activeId }) {
  return (
    <div className="pdRows" role="table" aria-label="工程">
      <div className="pdRow pdRow--head" role="row">
        <span role="columnheader" className="pdRowCheck" />
        <span role="columnheader">名称</span>
        <span role="columnheader">机器</span>
        <span role="columnheader">材料</span>
        <span role="columnheader" className="pdNum">零件</span>
        <span role="columnheader" className="pdNum">支撑点</span>
        <span role="columnheader" className="pdRowTime">修改</span>
        <span role="columnheader" />
      </div>
      {projects.map(p => {
        const m = machineById(p.machineId);
        const mat = materialById(p.materialId);
        const on = selected?.has(p.id);
        return (
          <div key={p.id} role="row" tabIndex={0} className={'pdRow' + (on ? ' is-checked' : '') + (activeId === p.id ? ' is-active' : '')}
            onClick={() => onOpen(p.id)} onKeyDown={e => { if (e.key === 'Enter') onOpen(p.id); }}>
            <span className="pdRowCheck" role="cell">
              {onToggle ? (
                <span role="checkbox" aria-checked={!!on} aria-label={`选择${p.name}`} tabIndex={0} className={'pdCheck' + (on ? ' is-on' : '')}
                  onClick={e => { e.stopPropagation(); onToggle(p.id); }} onKeyDown={e => { if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggle(p.id); } }} />
              ) : null}
            </span>
            <span role="cell" className="pdRowName">
              <Thumb src={p.thumb} className="pdRowThumb" />
              <span><b>{p.name}</b>{p.starred ? <Star size={12} fill="currentColor" className="pdStar" aria-label="星标" /> : null}</span>
            </span>
            <span role="cell" className="pdRowMuted">{m ? m.model : '自定义机器'}</span>
            <span role="cell" className="pdRowMat"><Swatch material={mat} size={12} />{mat.name} · {p.layerUm} µm</span>
            <span role="cell" className="pdNum">{p.stats?.parts ?? p.desc?.parts?.length ?? 0}</span>
            <span role="cell" className="pdNum">{p.stats?.points ? fmtInt(p.stats.points) : '–'}</span>
            <span role="cell" className="pdRowMuted pdRowTime">{relativeTime(p.updatedAt)}</span>
            <span role="cell" className="pdRowEnd"><MoreMenu items={menu(p)} label={`${p.name} 的操作`} /></span>
          </div>
        );
      })}
    </div>
  );
}

export function ProjectsView({ onOpen, onNew, isDirty, folder = 'all', title = '工程', activeId }) {
  const app = useApp();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const fileRef = useRef(null);
  const { menu, dialogs, setDlg } = useProjectActions({ onOpen });
  const list = useMemo(() => {
    let l = app.projects;
    if (folder === 'starred') l = l.filter(p => p.starred);
    else if (folder !== 'all') l = l.filter(p => p.folder === folder);
    const s = q.trim().toLowerCase();
    if (s) l = l.filter(p => `${p.name} ${machineName(machineById(p.machineId))} ${materialById(p.materialId).name}`.toLowerCase().includes(s));
    return l;
  }, [app.projects, folder, q]);
  const recent = useMemo(() => [...app.projects].sort((a, b) => new Date(b.openedAt || 0) - new Date(a.openedAt || 0)).slice(0, 4), [app.projects]);
  const toggle = id => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <div className="pdView">
      <header className="pdViewHead">
        <h1>{title}</h1>
        <span className="pdCount">{list.length}</span>
        <div className="pdViewTools">
          <SearchField value={q} onChange={setQ} placeholder="搜索工程、机器、材料" />
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}><Upload size={15} />导入工程</Button>
          <Button variant="primary" size="sm" onClick={onNew}><Plus size={15} />新建工程</Button>
          <input ref={fileRef} type="file" accept=".rfproj" hidden onChange={e => { if (e.target.files[0]) importProjectFile(e.target.files[0]); e.target.value = ''; }} />
        </div>
      </header>
      <ScrollArea className="pdViewScroll" fade={24}>
        <div className="pdViewBody">
          {folder === 'all' && !q ? (
            <section className="pdSection">
              <h2>最近打开</h2>
              <RecentTiles projects={recent} onOpen={onOpen} isDirty={isDirty} />
            </section>
          ) : null}
          <section className="pdSection">
            {folder === 'all' && !q ? <h2>全部工程</h2> : null}
            {list.length ? (
              <ProjectRows projects={list} onOpen={onOpen} selected={sel} onToggle={toggle} menu={menu} activeId={activeId} />
            ) : <Empty icon={<FolderOpen size={18} />} title={q ? '没有匹配的工程' : '这里还没有工程'}>{q ? '换个关键词试试。' : '新建一个，或者导入 .rfproj 文件。'}</Empty>}
          </section>
        </div>
      </ScrollArea>
      {sel.size ? (
        <div className="pdBatch" role="toolbar" aria-label="批量操作">
          <b>已选 {sel.size} 个工程</b>
          <Button variant="ghost" size="sm" onClick={() => setDlg({ type: 'move', ids: [...sel] })}><FolderInput size={14} />移动到</Button>
          <Button variant="ghost" size="sm" onClick={() => { for (const id of sel) toggleStar(id); setSel(new Set()); }}><Star size={14} />星标</Button>
          <Button variant="danger" size="sm" onClick={() => setDlg({ type: 'delete', ids: [...sel], name: '' })}><Trash2 size={14} />删除</Button>
          <Button variant="ghost" size="sm" onClick={() => setSel(new Set())}>取消</Button>
        </div>
      ) : null}
      {dialogs}
    </div>
  );
}

/* ---------- 零件库 ---------- */

export function LivePreview({ item, color = '#a3a9b2', className = '' }) {
  const ref = useRef(null);
  const view = useRef(null);
  const [state, setState] = useState('loading');
  useEffect(() => {
    view.current = createLivePreview(ref.current);
    return () => { view.current?.dispose(); view.current = null; };
  }, []);
  useEffect(() => {
    let alive = true;
    if (!item) return undefined;
    setState('loading');
    previewInputOf(item, hash => dbGet('blobs', hash)).then(input => {
      if (!alive || !view.current) return;
      view.current.update({ ...input, color });
      setState('ready');
    }).catch(() => { if (alive) setState('error'); });
    return () => { alive = false; };
  }, [item, color]);
  return (
    <div className={'pdLive ' + className} data-state={state}>
      <canvas ref={ref} aria-label="3D 预览，可拖动旋转" />
      {state === 'loading' ? <span className="pdLiveNote">载入模型…</span> : null}
      {state === 'error' ? <span className="pdLiveNote">模型文件读不出来</span> : null}
    </div>
  );
}

export function PartInspector({ entry, onInsertTo, onNewWith }) {
  const app = useApp();
  const [dlg, setDlg] = useState(null);
  if (!entry) return <aside className="pdInspector"><Empty title="选一个零件">在这里预览、查看支撑，放进工程。</Empty></aside>;
  const used = partUsage(entry.id);
  const folder = app.partFolders.find(f => f.id === entry.folder)?.name || '未分组';
  return (
    <aside className="pdInspector" aria-label="零件详情">
      <LivePreview item={entry} className="pdInspectorLive" />
      <div className="pdInspectorBody">
        <div className="pdInspectorTitle">
          <h2>{entry.name}</h2>
          <MoreMenu label="零件操作" items={[
            { label: '重命名…', icon: <Pencil size={15} />, onSelect: () => setDlg('rename') },
            { label: '移动到…', icon: <FolderInput size={15} />, onSelect: () => setDlg('move') },
            { label: entry.fav ? '取消收藏' : '收藏', icon: <Star size={15} />, onSelect: () => toggleFav(entry.id) },
            { label: '删除…', icon: <Trash2 size={15} />, destructive: true, separatorBefore: true, onSelect: () => setDlg('delete') },
          ]} />
        </div>
        <dl className="pdFacts">
          <div><dt>支撑</dt><dd>{entry.sup ? `${entry.sup.points.length} 个点 · ${templateName(entry.sup.template)}模板` : '只有模型'}</dd></div>
          <div><dt>尺寸</dt><dd>{entry.size ? `${entry.size.x.toFixed(1)} × ${entry.size.z.toFixed(1)} × ${entry.size.y.toFixed(1)} mm` : '–'}</dd></div>
          <div><dt>面数</dt><dd>{fmtInt(entry.faces)}</dd></div>
          <div><dt>文件夹</dt><dd>{folder}</dd></div>
          <div><dt>被引用</dt><dd>{used ? `${used} 个工程` : '还没有工程用到'}</dd></div>
          <div><dt>更新</dt><dd>{relativeTime(entry.updatedAt)}</dd></div>
        </dl>
        {entry.sup ? <p className="pdNote">预览里的细针是保存的支撑点；放进工程后按工程的参数重建完整的支撑结构。</p> : null}
        <div className="pdInspectorActions">
          <Button variant="primary" size="sm" onClick={() => onInsertTo(entry)}><Plus size={15} />放进工程</Button>
          <Button variant="secondary" size="sm" onClick={() => onNewWith(entry)}><Sparkles size={15} />用它新建工程</Button>
        </div>
      </div>
      <RenameDialog open={dlg === 'rename'} title="重命名零件" initial={entry.name} onCancel={() => setDlg(null)} onConfirm={v => { renamePart(entry.id, v); setDlg(null); }} />
      <MoveDialog open={dlg === 'move'} count={1} folders={app.partFolders} initial={entry.folder} onAddFolder={n => addFolder('part', n)} onCancel={() => setDlg(null)} onConfirm={f => { moveParts([entry.id], f); setDlg(null); }} />
      <ConfirmDialog open={dlg === 'delete'} title={`删除「${entry.name}」？`}
        description={used ? `有 ${used} 个工程用到它。工程里放的是副本，删掉库里的条目不影响这些工程。` : '从零件库里删掉；模型文件没有别处引用时随后回收。'}
        onCancel={() => setDlg(null)} onConfirm={() => { deleteParts([entry.id]); setDlg(null); }} />
    </aside>
  );
}

export function PartsView({ folder: folderProp = 'all', onInsertTo, onNewWith, title = '零件库', showFolders = true }) {
  const app = useApp();
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState(folderProp);
  const [selId, setSelId] = useState(null);
  const fileRef = useRef(null);
  useEffect(() => { setFolder(folderProp); }, [folderProp]);
  const list = useMemo(() => {
    let l = app.library;
    if (folder === 'sup') l = l.filter(e => e.sup);
    else if (folder === 'fav') l = l.filter(e => e.fav);
    else if (folder !== 'all') l = l.filter(e => e.folder === folder);
    const s = q.trim().toLowerCase();
    if (s) l = l.filter(e => `${e.name} ${(e.tags || []).join(' ')}`.toLowerCase().includes(s));
    return l;
  }, [app.library, folder, q]);
  const sel = list.find(e => e.id === selId) || list[0] || null;
  const drop = e => { if (e.dataTransfer.files?.length) { e.preventDefault(); e.stopPropagation(); importPartFiles(e.dataTransfer.files, ['all', 'sup', 'fav'].includes(folder) ? 'test' : folder); } };
  return (
    <div className="pdView pdView--split" onDragOver={e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); } }} onDrop={drop}>
      <div className="pdViewMain">
        <header className="pdViewHead">
          <h1>{title}</h1>
          <span className="pdCount">{list.length}</span>
          <div className="pdViewTools">
            <SearchField value={q} onChange={setQ} placeholder="搜索零件、标签" />
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}><Upload size={15} />导入 STL</Button>
            <input ref={fileRef} type="file" accept=".stl" multiple hidden onChange={e => { importPartFiles(e.target.files, ['all', 'sup', 'fav'].includes(folder) ? 'test' : folder); e.target.value = ''; }} />
          </div>
        </header>
        {showFolders ? <div className="pdViewFilters"><FolderChips folders={app.partFolders} value={folder} onChange={setFolder} /></div> : null}
        <ScrollArea className="pdViewScroll" fade={24}>
          {list.length ? (
            <div className="pdPartGrid">
              {list.map(e => (
                <button key={e.id} type="button" className={'pdPart' + (sel?.id === e.id ? ' is-on' : '')} onClick={() => setSelId(e.id)} onDoubleClick={() => onInsertTo(e)}>
                  <Thumb src={e.thumb} className="pdPartThumb" />
                  <span className="pdPartName">{e.name}{e.fav ? <Star size={11} fill="currentColor" className="pdStar" /> : null}</span>
                  <span className="pdPartMeta">{e.sup ? <><Layers size={11} />{e.sup.points.length} 个支撑点</> : '只有模型'}</span>
                </button>
              ))}
            </div>
          ) : <Empty icon={<Upload size={18} />} title={q ? '没有匹配的零件' : '这个文件夹还是空的'}>把 STL 拖到这里导入；同一个文件只存一份。</Empty>}
        </ScrollArea>
      </div>
      <PartInspector entry={sel} onInsertTo={onInsertTo} onNewWith={onNewWith} />
    </div>
  );
}

/* ---------- 机器 ---------- */

export function MachinesView({ defaultId, onMakeDefault }) {
  return (
    <div className="pdView">
      <header className="pdViewHead">
        <h1>机器</h1>
        <span className="pdCount">{MACHINES.length}</span>
      </header>
      <ScrollArea className="pdViewScroll" fade={24}>
        <p className="pdLead">机器是参数档案：决定板面、打印高度和 XY 像素，不要求机器在线。板面按同一比例画，便于比较大小。</p>
        <div className="pdMachineGrid">
          {MACHINES.map(m => (
            <div key={m.id} className={'pdMachine' + (m.id === defaultId ? ' is-default' : '')}>
              <div className="pdMachineArt"><PlateGlyph machine={m} box={168} /></div>
              <div className="pdMachineBody">
                <b>{m.brand} {m.model}</b>
                <span>{m.plateX} × {m.plateZ} mm 板面 · 高 {m.plateY} mm</span>
                <span>XY 像素 {m.pixelUm} µm</span>
              </div>
              {m.id === defaultId ? <span className="pdDefault">新建默认</span> : (
                <Button variant="ghost" size="sm" onClick={() => onMakeDefault(m.id)}>设为新建默认</Button>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/* ---------- 材料 ---------- */

export function MaterialsView({ defaultId, onMakeDefault }) {
  return (
    <div className="pdView">
      <header className="pdViewHead">
        <h1>材料</h1>
        <span className="pdCount">{MATERIALS.length}</span>
      </header>
      <ScrollArea className="pdViewScroll" fade={24}>
        <p className="pdLead">选材料会带出可选层厚和默认支撑模板；工程保存的是展开后的参数快照。价格为演示值。</p>
        <div className="pdMaterialList">
          {MATERIALS.map(m => (
            <div key={m.id} className={'pdMaterial' + (m.id === defaultId ? ' is-default' : '')}>
              <Swatch material={m} size={40} />
              <span className="pdMaterialMain">
                <b>{m.name}</b>
                <small>{m.note}</small>
              </span>
              <span className="pdMaterialFact"><small>层厚</small>{m.layers.join(' / ')} µm</span>
              <span className="pdMaterialFact"><small>默认支撑</small>{templateName(m.template)}</span>
              <span className="pdMaterialFact"><small>密度</small>{m.density} g/cm³</span>
              <span className="pdMaterialFact"><small>价格</small>{m.price} 元/kg</span>
              {m.id === defaultId ? <span className="pdDefault">新建默认</span> : (
                <Button variant="ghost" size="sm" onClick={() => onMakeDefault(m.id)}>设为新建默认</Button>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

export { History, Printer };
