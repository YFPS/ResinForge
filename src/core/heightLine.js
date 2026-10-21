/* 高度线：手动加支撑时，鼠标停在模型上，按命中高度画出这一层的截面白线。
   交线先串成圈，再在这一层平面里磨两遍，去掉三角面切出来的折角。 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { state } from '../store.js';

const Y_STEP = 0.05;

let group = null;
let cacheKey = '';
let cacheY = null;

function host() {
  const mesh = state.mesh;
  return mesh && mesh.parent && mesh.parent.parent;
}

function disposeGroup() {
  if (!group) return;
  if (group.parent) group.parent.remove(group);
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
  group = null;
}

export function clearHeightLine() {
  cacheKey = '';
  cacheY = null;
  disposeGroup();
}

function worldOf(pos, e, i, out) {
  const x = pos.getX(i);
  const y = pos.getY(i);
  const z = pos.getZ(i);
  out.x = e[0] * x + e[4] * y + e[8] * z + e[12];
  out.y = e[1] * x + e[5] * y + e[9] * z + e[13];
  out.z = e[2] * x + e[6] * y + e[10] * z + e[14];
}

function sectionAt(mesh, y) {
  const geom = mesh.geometry;
  const pos = geom.getAttribute('position');
  if (!pos) return [];
  mesh.updateMatrixWorld();
  const e = mesh.matrixWorld.elements;
  const index = geom.index;
  const count = index ? index.count : pos.count;
  const A = { x: 0, y: 0, z: 0 };
  const B = { x: 0, y: 0, z: 0 };
  const C = { x: 0, y: 0, z: 0 };
  const segs = [];
  const cut = (p, q) => {
    const dy = p.y - q.y;
    if (Math.abs(dy) < 1e-8) return null;
    const t = (p.y - y) / dy;
    if (t < -1e-4 || t > 1 + 1e-4) return null;
    return { x: p.x + (q.x - p.x) * t, y, z: p.z + (q.z - p.z) * t };
  };
  for (let t = 0; t < count; t += 3) {
    const ia = index ? index.getX(t) : t;
    const ib = index ? index.getX(t + 1) : t + 1;
    const ic = index ? index.getX(t + 2) : t + 2;
    worldOf(pos, e, ia, A);
    worldOf(pos, e, ib, B);
    worldOf(pos, e, ic, C);
    const above = (A.y > y) + (B.y > y) + (C.y > y);
    if (above === 0 || above === 3) continue;
    const hits = [];
    const h1 = cut(A, B); if (h1) hits.push(h1);
    const h2 = cut(B, C); if (h2) hits.push(h2);
    const h3 = cut(C, A); if (h3) hits.push(h3);
    const uniq = [];
    for (const h of hits) {
      if (!uniq.some(u => (u.x - h.x) ** 2 + (u.z - h.z) ** 2 < 1e-8)) uniq.push(h);
    }
    if (uniq.length < 2) continue;
    let p0 = uniq[0];
    let p1 = uniq[1];
    let best = -1;
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const d = (uniq[i].x - uniq[j].x) ** 2 + (uniq[i].z - uniq[j].z) ** 2;
        if (d > best) { best = d; p0 = uniq[i]; p1 = uniq[j]; }
      }
    }
    if (best < 1e-8) continue;
    segs.push({ a: { x: p0.x, y, z: p0.z }, b: { x: p1.x, y, z: p1.z } });
  }
  return chain(segs);
}

function near2(a, b) {
  return (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
}

/* 只把真正接上的端点串起来。接不上就断成另一圈，不横跨空隙。 */
function chain(segs) {
  const keyOf = p => `${Math.round(p.x * 50)}_${Math.round(p.z * 50)}`;
  const at = new Map();
  segs.forEach((s, i) => {
    for (const end of ['a', 'b']) {
      const k = keyOf(s[end]);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push({ i, end });
    }
  });
  const used = new Uint8Array(segs.length);
  const loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts = [segs[i].a, segs[i].b];
    let guard = 0;
    while (guard++ < segs.length + 2) {
      const tip = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const list = at.get(keyOf(tip)) || [];
      let best = null;
      let bestDot = -2;
      let bestItem = null;
      const px = tip.x - prev.x;
      const pz = tip.z - prev.z;
      const pl = Math.hypot(px, pz) || 1;
      for (const item of list) {
        if (used[item.i]) continue;
        const s = segs[item.i];
        const close = s[item.end];
        const far = item.end === 'a' ? s.b : s.a;
        if (near2(close, tip) > 0.04) continue;
        const dx = far.x - tip.x;
        const dz = far.z - tip.z;
        const dl = Math.hypot(dx, dz) || 1;
        const dot = (dx * px + dz * pz) / (dl * pl);
        if (dot > bestDot) { bestDot = dot; best = far; bestItem = item; }
      }
      if (!bestItem) break;
      used[bestItem.i] = 1;
      pts.push(best);
      if (near2(best, pts[0]) < 0.04) break;
    }
    if (pts.length >= 2) loops.push(polish(pts));
  }
  return loops;
}

