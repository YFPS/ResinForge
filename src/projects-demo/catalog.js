import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { mergeGeoms } from '../core/model.js';
import { BUILTIN_MACHINES } from '../demo/machines.js';
import { SUPPORT_TEMPLATES } from '../core/supportTemplates.js';

/* 演示目录：零件几何、材料档案、机器（直接用产品内置机型表）。
   零件几何都是闭合实体，交给真实的 core 载入、分析、生成支撑：
   - core：与 core/model.js 的 loadDemo 同一套几何（环面结 / 蘑菇 / 双层平台 / 悬臂雕像 / 正方体）
   - 程序化：戒指、齿轮、带孔支架、薄壁花瓶（Demo 里补几件常见的树脂件形状）
   - 文件：仓库里的真实 STL（手办底座两件，约 10 万面）
   几何为 Y-up；交给 core 前转成 Z-up 的二进制 STL（core 载入时 rotateX(-90°) 正好还原）。 */

/* ---------- 几何 ---------- */

function demoKnot() {
  const g = new THREE.TorusKnotGeometry(13, 3.8, 200, 30);
  g.scale(1.5, 1.5, 1.5);
  return g;
}

function demoMushroom() {
  return mergeGeoms([
    { g: new THREE.CylinderGeometry(3.5, 5.5, 22, 28), y: 11 },
    (() => {
      const pts = [];
      for (let i = 0; i <= 24; i++) { const th = i / 24 * Math.PI / 2; pts.push(new THREE.Vector2(15.8 * Math.sin(th), 22 + 15.8 * Math.cos(th))); }
      for (let i = 24; i >= 0; i--) { const th = i / 24 * Math.PI / 2; pts.push(new THREE.Vector2(17.0 * Math.sin(th), 22 + 17.0 * Math.cos(th))); }
      return { g: new THREE.LatheGeometry(pts, 48), y: 0 };
    })(),
  ]);
}

function demoTier() {
  return mergeGeoms([
    { g: new THREE.CylinderGeometry(3, 4, 20, 24), y: 10 },
    { g: new THREE.CylinderGeometry(13, 13, 3, 32), y: 21.5 },
    { g: new THREE.CylinderGeometry(10, 10, 3, 32), y: 26.5 },
  ]);
}

function demoCube() {
  return new THREE.BoxGeometry(40, 40, 40);
}

function demoStatue() {
  return mergeGeoms([
    { g: new THREE.BoxGeometry(30, 5, 30), y: 2.5 },
    { g: new THREE.CylinderGeometry(7, 10, 30, 24), y: 20 },
    { g: new THREE.SphereGeometry(8, 24, 16), y: 50 },
    { g: new THREE.BoxGeometry(30, 2.5, 2.5), y: 40 },
    { g: new THREE.BoxGeometry(1.5, 28, 2.5), x: 14, y: 54 },
  ]);
}

/* 戒指：立放的戒圈 + 镶口 + 主石（三块实体重叠，core 的分析按并集处理） */
function ring() {
  const band = new THREE.TorusGeometry(9.2, 1.7, 28, 120);           // XY 平面内立放，圈底 y = -10.9
  band.translate(0, 10.9, 0);
  const bezel = new THREE.CylinderGeometry(2.6, 2.1, 2.4, 6);
  bezel.translate(0, 21.9, 0);
  const gem = new THREE.OctahedronGeometry(3.1, 0);
  gem.scale(1, 0.82, 1);
  gem.rotateY(Math.PI / 4);
  gem.translate(0, 24.3, 0);
  // 首饰件常见的倾斜摆放（绕 X 轴倾 35°）：戒圈一侧整段悬空，支撑落在圈外侧，内圈与主石不碰支撑
  const g = mergeGeoms([{ g: band }, { g: bezel }, { g: gem }]);
  g.rotateX(-35 * Math.PI / 180);
  return g;
}

/* 齿轮：28 齿直齿轮，平放；齿形用梯形近似，中间轴孔带键槽 */
function gear() {
  const teeth = 28, rRoot = 15.2, rTip = 17.6;
  const shape = new THREE.Shape();
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    const pts = [
      [rRoot, a0], [rRoot, a0 + step * 0.18], [rTip, a0 + step * 0.32],
      [rTip, a0 + step * 0.58], [rRoot, a0 + step * 0.72],
    ];
    pts.forEach(([r, a], k) => {
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0 && k === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    });
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, 4, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(shape, { depth: 6, bevelEnabled: true, bevelThickness: 0.5, bevelSize: 0.4, bevelSegments: 2, curveSegments: 24 });
  g.rotateX(-Math.PI / 2);
  return g;
}

