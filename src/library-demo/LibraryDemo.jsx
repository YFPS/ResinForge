import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import {
  Copy, Download, FileJson, FolderInput, FolderOpen, Pencil, Plus, Star, Tag, Trash2, X,
} from 'lucide-react';
import { CandidateA, CandidateB } from './candidates.jsx';
import { CandidateCArc } from './candidateCArc.jsx';
import { Toast, Wizard } from './ui.jsx';
import { Workspace } from './Workspace.jsx';
import { createThumbnailRenderer } from './thumbs.js';
import { registerModel } from './models.js';
import { projectFiles } from './projectFile.js';
import {
  ConfirmDialog, FolderPickerDialog, ManifestDialog, ProjectPickDialog, PromptDialog,
} from './dialogs.jsx';
import {
  FOLDERS, LIBRARY, LIBRARY_FOLDERS, PROJECTS, folderName, machineById, makeItem, makeLibraryPart,
  materialById, thumbKeyOfProject, usageOf, withSummary,
} from './data.js';

/* 资源库 Demo 总控：三套方案（A 文件管理器 / B 工作台 / C 专业库）共用这里的数据与操作，
   「打开工程」进入共用的工作区（Workspace.jsx），各方案在工作区里取用零件库的方式不同。
   地址：#a / #b / #c 选方案，#c/ws/<工程 id> 直接打开某个工程（截图、对照用）。数据只在本页内存里，刷新回到演示数据。 */

const SCHEMES = ['a', 'b', 'c'];

function readHash() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const [s, ws, id] = raw.split('/');
  let scheme = SCHEMES.includes(s) ? s : null;
  if (!scheme) {
    try { const saved = localStorage.getItem('resinforge:library-demo.scheme'); if (SCHEMES.includes(saved)) scheme = saved; } catch { /* 忽略 */ }
  }
  return { scheme: scheme || 'a', openId: ws === 'ws' && id ? id : null };
}

const matchQuery = (text, q) => !q || String(text).toLowerCase().includes(q.toLowerCase());