/* 闭合的圈在水平面里磨两遍，折角变圆，高度不变。长跳过的空隙不磨。 */
function polish(loop) {
  if (loop.length < 4) return loop;
  const y = loop[0].y;
  const closed = near2(loop[0], loop[loop.length - 1]) < 0.09;
  let src = closed ? loop.slice(0, -1) : loop.slice();
  for (let pass = 0; pass < 2; pass++) {
    const n = src.length;
    if (n < 3) break;
    const out = [];
    const count = closed ? n : n - 1;
    if (!closed) out.push(src[0]);
    for (let i = 0; i < count; i++) {
      const a = src[i];
      const b = src[(i + 1) % n];
      if (near2(a, b) > 4) {
        out.push(a);
        continue;
      }
      out.push(
        { x: a.x * 0.75 + b.x * 0.25, y, z: a.z * 0.75 + b.z * 0.25 },
        { x: a.x * 0.25 + b.x * 0.75, y, z: a.z * 0.25 + b.z * 0.75 },
      );
    }
    if (!closed) out.push(src[n - 1]);
    src = out;
  }
  if (closed && src.length) src.push({ x: src[0].x, y, z: src[0].z });
  return src;
}

function ensureGroup(parent) {
  if (group && group.parent === parent) return group;
  disposeGroup();
  group = new THREE.Group();
  group.name = 'heightLine';
  parent.add(group);
  return group;
}

function drawLoops(loops, view) {
  const parent = host();
  if (!parent) return;
  const g = ensureGroup(parent);
  while (g.children.length) {
    const child = g.children.pop();
    child.geometry.dispose();
    child.material.dispose();
  }
  const width = Math.max(view && view.width || 1, 1);
  const height = Math.max(view && view.height || 1, 1);
  for (const loop of loops) {
    if (loop.length < 2) continue;
    const arr = [];
    for (const p of loop) arr.push(p.x, p.y, p.z);
    if (arr.length < 6) continue;
    const mat = new LineMaterial({
      color: 0xffffff,
      /* 蓝图工作室截面线是 Line2 的 linewidth: 1（edge-view，toneMapped 关掉）。 */
      linewidth: 1,
      depthTest: true,
      depthWrite: false,
      worldUnits: false,
    });
    mat.toneMapped = false;
    mat.fog = false;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    mat.resolution.set(width, height);
    const geom = new LineGeometry();
    geom.setPositions(arr);
    const line = new Line2(geom, mat);
    line.raycast = () => {};
    line.renderOrder = 3;
    g.add(line);
  }
  g.visible = g.children.length > 0;
}

/* hit 为空就收起。高度几乎没变时不重切。 */
export function showHeightLine(hit, view) {
  const mesh = state.mesh;
  const parent = host();
  if (!hit || !mesh || !parent) {
    if (group) group.visible = false;
    cacheY = null;
    return;
  }
  const y = Math.round(hit.point.y / Y_STEP) * Y_STEP;
  const key = `${mesh.geometry.uuid}:${mesh.position.x.toFixed(2)}:${mesh.position.y.toFixed(2)}:${mesh.position.z.toFixed(2)}`;
  if (key !== cacheKey) {
    cacheKey = key;
    cacheY = null;
  }
  if (cacheY === y && group) {
    group.visible = true;
    const width = Math.max(view && view.width || 1, 1);
    const height = Math.max(view && view.height || 1, 1);
    for (const line of group.children) line.material.resolution.set(width, height);
    return;
  }
  drawLoops(sectionAt(mesh, y), view);
  cacheY = y;
}
