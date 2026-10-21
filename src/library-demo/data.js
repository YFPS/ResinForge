import { modelMetrics, modelVolume } from './models.js';
import { SUPPORT_TEMPLATES } from '../core/supportTemplates.js';
import { LIFT, supportCount } from './supportsMock.js';

const now = Date.now();
const ago = (mins) => new Date(now - mins * 60000).toISOString();

export const FOLDERS = [
  { id: 'all', name: '全部工程', smart: true, icon: 'grid' },
  { id: 'recent', name: '最近打开', smart: true, icon: 'clock' },
  { id: 'starred', name: '星标', smart: true, icon: 'star' },
  { id: 'test', name: '测试', icon: 'folder' },
  { id: 'jewelry', name: '首饰', icon: 'folder' },
  { id: 'figure', name: '手办', icon: 'folder' },
  { id: 'mech', name: '机械件', icon: 'folder' },
  { id: 'client', name: '客户项目', icon: 'folder' },
  { id: 'decor', name: '摆件', icon: 'folder' },
];

export const LIBRARY_FOLDERS = [
  { id: 'all', name: '全部零件', smart: true, icon: 'grid' },
  { id: 'used', name: '最近使用', smart: true, icon: 'clock' },
  { id: 'fav', name: '收藏', smart: true, icon: 'star' },
  { id: 'test', name: '测试模型', icon: 'folder' },
  { id: 'jewelry', name: '首饰', icon: 'folder' },
  { id: 'figure', name: '手办', icon: 'folder' },
  { id: 'mech', name: '机械件', icon: 'folder' },
  { id: 'decor', name: '摆件', icon: 'folder' },
];

/* 机器档案：取自产品内置机型（src/demo/machines.js 的 BUILTIN_MACHINES，按厂商公开规格整理），
   不直接 import——那份模块依赖 core/model.js，会把整套场景拉进 Demo 页。
   plateX / plateZ 为板面两边，plateY 为打印高度。Form 4 是 LFD 屏（LCD 掩膜），产品表里标的「激光」应为 Form 3 */
export const MACHINES = [
  { id: 'mars4ultra', brand: 'Elegoo', model: 'Mars 4 Ultra', plateX: 153.4, plateY: 165, plateZ: 77.8, pixelUm: 18, type: 'LCD' },
  { id: 'saturn4ultra', brand: 'Elegoo', model: 'Saturn 4 Ultra', plateX: 218.9, plateY: 220, plateZ: 122.9, pixelUm: 19, type: 'LCD' },
  { id: 'm5s', brand: 'Anycubic', model: 'Photon M5s', plateX: 218, plateY: 200, plateZ: 123, pixelUm: 19, type: 'LCD' },
  { id: 'photonmono2', brand: 'Anycubic', model: 'Photon Mono 2', plateX: 143, plateY: 165, plateZ: 89, pixelUm: 34.4, type: 'LCD' },
  { id: 'mighty8k', brand: 'Phrozen', model: 'Sonic Mighty 8K', plateX: 218, plateY: 235, plateZ: 123, pixelUm: 28, type: 'LCD' },
  { id: 'mega8k', brand: 'Phrozen', model: 'Sonic Mega 8K', plateX: 330, plateY: 300, plateZ: 185, pixelUm: 43, type: 'LCD' },
  { id: 'halotmage', brand: 'Creality', model: 'Halot Mage', plateX: 228, plateY: 230, plateZ: 128, pixelUm: 29, type: 'LCD' },
  { id: 'form4', brand: 'Formlabs', model: 'Form 4', plateX: 200, plateY: 210, plateZ: 125, pixelUm: 50, type: 'LFD' },
];

/* 材料档案（通用类型；密度、价格为演示值）。preset = 默认支撑模板（细 / 中细 / 中粗 / 粗） */
export const MATERIALS = [
  { id: 'std-grey', name: '标准树脂 灰', brand: '通用', family: '标准', color: '#9aa0a6', density: 1.1, cost: 180, layers: [30, 50], preset: 'fine', note: '通用件、原型验证' },
  { id: 'wash-white', name: '水洗树脂 白', brand: '通用', family: '水洗', color: '#e8e6df', density: 1.05, cost: 210, layers: [30, 50], preset: 'fine', note: '易清洗，适合手办' },
  { id: 'tough-black', name: '工程树脂 黑', brand: '通用', family: '工程', color: '#3a3d44', density: 1.12, cost: 320, layers: [30, 50], preset: 'mid-fine', note: '韧性件、卡扣' },
  { id: 'cast-violet', name: '铸造树脂 紫', brand: '通用', family: '铸造', color: '#8c6bd8', density: 1.15, cost: 420, layers: [25, 50], preset: 'fine', note: '首饰、失蜡铸造' },
  { id: 'flex-clear', name: '弹性树脂 透明', brand: '通用', family: '弹性', color: '#bcd9d5', density: 1.02, cost: 380, layers: [50], preset: 'mid-coarse', note: '软胶、密封件；支撑要粗' },
  { id: 'precision-ivory', name: '高精度树脂 米白', brand: '通用', family: '高精度', color: '#e6dcc8', density: 1.08, cost: 360, layers: [20, 30, 50], preset: 'fine', note: '微缩模型、细节件' },
];

