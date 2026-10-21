import { useSyncExternalStore } from 'react';
import { state, params, bus } from '../store.js';
import { setParam, pushToast } from '../demo/bridge.js';
import { goStep } from '../demo/ui.js';
import { activeSupportTemplate, applySupportTemplate } from '../demo/actions.js';
import { getSupportTemplate, templateParams } from '../core/supportTemplates.js';
import * as db from './db.js';
import * as E from './engine.js';
import {
  PART_FOLDERS, PROJECT_FOLDERS, machineById, machineName, materialById, stlFromPositions,
} from './catalog.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { renderPartThumb } from './preview.js';

/* 应用控制层：三套方案共用的数据与操作。界面只读 useApp() 的快照、只调这里导出的函数。
   场景只有一个（core 是单例）：「打开工程」= 把工程描述恢复进场景；方案一的多个标签之间切换时，
   未保存的修改按工程描述暂存在内存里（drafts），切回来再恢复。 */

const now = () => new Date().toISOString();
const agoIso = mins => new Date(Date.now() - mins * 60000).toISOString();

let snap = {
  ready: false,
  error: null,
  projects: [],
  library: [],
  projectFolders: PROJECT_FOLDERS,
  partFolders: PART_FOLDERS,
  active: null,
  tabs: [],
  dirty: false,
  changes: [],
  job: null,
  loading: null,
  busy: '',
  lastConfig: { machineId: 'saturn4ultra', materialId: 'std-grey', layerUm: 50, templateId: 'fine' },
  storage: null,
  autosave: false,
  savedAt: null,
};
const subs = new Set();
function set(patch) {
  snap = { ...snap, ...(typeof patch === 'function' ? patch(snap) : patch) };
  subs.forEach(fn => fn());
}
export const getApp = () => snap;
export const useApp = () => useSyncExternalStore(fn => { subs.add(fn); return () => subs.delete(fn); }, () => snap);

const drafts = new Map();   // 工程 id → { desc, dirty, changes, job }（方案一：切标签时暂存未保存的修改）
let lastSig = '';
let lock = 0;                // 自己在改场景时不算「用户修改」

/* ---------- 工艺（当前工程的机器 / 材料 / 层厚 / 模板） ---------- */

const jobOf = rec => ({
  machineId: rec.machineId,
  materialId: rec.materialId,
  layerUm: rec.layerUm,
  templateId: rec.templateId,
});

/** 层厚与模板从 params 里读（用户可能在 Studio 的参数面板里直接改了），机器与材料由本层记录 */
export function currentJob() {
  if (!snap.job) return null;
  return {
    ...snap.job,
    layerUm: Math.round((params.layerH || 0.05) * 1000),
    templateId: activeSupportTemplate(params),
  };
}

/* ---------- 改动检测：只看会进工程文件的内容 ---------- */

let sigTimer = 0;
const EVENT_LABEL = { modelInfo: '零件有改动', supStats: '支撑点有改动', param: '参数有改动' };
function watch(ev) {
  bus.on(ev, () => {
    if (lock || !snap.active || snap.loading) return;
    clearTimeout(sigTimer);
    sigTimer = setTimeout(() => {
      if (lock || !snap.active || snap.loading) return;
      const sig = E.sceneSignature();
      if (sig === lastSig) return;
      lastSig = sig;
      markChanged(EVENT_LABEL[ev]);
    }, 220);
  });
}

function markChanged(label) {
  set(s => ({
    dirty: true,
    changes: s.changes[s.changes.length - 1] === label ? s.changes : [...s.changes, label],
  }));
  if (snap.autosave) scheduleAutosave();
}

/** 自己发起的改动：执行期间不触发自动检测，结束后记一条可读的说明 */
async function own(label, fn) {
  lock++;
  try {
    const out = await fn();
    lastSig = E.sceneSignature();
    if (label) markChanged(label);
    return out;
  } finally {
    lock--;
  }
}

/* ---------- 自动保存（方案二） ---------- */

