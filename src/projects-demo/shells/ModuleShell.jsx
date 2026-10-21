import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Boxes, Copy, Download, Droplet, FolderOpen, Grid2X2, History, Layers, Pencil, Printer, RotateCcw, Save, Star, Upload,
} from 'lucide-react';
import Button from '@/components/arc/button/button';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import { machineById, materialById } from '../catalog.js';
import { plateHit } from '../engine.js';
import {
  duplicateProject, exportProject, getApp, importProjectFile, insertPart, loadVersions, newProject, openProject,
  restoreVersion, saveCurrent, setLastConfig, toggleStar, useApp,
} from '../appStore.js';
import { NewProjectDialog } from '../ui/dialogs.jsx';
import { LoadingCard, ObjectsList, OpenFileButton, PartTile, SearchField, TitleBar, WorkspaceShell } from '../ui/workspace.jsx';
import { LivePreview, MachinesView, MaterialsView, PartsView, ProjectMeta, useProjectActions } from '../ui/views.jsx';
import { Empty, MoreMenu, Thumb, fmtInt, relativeTime, templateName } from '../ui/common.jsx';

/* 方案三 · 资源库模块 + 工作区模块（参照 Lightroom 的「图库 / 修改照片」两个模块）
   - 资源库：三栏浏览器。左侧来源（工程 / 零件 / 机器 / 材料），中间大缩略图，右侧检查器带可转动的 3D 预览、
     文件内容和历史版本；双击工程进工作区
   - 工作区：真实 Studio；底部「胶片条」显示资源库里最后看的那一组零件，点一下或拖进视口就放进工程
   - 两个模块用标题栏左端同一个切换器来回切；工程在工作区里一直开着，切回资源库不会关掉它（标题栏正中一直显示它） */

function ModuleSwitch({ mode, onChange }) {
  return (
    <div className="pdModuleSwitch" role="tablist" aria-label="模块">
      <button type="button" role="tab" aria-selected={mode === 'library'} className={mode === 'library' ? 'is-on' : ''} onClick={() => onChange('library')}>资源库</button>
      <button type="button" role="tab" aria-selected={mode === 'work'} className={mode === 'work' ? 'is-on' : ''} onClick={() => onChange('work')}>工作区</button>
    </div>
  );
}

export function ModuleShell({ stageDrop }) {
  const app = useApp();
  const [mode, setMode] = useState('library');
  const [nav, setNav] = useState({ kind: 'projects', folder: 'all' });
  const [strip, setStrip] = useState('all');   // 胶片条显示哪一组零件：资源库里最后看的零件文件夹
  const [newDlg, setNewDlg] = useState(null);

  useEffect(() => { if (nav.kind === 'parts') setStrip(nav.folder); }, [nav]);

  stageDrop.current = {
    enabled: mode === 'work' && !!app.active,
    onPart: (id, e) => {
      const canvas = document.querySelector('.stuStage canvas');
      insertPart(id, canvas ? plateHit(e.clientX, e.clientY, canvas) : null);
    },
  };

  const openInWork = async id => { setMode('work'); await openProject(id); };

  return (
    <div className="pdModuleApp">
      <TitleBar start={<ModuleSwitch mode={mode} onChange={setMode} />} center={<ActiveDoc mode={mode} onWork={() => setMode('work')} />} />
      {mode === 'library' ? (
        <LibraryModule nav={nav} setNav={setNav} onOpen={openInWork}
          onNew={parts => setNewDlg({ parts })}
          onInsert={async entry => { if (!getApp().active) { setNewDlg({ parts: [entry] }); return; } setMode('work'); await insertPart(entry.id); }} />
      ) : (
        <WorkspaceShell
          barEnd={<SaveButton />}
          left={(
            <div className="stuCard pdCard pdCard--objects">
              <div className="pdCardHead"><b className="pdCardTitle">对象</b><span className="pdMuted pdCardName">{app.projects.find(p => p.id === app.active)?.name || ''}</span></div>
              <div className="stuCardBody pdCardBody"><ObjectsList emptyHint="从底部胶片条点一下零件，或者拖进视口。" /></div>
              <div className="pdCardFoot"><span className="pdMuted">零件在底部胶片条里</span><OpenFileButton /></div>
            </div>
          )}
          bottom={app.active ? <Filmstrip folder={strip} setFolder={setStrip} /> : null}
          overlay={<><LoadingCard />{!app.active && !app.loading ? <NoProject onBack={() => setMode('library')} /> : null}</>}
        />
      )}
      {mode === 'library' ? <LoadingCard /> : null}
      <NewProjectDialog open={!!newDlg} initial={app.lastConfig} parts={newDlg?.parts || []} onCancel={() => setNewDlg(null)}
        onCreate={async cfg => { const parts = newDlg?.parts || []; setNewDlg(null); setMode('work'); await newProject(cfg, parts.map(p => p.id)); }} />
    </div>
  );
}

