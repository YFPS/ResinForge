/* 排版之后的距离标尺。画在板面上：尺寸线、两端箭头、中间数字。
   模型间距、支撑外沿间距、离板边各用一种颜色。 */
import * as THREE from 'three';
import { scene } from './scene.js';
import { partBounds } from './model.js';
import { params, state } from '../store.js';

const Y = 0.35;
const group = new THREE.Group();
group.name = 'nestRulers';
group.renderOrder = 8;
scene.add(group);

const lineMat = new THREE.LineBasicMaterial({ color: 0xff4d4f, depthTest: false, transparent: true, opacity: 0.95 });
const edgeMat = new THREE.LineBasicMaterial({ color: 0xd7dde6, depthTest: false, transparent: true, opacity: 0.9 });
const supMat = new THREE.LineBasicMaterial({ color: 0xff9a3c, depthTest: false, transparent: true, opacity: 0.95 });

function disposeGroup() {
  for (const child of [...group.children]) {
    group.remove(child);
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (child.material.map) child.material.map.dispose();
      if (child.material !== lineMat && child.material !== edgeMat && child.material !== supMat) child.material.dispose();
    }
  }
}

export function clearNestRulers() {
  disposeGroup();
}

function labelSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 96);
  g.fillStyle = 'rgba(12, 14, 18, 0.82)';
  roundRect(g, 8, 16, 240, 64, 16);
  g.fill();
  g.fillStyle = color;
  g.font = '700 40px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  const w = Math.max(7, text.length * 1.55);
  sp.scale.set(w, w * 96 / 256, 1);
  sp.raycast = () => {};
  sp.renderOrder = 9;
  return sp;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function addLine(mat, ax, az, bx, bz) {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(ax, Y, az),
    new THREE.Vector3(bx, Y, bz),
  ]);
  const line = new THREE.Line(geo, mat);
  line.raycast = () => {};
  line.renderOrder = 8;
  group.add(line);
}

function addArrow(mat, x, z, dx, dz) {
  const len = 1.35;
  const w = 0.48;
  const px = -dz;
  const pz = dx;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    x, Y, z,
    x - dx * len + px * w, Y, z - dz * len + pz * w,
    x - dx * len - px * w, Y, z - dz * len - pz * w,
  ]), 3));
  geo.setIndex([0, 1, 2]);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: mat.color, depthTest: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
  }));
  mesh.raycast = () => {};
  mesh.renderOrder = 8;
  group.add(mesh);
}

/* 从 A 到 B 画一条尺寸：两端箭头朝外对着被量的边，数字写在中点旁。 */
function addDim(ax, az, bx, bz, text, mat, color) {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 0.4) return;
  const ux = dx / len;
  const uz = dz / len;
  const px = -uz;
  const pz = ux;
  addLine(mat, ax, az, bx, bz);
  const tick = 1.5;
  addLine(mat, ax - px * tick, az - pz * tick, ax + px * tick, az + pz * tick);
  addLine(mat, bx - px * tick, bz - pz * tick, bx + px * tick, bz + pz * tick);
  if (len >= 5) {
    addArrow(mat, ax, az, ux, uz);
    addArrow(mat, bx, bz, -ux, -uz);
  } else {
    addArrow(mat, ax, az, -ux, -uz);
    addArrow(mat, bx, bz, ux, uz);
  }
  const sp = labelSprite(text, color);
  sp.position.set((ax + bx) / 2 + px * 2.2, Y + 0.4, (az + bz) / 2 + pz * 2.2);
  group.add(sp);
}