let autoTimer = 0;
function scheduleAutosave() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    if (snap.dirty && !snap.loading && !snap.busy) saveCurrent({ label: '自动保存', quiet: true });
  }, 1800);
}
export function setAutosave(on) { set({ autosave: !!on }); }

/* ---------- 启动：首次运行导入演示种子 ---------- */

export async function init() {
  if (snap.ready || snap.loadingInit) return;
  set({ loadingInit: true });
  try {
    watch('modelInfo'); watch('supStats'); watch('param');
    const seeded = await db.get('meta', 'seeded');
    if (!seeded) await importSeed();
    const [projects, library, lastConfig] = await Promise.all([db.all('projects'), db.all('library'), db.get('meta', 'lastConfig')]);
    set({ projects: sortProjects(projects), library: sortLibrary(library), lastConfig: lastConfig || snap.lastConfig, ready: true, loadingInit: false });
    refreshStorage();
  } catch (e) {
    console.error(e);
    set({ error: String(e && e.message || e), loadingInit: false });
  }
}

async function importSeed() {
  const res = await fetch('/projects-demo/seed.json');
  if (!res.ok) throw new Error('演示数据读取失败');
  const seed = await res.json();
  await db.putMany('library', seed.library.map(l => {
    const { ago, ...rest } = l;
    return [l.id, { ...rest, createdAt: agoIso(ago + 2600), updatedAt: agoIso(ago), usedAt: null }];
  }));
  await db.putMany('projects', seed.projects.map(p => {
    const { ago, ...rest } = p;
    return [p.id, { ...rest, createdAt: agoIso(ago + 4200), updatedAt: agoIso(ago), openedAt: agoIso(ago) }];
  }));
  await db.putMany('versions', seed.projects.map(p => {
    const ts = Date.now() - p.ago * 60000;
    return [`${p.id}:${ts}`, { ts, label: '保存', desc: p.desc, stats: p.stats, thumb: p.thumb }];
  }));
  await db.put('meta', 'seeded', true);
}

export async function resetDemo() {
  await db.resetAll();
  drafts.clear();
  location.reload();
}

const sortProjects = list => [...list].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
const sortLibrary = list => [...list].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

async function refreshStorage() {
  set({ storage: await db.usage() });
}

/* ---------- 打开 / 关闭 ---------- */

const STEP_P = { '读取工程文件': 0.08, '载入零件': 0.2, '逐层分析': 0.42, '重建支撑结构': 0.66 };

async function getBlob(hash) {
  return db.get('blobs', hash);
}

/** 把一份工程描述恢复进场景（带进度）；title 显示在进度卡上 */
async function restore(desc, title, kind = 'open') {
  set({ loading: { title, label: '读取工程文件', p: 0.04, kind, steps: desc.points?.length ? 4 : 2 } });
  lock++;
  try {
    const t0 = performance.now();
    await E.openScene(desc, {
      getBlob,
      onStep: (label, p) => { if (label) set(s => ({ loading: s.loading && { ...s.loading, label, p: p ?? STEP_P[label] ?? s.loading.p } })); },
    });
    goStep(desc.points?.length ? 'support' : 'model');
    lastSig = E.sceneSignature();
    return performance.now() - t0;
  } finally {
    lock--;
    set({ loading: null });
  }
}

