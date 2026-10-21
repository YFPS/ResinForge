import { keyInfo, layoutItems, machineById, materialById } from './data.js';
import { presetOf, supportCount } from './supportsMock.js';

/* 按设计文档（docs/resinforge-project-library-design.md）的工程格式，算出某个工程会写出的文件与大小。
   大小按往返实测（.ref/proj-roundtrip）折算：每个支撑点在 supports.json 里约 236 字节（环面结 191 点 45 KB），
   模型几何按 float32 三角形 36 字节 / 面；同一模型只存一份（内容寻址），零件库与各工程共用。 */

const fnv = s => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
};
const fakeSha = key => (fnv(key) + fnv(key + '#') + fnv('#' + key)).slice(0, 16);
const kb = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function projectFiles(p) {
  const machine = machineById(p.machineId);
  const material = materialById(p.materialId);
  const preset = presetOf(p.preset);
  const pos = layoutItems(p.items);
  const anySup = p.items.some(it => it.sup);
  const points = p.items.reduce((s, it) => s + (it.sup ? supportCount(it.key, p.preset) : 0), 0);
  const manifest = {
    schema: 'resinforge.project',
    schemaVersion: 1,
    id: p.id,
    name: p.name,
    updatedAt: p.updatedAt,
    folderId: p.folder,
    starred: !!p.starred,
    machine: { id: machine.id, name: `${machine.brand} ${machine.model}`, plateX: machine.plateX, plateY: machine.plateY, plateZ: machine.plateZ, pixelUm: machine.pixelUm },
    material: { id: material.id, name: material.name, color: material.color, density: material.density, layerUm: p.layerUm, supportPreset: p.preset },
    lift: { supportLiftOn: anySup, raiseH: 4, joinLift: anySup ? 3.124 : 0 },
    settings: {
      params: {
        layerH: p.layerUm / 1000, raiseH: 4, selfAngle: 45,
        spacing: preset.spacing, esBarW: preset.diameter, esTipW: preset.tipW,
        baseJoin: true, unionExport: true, '…': '共 53 项，与 store.js 的 params 同名',
      },
    },
    parts: p.items.map(it => {
      const at = pos.get(it.uid) || { x: 0, z: 0 };
      return {
        uid: it.uid,
        name: it.name,
        origin: { type: it.origin, libraryId: it.libId },
        source: { blob: `sha256:${fakeSha(it.key)}…`, format: 'stl', faces: keyInfo(it.key).faces },
        transform: { ox: +at.x.toFixed(2), oy: 0, oz: +at.z.toFixed(2), q: [0, 0, 0, 1] },
        protected: [],
      };
    }),
    supports: { file: 'supports.json', points, algorithmVersion: 3 },
  };
  const json = JSON.stringify(manifest, null, 2);
  const uniq = [...new Set(p.items.map(it => it.key))];
  const geomBytes = uniq.reduce((s, k) => s + keyInfo(k).faces * 36, 0);
  const files = [
    { name: 'manifest.json', desc: '工程本身：机器 / 材料快照、零件引用与位置、参数快照', size: kb(new TextEncoder().encode(json).length) },
    { name: 'supports.json', desc: points ? `${points} 个支撑点（含锚点、法线、孤岛标记、所属零件）` : '还没有支撑点', size: points ? kb(points * 236) : '—' },
    { name: 'thumbnail.webp', desc: '列表缩略图', size: '≈ 30 KB' },
    { name: `store/blobs/（${uniq.length} 个）`, desc: '模型文件，按内容哈希存一份，零件库与各工程共用', size: kb(geomBytes) },
  ];
  return { manifest, json, files };
}
