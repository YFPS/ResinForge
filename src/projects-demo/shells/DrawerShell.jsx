import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Boxes, Check, ChevronDown, Download, FilePlus2, FolderOpen, History, Pencil, Printer, Upload,
} from 'lucide-react';
import * as DM from '@radix-ui/react-dropdown-menu';
import menuStyles from '@/components/arc/dropdown-menu/dropdown-menu.module.css';
import Button from '@/components/arc/button/button';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import { useBusLatest, useParams } from '../../demo/bridge.js';
import { state } from '../../store.js';
import { raiseH } from '../../core/model.js';
import { MACHINES, MATERIALS, TEMPLATES, machineById, materialById } from '../catalog.js';
import { fitOn, footprint, plateHit } from '../engine.js';
import {
  currentJob, exportProject, generate, getApp, importPartFiles, insertPart, loadVersions, newProject, openProject,
  renameProject, restoreVersion, saveCurrent, setAutosave, setLayer, setMachine, setMaterial, setTemplate, useApp,
} from '../appStore.js';
import { NewProjectDialog, RenameDialog, VersionsDialog } from '../ui/dialogs.jsx';
import {
  FolderChips, LoadingCard, ObjectsList, OpenFileButton, PartTile, SearchField, TitleBar, WorkspaceShell, useLibraryFilter,
} from '../ui/workspace.jsx';
import { PlateGlyph, Swatch, Thumb, fmtInt, relativeTime, templateName } from '../ui/common.jsx';

/* 方案二 · 单窗口 + 资源抽屉
   - 没有主页，一直停在 3D 视口里；启动时直接打开上次的工程
   - 左边一条竖向资源栏：工程 / 零件库 / 机器与材料，点开是一张宽抽屉，盖在对象卡的位置；零件从抽屉拖进视口
   - 自动保存（改完约 2 秒落盘），想留一个可以回去的节点就「存一个版本」；标题栏正中是工程名和工程菜单 */

const RAIL = [
  { id: 'objects', label: '对象', icon: Box },
  { id: 'projects', label: '工程', icon: FolderOpen },
  { id: 'library', label: '零件库', icon: Boxes },
  { id: 'profiles', label: '机器与材料', icon: Printer },
];

export function DrawerShell({ stageDrop }) {
  const app = useApp();
  const [panel, setPanel] = useState('objects');
  const [versions, setVersions] = useState(null);
  const [newDlg, setNewDlg] = useState(false);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => { setAutosave(true); return () => setAutosave(false); }, []);
  useEffect(() => {
    if (getApp().active || getApp().loading) return;
    const last = [...getApp().projects].sort((a, b) => new Date(b.openedAt || 0) - new Date(a.openedAt || 0))[0];
    if (last) openProject(last.id);
  }, []);

  stageDrop.current = {
    enabled: !!app.active,
    onPart: (id, e) => {
      const canvas = document.querySelector('.stuStage canvas');
      insertPart(id, canvas ? plateHit(e.clientX, e.clientY, canvas) : null);
    },
  };

  const rec = app.projects.find(p => p.id === app.active);
  const openOther = async id => {
    if (getApp().dirty) await saveCurrent({ label: '自动保存', quiet: true });
    await openProject(id);
    setPanel('objects');
  };

  return (
    <div className="pdDrawerApp">
      <TitleBar center={(
        <>
          <ProjectMenu rec={rec} onNew={() => setNewDlg(true)} onOpen={() => setPanel('projects')} onRename={() => setRenaming(true)}
            onVersions={async () => setVersions(await loadVersions(app.active))} />
          <AutosaveState />
        </>
      )} />
      <WorkspaceShell
        left={(
          <div className="pdDrawerCol">
            <nav className="pdRail" aria-label="资源">
              {RAIL.map(r => {
                const Icon = r.icon;
                return (
                  <button key={r.id} type="button" className={'pdRailBtn' + (panel === r.id ? ' is-on' : '')} aria-pressed={panel === r.id}
                    title={r.label} onClick={() => setPanel(panel === r.id && r.id !== 'objects' ? 'objects' : r.id)}>
                    <Icon size={18} strokeWidth={1.75} /><span>{r.label}</span>
                  </button>
                );
              })}
            </nav>
            {panel === 'objects' ? (
              <div className="stuCard pdCard pdDrawerCard">
                <div className="pdCardHead"><b className="pdCardTitle">对象</b></div>
                <div className="stuCardBody pdCardBody"><ObjectsList emptyHint="从左边的「零件库」拖进视口，或者打开 STL 文件。" /></div>
                <div className="pdCardFoot">
                  <Button variant="ghost" size="sm" className="pdCardBtn" onClick={() => setPanel('library')}><Boxes size={15} />零件库</Button>
                  <OpenFileButton />
                </div>
              </div>
            ) : null}
            {panel === 'projects' ? <ProjectsDrawer onOpen={openOther} onNew={() => setNewDlg(true)} onVersions={async () => setVersions(await loadVersions(app.active))} /> : null}
            {panel === 'library' ? <LibraryDrawer /> : null}
            {panel === 'profiles' ? <ProfilesDrawer /> : null}
          </div>
        )}
        overlay={<LoadingCard />}
      />
      <NewProjectDialog open={newDlg} initial={app.lastConfig} parts={[]} onCancel={() => setNewDlg(false)}
        onCreate={async cfg => { setNewDlg(false); if (getApp().dirty) await saveCurrent({ label: '自动保存', quiet: true }); await newProject(cfg); setPanel('library'); }} />
      <RenameDialog open={renaming} title="重命名工程" initial={rec?.name} onCancel={() => setRenaming(false)}
        onConfirm={v => { renameProject(app.active, v); setRenaming(false); }} />
      <VersionsDialog open={!!versions} name={rec?.name || ''} versions={versions || []} onCancel={() => setVersions(null)}
        onRestore={ts => { setVersions(null); restoreVersion(app.active, ts); }} />
    </div>
  );
}

