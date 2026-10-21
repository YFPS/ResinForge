import React, { useMemo, useState } from 'react';
import {
  Boxes, Download, Droplet, FolderOpen, Grid2X2, History, House, Layers, MoreHorizontal, Plus, Printer, Save, Star, X,
} from 'lucide-react';
import Button from '@/components/arc/button/button';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import { BrandMark } from '../../demo/components/TopBar.jsx';
import { useBusLatest } from '../../demo/bridge.js';
import {
  closeTab, exportProject, getApp, insertPart, isDirty, loadVersions, newProject, openProject, resetDemo,
  restoreVersion, saveCurrent, saveDraft, setLastConfig, useApp,
} from '../appStore.js';
import { plateHit } from '../engine.js';
import {
  ConfirmCloseDialog, NewProjectDialog, ProjectPickDialog, VersionsDialog,
} from '../ui/dialogs.jsx';
import {
  FolderChips, LoadingCard, ObjectsList, OpenFileButton, PartTile, SearchField, WorkspaceShell, useLibraryFilter,
} from '../ui/workspace.jsx';
import { MachinesView, MaterialsView, PartsView, ProjectsView } from '../ui/views.jsx';
import { MoreMenu, fmtBytes } from '../ui/common.jsx';

/* 方案一 · 标签页 + 主页（推荐）
   - 顶部一条标签：主页 + 打开的工程（未保存的标签带一个点）+ 新建。和 BPS 一样能同时开多个工程，也是桌面软件的惯例；
     在桌面版里这条就是自绘标题栏的位置
   - 主页：左侧导航（工程 / 零件库 / 机器 / 材料）+ 圆角内容画布，与 Arc 版的「L 形外框 + 画布」同一种结构
   - 工程标签：真实 Studio；左卡是 BPS 式的「对象 / 零件库」双页签，零件点一下或拖进视口就放进工程 */

export function TabsShell({ stageDrop }) {
  const app = useApp();
  const [view, setView] = useState('home');
  const [nav, setNav] = useState({ kind: 'projects', folder: 'all' });
  const [leftTab, setLeftTab] = useState('objects');
  const [closing, setClosing] = useState(null);
  const [newDlg, setNewDlg] = useState(null);
  const [pick, setPick] = useState(null);
  const [versions, setVersions] = useState(null);

  const openTab = async id => {
    setView('work');
    const ok = await openProject(id);
    if (!ok && !getApp().active) setView('home');
  };
  const activateTab = id => { if (id === app.active) setView('work'); else openTab(id); };
  const doClose = id => {
    const wasActive = id === app.active;
    const rest = app.tabs.filter(t => t !== id);
    closeTab(id);
    if (wasActive) {
      if (rest.length) openTab(rest[rest.length - 1]);
      else setView('home');
    }
  };
  const requestClose = id => { if (isDirty(id)) setClosing(id); else doClose(id); };

  const createProject = async (cfg, parts = []) => {
    setNewDlg(null);
    setView('work');
    await newProject(cfg, parts.map(p => p.id));
  };

  const insertIntoProject = async (projectId, entry) => {
    setPick(null);
    if (projectId !== app.active) await openTab(projectId);
    setView('work');
    await insertPart(entry.id);
  };

  /* 视口拖放：零件放到落点 */
  stageDrop.current = {
    enabled: view === 'work' && !!app.active,
    onPart: (id, e) => {
      const canvas = document.querySelector('.stuStage canvas');
      insertPart(id, canvas ? plateHit(e.clientX, e.clientY, canvas) : null);
    },
  };

  const activeRec = app.projects.find(p => p.id === app.active);
  const closingRec = app.projects.find(p => p.id === closing);

  return (
    <div className={'pdTabsApp' + (view === 'home' ? ' is-home' : '')}>
      <TabStrip view={view} onHome={() => setView('home')} onTab={activateTab} onClose={requestClose} onNew={() => setNewDlg({ parts: [] })} />

      {view === 'home' ? (
        <HomePage nav={nav} setNav={setNav}
          onOpen={openTab}
          onNew={() => setNewDlg({ parts: [] })}
          onInsertTo={entry => setPick(entry)}
          onNewWith={entry => setNewDlg({ parts: [entry] })} />
      ) : (
        <WorkspaceShell
          left={(
            <div className="stuCard pdCard pdCard--objects">
              <div className="pdCardHead">
                <div className="pdSeg" role="tablist" aria-label="左侧面板">
                  <button type="button" role="tab" aria-selected={leftTab === 'objects'} className={leftTab === 'objects' ? 'is-on' : ''} onClick={() => setLeftTab('objects')}>
                    对象<PartCount />
                  </button>
                  <button type="button" role="tab" aria-selected={leftTab === 'library'} className={leftTab === 'library' ? 'is-on' : ''} onClick={() => setLeftTab('library')}>
                    零件库<span>{app.library.length}</span>
                  </button>
                </div>
              </div>
              {leftTab === 'objects' ? (
                <>
                  <div className="stuCardBody pdCardBody"><ObjectsList emptyHint="到「零件库」页签里点一下零件，或者打开 STL 文件。" /></div>
                  <div className="pdCardFoot">
                    <Button variant="ghost" size="sm" className="pdCardBtn" onClick={() => setLeftTab('library')}><Boxes size={15} />从零件库添加</Button>
                    <OpenFileButton />
                  </div>
                </>
              ) : <LibraryCard onInsert={e => insertPart(e.id)} onManage={() => { setView('home'); setNav({ kind: 'parts', folder: 'all' }); }} />}
            </div>
          )}
          barEnd={<SaveControl onVersions={async () => setVersions(await loadVersions(app.active))} />}
          overlay={<LoadingCard />}
        />
      )}
      {view === 'home' ? <LoadingCard /> : null}

      <ConfirmCloseDialog
        open={!!closing}
        name={closingRec?.name || ''}
        changes={closing === app.active ? app.changes : []}
        onCancel={() => setClosing(null)}
        onDiscard={() => { const id = closing; setClosing(null); doClose(id); }}
        onSave={async () => {
          const id = closing;
          setClosing(null);
          if (id === getApp().active) await saveCurrent(); else await saveDraft(id);
          doClose(id);
        }}
      />
      <NewProjectDialog open={!!newDlg} initial={app.lastConfig} parts={newDlg?.parts || []}
        onCancel={() => setNewDlg(null)} onCreate={cfg => createProject(cfg, newDlg?.parts || [])} />
      <ProjectPickDialog open={!!pick} part={pick} projects={app.projects}
        onCancel={() => setPick(null)}
        onNew={() => { const e = pick; setPick(null); setNewDlg({ parts: [e] }); }}
        onConfirm={id => insertIntoProject(id, pick)} />
      <VersionsDialog open={!!versions} name={activeRec?.name || ''} versions={versions || []}
        onCancel={() => setVersions(null)}
        onRestore={ts => { setVersions(null); restoreVersion(app.active, ts); }} />
    </div>
  );
}

