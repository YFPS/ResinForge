import * as THREE from 'three';

/* Demo 里的模型几何：用真实 three.js 几何生成缩略图与面数 / 尺寸，
   不引入业务场景，避免 Demo 页加载整套 core / scene。 */

const M = (geometry, position = [0, 0, 0], rotation = [0, 0, 0], scale = 1) => ({
  geometry, position, rotation, scale,
});

function mushroom() {
  const pts = [];
  // 伞盖外表面：顶 → 赤道
  for (let i = 0; i <= 20; i++) {
    const t = i / 20 * Math.PI / 2;
    pts.push(new THREE.Vector2(16 * Math.sin(t), 32 - 10 * (1 - Math.cos(t))));
  }
  // 伞盖内表面：赤道 → 顶
  for (let i = 20; i >= 0; i--) {
    const t = i / 20 * Math.PI / 2;
    pts.push(new THREE.Vector2(13.5 * Math.sin(t), 32 - 8 * (1 - Math.cos(t))));
  }
  return [
    M(new THREE.CylinderGeometry(3.4, 5.4, 22, 28), [0, 11, 0]),
    M(new THREE.LatheGeometry(pts, 48), [0, 0, 0]),
  ];
}

function tier() {
  const out = [
    M(new THREE.BoxGeometry(34, 2.2, 34), [0, 1.1, 0]),
    M(new THREE.BoxGeometry(26, 2.2, 26), [0, 13.1, 0]),
  ];
  for (const [x, z] of [[-12, -12], [12, -12], [-12, 12], [12, 12]]) {
    out.push(M(new THREE.BoxGeometry(2.2, 10, 2.2), [x, 6.6, z]));
  }
  return out;
}

function statue() {
  return [
    M(new THREE.CylinderGeometry(11, 13, 2.4, 32), [0, 1.2, 0]),
    M(new THREE.CapsuleGeometry(6.2, 16, 8, 20), [0, 12.5, 0], [0, 0, 0.09]),
    M(new THREE.SphereGeometry(5.2, 24, 18), [1.8, 24.8, 0]),
    M(new THREE.CylinderGeometry(2.1, 2.7, 15, 16), [8.6, 14.5, 0], [0, 0, -0.9]),
  ];
}

function ring() {
  // 戒圈立放：圈底贴 y=0，主石嵌在圈顶（八面体下半截埋进戒圈，不悬空）
  return [
    M(new THREE.TorusGeometry(9, 2.3, 22, 64), [0, 11.3, 0]),
    M(new THREE.CylinderGeometry(2.2, 2.6, 2.2, 6), [0, 22.4, 0]),
    M(new THREE.OctahedronGeometry(2.6), [0, 24.6, 0], [0, Math.PI / 4, 0]),
  ];
}

function gear() {
  const out = [
    M(new THREE.CylinderGeometry(9, 9, 3, 28), [0, 8, 0], [Math.PI / 2, 0, 0]),
    M(new THREE.CylinderGeometry(3.2, 3.2, 3.4, 20), [0, 8, 0], [Math.PI / 2, 0, 0]),
  ];
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * Math.PI * 2;
    out.push(M(new THREE.BoxGeometry(3.4, 2.8, 3.2), [Math.cos(a) * 10.2, 8, Math.sin(a) * 10.2], [0, -a, 0]));
  }
  return out;
}

function bracket() {
  return [
    M(new THREE.BoxGeometry(26, 3, 12), [0, 1.5, 0]),
    M(new THREE.BoxGeometry(3, 18, 12), [-11.5, 10.5, 0]),
    M(new THREE.BoxGeometry(3, 3, 12), [11.5, 3, 0]),
  ];
}

function figurine() {
  return [
    M(new THREE.CylinderGeometry(7, 9, 2.2, 28), [0, 1.1, 0]),
    M(new THREE.ConeGeometry(5.5, 13, 24), [0, 8.5, 0]),
    M(new THREE.SphereGeometry(3.8, 22, 16), [0, 18.4, 0]),
    M(new THREE.CylinderGeometry(1.1, 1.4, 10, 14), [5.6, 12, 0], [0, 0, -0.7]),
    M(new THREE.CylinderGeometry(1.1, 1.4, 10, 14), [-5.6, 12, 0], [0, 0, 0.7]),
  ];
}

