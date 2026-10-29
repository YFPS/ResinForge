/* 材料目录。图片是厂商产品图，放在 public/catalog/resins，界面不请求外网。
   只记展示用的名字，不改支撑参数。选中项存在本机。 */
const KEY = 'resinforge:resin.current';
const LAST_KEY = 'resinforge:device.last';

export const RESINS = [
  { id: 'elegoo-std', brand: 'Elegoo', name: 'Standard V2.0', kind: '标准光敏树脂' },
  { id: 'elegoo-8k', brand: 'Elegoo', name: '8K Standard', kind: '8K 标准树脂' },
  { id: 'elegoo-abs', brand: 'Elegoo', name: 'ABS-Like V3.0', kind: '类 ABS 树脂' },
  { id: 'elegoo-ww', brand: 'Elegoo', name: 'Water-Washable V2.0', kind: '水洗树脂' },
  { id: 'anycubic-std', brand: 'Anycubic', name: 'Standard', kind: '标准光敏树脂' },
  { id: 'anycubic-abs', brand: 'Anycubic', name: 'ABS-Like 2.0', kind: '类 ABS 树脂' },
  { id: 'anycubic-ww', brand: 'Anycubic', name: 'Water-Wash 2.0', kind: '水洗树脂' },
  { id: 'anycubic-hs', brand: 'Anycubic', name: 'High Speed 2.0', kind: '高速树脂' },
  { id: 'phrozen-aqua', brand: 'Phrozen', name: 'Aqua-Gray 8K', kind: '水洗模型树脂' },
  { id: 'creality-std', brand: 'Creality', name: 'HALOT 16K Standard', kind: '标准光敏树脂' },
];

export const resinLabel = r => (r ? `${r.brand} ${r.name}` : '');

export function readResinId() {
  try {
    const id = localStorage.getItem(KEY);
    return RESINS.some(r => r.id === id) ? id : null;
  } catch {
    return null;
  }
}

export function writeResinId(id) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch { /* 隐私模式写不进去就只留在这一页 */ }
}

export function readLastDevice() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeLastDevice(entry) {
  try { localStorage.setItem(LAST_KEY, JSON.stringify(entry)); } catch { /* 同上 */ }
}
