import * as THREE from 'three';
import { makeGroup, disposeGroup } from './models.js';
import { SUPPORT_TEMPLATES } from '../core/supportTemplates.js';

/* Demo 用的示意支撑：只为了让「工程里有支撑」看得见、数得清，不是产品算法。
   产品里支撑点由 core/support.js 布点、core/supportTower.js 出格架塔结构；这里在模型朝下的面上
   按模板间距取点（低处优先，贪心稀疏化），每点竖直向下找落点：碰到模型 = 短小支撑（红），否则落到平台。
   结果按「模型 + 模板」缓存，坐标为零件局部系（零件底面 y=0，平台在 y=-LIFT）。 */

export const LIFT = 4;                    // 进支撑后模型抬高（与产品默认 raiseH 一致）
const OVERHANG_NY = -0.62;                // 法线朝下超过约 52°（自支撑角 45° 附近）才算要支撑
const cache = new Map();

export function presetOf(id) {
  return SUPPORT_TEMPLATES.find(t => t.id === id) || SUPPORT_TEMPLATES[0];
}

function collectTris(group) {
  group.updateMatrixWorld(true);
  const out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  group.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    const idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(o.matrixWorld);
      out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  });
  return new Float32Array(out);
}

/** 支撑点：[{ x, y, z（接触点）, ey（落点高度）, anchor（落在模型上）}] */
export function supportPointsFor(key, presetId) {
  const ck = key + '|' + presetId;
  if (cache.has(ck)) return cache.get(ck);
  const preset = presetOf(presetId);
  const spacing = preset.spacing;
  const group = makeGroup(key);
  const tris = collectTris(group);

  // 1. 朝下的面上取候选：面重心 + 大三角形按间距的一半细分
  const cand = [];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (let t = 0; t < tris.length; t += 9) {
    e1.set(tris[t + 3] - tris[t], tris[t + 4] - tris[t + 1], tris[t + 5] - tris[t + 2]);
    e2.set(tris[t + 6] - tris[t], tris[t + 7] - tris[t + 1], tris[t + 8] - tris[t + 2]);
    nrm.crossVectors(e1, e2);
    const area = nrm.length() / 2;
    if (area < 1e-6) continue;
    nrm.normalize();
    if (nrm.y > OVERHANG_NY) continue;
    const k = Math.max(1, Math.ceil(Math.sqrt(area) / (spacing * 0.5)));
    for (let i = 0; i < k; i++) {
      for (let j = 0; i + j < k; j++) {
        const u = (i + 1 / 3) / k, v = (j + 1 / 3) / k;
        cand.push(
          tris[t] + e1.x * u + e2.x * v,
          tris[t + 1] + e1.y * u + e2.y * v,
          tris[t + 2] + e1.z * u + e2.z * v,
        );
      }
    }
  }

  // 2. 低处优先 + 空间哈希贪心稀疏化：任意两点间距 ≥ 0.9 × 模板间距
  const order = [];
  for (let i = 0; i < cand.length; i += 3) order.push(i);
  order.sort((p, q) => cand[p + 1] - cand[q + 1]);
  const cell = spacing;
  const grid = new Map();
  const keep = [];
  const minD2 = (spacing * 0.9) ** 2;
  for (const i of order) {
    const x = cand[i], y = cand[i + 1], z = cand[i + 2];
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell), gz = Math.floor(z / cell);
    let ok = true;
    for (let dx = -1; dx <= 1 && ok; dx++) for (let dy = -1; dy <= 1 && ok; dy++) for (let dz = -1; dz <= 1 && ok; dz++) {
      const list = grid.get(`${gx + dx},${gy + dy},${gz + dz}`);
      if (!list) continue;
      for (const j of list) {
        const ddx = keep[j].x - x, ddy = keep[j].y - y, ddz = keep[j].z - z;
        if (ddx * ddx + ddy * ddy + ddz * ddz < minD2) { ok = false; break; }
      }
    }
    if (!ok) continue;
    const kg = `${gx},${gy},${gz}`;
    if (!grid.has(kg)) grid.set(kg, []);
    grid.get(kg).push(keep.length);
    keep.push({ x, y, z });
  }

  // 3. 每点竖直向下找落点（three.js 射线没有 BVH，逐面测试；导入的大网格超过 12 万面就不测，一律当落板）
  const side = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const meshes = [];
  group.traverse(o => { if (o.isMesh) { o.material = side; meshes.push(o); } });
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const origin = new THREE.Vector3();
  const probe = tris.length / 9 <= 120000;
  const pts = keep.map(p => {
    origin.set(p.x, p.y - 0.05, p.z);
    ray.set(origin, down);
    ray.far = p.y + LIFT;
    const hit = probe ? ray.intersectObjects(meshes, false)[0] : null;
    const anchor = !!hit && hit.point.y > 0.2;
    return { x: p.x, y: p.y, z: p.z, ey: anchor ? hit.point.y : -LIFT, anchor };
  });
  side.dispose();
  disposeGroup(group);
  cache.set(ck, pts);
  return pts;
}

export function supportCount(key, presetId) {
  return supportPointsFor(key, presetId).length;
}

/* ---------- 渲染：实例化的针身 + 针头 ---------- */

const pinGeom = (() => { const g = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false); g.translate(0, 0.5, 0); return g; })();
const tipGeom = (() => { const g = new THREE.CylinderGeometry(0.42, 1, 1, 8, 1, false); g.translate(0, 0.5, 0); return g; })();
export const SUP_COLOR = 0x312f32;        // 落板支撑（与 core/scene.js 同色）
export const SUP_ANCHOR_COLOR = 0xe0242c; // 短小支撑（落在模型上）

/** 一个零件的支撑 → Group（零件局部系；调用方把它放到零件同一位置） */
export function buildSupportGroup(key, presetId, mats) {
  const preset = presetOf(presetId);
  const r = preset.diameter / 2;
  const tipLen = Math.max(1.0, preset.taper || 1.5);
  const pts = supportPointsFor(key, presetId);
  const g = new THREE.Group();
  const ground = pts.filter(p => !p.anchor), anchor = pts.filter(p => p.anchor);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), t = new THREE.Vector3();
  const fill = (list, mat) => {
    if (!list.length) return;
    const pins = new THREE.InstancedMesh(pinGeom, mat, list.length);
    const tips = new THREE.InstancedMesh(tipGeom, mat, list.length);
    list.forEach((p, i) => {
      const top = p.y - tipLen;
      const h = Math.max(0.05, top - p.ey);
      m4.compose(t.set(p.x, p.ey, p.z), q, s.set(r, h, r));
      pins.setMatrixAt(i, m4);
      m4.compose(t.set(p.x, top, p.z), q, s.set(r, tipLen + 0.15, r));
      tips.setMatrixAt(i, m4);
    });
    g.add(pins, tips);
  };
  fill(ground, mats.ground);
  fill(anchor, mats.anchor);
  return g;
}