export async function openProject(id) {
  if (snap.loading || snap.busy) return false;
  if (snap.active === id) return true;
  const rec = snap.projects.find(p => p.id === id);
  if (!rec) return false;
  stashCurrent();
  const draft = drafts.get(id);
  const hadTab = snap.tabs.includes(id);
  set(s => ({ pendingId: id, tabs: hadTab ? s.tabs : [...s.tabs, id] }));   // 标签先出来，恢复过程在视口里看得到
  try {
    const ms = await restore(draft?.desc || rec.desc, rec.name);
    set(s => ({
      active: id,
      pendingId: null,
      tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id],
      dirty: !!draft?.dirty,
      changes: draft?.changes || [],
      job: draft?.job || jobOf(rec),
      savedAt: rec.updatedAt,
    }));
    drafts.delete(id);
    const opened = { ...rec, openedAt: now() };
    await db.put('projects', id, opened);
    replaceProject(opened);
    const pts = (draft?.desc || rec.desc).points?.length || 0;
    if (pts) pushToast(`已打开「${rec.name}」`, `${pts} 个支撑点按保存的参数重建，用时 ${(ms / 1000).toFixed(1)} 秒`);
    if (!rec.thumb && state.parts.length) {
      const thumb = E.renderThumb({ color: materialById(rec.materialId).color });
      const withThumb = { ...opened, thumb };
      await db.put('projects', id, withThumb);
      replaceProject(withThumb);
    }
    return true;
  } catch (e) {
    console.error(e);
    pushToast('打开失败', String(e && e.message || e));
    set(s => ({ pendingId: null, tabs: hadTab ? s.tabs : s.tabs.filter(t => t !== id) }));
    return false;
  }
}

/** 当前工程有未保存的修改：按工程描述暂存，切回来时恢复（方案一的标签）。
    在 Studio 里直接打开、还没存过的模型没有来源：几何留在内存里（mem），保存时再落成 blob */
function stashCurrent() {
  if (!snap.active) return;
  if (snap.dirty) {
    const { blobs, stats, ...desc } = E.captureScene();
    for (const b of blobs) desc.parts[b.index] = { ...desc.parts[b.index], src: { kind: 'mem', positions: b.positions } };
    drafts.set(snap.active, { desc: { ...desc, machineId: snap.job?.machineId }, dirty: true, changes: snap.changes, job: snap.job });
  } else {
    drafts.delete(snap.active);
  }
}

/** 保存一个不在场景里的标签（关标签时选「保存」）：暂存的工程描述直接落盘，缩略图沿用上次的 */
export async function saveDraft(id) {
  const d = drafts.get(id);
  const rec = snap.projects.find(p => p.id === id);
  if (!d || !rec) return;
  const desc = { ...d.desc, parts: d.desc.parts.map(p => ({ ...p })) };
  for (let i = 0; i < desc.parts.length; i++) {
    const src = desc.parts[i].src;
    if (src?.kind !== 'mem') continue;
    const buf = src.positions.buffer.slice(src.positions.byteOffset, src.positions.byteOffset + src.positions.byteLength);
    const hash = await db.sha256(buf);
    if (!(await db.get('blobs', hash))) await db.put('blobs', hash, buf);
    desc.parts[i].src = { kind: 'blob', hash };
  }
  const updated = { ...rec, ...d.job, desc, updatedAt: now(), stats: { ...rec.stats, parts: desc.parts.length, points: desc.points.length } };
  await db.put('projects', id, updated);
  const ts = Date.now();
  await db.put('versions', `${id}:${ts}`, { ts, label: '保存', desc, stats: updated.stats, thumb: rec.thumb });
  drafts.delete(id);
  replaceProject(updated);
}

export function isDirty(id) {
  if (id === snap.active) return snap.dirty;
  return !!drafts.get(id)?.dirty;
}

export function closeTab(id) {
  drafts.delete(id);
  set(s => {
    const tabs = s.tabs.filter(t => t !== id);
    return s.active === id ? { tabs, active: null, dirty: false, changes: [], job: null } : { tabs };
  });
}

/* ---------- 保存 ---------- */

async function persistBlobs(blobs, parts) {
  for (const b of blobs || []) {
    const buf = b.positions.buffer.slice(b.positions.byteOffset, b.positions.byteOffset + b.positions.byteLength);
    const hash = await db.sha256(buf);
    if (!(await db.get('blobs', hash))) await db.put('blobs', hash, buf);
    parts[b.index] = { ...parts[b.index], src: { kind: 'blob', hash } };
  }
}