function PartCount() {
  const info = useBusLatest('modelInfo', null);
  const n = info?.parts?.length || 0;
  return n ? <span>{n}</span> : null;
}

/* ---------- 顶部标签条 ---------- */

function TabStrip({ view, onHome, onTab, onClose, onNew }) {
  const app = useApp();
  const current = app.pendingId || app.active;
  return (
    <header className="pdTabs" role="tablist" aria-label="工程标签">
      <span className="pdTabsBrand"><BrandMark /></span>
      <button type="button" role="tab" aria-selected={view === 'home'} className={'pdTab pdTab--home' + (view === 'home' ? ' is-on' : '')} onClick={onHome}>
        <House size={15} strokeWidth={1.8} /><span>主页</span>
      </button>
      {app.tabs.map(id => {
        const p = app.projects.find(x => x.id === id);
        if (!p) return null;
        const on = view === 'work' && current === id;
        const dirty = isDirty(id);
        return (
          <div key={id} role="tab" aria-selected={on} tabIndex={0} className={'pdTab' + (on ? ' is-on' : '')}
            onClick={() => onTab(id)} onKeyDown={e => { if (e.key === 'Enter') onTab(id); }}
            onAuxClick={e => { if (e.button === 1) onClose(id); }} title={p.name}>
            <span className="pdTabName">{p.name}</span>
            {dirty ? <i className="pdDirtyDot" aria-label="有未保存的修改" /> : null}
            <button type="button" className="pdTabClose" aria-label={`关闭 ${p.name}`} onClick={e => { e.stopPropagation(); onClose(id); }}><X size={13} /></button>
          </div>
        );
      })}
      <button type="button" className="pdTabNew" aria-label="新建工程" onClick={onNew}><Plus size={16} /></button>
    </header>
  );
}

/* ---------- 工作区顶栏：保存状态 + 保存 + 工程菜单 ---------- */

function SaveControl({ onVersions }) {
  const app = useApp();
  if (!app.active) return null;
  const busy = app.busy === 'save' || !!app.loading;
  return (
    <>
      <span className="stuFloatSep" aria-hidden="true" />
      <span className={'pdSaveState' + (app.dirty ? ' is-dirty' : '')} title={app.dirty ? app.changes.join('\n') : ''}>
        {app.dirty ? `未保存 ${app.changes.length} 处` : '已保存'}
      </span>
      <Button variant="primary" size="sm" disabled={busy || !app.dirty} onClick={() => saveCurrent()}><Save size={15} />保存</Button>
      <MoreMenu label="工程菜单" items={[
        { label: '历史版本…', icon: <History size={15} />, onSelect: onVersions },
        { label: '导出 .rfproj', icon: <Download size={15} />, onSelect: () => exportProject(app.active) },
      ]} />
    </>
  );
}

/* ---------- 左卡的「零件库」页签 ---------- */

