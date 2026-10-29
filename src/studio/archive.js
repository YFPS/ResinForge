/* 工程和零件库。几何放 IndexedDB，列表只留摘要，避免一打开就把大模型全读进页面。 */
import { bus } from '../store.js';

const DB = 'resinforge-desk';
const VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('library')) db.createObjectStore('library', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('写入中断'));
  });
}

async function put(store, record) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(record);
  await txDone(tx);
  db.close();
  bus.emit('archive');
}

async function remove(store, id) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  await txDone(tx);
  db.close();
  bus.emit('archive');
}

async function all(store) {
  const db = await openDb();
  const tx = db.transaction(store, 'readonly');
  const req = tx.objectStore(store).getAll();
  const rows = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return rows;
}

async function one(store, id) {
  const db = await openDb();
  const tx = db.transaction(store, 'readonly');
  const req = tx.objectStore(store).get(id);
  const row = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return row;
}

const countOf = v => (Array.isArray(v) ? v.length : (v || 0));

const slim = row => ({
  id: row.id,
  name: row.name,
  savedAt: row.savedAt,
  kind: row.kind || 'part',
  faces: row.faces || 0,
  parts: row.partCount != null ? row.partCount : countOf(row.parts),
  points: row.pointCount != null ? row.pointCount : countOf(row.points),
  machine: row.machine || '',
  folderId: row.folderId || '',
  thumb: row.thumb || '',
});

export function listProjects() {
  return all('projects').then(rows => rows.map(slim).sort((a, b) => b.savedAt - a.savedAt));
}

export function listLibrary() {
  return all('library').then(rows => rows.map(slim).sort((a, b) => b.savedAt - a.savedAt));
}

export function readProject(id) { return one('projects', id); }
export function readLibraryItem(id) { return one('library', id); }

export function saveProject(record) { return put('projects', record); }
export function saveLibraryItem(record) { return put('library', record); }
export function deleteProject(id) { return remove('projects', id); }
export function deleteLibraryItem(id) { return remove('library', id); }

export async function updateProjectThumb(id, thumb) {
  const row = await readProject(id);
  if (row) await put('projects', { ...row, thumb });
}

export async function updateLibraryThumb(id, thumb) {
  const row = await readLibraryItem(id);
  if (row) await put('library', { ...row, thumb });
}

export function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