/* 标题栏正中：工作区里开着的工程。在资源库里点它回到工作区 */
function ActiveDoc({ mode, onWork }) {
  const app = useApp();
  const rec = app.projects.find(p => p.id === app.active);
  if (!rec) return null;
  const dot = app.dirty ? <i className="pdDirtyDot" aria-label="有未保存的修改" /> : null;
  return mode === 'library'
    ? <button type="button" className="pdTitleDoc pdTitleDoc--link" onClick={onWork} title="回到工作区"><span>工作区里开着「{rec.name}」</span>{dot}</button>
    : <span className="pdTitleDoc"><span>{rec.name}</span>{dot}</span>;
}

function SaveButton() {
  const app = useApp();
  if (!app.active) return null;
  return (
    <>
      <span className="stuFloatSep" aria-hidden="true" />
      <span className={'pdSaveState' + (app.dirty ? ' is-dirty' : '')}>{app.dirty ? `未保存 ${app.changes.length} 处` : '已保存'}</span>
      <Button variant="primary" size="sm" disabled={!app.dirty || app.busy === 'save' || !!app.loading} onClick={() => saveCurrent()}><Save size={15} />保存</Button>
    </>
  );
}

function NoProject({ onBack }) {
  return (
    <div className="pdLoading"><div className="pdLoadingCard pdNoProject">
      <b className="pdLoadingTitle">工作区里还没有工程</b>
      <p>回到资源库，双击一个工程打开，或者新建一个。</p>
      <Button variant="primary" size="sm" onClick={onBack}>回到资源库</Button>
    </div></div>
  );
}

/* ---------- 工作区底部的胶片条 ---------- */