function facingGap(a, b) {
  const gx = Math.max(b.min.x - a.max.x, a.min.x - b.max.x);
  const gz = Math.max(b.min.z - a.max.z, a.min.z - b.max.z);
  const overlapX = a.min.x < b.max.x - 0.05 && b.min.x < a.max.x - 0.05;
  const overlapZ = a.min.z < b.max.z - 0.05 && b.min.z < a.max.z - 0.05;
  if (overlapX && !overlapZ) {
    const z0 = gz >= 0 ? Math.min(a.max.z, b.max.z) : Math.max(a.min.z, b.min.z);
    const z1 = gz >= 0 ? Math.max(a.min.z, b.min.z) : Math.min(a.max.z, b.max.z);
    const x = (Math.max(a.min.x, b.min.x) + Math.min(a.max.x, b.max.x)) / 2;
    return { gap: Math.abs(gz), ax: x, az: z0, bx: x, bz: z1 };
  }
  if (overlapZ && !overlapX) {
    const x0 = gx >= 0 ? Math.min(a.max.x, b.max.x) : Math.max(a.min.x, b.min.x);
    const x1 = gx >= 0 ? Math.max(a.min.x, b.min.x) : Math.min(a.max.x, b.max.x);
    const z = (Math.max(a.min.z, b.min.z) + Math.min(a.max.z, b.max.z)) / 2;
    return { gap: Math.abs(gx), ax: x0, az: z, bx: x1, bz: z };
  }
  return null;
}

function boxOf(minX, maxX, minZ, maxZ) {
  return { min: { x: minX, z: minZ }, max: { x: maxX, z: maxZ } };
}

function closestPartBox(parts, x, z) {
  let best = parts[0];
  let bestD = Infinity;
  for (const p of parts) {
    const hx = p.base ? p.base.x / 2 : 0;
    const hz = p.base ? p.base.z / 2 : 0;
    const dx = Math.max(Math.abs(x - p.ox) - hx, 0);
    const dz = Math.max(Math.abs(z - p.oz) - hz, 0);
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function growBox(boxes, id, x, z) {
  if (!boxes.has(id)) return;
  const b = boxes.get(id);
  if (!b) { boxes.set(id, boxOf(x, x, z, z)); return; }
  if (x < b.min.x) b.min.x = x;
  if (x > b.max.x) b.max.x = x;
  if (z < b.min.z) b.min.z = z;
  if (z > b.max.z) b.max.z = z;
}

/* 支撑外沿：同一零件的格架、针、兜底件取并集。几件共用的网格按三角形重心切开，不再只量最后一张小网格。 */
function supportBoxes(parts) {
  const boxes = new Map();
  for (const p of parts) boxes.set(p.id, null);
  for (const s of state.supports || []) {
    const attr = s.mesh && s.mesh.geometry && s.mesh.geometry.attributes.position;
    if (!attr) continue;
    const owners = s.ownerIds || [];
    const exclusive = owners.length === 1 ? owners[0] : null;
    const pool = owners.length ? parts.filter(p => owners.includes(p.id)) : parts;
    if (!pool.length) continue;
    s.mesh.updateWorldMatrix(true, false);
    const e = s.mesh.matrixWorld.elements;
    const arr = attr.array;
    const xz = i => [
      e[0] * arr[i] + e[4] * arr[i + 1] + e[8] * arr[i + 2] + e[12],
      e[2] * arr[i] + e[6] * arr[i + 1] + e[10] * arr[i + 2] + e[14],
    ];
    if (exclusive) {
      for (let i = 0; i < arr.length; i += 3) {
        const w = xz(i);
        growBox(boxes, exclusive, w[0], w[1]);
      }
      continue;
    }
    const tris = (arr.length / 9) | 0;
    for (let t = 0; t < tris; t++) {
      const o = t * 9;
      let cx = 0;
      let cz = 0;
      const pts = [];
      for (let k = 0; k < 3; k++) {
        const w = xz(o + k * 3);
        pts.push(w[0], w[1]);
        cx += w[0];
        cz += w[1];
      }
      const owner = closestPartBox(pool, cx / 3, cz / 3);
      for (let k = 0; k < 3; k++) growBox(boxes, owner.id, pts[k * 2], pts[k * 2 + 1]);
    }
  }
  return boxes;
}

function drawPairs(boxes, mat, color, prefix, limit) {
  const ids = [...boxes.keys()];
  const dims = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = boxes.get(ids[i]);
      const b = boxes.get(ids[j]);
      if (!a || !b) continue;
      const dim = facingGap(a, b);
      if (!dim || dim.gap > 80) continue;
      dims.push(dim);
    }
  }
  dims.sort((a, b) => a.gap - b.gap);
  const kept = [];
  for (const dim of dims) {
    const midX = (dim.ax + dim.bx) / 2;
    const midZ = (dim.az + dim.bz) / 2;
    if (kept.some(k => Math.hypot((k.ax + k.bx) / 2 - midX, (k.az + k.bz) / 2 - midZ) < 8)) continue;
    kept.push(dim);
    if (kept.length >= limit) break;
  }
  for (const dim of kept) {
    const text = `${prefix}${dim.gap.toFixed(1)}`;
    addDim(dim.ax, dim.az, dim.bx, dim.bz, text, mat, color);
  }
}