/* 标题栏正中：工程名 + 菜单 */
function ProjectMenu({ rec, onNew, onOpen, onRename, onVersions }) {
  const app = useApp();
  if (!rec) return null;
  const items = [
    { label: '新建工程…', icon: <FilePlus2 size={15} />, onSelect: onNew },
    { label: '打开工程…', icon: <FolderOpen size={15} />, onSelect: onOpen },
    { label: '重命名…', icon: <Pencil size={15} />, onSelect: onRename, sep: true },
    { label: '存一个版本', icon: <Check size={15} />, onSelect: () => saveCurrent({ label: '手动存的版本' }) },
    { label: '历史版本…', icon: <History size={15} />, onSelect: onVersions },
    { label: '导出 .rfproj', icon: <Download size={15} />, onSelect: () => exportProject(app.active), sep: true },
  ];
  return (
    <>
      <DM.Root modal={false}>
        <DM.Trigger asChild>
          <button type="button" className="pdProjBtn" aria-label="工程菜单">
            <Thumb src={rec.thumb} className="pdProjBtnThumb" />
            <span>{rec.name}</span>
            <ChevronDown size={14} strokeWidth={1.9} />
          </button>
        </DM.Trigger>
        <DM.Portal>
          <DM.Content className={menuStyles.menu + ' pdMenu'} sideOffset={8} align="start" collisionPadding={12} loop>
            {items.map((it, i) => (
              <React.Fragment key={it.label}>
                {it.sep ? <DM.Separator className={menuStyles.separator} /> : null}
                <DM.Item className={menuStyles.item} style={{ '--i': i }} onSelect={it.onSelect}>
                  <span className={menuStyles.icon} aria-hidden="true">{it.icon}</span>{it.label}
                </DM.Item>
              </React.Fragment>
            ))}
          </DM.Content>
        </DM.Portal>
      </DM.Root>
    </>
  );
}

/* 工程名右边：自动保存状态 */
function AutosaveState() {
  const app = useApp();
  if (!app.active) return null;
  const text = app.busy === 'save' ? '正在保存…' : app.dirty ? '有修改，马上自动保存' : `已自动保存 · ${relativeTime(app.savedAt)}`;
  return <span className={'pdSaveState' + (app.dirty ? ' is-dirty' : '')}>{text}</span>;
}

/* ---------- 工程抽屉 ---------- */

