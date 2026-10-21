/* 本地存储（IndexedDB）：浏览器版的工程 / 零件库落盘方式，与设计文档 4.2 一致。
   stores：
     projects  工程记录（元数据 + 工程描述：参数快照、零件、支撑点、缩略图）
     versions  历史版本（每次保存一份工程描述 + 缩略图），key = `${projectId}:${ts}`
     library   零件库条目（来源、可选的支撑点与模板、缩略图、标签）
     blobs     模型文件（导入 / 在 Studio 里打开的零件的局部几何），key = 内容哈希，工程与零件库共用
     meta      杂项：是否已导入演示数据、上次的新建配置、自定义机器 / 材料 */

const DB_NAME = 'resinforge-projects-demo';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of ['projects', 'versions', 'library', 'blobs', 'meta']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let out;
    Promise.resolve(fn(t.objectStore(store))).then(v => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const get = (store, key) => tx(store, 'readonly', s => req(s.get(key)));
export const put = (store, key, value) => tx(store, 'readwrite', s => req(s.put(value, key)));
export const del = (store, key) => tx(store, 'readwrite', s => req(s.delete(key)));
export const all = store => tx(store, 'readonly', s => req(s.getAll()));
export const keys = store => tx(store, 'readonly', s => req(s.getAllKeys()));

export async function putMany(store, entries) {
  return tx(store, 'readwrite', s => Promise.all(entries.map(([k, v]) => req(s.put(v, k)))));
}

/** 某个工程的历史版本（新 → 旧） */
export async function versionsOf(projectId) {
  const ks = (await keys('versions')).filter(k => String(k).startsWith(projectId + ':'));
  const list = await Promise.all(ks.map(k => get('versions', k)));
  return list.filter(Boolean).sort((a, b) => b.ts - a.ts);
}

/** 只留最近 n 个版本 */
export async function pruneVersions(projectId, n = 12) {
  const list = await versionsOf(projectId);
  await Promise.all(list.slice(n).map(v => del('versions', `${projectId}:${v.ts}`)));
}

export async function deleteProjectData(projectId) {
  await del('projects', projectId);
  const ks = (await keys('versions')).filter(k => String(k).startsWith(projectId + ':'));
  await Promise.all(ks.map(k => del('versions', k)));
}

/** 没有任何工程 / 零件引用的模型文件回收掉（内容寻址 + 引用计数，设计文档 5.3） */
export async function gcBlobs() {
  const [projects, library, versions, blobKeys] = await Promise.all([all('projects'), all('library'), all('versions'), keys('blobs')]);
  const used = new Set();
  const mark = parts => { for (const p of parts || []) if (p.src?.kind === 'blob') used.add(p.src.hash); };
  for (const p of projects) mark(p.desc?.parts);
  for (const v of versions) mark(v.desc?.parts);
  for (const l of library) if (l.src?.kind === 'blob') used.add(l.src.hash);
  const drop = blobKeys.filter(k => !used.has(k));
  await Promise.all(drop.map(k => del('blobs', k)));
  return drop.length;
}

export async function usage() {
  try {
    const e = await navigator.storage.estimate();
    return { used: e.usage || 0, quota: e.quota || 0 };
  } catch {
    return null;
  }
}

export async function resetAll() {
  const db = await open();
  db.close();
  dbp = null;
  await new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = resolve; r.onerror = () => reject(r.error); r.onblocked = resolve;
  });
}

export async function sha256(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