function vase() {
  const pts = [
    new THREE.Vector2(5, 0), new THREE.Vector2(7, 2), new THREE.Vector2(9, 8),
    new THREE.Vector2(10, 16), new THREE.Vector2(8.5, 24), new THREE.Vector2(5.5, 28),
    new THREE.Vector2(4.2, 32), new THREE.Vector2(5.2, 34),
  ];
  return [M(new THREE.LatheGeometry(pts, 40), [0, 0, 0])];
}

function cube() {
  return [M(new THREE.BoxGeometry(24, 24, 24), [0, 12, 0])];
}

function knot() {
  return [M(new THREE.TorusKnotGeometry(13, 3.8, 180, 28), [0, 20, 0], [0, 0, 0], 1.45)];
}

export const MODELS = {
  knot: { name: '环面结', tags: ['自交曲面', '演示'], build: knot },
  mushroom: { name: '蘑菇', tags: ['伞盖', '悬垂'], build: mushroom },
  tier: { name: '双层平台', tags: ['窄缝', '多件'], build: tier },
  statue: { name: '悬臂雕像', tags: ['悬臂', '人像'], build: statue },
  cube: { name: '正方体', tags: ['平底', '验证'], build: cube },
  ring: { name: '戒圈', tags: ['戒指', '铸造'], build: ring },
  gear: { name: '齿轮', tags: ['机械', '装配'], build: gear },
  bracket: { name: '小支架', tags: ['结构', '装配'], build: bracket },
  figurine: { name: '手办', tags: ['人像', '手办'], build: figurine },
  vase: { name: '花瓶', tags: ['薄壁', '摆件'], build: vase },
};

/* 导入的模型：解析后的几何登记在这里（key 形如 file:<哈希前 12 位>），与内置模型同样出缩略图 / 示意支撑。
   几何已转成 Y-up、底面落到 y=0、XZ 居中；makeGroup 每次克隆一份，调用方照常 dispose */
const IMPORTED = new Map();

export function registerModel(key, name, geometry) {
  IMPORTED.set(key, { name, geometry });
}

export function hasModel(key) {
  return !!MODELS[key] || IMPORTED.has(key);
}

/* 把模型定义转成可渲染的 group；scale 只作用在最外层 */
export function makeGroup(key, offset = [0, 0, 0], scale = 1) {
  const g = new THREE.Group();
  const imported = IMPORTED.get(key);
  const def = MODELS[key] || (imported ? { build: () => [M(imported.geometry.clone())] } : null);
  if (!def) return g;
  for (const m of def.build()) {
    const mesh = new THREE.Mesh(m.geometry, null);
    mesh.position.set(...m.position);
    mesh.rotation.set(...m.rotation);
    mesh.scale.setScalar(m.scale || 1);
    g.add(mesh);
  }
  g.scale.setScalar(scale);
  g.position.set(...offset);
  return g;
}

export function modelMetrics(key) {
  const g = makeGroup(key);
  g.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(g);
  const size = box.getSize(new THREE.Vector3());
  let faces = 0;
  g.traverse(o => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    faces += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  });
  return {
    faces: Math.round(faces),
    size: { x: +size.x.toFixed(1), y: +size.y.toFixed(1), z: +size.z.toFixed(1) },
  };
}

/* 释放 geometry：缩略图渲染完后调用，避免 Demo 常驻一堆几何 */
export function disposeGroup(g) {
  g.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
}

/* 近似体积（mm³）：逐三角形有符号体积求和。内置模型由几块基本体拼成，重叠部分会重复计入，只作用量估算 */
const volumeCache = new Map();
export function modelVolume(key) {
  if (volumeCache.has(key)) return volumeCache.get(key);
  const g = makeGroup(key);
  g.updateMatrixWorld(true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let vol = 0;
  g.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    const idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(o.matrixWorld);
      vol += a.dot(b.clone().cross(c)) / 6;
    }
  });
  disposeGroup(g);
  const v = Math.abs(vol);
  volumeCache.set(key, v);
  return v;
}