function Filmstrip({ folder, setFolder }) {
  const app = useApp();
  const list = useMemo(() => (folder === 'all' ? app.library : folder === 'sup' ? app.library.filter(e => e.sup) : app.library.filter(e => e.folder === folder)), [app.library, folder]);
  const name = folder === 'all' ? '全部零件' : folder === 'sup' ? '带支撑的零件' : app.partFolders.find(f => f.id === folder)?.name;
  return (
    <section className="pdFilm" aria-label="零件胶片条">
      <div className="pdFilmHead">
        <b>{name}</b><small>{list.length}</small>
        <select value={folder} onChange={e => setFolder(e.target.value)} aria-label="换一组零件">
          <option value="all">全部零件</option>
          <option value="sup">带支撑的零件</option>
          {app.partFolders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>
      <ScrollArea orientation="horizontal" className="pdFilmScroll" fade={24}>
        <div className="pdFilmRow">
          {list.map(e => <PartTile key={e.id} entry={e} size="sm" onInsert={x => insertPart(x.id)} />)}
        </div>
      </ScrollArea>
    </section>
  );
}

/* ---------- 资源库模块 ---------- */

function LibraryModule({ nav, setNav, onOpen, onNew, onInsert }) {
  const app = useApp();
  const counts = useMemo(() => ({
    all: app.projects.length, starred: app.projects.filter(p => p.starred).length,
    parts: app.library.length, sup: app.library.filter(l => l.sup).length,
  }), [app.projects, app.library]);
  const Src = ({ kind, folder, icon, label, count }) => {
    const on = nav.kind === kind && (folder === undefined || nav.folder === folder);
    return (
      <button type="button" className={'pdNavItem' + (on ? ' is-on' : '')} aria-current={on ? 'page' : undefined} onClick={() => setNav({ kind, folder: folder ?? 'all' })}>
        {icon}<span>{label}</span>{count != null ? <small>{count}</small> : null}
      </button>
    );
  };
  return (
    <div className="pdLib">
      <div className="pdLibBody">
        <nav className="pdNav" aria-label="来源">
          <div className="pdNavGroup">
            <span className="pdNavLabel">工程</span>
            <Src kind="projects" folder="all" icon={<Grid2X2 size={16} strokeWidth={1.8} />} label="全部工程" count={counts.all} />
            <Src kind="projects" folder="starred" icon={<Star size={16} strokeWidth={1.8} />} label="星标" count={counts.starred} />
            {app.projectFolders.map(f => <Src key={f.id} kind="projects" folder={f.id} icon={<FolderOpen size={16} strokeWidth={1.8} />} label={f.name} />)}
          </div>
          <div className="pdNavGroup">
            <span className="pdNavLabel">零件</span>
            <Src kind="parts" folder="all" icon={<Boxes size={16} strokeWidth={1.8} />} label="全部零件" count={counts.parts} />
            <Src kind="parts" folder="sup" icon={<Layers size={16} strokeWidth={1.8} />} label="带支撑" count={counts.sup} />
            {app.partFolders.map(f => <Src key={f.id} kind="parts" folder={f.id} icon={<FolderOpen size={16} strokeWidth={1.8} />} label={f.name} />)}
          </div>
          <div className="pdNavGroup">
            <span className="pdNavLabel">档案</span>
            <Src kind="machines" icon={<Printer size={16} strokeWidth={1.8} />} label="机器" />
            <Src kind="materials" icon={<Droplet size={16} strokeWidth={1.8} />} label="材料" />
          </div>
        </nav>
        <main className="pdCanvas">
          {nav.kind === 'projects' ? <ProjectBrowser folder={nav.folder} onOpen={onOpen} onNew={() => onNew([])} /> : null}
          {nav.kind === 'parts' ? <PartsView folder={nav.folder} showFolders={false} onInsertTo={onInsert} onNewWith={e => onNew([e])}
            title={nav.folder === 'all' ? '全部零件' : nav.folder === 'sup' ? '带支撑的零件' : app.partFolders.find(f => f.id === nav.folder)?.name} /> : null}
          {nav.kind === 'machines' ? <MachinesView defaultId={app.lastConfig.machineId} onMakeDefault={id => setLastConfig({ machineId: id })} /> : null}
          {nav.kind === 'materials' ? <MaterialsView defaultId={app.lastConfig.materialId} onMakeDefault={id => setLastConfig({ materialId: id })} /> : null}
        </main>
      </div>
    </div>
  );
}

/* 工程浏览：大缩略图网格 + 检查器（3D 预览、工程文件、历史版本） */
function ProjectBrowser({ folder, onOpen, onNew }) {
  const app = useApp();
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState(null);
  const [zoom, setZoom] = useState(220);
  const fileRef = useRef(null);
  const { menu, dialogs } = useProjectActions({ onOpen });
  const list = useMemo(() => {
    let l = app.projects;
    if (folder === 'starred') l = l.filter(p => p.starred);
    else if (folder !== 'all') l = l.filter(p => p.folder === folder);
    const s = q.trim().toLowerCase();
    if (s) l = l.filter(p => p.name.toLowerCase().includes(s));
    return l;
  }, [app.projects, folder, q]);
  const sel = list.find(p => p.id === selId) || list[0] || null;
  return (
    <div className="pdView pdView--split pdView--browser">
      <div className="pdViewMain">
        <header className="pdViewHead">
          <h1>{folder === 'all' ? '全部工程' : folder === 'starred' ? '星标工程' : app.projectFolders.find(f => f.id === folder)?.name}</h1>
          <span className="pdCount">{list.length}</span>
          <div className="pdViewTools">
            <label className="pdZoom" title="缩略图大小">
              <Grid2X2 size={14} />
              <input type="range" min="160" max="320" step="20" value={zoom} onChange={e => setZoom(+e.target.value)} aria-label="缩略图大小" />
            </label>
            <SearchField value={q} onChange={setQ} placeholder="搜索工程" />
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}><Upload size={15} />导入</Button>
            <Button variant="primary" size="sm" onClick={onNew}>新建工程</Button>
            <input ref={fileRef} type="file" accept=".rfproj" hidden onChange={e => { if (e.target.files[0]) importProjectFile(e.target.files[0]); e.target.value = ''; }} />
          </div>
        </header>
        <ScrollArea className="pdViewScroll" fade={24}>
          {list.length ? (
            <div className="pdBrowseGrid" style={{ '--tile': `${zoom}px` }}>
              {list.map(p => (
                <div key={p.id} role="button" tabIndex={0} className={'pdBrowseTile' + (sel?.id === p.id ? ' is-on' : '')}
                  onClick={() => setSelId(p.id)} onDoubleClick={() => onOpen(p.id)} onKeyDown={e => { if (e.key === 'Enter') onOpen(p.id); }}
                  title="单击查看，双击在工作区打开">
                  <Thumb src={p.thumb} className="pdBrowseThumb" />
                  <span className="pdBrowseName"><b>{p.name}</b>{p.starred ? <Star size={12} fill="currentColor" className="pdStar" /> : null}</span>
                  <span className="pdBrowseMeta">{p.stats?.points ? `${fmtInt(p.stats.points)} 个支撑点` : '还没有支撑'} · {relativeTime(p.updatedAt)}</span>
                  <MoreMenu items={menu(p)} label={`${p.name} 的操作`} className="pdBrowseMore" />
                </div>
              ))}
            </div>
          ) : <Empty icon={<FolderOpen size={18} />} title="这里还没有工程">新建一个，或者导入 .rfproj 文件。</Empty>}
        </ScrollArea>
      </div>
      <ProjectInspector p={sel} onOpen={onOpen} />
      {dialogs}
    </div>
  );
}