export const SUPPORT_PRESETS = SUPPORT_TEMPLATES.map(t => ({
  id: t.id, name: t.name, diameter: t.diameter, spacing: t.spacing, tipW: t.tipW,
}));
export const presetName = id => (SUPPORT_PRESETS.find(p => p.id === id) || SUPPORT_PRESETS[0]).name;

/* ---------- 零件库 ---------- */

const PART_DEFS = [
  { id: 'lib-ring-01', name: '戒圈_01', key: 'ring', folder: 'jewelry', tags: ['戒指', '铸造'], fav: true, note: '内径 17.3 mm，壁厚 2.0 mm' },
  { id: 'lib-gear-36', name: '齿轮_36T', key: 'gear', folder: 'mech', tags: ['齿轮', '装配'], note: '模数 0.8，36 齿' },
  { id: 'lib-bracket', name: '小支架', key: 'bracket', folder: 'mech', tags: ['结构', '装配'], note: 'L 形加强支架' },
  { id: 'lib-figure', name: '手办_坐姿', key: 'figurine', folder: 'figure', tags: ['人像', '手办'], fav: true, note: '坐姿，细节保留版' },
  { id: 'lib-vase', name: '薄壁花瓶', key: 'vase', folder: 'decor', tags: ['薄壁', '摆件'], note: '壁厚 1.4 mm' },
  { id: 'lib-mushroom', name: '蘑菇伞盖', key: 'mushroom', folder: 'test', tags: ['悬垂', '测试'], note: '演示模型' },
  { id: 'lib-knot', name: '环面结', key: 'knot', folder: 'test', tags: ['自交', '测试'], note: '演示模型' },
  { id: 'lib-cube', name: '正方体', key: 'cube', folder: 'test', tags: ['平底', '测试'], note: '平底验证块' },
  { id: 'lib-tier', name: '双层平台', key: 'tier', folder: 'test', tags: ['窄缝', '测试'], note: '2 mm 窄缝' },
  { id: 'lib-statue', name: '悬臂雕像', key: 'statue', folder: 'figure', tags: ['悬臂', '测试'], note: '球顶 + 悬臂' },
];

const metricsCache = new Map();
export function keyInfo(key) {
  if (!metricsCache.has(key)) metricsCache.set(key, modelMetrics(key));
  return metricsCache.get(key);
}

export function makeLibraryPart(def, minutes = 30) {
  return {
    fav: false, tags: [], note: '', source: 'builtin',
    ...def,
    ...keyInfo(def.key),
    updatedAt: ago(minutes),
    createdAt: ago(minutes + 2400),
  };
}

export const LIBRARY = PART_DEFS.map((p, i) => makeLibraryPart(p, 20 + i * 137));

/* ---------- 工程 ---------- */

let uidSeq = 0;
export const newUid = () => 'it' + (++uidSeq).toString(36);

export function makeItem(key, name, libId = null, sup = false, origin = 'library') {
  return { uid: newUid(), key, name, libId, sup, origin, pos: null };
}

/* 零件在板上的位置：item.pos 有值（拖进视口的落点）就用，否则沿 X 排成一行、整组居中，间距 8 mm */
export function layoutItems(items) {
  const GAP = 8;
  const auto = items.filter(it => !it.pos);
  const total = auto.reduce((s, it) => s + keyInfo(it.key).size.x, 0) + GAP * Math.max(0, auto.length - 1);
  let x = -total / 2;
  const out = new Map();
  for (const it of auto) {
    const w = keyInfo(it.key).size.x;
    out.set(it.uid, { x: x + w / 2, z: 0 });
    x += w + GAP;
  }
  for (const it of items) if (it.pos) out.set(it.uid, it.pos);
  return out;
}

const libName = key => (PART_DEFS.find(p => p.key === key) || {}).name || key;
const libIdOf = key => (PART_DEFS.find(p => p.key === key) || {}).id || null;