function LibraryCard({ onInsert, onManage }) {
  const app = useApp();
  const { q, setQ, folder, setFolder, list } = useLibraryFilter(app.library);
  return (
    <div className="pdLibCard">
      <div className="pdLibTools">
        <SearchField value={q} onChange={setQ} placeholder="搜索零件" />
        <FolderChips folders={app.partFolders} value={folder} onChange={setFolder} />
      </div>
      <ScrollArea className="pdLibScroll" fade={18}>
        {list.length ? (
          <div className="pdLibGrid">{list.map(e => <PartTile key={e.id} entry={e} onInsert={onInsert} />)}</div>
        ) : <p className="pdMuted pdPad">没有匹配的零件</p>}
      </ScrollArea>
      <div className="pdCardFoot">
        <span className="pdMuted">点一下放进工程，或拖进视口</span>
        <button type="button" className="pdLink" onClick={onManage}>管理零件库</button>
      </div>
    </div>
  );
}

/* ---------- 主页 ---------- */

function HomePage({ nav, setNav, onOpen, onNew, onInsertTo, onNewWith }) {
  const app = useApp();
  const counts = useMemo(() => {
    const c = { all: app.projects.length, starred: app.projects.filter(p => p.starred).length, parts: app.library.length, sup: app.library.filter(l => l.sup).length };
    for (const f of app.projectFolders) c['p:' + f.id] = app.projects.filter(p => p.folder === f.id).length;
    for (const f of app.partFolders) c['l:' + f.id] = app.library.filter(l => l.folder === f.id).length;
    return c;
  }, [app.projects, app.library, app.projectFolders, app.partFolders]);
  const is = (kind, folder) => nav.kind === kind && (folder === undefined || nav.folder === folder);
  const Item = ({ kind, folder, icon, label, count }) => (
    <button type="button" className={'pdNavItem' + (is(kind, folder) ? ' is-on' : '')} aria-current={is(kind, folder) ? 'page' : undefined}
      onClick={() => setNav({ kind, folder: folder ?? 'all' })}>
      {icon}<span>{label}</span>{count != null ? <small>{count}</small> : null}
    </button>
  );
  return (
    <div className="pdHome">
      <nav className="pdNav" aria-label="主页导航">
        <div className="pdNavGroup">
          <Item kind="projects" folder="all" icon={<Grid2X2 size={16} strokeWidth={1.8} />} label="全部工程" count={counts.all} />
          <Item kind="projects" folder="starred" icon={<Star size={16} strokeWidth={1.8} />} label="星标" count={counts.starred} />
          {app.projectFolders.map(f => <Item key={f.id} kind="projects" folder={f.id} icon={<FolderOpen size={16} strokeWidth={1.8} />} label={f.name} count={counts['p:' + f.id]} />)}
        </div>
        <div className="pdNavGroup">
          <span className="pdNavLabel">零件库</span>
          <Item kind="parts" folder="all" icon={<Boxes size={16} strokeWidth={1.8} />} label="全部零件" count={counts.parts} />
          <Item kind="parts" folder="sup" icon={<Layers size={16} strokeWidth={1.8} />} label="带支撑" count={counts.sup} />
          {app.partFolders.map(f => <Item key={f.id} kind="parts" folder={f.id} icon={<FolderOpen size={16} strokeWidth={1.8} />} label={f.name} count={counts['l:' + f.id]} />)}
        </div>
        <div className="pdNavGroup">
          <span className="pdNavLabel">档案</span>
          <Item kind="machines" icon={<Printer size={16} strokeWidth={1.8} />} label="机器" />
          <Item kind="materials" icon={<Droplet size={16} strokeWidth={1.8} />} label="材料" />
        </div>
        <div className="pdNavFoot">
          {app.storage ? <span>本地已用 {fmtBytes(app.storage.used)}</span> : null}
          <button type="button" className="pdLink" onClick={() => { if (window.confirm('清空本页的演示数据，恢复成初始的 6 个工程和 11 个零件？')) resetDemo(); }}>重置演示数据</button>
        </div>
      </nav>
      <main className="pdCanvas">
        {nav.kind === 'projects' ? (
          <ProjectsView title={nav.folder === 'all' ? '工程' : nav.folder === 'starred' ? '星标工程' : app.projectFolders.find(f => f.id === nav.folder)?.name}
            folder={nav.folder} onOpen={onOpen} onNew={onNew} isDirty={isDirty} activeId={app.active} />
        ) : null}
        {nav.kind === 'parts' ? <PartsView folder={nav.folder} onInsertTo={onInsertTo} onNewWith={onNewWith} showFolders={false}
          title={nav.folder === 'all' ? '零件库' : nav.folder === 'sup' ? '带支撑的零件' : app.partFolders.find(f => f.id === nav.folder)?.name} /> : null}
        {nav.kind === 'machines' ? <MachinesView defaultId={app.lastConfig.machineId} onMakeDefault={id => setLastConfig({ machineId: id })} /> : null}
        {nav.kind === 'materials' ? <MaterialsView defaultId={app.lastConfig.materialId} onMakeDefault={id => setLastConfig({ materialId: id })} /> : null}
      </main>
    </div>
  );
}

export { MoreHorizontal };
