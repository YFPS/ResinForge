/* 多线段支撑。折线贴着模型表面走：两点之间沿屏幕上的连线逐段打回模型，
   不拉成悬空的直线。白线用屏幕像素宽度，末端跟一个小红点。 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { state, params, toast, log } from '../store.js';
import { localFaceOf, supportScopeIds, acceptSupportFace } from './model.js';
import { addSupportPoints } from './support.js';

/* 画出来的线沿法线抬出表面。贴在表面上的粗线会被模型切掉，看起来像穿进去。 */
const LIFT = 0.35;
const STEP = 0.55;
let pts = [];
let legs = [];
let rubber = [];
let hover = null;
let group = null;
let lastDown = 0;
const raycaster = new THREE.Raycaster();
const _v = new THREE.Vector3();

function parentOf() {
  const mesh = state.mesh;
  return mesh && mesh.parent && mesh.parent.parent;
}

function hitPoint(hit) {
  const n = hit.face && hit.face.normal
    ? hit.face.normal.clone().transformDirection(state.mesh.matrixWorld)
    : new THREE.Vector3(0, -1, 0);
  if (n.lengthSq() < 1e-8) n.set(0, -1, 0);
  else n.normalize();
  return {
    x: hit.point.x, y: hit.point.y, z: hit.point.z,
    nx: n.x, ny: n.y, nz: n.z,
    face: hit.faceIndex,
  };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function dropGroup() {
  if (!group) return;
  if (group.parent) group.parent.remove(group);
  group.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
  group = null;
}

export function cancelPolyLine() {
  pts = [];
  legs = [];
  rubber = [];
  hover = null;
  lastDown = 0;
  dropGroup();
}

function ensureGroup(parent) {
  if (group && group.parent === parent) return group;
  dropGroup();
  group = new THREE.Group();
  group.name = 'polyLine';
  const strokes = new THREE.Group();
  strokes.name = 'strokes';
  const nodeMat = new THREE.PointsMaterial({
    color: 0x3ee06a, size: 8, sizeAttenuation: false, depthTest: true, depthWrite: false,
  });
  nodeMat.toneMapped = false;
  const nodes = new THREE.Points(new THREE.BufferGeometry(), nodeMat);
  nodes.name = 'nodes';
  nodes.raycast = () => {};
  nodes.renderOrder = 5;
  group.add(strokes, nodes);
  parent.add(group);
  return group;
}

/* 沿屏幕上 a→b 的连线打回模型，得到贴在表面上的一串点。 */
function surfaceBetween(mesh, camera, a, b) {
  const span = dist(a, b);
  if (span < 1e-4) return [a];
  _v.set(a.x, a.y, a.z).project(camera);
  const ax = _v.x, ay = _v.y;
  _v.set(b.x, b.y, b.z).project(camera);
  const bx = _v.x, by = _v.y;
  const steps = Math.max(2, Math.min(120, Math.ceil(span / STEP)));
  const out = [a];
  let prev = a;
  const limit = Math.max(16, span * span * 0.55);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    raycaster.far = Infinity;
    raycaster.setFromCamera(new THREE.Vector2(ax + (bx - ax) * t, ay + (by - ay) * t), camera);
    const hits = raycaster.intersectObject(mesh, false);
    if (!hits.length) continue;
    let best = null;
    for (const h of hits) {
      if (!h.face) continue;
      const n = h.face.normal.clone().transformDirection(mesh.matrixWorld);
      const vx = camera.position.x - h.point.x;
      const vy = camera.position.y - h.point.y;
      const vz = camera.position.z - h.point.z;
      if (n.x * vx + n.y * vy + n.z * vz <= 0) continue;
      best = h;
      break;
    }
    if (!best) continue;
    const ex = a.x + (b.x - a.x) * t;
    const ey = a.y + (b.y - a.y) * t;
    const ez = a.z + (b.z - a.z) * t;
    const off = (best.point.x - ex) ** 2 + (best.point.y - ey) ** 2 + (best.point.z - ez) ** 2;
    if (off > limit) continue;
    const p = hitPoint(best);
    if (dist(prev, p) > Math.max(5, span * 0.45)) continue;
    out.push(p);
    prev = p;
  }
  if (dist(prev, b) > 0.05) out.push(b);
  return out;
}

function flatPath() {
  const out = [];
  const push = (p) => {
    const prev = out[out.length - 1];
    if (prev && dist(prev, p) < 0.04) return;
    out.push(p);
  };
  for (const leg of legs) for (const p of leg) push(p);
  for (const p of rubber) push(p);
  return out;
}

/* 弦的中点若离表面太远，这段是穿进模型的，不能画。 */
function outsideChord(mesh, a, b) {
  if (dist(a, b) < 1.2) return true;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const mz = (a.z + b.z) / 2;
  let nx = a.nx + b.nx, ny = a.ny + b.ny, nz = a.nz + b.nz;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  raycaster.set(new THREE.Vector3(mx + nx * 2, my + ny * 2, mz + nz * 2), new THREE.Vector3(-nx, -ny, -nz));
  raycaster.near = 0;
  raycaster.far = 4;
  const hit = raycaster.intersectObject(mesh, false)[0];
  if (!hit) return false;
  const dx = hit.point.x - mx, dy = hit.point.y - my, dz = hit.point.z - mz;
  return dx * dx + dy * dy + dz * dz < 0.45 * 0.45;
}