export async function saveCurrent({ label = '保存', quiet = false, name } = {}) {
  if (!snap.active || snap.loading) return null;
  const rec = snap.projects.find(p => p.id === snap.active);
  if (!rec) return null;
  set({ busy: 'save' });
  try {
    const { blobs, stats, ...desc } = E.captureScene();
    await persistBlobs(blobs, desc.parts);
    const job = currentJob();
    const material = materialById(job.materialId);
    const thumb = state.parts.length ? E.renderThumb({ color: material.color }) : null;
    const updated = {
      ...rec,
      name: name || rec.name,
      machineId: job.machineId, materialId: job.materialId, layerUm: job.layerUm, templateId: job.templateId,
      desc: { ...desc, machineId: job.machineId },
      stats, thumb, updatedAt: now(), status: stats.points ? 'supported' : 'new',
    };
    await db.put('projects', rec.id, updated);
    // 手动保存每次记一个历史版本；自动保存只更新工程本身，不刷版本（版本由「存一个版本」显式记）
    if (label !== '自动保存') {
      const ts = Date.now();
      await db.put('versions', `${rec.id}:${ts}`, { ts, label, desc: updated.desc, stats, thumb });
      await db.pruneVersions(rec.id);
    }
    replaceProject(updated);
    lastSig = E.sceneSignature();
    set({ dirty: false, changes: [], savedAt: updated.updatedAt });
    for (const p of desc.parts) if (p.libId) touchPart(p.libId);
    if (!quiet) pushToast(`已保存「${updated.name}」`, `${stats.parts} 个零件、${stats.points} 个支撑点和参数快照`);
    refreshStorage();
    return updated;
  } catch (e) {
    console.error(e);
    pushToast('保存失败', String(e && e.message || e));
    return null;
  } finally {
    set({ busy: '' });
  }
}

/** 另存为：当前场景存成一个新工程（原工程不动），然后切到新工程 */
export async function saveAs(name) {
  if (!snap.active) return null;
  const rec = snap.projects.find(p => p.id === snap.active);
  const id = 'prj-' + Date.now().toString(36);
  const copy = { ...rec, id, name, createdAt: now(), starred: false };
  await db.put('projects', id, copy);
  set(s => ({ projects: sortProjects([copy, ...s.projects]), active: id, tabs: s.tabs.map(t => (t === rec.id ? id : t)) }));
  return saveCurrent({ label: '另存为' });
}

function replaceProject(rec) {
  set(s => ({ projects: sortProjects(s.projects.some(p => p.id === rec.id) ? s.projects.map(p => (p.id === rec.id ? rec : p)) : [rec, ...s.projects]) }));
}

/* ---------- 新建 ---------- */

/** 新建工程：机器 / 材料 / 层厚 / 模板展开成参数快照；parts 为零件库条目（带支撑的条目连同支撑点一起放进来） */
export async function newProject(cfg, partIds = [], { open = true } = {}) {
  const id = 'prj-' + Date.now().toString(36);
  const base = JSON.parse(JSON.stringify(params));
  const tpl = getSupportTemplate(cfg.templateId);
  if (tpl) Object.assign(base, templateParams(tpl));
  base.layerH = cfg.layerUm / 1000;
  const m = machineById(cfg.machineId);
  if (m) Object.assign(base, { plateX: m.plateX, plateZ: m.plateZ, plateY: m.plateY, pixelUm: m.pixelUm });
  const entries = partIds.map(pid => snap.library.find(l => l.id === pid)).filter(Boolean);
  const desc = { machineId: cfg.machineId, params: base, lift: { supportLiftOn: false, joinLift: 0 }, parts: [], points: [] };
  for (const e of entries) addEntryToDesc(desc, e);
  const names = entries.map(e => e.name);
  const rec = {
    id,
    name: cfg.name || (names.length ? `${names[0]}${names.length > 1 ? ` 等 ${names.length} 件` : ''}` : `新工程 ${new Date().toLocaleDateString('zh-CN')}`),
    folder: cfg.folder || 'jobs', starred: false,
    machineId: cfg.machineId, materialId: cfg.materialId, layerUm: cfg.layerUm, templateId: cfg.templateId,
    desc, stats: { parts: entries.length, points: desc.points.length, ok: 0 }, thumb: null,
    createdAt: now(), updatedAt: now(), openedAt: now(), status: 'new',
  };
  await db.put('projects', id, rec);
  const lastConfig = { machineId: cfg.machineId, materialId: cfg.materialId, layerUm: cfg.layerUm, templateId: cfg.templateId };
  await db.put('meta', 'lastConfig', lastConfig);
  set(s => ({ projects: sortProjects([rec, ...s.projects]), lastConfig }));
  if (open) await openProject(id);
  return rec;
}