/* 带孔 L 形支架：竖板朝上，水平板底面悬空需要支撑 */
function bracket() {
  const s = new THREE.Shape();
  s.moveTo(0, 0); s.lineTo(34, 0); s.lineTo(34, 4); s.lineTo(4, 4); s.lineTo(4, 26); s.lineTo(0, 26); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 18, bevelEnabled: false });
  g.translate(-17, 0, -9);
  // 水平板上两个安装凸台
  const boss1 = new THREE.CylinderGeometry(3.2, 3.2, 2.2, 32); boss1.translate(8, 5.1, 0);
  const boss2 = new THREE.CylinderGeometry(3.2, 3.2, 2.2, 32); boss2.translate(-2, 5.1, 0);
  return mergeGeoms([{ g }, { g: boss1 }, { g: boss2 }]);
}

/* 薄壁花瓶：闭合的回转截面（外壁向上 → 瓶口 → 内壁向下 → 瓶底），壁厚约 1.4 mm */
function vase() {
  const outer = [[6, 0], [9.5, 3], [12, 10], [12.6, 18], [10.2, 28], [7, 34], [6.2, 39], [7.4, 42]];
  const inner = outer.slice().reverse().map(([r, y]) => [Math.max(r - 1.4, 0.01), Math.max(y, 1.6)]);
  inner[0][1] = 41;
  const pts = [new THREE.Vector2(0.01, 0)];
  for (const [r, y] of outer) pts.push(new THREE.Vector2(r, y));
  for (const [r, y] of inner) pts.push(new THREE.Vector2(r, y));
  pts.push(new THREE.Vector2(0.01, 1.6));
  return new THREE.LatheGeometry(pts, 64);
}

export const GEN = {
  knot: demoKnot, mushroom: demoMushroom, tier: demoTier, cube: demoCube, statue: demoStatue,
  ring, gear, bracket, vase,
};

/* 仓库里的真实 STL（Vite 开发服务器按项目根目录提供）。
   这两件是按 Y-up 导出的，core 按 Z-up 转换后圆盘会立起来；rotX 把它放平（场景坐标里绕 X 轴转） */
export const FILES = {
  'figure-base': { url: '/2B - 1_12/Base.stl', rotX: -90 },
  'figure-base-hollow': { url: '/2B - 1_12/Base(hollowed).stl', rotX: -90 },
};

/** 零件来源 → 几何（Y-up、非索引） */
const fileCache = new Map();
export async function geometryOf(src) {
  if (src.kind === 'gen') {
    const g = GEN[src.key]();
    return g.index ? g.toNonIndexed() : g;
  }
  if (src.kind === 'file') {
    const f = FILES[src.key];
    if (!fileCache.has(src.key)) {
      fileCache.set(src.key, fetch(encodeURI(f.url)).then(r => {
        if (!r.ok) throw new Error(`读取 ${f.url} 失败（${r.status}）`);
        return r.arrayBuffer();
      }).then(buf => {
        if (!f.rotX) return buf;
        const g = new STLLoader().parse(buf);
        g.rotateX(-Math.PI / 2);                    // 文件 Z-up → 场景 Y-up（同 core 载入）
        g.rotateX(f.rotX * Math.PI / 180);
        return stlFromGeometry(g);
      }));
    }
    // core 解析时会把缓冲区转交给后台线程（转交后原缓冲区变空），每次给一份拷贝
    return { stl: (await fileCache.get(src.key)).slice(0) };
  }
  throw new Error('未知零件来源');
}

/** Y-up 几何 → Z-up 二进制 STL */
export function stlFromGeometry(geom) {
  const g = geom.index ? geom.toNonIndexed() : geom;
  return stlFromPositions(g.attributes.position.array);
}

export function stlFromPositions(pos) {
  const nf = pos.length / 9;
  const buf = new ArrayBuffer(84 + nf * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, nf, true);
  let o = 84;
  for (let f = 0; f < nf; f++) {
    o += 12;
    for (let k = 0; k < 3; k++) {
      const i = f * 9 + k * 3;
      dv.setFloat32(o, pos[i], true);
      dv.setFloat32(o + 4, -pos[i + 2], true);
      dv.setFloat32(o + 8, pos[i + 1], true);
      o += 12;
    }
    o += 2;
  }
  return buf;
}

/* ---------- 零件库演示条目 ---------- */

export const PART_FOLDERS = [
  { id: 'jewelry', name: '首饰' },
  { id: 'figure', name: '手办' },
  { id: 'mech', name: '机械件' },
  { id: 'decor', name: '摆件' },
  { id: 'test', name: '测试件' },
];