function ProjectInspector({ p, onOpen }) {
  const app = useApp();
  const [versions, setVersions] = useState([]);
  useEffect(() => { let alive = true; if (p) loadVersions(p.id).then(v => { if (alive) setVersions(v); }); return () => { alive = false; }; }, [p?.id, p?.updatedAt]);
  if (!p) return <aside className="pdInspector"><Empty title="选一个工程">在这里预览、看文件内容和历史版本。</Empty></aside>;
  const m = machineById(p.machineId);
  const mat = materialById(p.materialId);
  const isOpen = app.active === p.id;
  return (
    <aside className="pdInspector" aria-label="工程详情">
      <LivePreview item={p} color={mat.color} className="pdInspectorLive" />
      <div className="pdInspectorBody">
        <div className="pdInspectorTitle"><h2>{p.name}</h2></div>
        <ProjectMeta p={p} />
        <dl className="pdFacts">
          <div><dt>板面</dt><dd>{m ? `${m.plateX} × ${m.plateZ} mm · ${m.pixelUm} µm` : '–'}</dd></div>
          <div><dt>支撑模板</dt><dd>{templateName(p.templateId)}</dd></div>
          <div><dt>零件</dt><dd>{p.desc.parts.map(x => x.name).join('、') || '–'}</dd></div>
          <div><dt>支撑点</dt><dd>{p.stats?.points ? fmtInt(p.stats.points) : '还没有'}</dd></div>
          <div><dt>修改</dt><dd>{relativeTime(p.updatedAt)}</dd></div>
        </dl>
        <p className="pdNote">预览里的细针是保存的支撑点；在工作区打开时按这些点和参数重建完整结构。</p>
        <div className="pdInspectorActions">
          <Button variant="primary" size="sm" onClick={() => onOpen(p.id)}>{isOpen ? '回到工作区' : '在工作区打开'}</Button>
          <Button variant="secondary" size="sm" onClick={() => duplicateProject(p.id)}><Copy size={14} />复制</Button>
          <Button variant="ghost" size="sm" onClick={() => exportProject(p.id)}><Download size={14} />导出</Button>
        </div>
        <div className="pdTimeline">
          <span className="pdFieldLabel">历史版本</span>
          {versions.slice(0, 5).map((v, i) => (
            <div key={v.ts} className="pdTimelineItem">
              <i aria-hidden="true" />
              <span><b>{new Date(v.ts).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</b><small>{v.label} · {v.stats?.points ?? v.desc.points.length} 个支撑点</small></span>
              {i > 0 && isOpen ? <button type="button" className="pdLink" onClick={() => restoreVersion(p.id, v.ts)}><RotateCcw size={12} /> 恢复</button> : null}
            </div>
          ))}
          {!versions.length ? <p className="pdMuted">还没有保存过</p> : null}
        </div>
      </div>
    </aside>
  );
}

export { History, Pencil, toggleStar };
