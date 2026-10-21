/* 机型预设：内置常见光固化打印机（构建板 X/Z 与 XY 像素），外加用户自定义机型（存浏览器 localStorage）。
   参数取自厂商公开规格（成型尺寸 / XY 分辨率），用于越界警告与分析格像素比提示；
   如有出入可直接改三个参数后「保存为机型」，自定义项优先于内置项参与匹配。
   顶栏的打印机选择与「模型」步骤的板面检查共用这里的 store。 */
import { useSyncExternalStore } from 'react';
import { onPlateChanged } from '../core/model.js';

export const CUSTOM_ID = '__custom__';

const STORAGE_KEY = 'resinforge:machines.v1';
/* 当前生效的机器参数：机器属「环境配置」而非工作状态，所以跟随用户持久化
   （模型 / 保护面 / 支撑等仍是刷新即丢） */
const CURRENT_KEY = 'resinforge:machine.current';

/** 内置机型（入门桌面 / 主流中端 / 大尺寸 / SLA 激光） */
export const BUILTIN_MACHINES = [
  { id: 'mars3', brand: 'Elegoo', model: 'Mars 3', plateX: 143.4, plateY: 175, plateZ: 89.6, pixelUm: 35 },
  { id: 'mars4ultra', brand: 'Elegoo', model: 'Mars 4 Ultra', plateX: 153.4, plateY: 165, plateZ: 77.8, pixelUm: 18 },
  { id: 'halotone', brand: 'Creality', model: 'Halot One', plateX: 130, plateY: 160, plateZ: 82, pixelUm: 50 },
  { id: 'photonmono2', brand: 'Anycubic', model: 'Photon Mono 2', plateX: 143, plateY: 165, plateZ: 89, pixelUm: 34.4 },
  { id: 'saturn2', brand: 'Elegoo', model: 'Saturn 2', plateX: 218.9, plateY: 250, plateZ: 122.9, pixelUm: 28.5 },
  { id: 'saturn4ultra', brand: 'Elegoo', model: 'Saturn 4 Ultra', plateX: 218.9, plateY: 220, plateZ: 122.9, pixelUm: 19 },
  { id: 'monox6k', brand: 'Anycubic', model: 'Photon Mono X 6K', plateX: 198, plateY: 245, plateZ: 123, pixelUm: 34.5 },
  { id: 'm5s', brand: 'Anycubic', model: 'Photon M5s', plateX: 218, plateY: 200, plateZ: 123, pixelUm: 19 },
  { id: 'halotmage', brand: 'Creality', model: 'Halot Mage', plateX: 228, plateY: 230, plateZ: 128, pixelUm: 29 },
  { id: 'mighty8k', brand: 'Phrozen', model: 'Sonic Mighty 8K', plateX: 218, plateY: 235, plateZ: 123, pixelUm: 28 },
  { id: 'mega8k', brand: 'Phrozen', model: 'Sonic Mega 8K', plateX: 330, plateY: 300, plateZ: 185, pixelUm: 43 },
  { id: 'form3', brand: 'Formlabs', model: 'Form 3（激光）', plateX: 145, plateY: 185, plateZ: 145, pixelUm: 85 },
  { id: 'form4', brand: 'Formlabs', model: 'Form 4（激光）', plateX: 200, plateY: 210, plateZ: 125, pixelUm: 50 },
];

const isMachine = m => m && typeof m === 'object'
  && typeof m.id === 'string' && typeof m.name === 'string'
  && Number.isFinite(m.plateX) && Number.isFinite(m.plateZ) && Number.isFinite(m.pixelUm);

const isTriple = m => m && Number.isFinite(m.plateX) && Number.isFinite(m.plateZ) && Number.isFinite(m.pixelUm);

function loadSavedMachines() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(list) ? list.filter(isMachine) : [];
  } catch {
    return [];
  }
}

function persistSavedMachines(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* 隐私模式下写入失败：静默降级 */ }
}