export const PROJECT_FOLDERS = [
  { id: 'jobs', name: '在做' },
  { id: 'jewelry', name: '首饰' },
  { id: 'figure', name: '手办' },
  { id: 'test', name: '测试' },
];

/* sup：入库时是否连同支撑一起存（模板 id）；null = 只有模型 */
export const LIBRARY_SEED = [
  { id: 'lp-ring', name: '戒指 主石款', src: { kind: 'gen', key: 'ring' }, folder: 'jewelry', tags: ['戒指', '铸造'], sup: 'fine' },
  { id: 'lp-figure-base', name: '手办底座', src: { kind: 'file', key: 'figure-base' }, folder: 'figure', tags: ['底座'], sup: 'mid-coarse' },
  { id: 'lp-figure-base-hollow', name: '手办底座（镂空）', src: { kind: 'file', key: 'figure-base-hollow' }, folder: 'figure', tags: ['底座', '镂空'], sup: null },
  { id: 'lp-gear', name: '齿轮 28 齿', src: { kind: 'gen', key: 'gear' }, folder: 'mech', tags: ['齿轮'], sup: 'mid-fine' },
  { id: 'lp-bracket', name: 'L 形支架', src: { kind: 'gen', key: 'bracket' }, folder: 'mech', tags: ['支架'], sup: null },
  { id: 'lp-vase', name: '薄壁花瓶', src: { kind: 'gen', key: 'vase' }, folder: 'decor', tags: ['薄壁'], sup: null },
  { id: 'lp-statue', name: '悬臂雕像', src: { kind: 'gen', key: 'statue' }, folder: 'decor', tags: ['悬臂'], sup: 'fine' },
  { id: 'lp-knot', name: '环面结', src: { kind: 'gen', key: 'knot' }, folder: 'test', tags: ['自交'], sup: null },
  { id: 'lp-mushroom', name: '蘑菇', src: { kind: 'gen', key: 'mushroom' }, folder: 'test', tags: ['伞盖'], sup: null },
  { id: 'lp-tier', name: '双层平台', src: { kind: 'gen', key: 'tier' }, folder: 'test', tags: ['窄缝'], sup: null },
  { id: 'lp-cube', name: '正方体 40 mm', src: { kind: 'gen', key: 'cube' }, folder: 'test', tags: ['平底'], sup: null },
];

/* ---------- 材料 ---------- */

/* 通用树脂类型；密度为常见值，价格为演示值。layers：可选层厚（µm）；template：默认支撑模板 */
export const MATERIALS = [
  { id: 'std-grey', name: '标准树脂 灰', family: '标准', color: '#8f959e', density: 1.1, price: 120, layers: [50, 100], template: 'fine', note: '通用件和打样' },
  { id: 'wash-white', name: '水洗树脂 白', family: '水洗', color: '#e8e5de', density: 1.08, price: 150, layers: [50, 100], template: 'fine', note: '手办、摆件，清洗方便' },
  { id: 'tough-black', name: '高韧树脂 黑', family: '高韧', color: '#33363c', density: 1.12, price: 260, layers: [50, 100], template: 'mid-fine', note: '卡扣、功能件' },
  { id: 'cast-wax', name: '铸造树脂 绿', family: '铸造', color: '#4f9a78', density: 1.14, price: 480, layers: [25, 50], template: 'fine', note: '首饰失蜡铸造' },
  { id: 'detail-ivory', name: '高精度树脂 象牙', family: '高精度', color: '#e4d8c2', density: 1.09, price: 300, layers: [25, 50], template: 'fine', note: '微缩模型、细节件' },
  { id: 'flex-clear', name: '柔性树脂 透明', family: '柔性', color: '#c9e3e0', clear: true, density: 1.05, price: 360, layers: [100], template: 'mid-coarse', note: '软胶件，支撑要粗' },
];

export const materialById = id => MATERIALS.find(m => m.id === id) || MATERIALS[0];

export const TEMPLATES = SUPPORT_TEMPLATES.map(t => ({ id: t.id, name: t.name, diameter: t.diameter, spacing: t.spacing }));
export const templateById = id => TEMPLATES.find(t => t.id === id) || null;

/* ---------- 机器（产品内置机型表） ---------- */

export const MACHINES = BUILTIN_MACHINES;
export const machineById = id => MACHINES.find(m => m.id === id) || null;
export const machineName = m => (m ? `${m.brand} ${m.model}` : '自定义机器');