/** 零件库条目 → 工程描述里的一个零件（+ 它自带的支撑点，坐标是零件局部系，原样带过去） */
function addEntryToDesc(desc, entry, at = null) {
  const pos = at || E.placeNewPart(desc, entry.size || { x: 20, y: 20, z: 20 });
  const index = desc.parts.length;
  desc.parts.push({
    uid: E.newUid(), name: entry.name, src: entry.src, libId: entry.id,
    ox: pos.x, oy: 0, oz: pos.z, q: [0, 0, 0, 1], protected: [], size: entry.size,
  });
  if (entry.sup?.points?.length) {
    for (const p of entry.sup.points) desc.points.push({ ...p, part: index });
    desc.lift = { ...desc.lift, supportLiftOn: true };
  }
  return index;
}

/* ---------- 往当前工程里放零件 ---------- */

export async function insertPart(partId, at = null) {
  if (!snap.active || snap.loading || snap.busy) return;
  const entry = snap.library.find(l => l.id === partId);
  if (!entry) return;
  const { blobs, stats, ...desc } = E.captureScene();
  await persistBlobs(blobs, desc.parts);
  addEntryToDesc(desc, entry, at);
  desc.machineId = snap.job?.machineId;
  await own(`放进「${entry.name}」${entry.sup ? '（带支撑）' : ''}`, () => restore(desc, `放进「${entry.name}」`, 'insert'));
  touchPart(entry.id);
}

/** 从工程移除一个零件。core 的删除会把所有零件的支撑一起清掉；这里只去掉这个零件和它的支撑点，其余原样恢复 */
export async function removePart(index) {
  if (!snap.active || snap.loading || snap.busy) return;
  const { blobs, stats, ...desc } = E.captureScene();
  await persistBlobs(blobs, desc.parts);
  const gone = desc.parts[index];
  if (!gone) return;
  desc.parts.splice(index, 1);
  desc.points = desc.points.filter(p => p.part !== index).map(p => (p.part > index ? { ...p, part: p.part - 1 } : p));
  desc.machineId = snap.job?.machineId;
  await own(`移除「${gone.name}」`, () => restore(desc, `移除「${gone.name}」`, 'remove'));
}

/** 把模型文件直接放进当前工程（不进零件库；要复用再「加入零件库」） */
export async function insertFiles(files) {
  if (!snap.active || snap.loading || snap.busy) return;
  const list = [...files].filter(f => /\.stl$/i.test(f.name));
  if (!list.length) { pushToast('只演示 STL', '请选择 .stl 文件'); return; }
  const { blobs, stats, ...desc } = E.captureScene();
  await persistBlobs(blobs, desc.parts);
  for (const file of list) {
    const g = new STLLoader().parse(await file.arrayBuffer());
    g.rotateX(-Math.PI / 2);
    g.computeBoundingBox();
    const bb = g.boundingBox;
    g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    const pos = g.attributes.position.array;
    const buf = pos.buffer.slice(pos.byteOffset, pos.byteOffset + pos.byteLength);
    const hash = await db.sha256(buf);
    if (!(await db.get('blobs', hash))) await db.put('blobs', hash, buf);
    const size = { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };
    addEntryToDesc(desc, { id: null, name: file.name.replace(/\.stl$/i, ''), src: { kind: 'blob', hash }, size });
    g.dispose();
  }
  desc.machineId = snap.job?.machineId;
  await own(`打开文件 ${list.map(f => f.name).join('、')}`, () => restore(desc, '载入文件', 'insert'));
}