/** 往文件夹列表里加一项（模块级数组，Demo 里直接改；调用方随后刷新一次） */
function addFolder(list, name, prefix) {
  const id = `${prefix}-${Date.now().toString(36)}`;
  list.push({ id, name, icon: 'folder' });
  return id;
}

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export default function LibraryDemo() {
  const initial = useMemo(readHash, []);
  const [candidate, setCandidateState] = useState(initial.scheme);
  const [openId, setOpenId] = useState(initial.openId);
  const [section, setSectionState] = useState('projects');
  const [folder, setFolder] = useState('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(PROJECTS[0]?.id || null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileTab, setProfileTab] = useState('machine');
  const [machineId, setMachineId] = useState('saturn4ultra');
  const [materialId, setMaterialId] = useState('std-grey');
  const [wizard, setWizard] = useState(null);       // null | { partIds }
  const [view, setView] = useState('list');
  const [toast, setToast] = useState('');
  const [projects, setProjects] = useState(PROJECTS);
  const [parts, setParts] = useState(LIBRARY);
  const [thumbs, setThumbs] = useState({});
  const [checked, setChecked] = useState(() => new Set());
  const [dialog, setDialog] = useState(null);       // { type, ... }
  const [pendingInsert, setPendingInsert] = useState(null);   // 打开工作区后要插入的零件
  const [, setRev] = useState(0);                    // 文件夹列表变了（模块级数组）后刷新一次

  const rendererRef = useRef(null);
  const thumbsRef = useRef({});
  const pendingThumbs = useRef(new Set());
  const toastTimer = useRef(0);
  const fileRef = useRef(null);

  const notify = useCallback(message => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 3200);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  /* ---------- 地址 ---------- */
  const writeHash = useCallback((scheme, id) => {
    try {
      localStorage.setItem('resinforge:library-demo.scheme', scheme);
      history.replaceState(null, '', '#' + scheme + (id ? `/ws/${id}` : ''));
    } catch { /* 忽略 */ }
  }, []);
  useEffect(() => {
    const onHash = () => {
      const h = readHash();
      setCandidateState(h.scheme);
      setOpenId(h.openId);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { writeHash(candidate, openId); }, [candidate, openId, writeHash]);

  /* ---------- 缩略图：零件用中性灰，工程带材料色与示意支撑；逐张让出主线程 ---------- */
  useEffect(() => {
    try { rendererRef.current = createThumbnailRenderer(); } catch { rendererRef.current = null; }
    return () => { rendererRef.current?.dispose(); rendererRef.current = null; };
  }, []);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return undefined;
    const jobs = [];
    const seen = new Set();
    const push = (id, run) => {
      if (seen.has(id) || thumbsRef.current[id] || pendingThumbs.current.has(id)) return;
      seen.add(id);
      jobs.push({ id, run });
    };
    for (const p of parts) push(p.key, () => r.renderPart(p.key));
    for (const p of projects) push(thumbKeyOfProject(p), () => r.renderProject(p, materialById(p.materialId).color));
    if (!jobs.length) return undefined;
    let cancelled = false;
    for (const j of jobs) pendingThumbs.current.add(j.id);
    (async () => {
      for (let i = 0; i < jobs.length; i++) {
        if (cancelled || !rendererRef.current) break;
        try { thumbsRef.current = { ...thumbsRef.current, [jobs[i].id]: jobs[i].run() }; } catch { /* 缩略图失败不阻塞 Demo */ }
        pendingThumbs.current.delete(jobs[i].id);
        if (i % 3 === 2 || i === jobs.length - 1) {
          setThumbs(thumbsRef.current);
          await new Promise(res => setTimeout(res, 0));
        }
      }
    })();
    return () => { cancelled = true; for (const j of jobs) pendingThumbs.current.delete(j.id); };
  }, [parts, projects]);

  /* ---------- 方案 / 分区 / 选中 ---------- */
  const setCandidate = useCallback(value => setCandidateState(value), []);

  const setSection = useCallback(value => {
    setSectionState(value);
    setFolder('all');
    setQuery('');
    setChecked(new Set());
    setSelectedId(value === 'projects' ? projects[0]?.id || null : value === 'parts' ? parts[0]?.id || null : null);
    setDrawerOpen(false);
    if (value === 'profiles') setProfileTab('machine');
  }, [projects, parts]);

  const selectId = useCallback(id => {
    setSelectedId(id);
    setDrawerOpen(!!id);
  }, []);

  const toggleCheck = useCallback(id => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const clearChecked = useCallback(() => setChecked(new Set()), []);

  const usage = useCallback(id => usageOf(id, projects), [projects]);

  /* ---------- 列表 ---------- */
  const projectList = useMemo(() => {
    let list = [...projects];
    if (folder === 'starred') list = list.filter(p => p.starred);
    else if (folder === 'recent') list = list.filter(p => p.openedAt).sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
    else if (folder !== 'all') list = list.filter(p => p.folder === folder);
    if (query) {
      list = list.filter(p => matchQuery(p.name, query) || matchQuery(machineById(p.machineId).model, query)
        || matchQuery(materialById(p.materialId).name, query) || matchQuery(folderName(p.folder), query));
    }
    if (folder !== 'recent') list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return list;
  }, [projects, folder, query]);

  const partList = useMemo(() => {
    let list = [...parts];
    if (folder === 'fav') list = list.filter(p => p.fav);
    else if (folder === 'used') list = list.filter(p => p.usedAt).sort((a, b) => new Date(b.usedAt) - new Date(a.usedAt));
    else if (folder !== 'all') list = list.filter(p => p.folder === folder);
    if (query) list = list.filter(p => matchQuery(p.name, query) || p.tags.some(t => matchQuery(t, query)) || matchQuery(folderName(p.folder, LIBRARY_FOLDERS), query));
    if (folder !== 'used') list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return list;
  }, [parts, folder, query]);

  const projectCounts = useMemo(() => {
    const c = { all: projects.length, recent: projects.filter(p => p.openedAt).length, starred: projects.filter(p => p.starred).length };
    for (const f of FOLDERS.filter(f => !f.smart)) c[f.id] = projects.filter(p => p.folder === f.id).length;
    return c;
  }, [projects]);

  const partCounts = useMemo(() => {
    const c = { all: parts.length, used: parts.filter(p => p.usedAt).length, fav: parts.filter(p => p.fav).length };
    for (const f of LIBRARY_FOLDERS.filter(f => !f.smart)) c[f.id] = parts.filter(p => p.folder === f.id).length;
    return c;
  }, [parts]);

  const selectedProject = projects.find(p => p.id === selectedId) || null;
  const selectedPart = parts.find(p => p.id === selectedId) || null;
  const selectedMachine = machineById(machineId);
  const selectedMaterial = materialById(materialId);

  /* ---------- 工程操作 ---------- */
  const openProject = useCallback((id, insertPart = null) => {
    setProjects(list => list.map(p => (p.id === id ? { ...p, openedAt: new Date().toISOString() } : p)));
    setPendingInsert(insertPart);
    setOpenId(id);
  }, []);

  const saveProject = useCallback(draft => {
    const { builtPreset, builtLayer, ...rest } = draft;
    setProjects(list => list.map(p => (p.id === draft.id ? withSummary({ ...rest, status: 'ready', updatedAt: new Date().toISOString() }) : p)));
    const used = new Set(draft.items.map(it => it.libId).filter(Boolean));
    if (used.size) setParts(list => list.map(p => (used.has(p.id) && !p.usedAt ? { ...p, usedAt: new Date().toISOString() } : p)));
  }, []);

  const duplicateProject = useCallback(item => {
    const clone = withSummary({
      ...item, id: 'prj-' + Date.now().toString(36), name: item.name + ' 副本', starred: false,
      updatedAt: new Date().toISOString(), openedAt: null,
      items: item.items.map(it => ({ ...makeItem(it.key, it.name, it.libId, it.sup, it.origin), pos: it.pos })),
    });
    setProjects(list => [clone, ...list]);
    setSelectedId(clone.id);
    notify(`已复制「${item.name}」：零件引用同一份模型文件，支撑点一起复制`);
  }, [notify]);

  const projectMenu = useCallback(item => [
    { label: '打开', icon: <FolderOpen size={15} />, onSelect: () => openProject(item.id) },
    { label: '重命名…', icon: <Pencil size={15} />, onSelect: () => setDialog({ type: 'renameProject', target: item }) },
    { label: '移动到…', icon: <FolderInput size={15} />, onSelect: () => setDialog({ type: 'moveProjects', ids: [item.id] }) },
    { label: item.starred ? '取消星标' : '加星标', icon: <Star size={15} />, onSelect: () => setProjects(list => list.map(p => (p.id === item.id ? { ...p, starred: !p.starred } : p))) },
    { label: '复制工程', icon: <Copy size={15} />, onSelect: () => duplicateProject(item) },
    { label: '查看工程文件', icon: <FileJson size={15} />, onSelect: () => setDialog({ type: 'manifest', target: item }) },
    { label: '删除…', icon: <Trash2 size={15} />, destructive: true, separatorBefore: true, onSelect: () => setDialog({ type: 'deleteProjects', ids: [item.id] }) },
  ], [openProject, duplicateProject]);

  /* ---------- 零件库操作 ---------- */
  const partMenu = useCallback(item => [
    { label: '放进工程…', icon: <Plus size={15} />, onSelect: () => setDialog({ type: 'insertTo', target: item }) },
    { label: '重命名…', icon: <Pencil size={15} />, onSelect: () => setDialog({ type: 'renamePart', target: item }) },
    { label: '移动到…', icon: <FolderInput size={15} />, onSelect: () => setDialog({ type: 'moveParts', ids: [item.id] }) },
    { label: '编辑标签…', icon: <Tag size={15} />, onSelect: () => setDialog({ type: 'tagParts', ids: [item.id], initial: item.tags.join(' ') }) },
    { label: item.fav ? '取消收藏' : '收藏', icon: <Star size={15} />, onSelect: () => setParts(list => list.map(p => (p.id === item.id ? { ...p, fav: !p.fav } : p))) },
    { label: '导出原文件', icon: <Download size={15} />, onSelect: () => notify(`演示：导出「${item.name}」的原始模型文件`) },
    { label: '删除…', icon: <Trash2 size={15} />, destructive: true, separatorBefore: true, onSelect: () => setDialog({ type: 'deleteParts', ids: [item.id] }) },
  ], [notify]);

  /* 导入 STL：算 SHA-256 查重（同一个文件只存一份），解析成 Y-up、底面落到 y=0，登记几何后出缩略图 */
  const importFiles = useCallback(async files => {
    const list = [...files];
    if (!list.length) return;
    let added = 0;
    for (const file of list) {
      if (!/\.stl$/i.test(file.name)) { notify(`「${file.name}」：Demo 只演示 STL 导入`); continue; }
      try {
        const buf = await file.arrayBuffer();
        const hash = hex(await crypto.subtle.digest('SHA-256', buf));
        const dup = parts.find(p => p.hash === hash);
        if (dup) {
          setSectionState('parts'); setFolder('all'); setSelectedId(dup.id);
          notify(`「${file.name}」和库里的「${dup.name}」是同一个文件（SHA-256 相同），没有重复导入`);
          continue;
        }
        const geom = new STLLoader().parse(buf);
        geom.rotateX(-Math.PI / 2);                 // STL 惯例 Z-up → 场景 Y-up（与 core 载入一致）
        geom.computeBoundingBox();
        const bb = geom.boundingBox;
        geom.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
        geom.computeVertexNormals();
        const key = 'file:' + hash.slice(0, 12);
        registerModel(key, file.name, geom);
        const target = section === 'parts' && !['all', 'used', 'fav'].includes(folder) ? folder : 'test';
        const part = makeLibraryPart({
          id: 'lib-' + hash.slice(0, 10), name: file.name.replace(/\.stl$/i, ''), key, folder: target,
          tags: ['导入'], source: 'import', hash,
          note: `${(file.size / 1048576).toFixed(1)} MB · SHA-256 ${hash.slice(0, 10)}…`,
        }, 0);
        setParts(prev => [part, ...prev]);
        setSectionState('parts'); setFolder('all'); setSelectedId(part.id);
        added++;
        if (geom.attributes.position.count / 3 > 120000) notify(`「${part.name}」面数较大（${Math.round(geom.attributes.position.count / 3).toLocaleString()} 面），示意支撑不做避让`);
      } catch (e) {
        notify(`「${file.name}」解析失败：${e.message || e}`);
      }
    }
    if (added) notify(`已导入 ${added} 个零件到零件库`);
  }, [parts, notify, section, folder]);

  const onImport = useCallback(() => fileRef.current?.click(), []);

  /* 资源库页面上直接拖入 STL */
  const onDropFiles = e => {
    if (openId || !e.dataTransfer?.files?.length) return;
    e.preventDefault();
    importFiles(e.dataTransfer.files);
  };

  /* ---------- 对话框结果 ---------- */
  const closeDialog = () => setDialog(null);
  const applyDialog = (res) => {
    const d = dialog;
    if (!d) return;
    if (d.type === 'renameProject') {
      setProjects(list => list.map(p => (p.id === d.target.id ? { ...p, name: res } : p)));
    } else if (d.type === 'renamePart') {
      setParts(list => list.map(p => (p.id === d.target.id ? { ...p, name: res } : p)));
    } else if (d.type === 'moveProjects' || d.type === 'moveParts') {
      const isPart = d.type === 'moveParts';
      const target = res.newFolder ? addFolder(isPart ? LIBRARY_FOLDERS : FOLDERS, res.newFolder, isPart ? 'lf' : 'pf') : res.folderId;
      if (res.newFolder) setRev(r => r + 1);
      const ids = new Set(d.ids);
      if (isPart) setParts(list => list.map(p => (ids.has(p.id) ? { ...p, folder: target } : p)));
      else setProjects(list => list.map(p => (ids.has(p.id) ? { ...p, folder: target } : p)));
      notify(`已移动 ${ids.size} 项到「${folderName(target, isPart ? LIBRARY_FOLDERS : FOLDERS)}」`);
      clearChecked();
    } else if (d.type === 'tagParts') {
      const tags = res.split(/[\s,，、]+/).filter(Boolean).slice(0, 6);
      const ids = new Set(d.ids);
      setParts(list => list.map(p => (ids.has(p.id) ? { ...p, tags } : p)));
      clearChecked();
    } else if (d.type === 'deleteParts') {
      const ids = new Set(d.ids);
      setParts(list => list.filter(p => !ids.has(p.id)));
      if (ids.has(selectedId)) setSelectedId(null);
      notify(`已从零件库删除 ${ids.size} 个零件；用到它们的工程不受影响（工程里是副本）`);
      clearChecked();
    } else if (d.type === 'deleteProjects') {
      const ids = new Set(d.ids);
      setProjects(list => list.filter(p => !ids.has(p.id)));
      if (ids.has(selectedId)) setSelectedId(null);
      notify(`已删除 ${ids.size} 个工程；零件库不受影响`);
      clearChecked();
    } else if (d.type === 'insertTo') {
      openProject(res, d.target);
    }
    setDialog(null);
  };

  /* ---------- 新建工程 ---------- */
  const onCreate = useCallback(payload => {
    const picked = payload.partIds.map(id => parts.find(p => p.id === id)).filter(Boolean);
    const id = 'prj-' + Date.now().toString(36);
    const material = materialById(payload.materialId);
    const project = withSummary({
      id,
      name: picked.length ? `${picked[0].name}${picked.length > 1 ? ` 等 ${picked.length} 件` : ''}` : '未命名工程',
      folder: 'test',
      machineId: payload.machineId,
      materialId: payload.materialId,
      layerUm: payload.layerUm,
      preset: payload.preset,
      starred: false,
      status: 'new',
      updatedAt: new Date().toISOString(),
      openedAt: new Date().toISOString(),
      items: picked.map(p => makeItem(p.key, p.name, p.id, false, p.source === 'import' ? 'import' : 'library')),
    });
    setProjects(list => [project, ...list]);
    setWizard(null);
    setSectionState('projects');
    setFolder('all');
    setSelectedId(id);
    setOpenId(id);
    notify(`已创建「${project.name}」：${material.name} · ${payload.layerUm} µm，进入工作区生成支撑`);
  }, [parts, notify]);

  const onAction = useCallback((type, item) => {
    switch (type) {
      case 'open': openProject(item.id); break;
      case 'copy': duplicateProject(item); break;
      case 'export': setDialog({ type: 'manifest', target: item }); break;
      case 'insert': setDialog({ type: 'insertTo', target: item }); break;
      case 'newWithPart': setWizard({ partIds: [item.id] }); break;
      case 'exportPart': notify(`演示：导出「${item.name}」的原始模型文件`); break;
      case 'renamePart': setDialog({ type: 'tagParts', ids: [item.id], initial: item.tags.join(' ') }); break;
      case 'import': onImport(); break;
      default: notify('演示操作');
    }
  }, [openProject, duplicateProject, notify, onImport]);

  const ctx = {
    candidate, setCandidate,
    section, setSection,
    folder, setFolder,
    query, setQuery,
    selectedId, setSelectedId: selectId,
    drawerOpen, setDrawerOpen,
    view, setView,
    projects, parts,
    projectList, partList, projectCounts, partCounts,
    selectedProject, selectedPart,
    profileTab, setProfileTab,
    machineId, setMachineId,
    materialId, setMaterialId,
    selectedMachine, selectedMaterial,
    thumbs, usage,
    checked, toggleCheck, clearChecked,
    projectMenu, partMenu,
    onAction,
    onImport,
    onNew: () => setWizard({ partIds: [] }),
    onBatch: (type) => {
      const ids = [...checked];
      if (!ids.length) return;
      if (type === 'move') setDialog({ type: section === 'parts' ? 'moveParts' : 'moveProjects', ids });
      if (type === 'tag') setDialog({ type: 'tagParts', ids, initial: '' });
      if (type === 'delete') setDialog({ type: section === 'parts' ? 'deleteParts' : 'deleteProjects', ids });
      if (type === 'fav') { const s = new Set(ids); setParts(list => list.map(p => (s.has(p.id) ? { ...p, fav: true } : p))); clearChecked(); notify(`已收藏 ${ids.length} 个零件`); }
      if (type === 'star') { const s = new Set(ids); setProjects(list => list.map(p => (s.has(p.id) ? { ...p, starred: true } : p))); clearChecked(); }
    },
  };

  const openProjectObj = openId ? projects.find(p => p.id === openId) : null;
  useEffect(() => { if (openId && !openProjectObj) setOpenId(null); }, [openId, openProjectObj]);

  /* 对话框里要用的派生内容 */
  const deleteTargets = dialog && (dialog.type === 'deleteParts' || dialog.type === 'deleteProjects') ? dialog.ids : [];
  const manifest = dialog?.type === 'manifest' ? projectFiles(dialog.target) : null;

  return (
    <div className="ldApp" data-scheme={candidate} onDragOver={e => { if (!openId && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); }} onDrop={onDropFiles}>
      {openProjectObj ? (
        <Workspace
          key={openProjectObj.id}
          scheme={candidate}
          project={openProjectObj}
          parts={parts}
          thumbs={thumbs}
          usage={usage}
          pendingInsert={pendingInsert}
          onPendingDone={() => setPendingInsert(null)}
          notify={notify}
          onSave={saveProject}
          onClose={() => { setOpenId(null); setSectionState('projects'); setSelectedId(openProjectObj.id); }}
          onManageLibrary={() => { setOpenId(null); setSectionState('parts'); setFolder('all'); setSelectedId(parts[0]?.id || null); }}
          onAddToLibrary={(item, res) => {
            const folderId = res.newFolder ? addFolder(LIBRARY_FOLDERS, res.newFolder, 'lf') : res.folderId;
            if (res.newFolder) setRev(r => r + 1);
            const src = parts.find(p => p.key === item.key);
            const part = makeLibraryPart({
              id: 'lib-' + Date.now().toString(36), name: item.name, key: item.key, folder: folderId,
              tags: src?.tags || [], source: src?.source || 'builtin', hash: src?.hash,
              note: `从工程「${openProjectObj.name}」加入`,
            }, 0);
            setParts(list => [part, ...list]);
            notify(`已加入零件库「${folderName(folderId, LIBRARY_FOLDERS)}」${src ? '：模型文件与已有条目共用一份' : ''}`);
          }}
        />
      ) : (
        <>
          {candidate === 'a' ? <CandidateA ctx={ctx} /> : null}
          {candidate === 'b' ? <CandidateB ctx={ctx} /> : null}
          {candidate === 'c' ? <CandidateCArc ctx={ctx} /> : null}
          {checked.size ? (
            <div className="ldBatch" role="toolbar" aria-label="批量操作">
              <b>已选 {checked.size} {section === 'parts' ? '个零件' : '个工程'}</b>
              <button type="button" onClick={() => ctx.onBatch('move')}><FolderInput size={14} />移动到</button>
              {section === 'parts' ? <button type="button" onClick={() => ctx.onBatch('tag')}><Tag size={14} />标签</button> : null}
              {section === 'parts'
                ? <button type="button" onClick={() => ctx.onBatch('fav')}><Star size={14} />收藏</button>
                : <button type="button" onClick={() => ctx.onBatch('star')}><Star size={14} />星标</button>}
              <button type="button" className="is-danger" onClick={() => ctx.onBatch('delete')}><Trash2 size={14} />删除</button>
              <button type="button" className="ldBatchClose" onClick={clearChecked} aria-label="取消选择"><X size={15} /></button>
            </div>
          ) : null}
        </>
      )}

      <input ref={fileRef} type="file" accept=".stl" multiple hidden onChange={e => { importFiles(e.target.files); e.target.value = ''; }} />

      <Wizard open={!!wizard} initialParts={wizard?.partIds || []} parts={parts} onClose={() => setWizard(null)} onCreate={onCreate} onImport={onImport} thumbs={thumbs} />

      <PromptDialog
        open={dialog?.type === 'renameProject' || dialog?.type === 'renamePart'}
        title={dialog?.type === 'renamePart' ? '重命名零件' : '重命名工程'}
        label="名称"
        initial={dialog?.target?.name || ''}
        confirmText="重命名"
        onCancel={closeDialog}
        onConfirm={applyDialog}
      />
      <PromptDialog
        open={dialog?.type === 'tagParts'}
        title="编辑标签"
        description={dialog?.ids?.length > 1 ? `给 ${dialog.ids.length} 个零件设置同一组标签。` : '用空格分隔，最多 6 个。'}
        label="标签"
        initial={dialog?.initial || ''}
        confirmText="保存"
        onCancel={closeDialog}
        onConfirm={applyDialog}
      />
      <FolderPickerDialog
        open={dialog?.type === 'moveProjects' || dialog?.type === 'moveParts'}
        title={`移动 ${dialog?.ids?.length || 0} 项`}
        description="选目标文件夹，也可以新建一个。"
        folders={dialog?.type === 'moveParts' ? LIBRARY_FOLDERS : FOLDERS}
        confirmText="移动"
        onCancel={closeDialog}
        onConfirm={applyDialog}
      />
      <ConfirmDialog
        open={dialog?.type === 'deleteParts'}
        title={deleteTargets.length > 1 ? `删除 ${deleteTargets.length} 个零件？` : `删除「${parts.find(p => p.id === deleteTargets[0])?.name || ''}」？`}
        description="工程里放的是副本，删除库条目不影响已有工程；模型文件在没有任何引用后才回收。"
        onCancel={closeDialog}
        onConfirm={() => applyDialog()}
      >
        {deleteTargets.some(id => usage(id)) ? (
          <p className="ldDlgNote">其中 {deleteTargets.filter(id => usage(id)).length} 个正被工程使用（{deleteTargets.reduce((s, id) => s + usage(id), 0)} 处），这些工程照常打开。</p>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog?.type === 'deleteProjects'}
        title={deleteTargets.length > 1 ? `删除 ${deleteTargets.length} 个工程？` : `删除「${projects.find(p => p.id === deleteTargets[0])?.name || ''}」？`}
        description="工程文件与支撑数据一起删除（保留 30 天可在回收站找回）；零件库不受影响。"
        onCancel={closeDialog}
        onConfirm={() => applyDialog()}
      />
      <ProjectPickDialog
        open={dialog?.type === 'insertTo'}
        part={dialog?.target}
        projects={[...projects].sort((a, b) => new Date(b.openedAt || b.updatedAt) - new Date(a.openedAt || a.updatedAt))}
        onCancel={closeDialog}
        onNew={() => { const t = dialog.target; setDialog(null); setWizard({ partIds: [t.id] }); }}
        onConfirm={applyDialog}
      />
      <ManifestDialog
        open={dialog?.type === 'manifest'}
        title={dialog?.target ? `工程文件 · ${dialog.target.name}` : ''}
        files={manifest?.files || []}
        json={manifest?.json || ''}
        onCancel={closeDialog}
      />

      <Toast message={toast} />
    </div>
  );
}