function rememberMachine(p) {
  try { localStorage.setItem(CURRENT_KEY, JSON.stringify({ plateX: p.plateX, plateY: p.plateY, plateZ: p.plateZ, pixelUm: p.pixelUm })); } catch { /* 同上 */ }
}

/** 当前三个参数命中的机型（已保存优先于内置），无命中返回 null */
const matchMachine = (machines, p) => machines.find(m =>
  m.plateX === p.plateX && m.plateZ === p.plateZ && m.pixelUm === p.pixelUm) || null;

export const machineLabel = m => (m.name ? m.name : `${m.brand} ${m.model}`);

/* ---------- store ----------
   选中项显式记录 selectedId，而不是每次用参数反推——否则参数相同的自定义机型会被内置机型顶掉。 */

let params = null;   // store.js 的 params（initMachine 注入，避免本模块直接依赖 store）
let snap = { saved: [], selectedId: CUSTOM_ID, plateX: 0, plateY: 0, plateZ: 0, pixelUm: 0 };
const subs = new Set();
function publish(patch) {
  snap = { ...snap, ...patch, plateX: params.plateX, plateY: params.plateY, plateZ: params.plateZ, pixelUm: params.pixelUm };
  subs.forEach(fn => fn());
}

export const useMachine = () => useSyncExternalStore(fn => { subs.add(fn); return () => subs.delete(fn); }, () => snap);

/** 首帧前调用（demo/main.jsx）：把上次的机器参数写回 params，并认出它属于哪台机型 */
export function initMachine(p) {
  params = p;
  try {
    const m = JSON.parse(localStorage.getItem(CURRENT_KEY) || 'null');
    if (isTriple(m)) {
      p.plateX = m.plateX; p.plateZ = m.plateZ; p.pixelUm = m.pixelUm;
      if (Number.isFinite(m.plateY)) p.plateY = m.plateY;
    }
    const saved = loadSavedMachines();
    const hit = matchMachine([...saved, ...BUILTIN_MACHINES], p);
    // 旧记录没有打印高度时，用命中机型的公开高度，体积框才跟机型走
    if (hit && Number.isFinite(hit.plateY) && !(m && Number.isFinite(m.plateY))) p.plateY = hit.plateY;
    publish({ saved, selectedId: hit ? hit.id : CUSTOM_ID });
  } catch { /* 数据损坏时保持默认值 */
    publish({ saved: loadSavedMachines(), selectedId: CUSTOM_ID });
  }
}

/** 当前选中的机型对象；自定义时为 null */
export const currentMachine = s => [...s.saved, ...BUILTIN_MACHINES].find(m => m.id === s.selectedId) || null;

/** 选机型：内置 / 已保存的直接写入三个参数；「自定义」保留当前参数，便于以现有机器为模板微调 */
export function selectMachine(id) {
  const m = [...snap.saved, ...BUILTIN_MACHINES].find(x => x.id === id);
  if (m) {
    params.plateX = m.plateX;
    params.plateZ = m.plateZ;
    params.pixelUm = m.pixelUm;
    if (Number.isFinite(m.plateY)) params.plateY = m.plateY;
    rememberMachine(params);
    onPlateChanged();
  }
  publish({ selectedId: m ? m.id : CUSTOM_ID });
}

/** 自定义参数改动（板面 X / Z、像素） */
export function setMachineParam(key, v) {
  params[key] = v;
  rememberMachine(params);
  publish({});
  onPlateChanged();
}

export function saveCustomMachine(name) {
  const entry = { id: 'c' + Date.now(), name, plateX: params.plateX, plateY: params.plateY, plateZ: params.plateZ, pixelUm: params.pixelUm };
  const saved = [...snap.saved, entry];
  persistSavedMachines(saved);
  publish({ saved, selectedId: entry.id });
  return entry;
}

export function deleteMachine(id) {
  const saved = snap.saved.filter(m => m.id !== id);
  persistSavedMachines(saved);
  publish({ saved, selectedId: CUSTOM_ID });   // 参数保留，回到自定义
}