function unionBox(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return boxOf(
    Math.min(a.min.x, b.min.x), Math.max(a.max.x, b.max.x),
    Math.min(a.min.z, b.min.z), Math.max(a.max.z, b.max.z),
  );
}

/* 每圈边框的世界投影外沿。边框不可重叠时，零件间距和离板边都量这个矩形。 */
function frameBoxes(parts) {
  if (!state.frame || params.nestFrameOverlap) return null;
  const frames = scene.getObjectByName('bboxFrameGroup');
  if (!frames || !frames.children.length) return null;
  frames.updateWorldMatrix(true, true);
  const boxes = new Map();
  for (const p of parts) boxes.set(p.id, null);
  let any = false;
  for (const mesh of frames.children) {
    const id = mesh.userData.partId;
    if (!boxes.has(id)) continue;
    const attr = mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position;
    if (!attr) continue;
    const e = mesh.matrixWorld.elements;
    const arr = attr.array;
    for (let i = 0; i < arr.length; i += 3) {
      const x = e[0] * arr[i] + e[4] * arr[i + 1] + e[8] * arr[i + 2] + e[12];
      const z = e[2] * arr[i] + e[6] * arr[i + 1] + e[10] * arr[i + 2] + e[14];
      growBox(boxes, id, x, z);
      any = true;
    }
  }
  return any ? boxes : null;
}

/** 排版成功后标出零件间距和离板边。
 *  有边框且不可重叠时，按边框投影外沿。否则支撑不可重叠时按加上支撑后的投影外沿。 */
export function showNestRulers(parts) {
  disposeGroup();
  if (!parts || parts.length < 2) return;
  const model = new Map();
  for (const p of parts) {
    const b = partBounds(p);
    model.set(p.id, boxOf(b.min.x, b.max.x, b.min.z, b.max.z));
  }
  const framed = frameBoxes(parts);
  const sup = !framed && (state.supports || []).length ? supportBoxes(parts) : null;
  const blockSup = !!(sup && !params.nestSupportOverlap);
  const footprint = new Map();
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of parts) {
    const frame = framed && framed.get(p.id);
    const box = frame || (blockSup ? unionBox(model.get(p.id), sup.get(p.id)) : model.get(p.id));
    footprint.set(p.id, box);
    if (!box) continue;
    if (box.min.x < minX) minX = box.min.x;
    if (box.max.x > maxX) maxX = box.max.x;
    if (box.min.z < minZ) minZ = box.min.z;
    if (box.max.z > maxZ) maxZ = box.max.z;
  }
  drawPairs(footprint, lineMat, '#ffd0d0', '', 8);
  if (sup && !blockSup) drawPairs(sup, supMat, '#ffe0c2', '支 ', 8);
  const plateX = params.plateX || 150;
  const plateZ = params.plateZ || 85;
  const hx = plateX / 2;
  const hz = plateZ / 2;
  const midZ = (minZ + maxZ) / 2;
  const midX = (minX + maxX) / 2;
  addDim(-hx, midZ, minX, midZ, `边 ${(minX + hx).toFixed(1)}`, edgeMat, '#e7edf5');
  addDim(maxX, midZ, hx, midZ, `边 ${(hx - maxX).toFixed(1)}`, edgeMat, '#e7edf5');
  addDim(midX, -hz, midX, minZ, `边 ${(minZ + hz).toFixed(1)}`, edgeMat, '#e7edf5');
  addDim(midX, maxZ, midX, hz, `边 ${(hz - maxZ).toFixed(1)}`, edgeMat, '#e7edf5');
}