/* ---------- 从当前工程加入零件库（可连同支撑） ---------- */

export async function addToLibrary(partIndex, { name, folder, withSupports = true }) {
  const { blobs, stats, ...desc } = E.captureScene();
  await persistBlobs(blobs, desc.parts);
  const part = desc.parts[partIndex];
  if (!part) return null;
  const pts = withSupports ? desc.points.filter(p => p.part === partIndex).map(p => ({ ...p, part: 0 })) : [];
  const src = part.src;
  const existing = snap.library.find(l => l.src && JSON.stringify(l.src) === JSON.stringify(src));
  const tplId = activeSupportTemplate(params);
  const geom = state.parts[partIndex]?.geom;
  const thumb = existing?.thumb && !pts.length ? existing.thumb : renderPartThumb(geom, pts);
  const entry = {
    id: 'lp-' + Date.now().toString(36),
    name: name || part.name,
    folder: folder || 'test',
    tags: existing?.tags || [],
    src, faces: part.nf, size: part.size,
    sup: pts.length ? { template: tplId, points: pts, stats: { points: pts.length } } : null,
    thumb,
    createdAt: now(), updatedAt: now(), usedAt: null,
  };
  await db.put('library', entry.id, entry);
  set(s => ({ library: sortLibrary([entry, ...s.library]) }));
  pushToast(`已加入零件库「${entry.name}」`, pts.length ? `连同 ${pts.length} 个支撑点；放进别的工程时支撑跟着走` : '只存模型');
  refreshStorage();
  return entry;
}

function touchPart(id) {
  const e = snap.library.find(l => l.id === id);
  if (!e) return;
  const u = { ...e, usedAt: now() };
  db.put('library', id, u);
  set(s => ({ library: s.library.map(l => (l.id === id ? u : l)) }));
}

/* ---------- 工艺切换（真实参数） ---------- */

export async function setMachine(id) {
  if (!snap.active || !snap.job || snap.job.machineId === id) return;
  await own(`机器改为 ${machineName(machineById(id))}`, () => { E.applyMachine(id); });
  set(s => ({ job: { ...s.job, machineId: id } }));
}

export async function setMaterial(id) {
  if (!snap.active || !snap.job || snap.job.materialId === id) return;
  const m = materialById(id);
  set(s => ({ job: { ...s.job, materialId: id } }));
  await own(`材料改为 ${m.name}`, () => {
    const um = Math.round((params.layerH || 0.05) * 1000);
    if (!m.layers.includes(um)) setParam('layerH', m.layers[0] / 1000);
  });
  // 还没有支撑时，支撑模板跟着材料的默认档走；已有支撑就不动（改不改由人决定）
  if (!(state.supportPoints || []).length && m.template && activeSupportTemplate(params) !== m.template) {
    await own(null, () => { for (const [k, v] of Object.entries(templateParams(getSupportTemplate(m.template)))) setParam(k, v); });
  }
}

export async function setLayer(um) {
  if (!snap.active) return;
  await own(`层厚改为 ${um} µm`, () => { setParam('layerH', um / 1000); state.analysis = null; });
}

export async function setTemplate(id) {
  if (!snap.active || snap.busy || snap.loading) return;
  set({ busy: 'template' });
  try {
    await own(`支撑模板改为「${getSupportTemplate(id)?.name || id}」`, () => applySupportTemplate(id, setParam));
  } finally {
    set({ busy: '' });
  }
}

export async function generate() {
  if (!snap.active || snap.busy || snap.loading) return;
  set({ busy: 'generate' });
  try {
    await own((state.supportPoints || []).length ? '重新生成支撑' : '生成支撑', () => E.generateSupports());
  } catch (e) {
    pushToast('生成失败', String(e && e.message || e));
  } finally {
    set({ busy: '' });
  }
}