/** 工程的派生摘要：零件数、面数、支撑点数、占地尺寸、近似树脂用量、层数（随零件 / 预设 / 层厚变化，保存时重算） */
export function summarize(project) {
  const items = project.items || [];
  const lifted = items.some(it => it.sup);
  let faces = 0, supports = 0, vol = 0, w = 0, d = 0, h = 0;
  for (const it of items) {
    const info = keyInfo(it.key);
    faces += info.faces;
    vol += modelVolume(it.key);
    if (it.sup) supports += supportCount(it.key, project.preset);
    w += info.size.x;
    d = Math.max(d, info.size.z);
    h = Math.max(h, info.size.y);
  }
  w += Math.max(0, items.length - 1) * 8;
  const height = h + (lifted ? LIFT : 0);
  const material = MATERIALS.find(m => m.id === project.materialId) || MATERIALS[0];
  return {
    parts: items.length,
    faces,
    supports,
    size: { x: +w.toFixed(1), y: +height.toFixed(1), z: +d.toFixed(1) },
    layers: Math.ceil(height * 1000 / (project.layerUm || 50)),
    resinG: +(vol / 1000 * material.density * (lifted ? 1.12 : 1)).toFixed(1),   // 支撑按模型的 12% 粗估
    keys: items.map(it => it.key),
  };
}

export const withSummary = project => ({ ...project, ...summarize(project) });

const project = (id, name, keys, opts) => {
  const { folder, machineId, materialId, layerUm = 30, preset = 'fine', starred = false, minutes, status = 'ready', sup = true } = opts;
  const items = keys.map(k => makeItem(k, libName(k), libIdOf(k), sup));
  return withSummary({ id, name, folder, machineId, materialId, layerUm, preset, starred, updatedAt: ago(minutes), status, items });
};

export const PROJECTS = [
  project('prj-knot', '环面结 · 支撑参数验证', ['knot'], { folder: 'test', machineId: 'saturn4ultra', materialId: 'std-grey', starred: true, minutes: 42 }),
  project('prj-statue', '悬臂雕像 · 0.3mm 接触', ['statue'], { folder: 'figure', machineId: 'mars4ultra', materialId: 'wash-white', starred: true, minutes: 180 }),
  project('prj-tier', '双层平台 · 窄缝测试', ['tier', 'cube'], { folder: 'test', machineId: 'saturn4ultra', materialId: 'tough-black', preset: 'mid-fine', minutes: 500 }),
  project('prj-mushroom', '蘑菇 · 伞盖支撑', ['mushroom'], { folder: 'test', machineId: 'mars4ultra', materialId: 'std-grey', minutes: 720 }),
  project('prj-ring-batch', '戒指批量 · 5 件排版', ['ring', 'ring', 'ring', 'ring', 'ring'], { folder: 'jewelry', machineId: 'saturn4ultra', materialId: 'cast-violet', layerUm: 25, starred: true, minutes: 1440 }),
  project('prj-client-a', '小件合集 · 客户 A', ['bracket', 'gear', 'figurine'], { folder: 'client', machineId: 'm5s', materialId: 'std-grey', minutes: 2100 }),
  project('prj-vase', '薄壁花瓶 · 20µm 层厚', ['vase'], { folder: 'decor', machineId: 'mega8k', materialId: 'precision-ivory', layerUm: 20, minutes: 2900 }),
  project('prj-cube', '正方体 · 平底验证', ['cube'], { folder: 'test', machineId: 'photonmono2', materialId: 'std-grey', layerUm: 50, minutes: 4300, status: 'sliced' }),
];

/* 零件被多少个工程引用（按工程里零件条目记下的库条目 id 统计；副本语义下删库条目不影响这些工程） */
export function usageOf(partId, projects) {
  let n = 0;
  for (const p of projects) if ((p.items || []).some(it => it.libId === partId)) n++;
  return n;
}

export const machineById = id => MACHINES.find(m => m.id === id) || MACHINES[0];
export const materialById = id => MATERIALS.find(m => m.id === id) || MATERIALS[0];
export const folderName = (id, list = FOLDERS) => (list.find(f => f.id === id) || {}).name || '未分类';

export function relativeTime(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  if (mins < 1440) return `${Math.round(mins / 60)} 小时前`;
  if (mins < 10080) return `${Math.round(mins / 1440)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export const thumbKeyOfProject = p => (p.items || []).map(it => it.key + (it.sup ? '*' : '')).join('+') + '|' + p.preset + '|' + p.materialId;
