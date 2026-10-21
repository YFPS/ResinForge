/* OBJ / 3MF 解析直接用 three.js 的加载器。
   加载器给出的是 Z-up 装配体。这里只补两件加载器没做的事：
   3MF 的 unit 换成毫米（ThreeMFLoader 只记录、不缩放），再绕 X 转 -90° 变成和 STL 一样的 Y-up。
   一个文件里的三角网格乘上世界矩阵后合并成一份。 */
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { unzipSync } from 'three/addons/libs/fflate.module.js';

/* 3MF Core Spec 的 unit。缺省或认不出时按毫米（系数 1）。 */
const UNIT_TO_MM = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

export function modelKind(name) {
  const m = /\.(stl|obj|3mf)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : null;
}

function disposeObject(root) {
  if (!root || !root.traverse) return;
  root.traverse(obj => {
    if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    for (const mat of mats) {
      if (!mat || !mat.dispose) continue;
      mat.dispose();
    }
  });
}

/* 镜像矩阵会把绕序翻到朝里。交换每个三角形的前两个顶点。 */
function reverseWinding(geom) {
  const pos = geom.getAttribute('position');
  const a = pos.array;
  for (let i = 0; i + 8 < a.length; i += 9) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    a[i] = a[i + 3]; a[i + 1] = a[i + 4]; a[i + 2] = a[i + 5];
    a[i + 3] = x; a[i + 4] = y; a[i + 5] = z;
  }
}

/* 单位缩放和 Z-up → Y-up 都交给 Object3D，再 bake 进几何。 */
function positionsFromGroup(root, scale) {
  root.scale.setScalar(scale || 1);
  root.rotateX(-Math.PI / 2);
  root.updateMatrixWorld(true);
  const geoms = [];
  root.traverse(obj => {
    if (!obj.isMesh || !obj.geometry) return;
    const src = obj.geometry.getAttribute('position');
    if (!src || src.count < 3) return;
    const geom = obj.geometry.index ? obj.geometry.toNonIndexed() : obj.geometry.clone();
    if (obj.matrixWorld.determinant() < 0) reverseWinding(geom);
    geom.applyMatrix4(obj.matrixWorld);
    const only = new THREE.BufferGeometry();
    only.setAttribute('position', geom.getAttribute('position').clone());
    geom.dispose();
    geoms.push(only);
  });
  if (!geoms.length) return new Float32Array(0);
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms);
  if (!merged) throw new Error('网格无法合并');
  const pos = new Float32Array(merged.getAttribute('position').array);
  if (merged !== geoms[0]) merged.dispose();
  for (const geom of geoms) geom.dispose();
  return pos;
}

export function objPositions(buf) {
  const group = new OBJLoader().parse(new TextDecoder().decode(buf));
  try {
    return positionsFromGroup(group, 1);
  } finally {
    disposeObject(group);
  }
}

/* ThreeMFLoader 不读 unit。用它同一份 fflate 解开包，再用 DOMParser 取根模型的单位。 */
function unitScaleOf(buf) {
  let zip;
  try {
    zip = unzipSync(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  } catch {
    return 1;
  }
  const names = Object.keys(zip);
  const dec = new TextDecoder();
  const relsName = names.find(n => /(^|\/)_rels\/\.rels$/i.test(n));
  let target = null;
  if (relsName) {
    const rels = new DOMParser().parseFromString(dec.decode(zip[relsName]), 'application/xml');
    const nodes = rels.getElementsByTagNameNS('*', 'Relationship');
    for (const node of nodes) {
      const want = (node.getAttribute('Target') || '').replace(/^\/+/, '');
      if (!/\.model$/i.test(want)) continue;
      target = names.find(n => n.toLowerCase() === want.toLowerCase()) || null;
      if (target) break;
    }
  }
  if (!target) target = names.find(n => /^3d\/.*\.model$/i.test(n)) || names.find(n => /\.model$/i.test(n));
  if (!target) return 1;
  const doc = new DOMParser().parseFromString(dec.decode(zip[target]), 'application/xml');
  const unit = (doc.documentElement.getAttribute('unit') || '').trim().toLowerCase();
  const scale = UNIT_TO_MM[unit];
  return scale == null ? 1 : scale;
}

export function threeMfPositions(buf) {
  const group = new ThreeMFLoader().parse(buf);
  if (!group) throw new Error('3MF 里没有模型');
  try {
    return positionsFromGroup(group, unitScaleOf(buf));
  } finally {
    disposeObject(group);
  }
}