/* ---------- 工程管理 ---------- */

async function patchProject(id, patch) {
  const rec = snap.projects.find(p => p.id === id);
  if (!rec) return;
  const u = { ...rec, ...patch };
  await db.put('projects', id, u);
  replaceProject(u);
}

export const renameProject = (id, name) => patchProject(id, { name });
export const moveProjects = async (ids, folder) => { for (const id of ids) await patchProject(id, { folder }); };
export const toggleStar = id => patchProject(id, { starred: !snap.projects.find(p => p.id === id)?.starred });

export async function duplicateProject(id) {
  const rec = snap.projects.find(p => p.id === id);
  if (!rec) return null;
  const copy = { ...rec, id: 'prj-' + Date.now().toString(36), name: `${rec.name} 副本`, starred: false, createdAt: now(), updatedAt: now(), openedAt: null };
  await db.put('projects', copy.id, copy);
  replaceProject(copy);
  pushToast('已复制工程', '零件引用同一份模型文件，支撑点一起复制');
  return copy;
}

export async function deleteProjects(ids) {
  for (const id of ids) {
    await db.deleteProjectData(id);
    drafts.delete(id);
  }
  const gone = new Set(ids);
  set(s => ({
    projects: s.projects.filter(p => !gone.has(p.id)),
    tabs: s.tabs.filter(t => !gone.has(t)),
    ...(gone.has(s.active) ? { active: null, dirty: false, changes: [], job: null } : {}),
  }));
  await db.gcBlobs();
  refreshStorage();
}

export const loadVersions = id => db.versionsOf(id);

export async function restoreVersion(id, ts) {
  const list = await db.versionsOf(id);
  const v = list.find(x => x.ts === ts);
  if (!v || snap.active !== id) return;
  await own(`恢复到 ${new Date(ts).toLocaleString('zh-CN', { hour12: false })} 的版本`, () => restore(v.desc, '恢复历史版本', 'version'));
}