function splitOutside(mesh, path) {
  const runs = [];
  let cur = [];
  for (const p of path) {
    const prev = cur[cur.length - 1];
    if (prev && mesh && !outsideChord(mesh, prev, p)) {
      if (cur.length >= 2) runs.push(cur);
      cur = [p];
      continue;
    }
    cur.push(p);
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

function redraw(view) {
  const parent = parentOf();
  const path = flatPath();
  if (!parent || path.length < 1 || !view) {
    if (group) group.visible = false;
    return;
  }
  const g = ensureGroup(parent);
  g.visible = true;
  const holder = g.getObjectByName('strokes');
  while (holder.children.length) {
    const child = holder.children.pop();
    child.geometry.dispose();
    child.material.dispose();
  }
  const width = Math.max(view.width, 1);
  const height = Math.max(view.height, 1);
  const runs = splitOutside(state.mesh, path);
  for (const run of runs) {
    const draw = [];
    for (const p of run) draw.push(p.x + p.nx * LIFT, p.y + p.ny * LIFT, p.z + p.nz * LIFT);
    if (draw.length < 6) continue;
    const mat = new LineMaterial({
      color: 0xffffff, linewidth: 2.4, depthTest: true, depthWrite: false, worldUnits: false,
    });
    mat.toneMapped = false;
    mat.fog = false;
    mat.resolution.set(width, height);
    const geom = new LineGeometry();
    geom.setPositions(draw);
    const line = new Line2(geom, mat);
    line.raycast = () => {};
    line.renderOrder = 4;
    holder.add(line);
  }
  const nodes = g.getObjectByName('nodes');
  const marks = pts.slice();
  if (hover && (!marks.length || dist(hover, marks[marks.length - 1]) > 0.4)) marks.push(hover);
  const arr = [];
  for (const p of marks) arr.push(p.x + p.nx * LIFT, p.y + p.ny * LIFT, p.z + p.nz * LIFT);
  nodes.geometry.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  nodes.geometry.computeBoundingSphere();
  nodes.visible = marks.length > 0;
}

export function movePolyLine(hit, view) {
  if (!pts.length || !view) {
    hover = null;
    rubber = [];
    return;
  }
  if (!hit || !state.mesh) {
    hover = null;
    rubber = [];
    redraw(view);
    return;
  }
  hover = hitPoint(hit);
  rubber = surfaceBetween(state.mesh, view.camera, pts[pts.length - 1], hover);
  redraw(view);
}

export function downPolyLine(hit, view) {
  if (!hit || !state.mesh || !view) return;
  if (!acceptSupportFace(hit.faceIndex)) return;
  const p = hitPoint(hit);
  const now = performance.now();
  const last = pts[pts.length - 1];
  const dbl = now - lastDown < 320;
  lastDown = now;
  if (!pts.length) {
    pts.push(p);
    hover = p;
    rubber = [];
    redraw(view);
    return;
  }
  if (dbl) {
    if (!last || dist(last, p) >= 0.6) {
      legs.push(surfaceBetween(state.mesh, view.camera, last, p));
      pts.push(p);
    }
    hover = null;
    rubber = [];
    redraw(view);
    finishPolyLine();
    return;
  }
  if (last && dist(last, p) < 0.4) return;
  legs.push(rubber.length >= 2 ? rubber : surfaceBetween(state.mesh, view.camera, last, p));
  pts.push(p);
  hover = p;
  rubber = [];
  redraw(view);
}

function samplesAlong(path) {
  const spacing = Math.max(0.1, Number(params.polySpacing) || 2);
  const out = [];
  let acc = 0;
  let next = spacing * 0.5;
  const faces = state.protectedFaces;
  const scope = supportScopeIds();
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const d = dist(a, b);
    if (d < 1e-4) continue;
    while (acc + d >= next - 1e-6) {
      const t = (next - acc) / d;
      const ny = a.ny + (b.ny - a.ny) * t;
      const face = t < 0.5 ? a.face : b.face;
      if (ny <= 0.25 && !(faces && faces.has(face))) {
        const loc = localFaceOf(face);
        const partId = loc ? loc.part.id : null;
        if (scope && (partId == null || !scope.has(partId))) { next += spacing; continue; }
        out.push({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
          n: [
            a.nx + (b.nx - a.nx) * t,
            ny,
            a.nz + (b.nz - a.nz) * t,
          ],
          partId,
        });
      }
      next += spacing;
    }
    acc += d;
  }
  return out;
}

export function finishPolyLine() {
  if (pts.length < 2) {
    toast('再点一个点，双击或按回车结束');
    return;
  }
  const path = [];
  for (const leg of legs) for (const p of leg) path.push(p);
  const samples = samplesAlong(path);
  cancelPolyLine();
  const spacing = Math.max(0.1, Number(params.polySpacing) || 2);
  const exist = state.supportPoints || [];
  const keep = [];
  const limit = spacing * 0.55;
  for (const s of samples) {
    const near = exist.concat(keep).some(p => {
      const dx = p.x - s.x, dy = p.y - s.y, dz = p.z - s.z;
      return dx * dx + dy * dy + dz * dz < limit * limit;
    });
    if (!near) keep.push({ x: s.x, y: s.y, z: s.z, n: s.n });
  }
  if (!keep.length) {
    toast(samples.length ? '这条折线附近已经有支撑' : '这条折线朝上或在保护面上，不加支撑');
    return;
  }
  log(`多线段：沿折线加 ${keep.length} 个支撑点`, 'ok');
  addSupportPoints(keep);
}