function ProjectsDrawer({ onOpen, onNew, onVersions }) {
  const app = useApp();
  const [q, setQ] = useState('');
  const rec = app.projects.find(p => p.id === app.active);
  const others = useMemo(() => {
    const s = q.trim().toLowerCase();
    return app.projects.filter(p => p.id !== app.active && (!s || p.name.toLowerCase().includes(s)));
  }, [app.projects, app.active, q]);
  return (
    <section className="stuCard pdCard pdDrawer" aria-label="工程">
      <div className="pdCardHead"><b className="pdCardTitle">工程</b><Button variant="secondary" size="sm" onClick={onNew}><FilePlus2 size={15} />新建</Button></div>
      {rec ? (
        <div className="pdCurrent">
          <Thumb src={rec.thumb} className="pdCurrentThumb" />
          <div className="pdCurrentBody">
            <b>{rec.name}</b>
            <small>{machineById(rec.machineId)?.model} · {materialById(rec.materialId).name}</small>
            <div className="pdCurrentActions">
              <Button variant="ghost" size="sm" onClick={() => saveCurrent({ label: '手动存的版本' })}><Check size={14} />存一个版本</Button>
              <Button variant="ghost" size="sm" onClick={onVersions}><History size={14} />历史版本</Button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="pdLibTools"><SearchField value={q} onChange={setQ} placeholder="搜索工程" /></div>
      <ScrollArea className="pdLibScroll" fade={18}>
        <div className="pdDrawerList">
          {others.map(p => (
            <button key={p.id} type="button" className="pdDrawerRow" onClick={() => onOpen(p.id)}>
              <Thumb src={p.thumb} className="pdDrawerRowThumb" />
              <span className="pdDrawerRowMain">
                <b>{p.name}</b>
                <small>{p.stats?.points ? `${fmtInt(p.stats.points)} 个支撑点` : '还没有支撑'} · {relativeTime(p.updatedAt)}</small>
              </span>
            </button>
          ))}
          {!others.length ? <p className="pdMuted pdPad">没有别的工程</p> : null}
        </div>
      </ScrollArea>
      <div className="pdCardFoot"><span className="pdMuted">切换工程前，当前的修改会先自动保存</span></div>
    </section>
  );
}

/* ---------- 零件库抽屉 ---------- */

function LibraryDrawer() {
  const app = useApp();
  const { q, setQ, folder, setFolder, list } = useLibraryFilter(app.library);
  const fileRef = useRef(null);
  return (
    <section className="stuCard pdCard pdDrawer" aria-label="零件库">
      <div className="pdCardHead">
        <b className="pdCardTitle">零件库<small>{app.library.length}</small></b>
        <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}><Upload size={15} />导入 STL</Button>
        <input ref={fileRef} type="file" accept=".stl" multiple hidden onChange={e => { importPartFiles(e.target.files, ['all', 'sup'].includes(folder) ? 'test' : folder); e.target.value = ''; }} />
      </div>
      <div className="pdLibTools">
        <SearchField value={q} onChange={setQ} placeholder="搜索零件" />
        <FolderChips folders={app.partFolders} value={folder} onChange={setFolder} />
      </div>
      <ScrollArea className="pdLibScroll" fade={18}>
        {list.length ? <div className="pdLibGrid">{list.map(e => <PartTile key={e.id} entry={e} onInsert={x => insertPart(x.id)} />)}</div>
          : <p className="pdMuted pdPad">没有匹配的零件</p>}
      </ScrollArea>
      <div className="pdCardFoot"><span className="pdMuted">拖进视口放到指定位置；点一下自动找空位</span></div>
    </section>
  );
}

/* ---------- 机器与材料抽屉（直接作用到当前工程） ---------- */

function ProfilesDrawer() {
  const app = useApp();
  useParams();
  useBusLatest('modelInfo', null);
  const job = currentJob();
  if (!job) return null;
  const fp = footprint(state.parts);
  const m = materialById(job.materialId);
  const hasSup = (state.supportPoints || []).length > 0;
  const stale = hasSup && !state.analysis;
  return (
    <section className="stuCard pdCard pdDrawer" aria-label="机器与材料">
      <div className="pdCardHead"><b className="pdCardTitle">机器与材料</b></div>
      <ScrollArea className="pdLibScroll" fade={18}>
        <div className="pdProfiles">
          <h3>机器</h3>
          <div className="pdPopList">
            {MACHINES.map(x => {
              const f = fitOn(x, fp, raiseH());
              const on = x.id === job.machineId;
              return (
                <button key={x.id} type="button" className={on ? 'is-on' : ''} onClick={() => setMachine(x.id)}>
                  <PlateGlyph machine={x} fp={fp} box={52} over={!f.ok} />
                  <span className="pdPopMain"><b>{x.brand} {x.model}</b><small>{x.plateX} × {x.plateZ} mm · {x.pixelUm} µm</small></span>
                  <span className={'pdFit' + (f.ok ? '' : ' is-over')}>{f.ok ? '放得下' : `超出 ${Math.ceil(f.over)} mm`}</span>
                </button>
              );
            })}
          </div>
          <h3>材料</h3>
          <div className="pdPopList">
            {MATERIALS.map(x => (
              <button key={x.id} type="button" className={x.id === job.materialId ? 'is-on' : ''} onClick={() => setMaterial(x.id)}>
                <Swatch material={x} size={24} />
                <span className="pdPopMain"><b>{x.name}</b><small>{x.note} · 默认{templateName(x.template)}</small></span>
              </button>
            ))}
          </div>
          <div className="pdPopField"><span>层厚</span>
            <SegmentedControl label="层厚" value={String(job.layerUm)} onValueChange={v => setLayer(+v)} options={m.layers.map(u => ({ value: String(u), label: `${u} µm` }))} />
          </div>
          <div className="pdPopField"><span>支撑模板</span>
            <SegmentedControl label="支撑模板" value={job.templateId || 'custom'} onValueChange={v => { if (v !== 'custom') setTemplate(v); }}
              options={[...TEMPLATES.map(t => ({ value: t.id, label: t.name })), ...(job.templateId ? [] : [{ value: 'custom', label: '自定义' }])]} />
          </div>
          {stale ? (
            <div className="pdPopNotice"><span>层厚改了，现在的支撑还是按原来的层厚生成的。</span>
              <Button variant="secondary" size="sm" onClick={() => generate()}>重新生成</Button></div>
          ) : null}
        </div>
      </ScrollArea>
    </section>
  );
}