/* 大缓冲区分块转 base64（一次展开几百万个参数会爆调用栈） */
function toBase64(buf) {
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/* .rfproj：gzip 压缩的 JSON（设计文档里正式版是 zip；Demo 用浏览器自带的 CompressionStream 演示同样的内容） */
export async function exportProject(id) {
  const rec = snap.projects.find(p => p.id === id);
  if (!rec) return;
  const blobs = {};
  for (const p of rec.desc.parts || []) {
    if (p.src?.kind !== 'blob') continue;
    const buf = await db.get('blobs', p.src.hash);
    if (buf) blobs[p.src.hash] = toBase64(buf);
  }
  const body = JSON.stringify({ schema: 'resinforge.project', schemaVersion: 1, exportedAt: now(), project: rec, blobs });
  const gz = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'));
  const file = await new Response(gz).blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = `${rec.name}.rfproj`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  pushToast('已导出工程', `${rec.name}.rfproj · ${(file.size / 1024).toFixed(0)} KB（模型 + 支撑点 + 参数快照）`);
}

export async function importProjectFile(file) {
  try {
    const text = await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const data = JSON.parse(text);
    if (data.schema !== 'resinforge.project' || !data.project?.desc) throw new Error('不是 ResinForge 工程文件');
    for (const [hash, b64] of Object.entries(data.blobs || {})) {
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      if (!(await db.get('blobs', hash))) await db.put('blobs', hash, u8.buffer);
    }
    const rec = { ...data.project, id: 'prj-' + Date.now().toString(36), createdAt: now(), openedAt: null };
    if (snap.projects.some(p => p.name === rec.name)) rec.name += '（导入）';
    await db.put('projects', rec.id, rec);
    replaceProject(rec);
    pushToast('已导入工程', rec.name);
    return rec;
  } catch (e) {
    pushToast('导入失败', String(e && e.message || e));
    return null;
  }
}

/* ---------- 零件库管理 ---------- */

async function patchPart(id, patch) {
  const e = snap.library.find(l => l.id === id);
  if (!e) return;
  const u = { ...e, ...patch, updatedAt: now() };
  await db.put('library', id, u);
  set(s => ({ library: s.library.map(l => (l.id === id ? u : l)) }));
}

export const renamePart = (id, name) => patchPart(id, { name });
export const moveParts = async (ids, folder) => { for (const id of ids) await patchPart(id, { folder }); };
export const setPartTags = (id, tags) => patchPart(id, { tags });
export const toggleFav = id => patchPart(id, { fav: !snap.library.find(l => l.id === id)?.fav });

export async function deleteParts(ids) {
  for (const id of ids) await db.del('library', id);
  const gone = new Set(ids);
  set(s => ({ library: s.library.filter(l => !gone.has(l.id)) }));
  const n = await db.gcBlobs();
  refreshStorage();
  return n;
}

export const partUsage = id => snap.projects.filter(p => (p.desc?.parts || []).some(x => x.libId === id)).length;

/** 导入 STL：内容哈希查重（同一个文件只存一份），解析成 Y-up 局部几何存进 blobs */
export async function importPartFiles(files, folder = 'test') {
  const added = [];
  for (const file of [...files]) {
    if (!/\.stl$/i.test(file.name)) { pushToast('只演示 STL 导入', file.name); continue; }
    const buf = await file.arrayBuffer();
    const hash = await db.sha256(buf);
    const dup = snap.library.find(l => l.hash === hash);
    if (dup) { pushToast('零件库里已有同一个文件', `「${dup.name}」与 ${file.name} 内容相同，没有重复导入`); continue; }
    const g = new STLLoader().parse(buf);
    g.rotateX(-Math.PI / 2);
    g.computeBoundingBox();
    const bb = g.boundingBox;
    g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    g.computeBoundingBox();
    const pos = g.attributes.position.array;
    const local = pos.buffer.slice(pos.byteOffset, pos.byteOffset + pos.byteLength);
    const blobHash = await db.sha256(local);
    if (!(await db.get('blobs', blobHash))) await db.put('blobs', blobHash, local);
    const size = { x: +(g.boundingBox.max.x - g.boundingBox.min.x).toFixed(2), y: +(g.boundingBox.max.y).toFixed(2), z: +(g.boundingBox.max.z - g.boundingBox.min.z).toFixed(2) };
    const entry = {
      id: 'lp-' + hash.slice(0, 10), name: file.name.replace(/\.stl$/i, ''), folder, tags: ['导入'],
      src: { kind: 'blob', hash: blobHash }, hash, faces: pos.length / 9, size, sup: null,
      thumb: renderPartThumb(g, []), createdAt: now(), updatedAt: now(), usedAt: null,
    };
    g.dispose();
    await db.put('library', entry.id, entry);
    added.push(entry);
  }
  if (added.length) {
    set(s => ({ library: sortLibrary([...added, ...s.library]) }));
    pushToast(`已导入 ${added.length} 个零件`, added.map(a => a.name).join('、'));
    refreshStorage();
  }
  return added;
}

/** 新建工程的默认配置（上次用过的；机器 / 材料页里也可以直接设） */
export async function setLastConfig(patch) {
  const lastConfig = { ...snap.lastConfig, ...patch };
  if (patch.materialId) {
    const m = materialById(patch.materialId);
    if (!m.layers.includes(lastConfig.layerUm)) lastConfig.layerUm = m.layers[0];
    if (m.template) lastConfig.templateId = m.template;
  }
  await db.put('meta', 'lastConfig', lastConfig);
  set({ lastConfig });
}

/* ---------- 文件夹 ---------- */

export function addFolder(kind, name) {
  const id = `${kind}-${Date.now().toString(36)}`;
  if (kind === 'part') set(s => ({ partFolders: [...s.partFolders, { id, name }] }));
  else set(s => ({ projectFolders: [...s.projectFolders, { id, name }] }));
  return id;
}

export { stlFromPositions };
