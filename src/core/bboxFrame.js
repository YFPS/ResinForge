/* ================================================================
   包围盒边框：按模型世界包围盒生成矩形笼架。
   顶面四条梁 + 四角立柱（没有底面梁），可选 Y 型 / 立柱 / A 字，
   以及底板、打孔、栅角、圆弧角、内部立柱和加强筋。
   纯几何，不碰场景、不读 DOM。世界系与项目一致：平台顶面 y=0。
   ================================================================ */
import * as THREE from 'three';

export const FRAME_COLOR = 0xe2a23a;

export const FRAME_DEFAULTS = {
  beam: 2,
  offset: 1,
  supportGap: 2,
  top: 2,
  support: 'pillar',
  yHeight: 20,
  ySpacing: 40,
  pillarSpacing: 30,
  pillarW: 2,
  pillarD: 2,
  aSpacing: 40,
  aBase: 20,
  aConverge: 30,
  aCross: true,
  aCrossRatio: 0.5,
  plate: true,
  plateH: 1.3,
  plateOffset: 0,
  plateAngle: 15,
  holes: false,
  holeShape: 'circle',
  holeR: 1,
  holeSpacing: 4,
  holeSegments: 12,
  arc: false,
  arcH: 0,
  arcCurve: 100,
  inner: false,
  innerSpacing: 2,
  innerR: 1.5,
  innerMargin: 3,
  reinf: false,
  reinfType: 'x',
  reinfLayers: 5,
  reinfSpacing: 10,
  reinfRatio: 0.7,
  yBetween: false,
  yWithin: false,
  yBranch: false,
  yTrunk: false,
  aToCorner: false,
};

const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3(1, 1, 1);


function num(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

export function normalizeFrameConfig(raw) {
  const c = { ...FRAME_DEFAULTS, ...(raw || {}) };
  c.beam = num(c.beam, 2, 0.4, 16);
  c.offset = num(c.offset, 1, 0, 40);
  c.supportGap = num(c.supportGap, 2, 0, 40);
  c.supportWrapped = !!c.supportWrapped;
  c.top = num(c.top, 2, 0, 80);
  c.support = ['none', 'y', 'pillar', 'aframe'].includes(c.support) ? c.support : 'pillar';
  c.yHeight = num(c.yHeight, 20, 4, 80);
  c.ySpacing = num(c.ySpacing, 40, 8, 120);
  c.pillarSpacing = num(c.pillarSpacing, 30, 6, 120);
  c.pillarW = num(c.pillarW, c.beam, 0.4, 16);
  c.pillarD = num(c.pillarD, c.beam, 0.4, 16);
  c.aSpacing = num(c.aSpacing, 40, 8, 120);
  c.aBase = num(c.aBase, 20, 4, 80);
  c.aConverge = num(c.aConverge, 30, 4, 120);
  c.aCrossRatio = num(c.aCrossRatio, 0.5, 0.15, 0.85);
  c.plateH = num(c.plateH, 1.3, 0.4, 8);
  c.plateOffset = num(c.plateOffset, 0, 0, 30);
  c.plateAngle = num(c.plateAngle, 15, 0, 55);
  c.holeR = num(c.holeR, 1, 0.3, 8);
  c.holeSpacing = num(c.holeSpacing, 4, 1, 30);
  c.holeSegments = Math.round(num(c.holeSegments, 12, 6, 24));
  c.arcH = num(c.arcH, 0, 0, 40);
  c.arcCurve = num(c.arcCurve, 50, 0, 100);
  c.innerSpacing = num(c.innerSpacing, 2, 1.2, 30);
  c.innerR = num(c.innerR, 1.5, 0.4, 6);
  c.innerMargin = num(c.innerMargin, 3, 0, 20);
  c.reinfLayers = Math.round(num(c.reinfLayers, 5, 1, 12));
  c.reinfSpacing = num(c.reinfSpacing, 10, 2, 40);
  c.reinfRatio = num(c.reinfRatio, 0.7, 0.3, 1.4);
  c.holeShape = c.holeShape === 'square' ? 'square' : 'circle';
  if (!['x', 'rice', 'ladder', 'diamond', 'radial'].includes(c.reinfType)) c.reinfType = 'x';
  c.plate = !!c.plate;
  c.holes = !!c.holes;
  c.arc = !!c.arc;
  c.inner = !!c.inner;
  c.reinf = !!c.reinf;
  c.aCross = !!c.aCross;
  c.yBetween = !!c.yBetween;
  c.yWithin = !!c.yWithin;
  c.yBranch = !!c.yBranch;
  c.yTrunk = !!c.yTrunk;
  c.aToCorner = !!c.aToCorner;
  return c;
}

function addBox(chunks, cx, cy, cz, sx, sy, sz, quat) {
  if (sx < 0.05 || sy < 0.05 || sz < 0.05) return;
  const g = new THREE.BoxGeometry(sx, sy, sz);
  _pos.set(cx, cy, cz);
  if (quat) g.applyMatrix4(new THREE.Matrix4().compose(_pos, quat, _scl));
  else g.translate(cx, cy, cz);
  chunks.push(g.toNonIndexed().attributes.position.array);
  g.dispose();
}

function addBeam(chunks, a, b, size) {
  _dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = _dir.length();
  if (len < 0.08 || size < 0.05) return false;
  _dir.multiplyScalar(1 / len);
  const extra = Math.min(size * 0.18, len * 0.08);
  const ax = (a[0] + b[0]) / 2;
  const ay = (a[1] + b[1]) / 2;
  const az = (a[2] + b[2]) / 2;
  if (_dir.y < -0.999) _q.setFromAxisAngle(_up, Math.PI);
  else _q.setFromUnitVectors(_up, _dir);
  addBox(chunks, ax, ay, az, size, len + extra * 2, size, _q);
  return true;
}

function edgeList(min, max) {
  return [
    { label: '前', dir: 'x', z: min.z, x: null, a: min.x, b: max.x },
    { label: '右', dir: 'z', x: max.x, z: null, a: min.z, b: max.z },
    { label: '后', dir: 'x', z: max.z, x: null, a: min.x, b: max.x },
    { label: '左', dir: 'z', x: min.x, z: null, a: min.z, b: max.z },
  ];
}

function pointOn(edge, t) {
  if (edge.dir === 'x') return { x: edge.a + (edge.b - edge.a) * t, z: edge.z };
  return { x: edge.x, z: edge.a + (edge.b - edge.a) * t };
}

function placeCount(len, spacing, marginRatio) {
  const margin = spacing * marginRatio;
  const usable = len - margin * 2;
  if (usable <= spacing * 0.35) return 0;
  return Math.max(1, Math.floor((usable + spacing) / spacing));
}

function addUpright(chunks, x, z, y0, y1, along, width, depth) {
  const h = y1 - y0;
  if (h < 0.08) return false;
  const cy = (y0 + y1) / 2;
  if (along === 'x') addBox(chunks, x, cy, z, depth, h, width);
  else addBox(chunks, x, cy, z, width, h, depth);
  return true;
}

function bayLayers(y0, y1, spacing, maxLayers) {
  const h = y1 - y0;
  if (h < 1.2) return 0;
  const bySpace = Math.floor(h / Math.max(spacing, 1.5));
  return Math.max(1, Math.min(maxLayers, bySpace || 1));
}

function lerp3(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/** 两条斜线段之间的 X。点必须落在线段上，不能把端点当成竖柱。 */
function addSlantedX(chunks, a0, a1, b0, b1, layers, size, stats) {
  const n = Math.max(1, Math.min(layers, 8));
  for (let i = 0; i < n; i++) {
    const t1 = (i + 0.5) / (n + 1);
    const t2 = (i + 1.5) / (n + 1);
    const p1 = lerp3(a0, a1, t1);
    const p2 = lerp3(a0, a1, t2);
    const q1 = lerp3(b0, b1, t1);
    const q2 = lerp3(b0, b1, t2);
    if (addBeam(chunks, [p1.x, p1.y, p1.z], [q2.x, q2.y, q2.z], size)) stats.braces++;
    if (addBeam(chunks, [q1.x, q1.y, q1.z], [p2.x, p2.y, p2.z], size)) stats.braces++;
  }
}

function addXBay(chunks, p1, p2, y0, y1, layers, size, stats) {
  if (layers < 1) return;
  for (let i = 0; i < layers; i++) {
    const a = y0 + ((y1 - y0) * i) / layers;
    const b = y0 + ((y1 - y0) * (i + 1)) / layers;
    if (addBeam(chunks, [p1.x, a, p1.z], [p2.x, b, p2.z], size)) stats.braces++;
    if (addBeam(chunks, [p1.x, b, p1.z], [p2.x, a, p2.z], size)) stats.braces++;
  }
}

function addRiceBay(chunks, p1, p2, y0, y1, layers, size, stats) {
  addXBay(chunks, p1, p2, y0, y1, layers, size, stats);
  for (let i = 1; i <= layers; i++) {
    const y = y0 + ((y1 - y0) * i) / layers;
    if (addBeam(chunks, [p1.x, y, p1.z], [p2.x, y, p2.z], size)) stats.braces++;
  }
  const mx = (p1.x + p2.x) / 2;
  const mz = (p1.z + p2.z) / 2;
  if (addBeam(chunks, [mx, y0, mz], [mx, y1, mz], size)) stats.braces++;
}

function addArcPanel(chunks, p1, p2, topY, thick, arcH, curve, stats) {
  const dx = p2.x - p1.x;
  const dz = p2.z - p1.z;
  const len = Math.hypot(dx, dz);
  const h = Math.min(arcH, len * 0.4);
  if (len < 0.8 || h < 0.15 || thick < 0.05) return;
  const ux = dx / len;
  const uz = dz / len;
  const nx = -uz;
  const nz = ux;
  const cr = Math.max(0, Math.min(1, curve / 100));
  const control = -h * (1 - cr);
  const yAt = t => {
    const u = 1 - t;
    return u * u * -h + 2 * u * t * control + t * t * -h;
  };
  const segs = 14;
  const ht = thick / 2;
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push({
      x: p1.x + ux * len * t,
      z: p1.z + uz * len * t,
      yb: topY + yAt(t),
      yt: topY,
    });
  }
  const vert = [];
  const push = (x, y, z) => vert.push(x, y, z);
  const quad = (a, b, c, d) => {
    push(...a); push(...b); push(...c);
    push(...a); push(...c); push(...d);
  };
  for (let i = 0; i < segs; i++) {
    const s = pts[i];
    const e = pts[i + 1];
    const sOutT = [s.x + nx * ht, s.yt, s.z + nz * ht];
    const sInT = [s.x - nx * ht, s.yt, s.z - nz * ht];
    const eOutT = [e.x + nx * ht, e.yt, e.z + nz * ht];
    const eInT = [e.x - nx * ht, e.yt, e.z - nz * ht];
    const sOutB = [s.x + nx * ht, s.yb, s.z + nz * ht];
    const sInB = [s.x - nx * ht, s.yb, s.z - nz * ht];
    const eOutB = [e.x + nx * ht, e.yb, e.z + nz * ht];
    const eInB = [e.x - nx * ht, e.yb, e.z - nz * ht];
    quad(sOutB, eOutB, eOutT, sOutT);
    quad(sInT, eInT, eInB, sInB);
    quad(sOutT, eOutT, eInT, sInT);
    quad(sInB, eInB, eOutB, sOutB);
  }
  chunks.push(new Float32Array(vert));
  stats.arc++;
}

function flipWinding(array) {
  for (let i = 0; i < array.length; i += 9) {
    const bx = array[i + 3];
    const by = array[i + 4];
    const bz = array[i + 5];
    array[i + 3] = array[i + 6];
    array[i + 4] = array[i + 7];
    array[i + 5] = array[i + 8];
    array[i + 6] = bx;
    array[i + 7] = by;
    array[i + 8] = bz;
  }
}

/** 顶面法线必须朝上。挤出体转成躺平之后若朝下，整张板翻面，避免正面剔除看起来像丢面。 */
function orientPlateUp(array, thick) {
  let ny = 0;
  for (let i = 0; i < array.length; i += 9) {
    const y0 = array[i + 1];
    const y1 = array[i + 4];
    const y2 = array[i + 7];
    if (y0 < thick * 0.72 || y1 < thick * 0.72 || y2 < thick * 0.72) continue;
    ny += (array[i + 5] - array[i + 2]) * (array[i + 6] - array[i])
      - (array[i + 3] - array[i]) * (array[i + 8] - array[i + 2]);
  }
  if (ny < 0) flipWinding(array);
}

function chamferPlateArray(array, thick, angleDeg, holes) {
  const inset = thick * Math.tan((angleDeg * Math.PI) / 180);
  if (inset < 0.02) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < array.length; i += 3) {
    const x = array[i], z = array[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const hw = (maxX - minX) / 2;
  const hd = (maxZ - minZ) / 2;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  for (let i = 0; i < array.length; i += 3) {
    const y = array[i + 1];
    if (y > thick * 0.4) continue;
    const pull = inset * (1 - y / Math.max(thick, 0.01));
    if (pull < 0.02) continue;
    const x = array[i] - cx;
    const z = array[i + 2] - cz;
    if (holes.some(h => (x - h.x) * (x - h.x) + (z - h.z) * (z - h.z) < (h.r + 0.35) * (h.r + 0.35))) continue;
    const dx = hw - Math.abs(x);
    const dz = hd - Math.abs(z);
    if (Math.min(dx, dz) > pull + 0.2) continue;
    if (dx <= dz + 0.05) array[i] = cx + x - Math.sign(x || 1) * Math.min(pull, Math.max(0, Math.abs(x) - 0.25));
    if (dz <= dx + 0.05) array[i + 2] = cz + z - Math.sign(z || 1) * Math.min(pull, Math.max(0, Math.abs(z) - 0.25));
  }
}

function addChamferedSlab(chunks, cx, cz, width, depth, thick, angleDeg) {
  const g = new THREE.BoxGeometry(width, thick, depth);
  g.translate(0, thick / 2, 0);
  const inset = Math.min(width * 0.45, depth * 0.45, Math.max(0, thick * Math.tan((angleDeg * Math.PI) / 180)));
  if (inset > 0.02) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > thick * 0.25) continue;
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setX(i, x - Math.sign(x || 1) * inset);
      pos.setZ(i, z - Math.sign(z || 1) * inset);
    }
    pos.needsUpdate = true;
  }
  g.translate(cx, 0, cz);
  chunks.push(g.toNonIndexed().attributes.position.array);
  g.dispose();
}

function addPlate(chunks, cx, cz, width, depth, thick, cfg, stats) {
  const hw = width / 2;
  const hd = depth / 2;
  const wantHoles = cfg.holes && cfg.holeSpacing > cfg.holeR * 2.05;
  if (!wantHoles) {
    addChamferedSlab(chunks, cx, cz, width, depth, thick, cfg.plateAngle);
    stats.plate = true;
    return;
  }
  /* 形状画在 XY，y = -世界 z。绕 X 转 -90° 后厚度沿 +Y、底面在 y=0，不再做镜像缩放（缩放会翻面，正面被剔掉就像丢面）。 */
  const shape = new THREE.Shape();
  shape.moveTo(-hw, hd);
  shape.lineTo(-hw, -hd);
  shape.lineTo(hw, -hd);
  shape.lineTo(hw, hd);
  shape.closePath();
  const holeCenters = [];
  const sp = cfg.holeSpacing;
  const margin = Math.max(sp * 0.75, cfg.holeR + cfg.beam * 0.5);
  let n = 0;
  for (let x = -hw + margin; x <= hw - margin + 1e-4; x += sp) {
    for (let z = -hd + margin; z <= hd - margin + 1e-4; z += sp) {
      if (n >= 400) break;
      const path = new THREE.Path();
      const sy = -z;
      if (cfg.holeShape === 'square') {
        path.moveTo(x - cfg.holeR, sy - cfg.holeR);
        path.lineTo(x + cfg.holeR, sy - cfg.holeR);
        path.lineTo(x + cfg.holeR, sy + cfg.holeR);
        path.lineTo(x - cfg.holeR, sy + cfg.holeR);
        path.closePath();
      } else {
        path.absarc(x, sy, cfg.holeR, 0, Math.PI * 2, true);
      }
      shape.holes.push(path);
      holeCenters.push({ x, z, r: cfg.holeR });
      n++;
    }
  }
  stats.holes = n;
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: thick,
    bevelEnabled: false,
    curveSegments: cfg.holeShape === 'square' ? 1 : cfg.holeSegments,
  });
  geom.rotateX(-Math.PI / 2);
  const baked = geom.index ? geom.toNonIndexed() : geom;
  const array = new Float32Array(baked.attributes.position.array);
  if (baked !== geom) baked.dispose();
  geom.dispose();
  orientPlateUp(array, thick);
  chamferPlateArray(array, thick, cfg.plateAngle, holeCenters);
  for (let i = 0; i < array.length; i += 3) {
    array[i] += cx;
    array[i + 2] += cz;
  }
  chunks.push(array);
  stats.plate = true;
}

function cornersOf(min, max, y) {
  return {
    前: [{ x: min.x, z: min.z, y }, { x: max.x, z: min.z, y }],
    右: [{ x: max.x, z: min.z, y }, { x: max.x, z: max.z, y }],
    后: [{ x: min.x, z: max.z, y }, { x: max.x, z: max.z, y }],
    左: [{ x: min.x, z: min.z, y }, { x: min.x, z: max.z, y }],
  };
}

/**
 * @param {{min:{x,y,z}, max:{x,y,z}}} modelBox 模型世界包围盒（已含抬高）
 * @param {object} raw 参数，缺项用 FRAME_DEFAULTS
 * @param {(x:number, z:number) => boolean} [occupied] 底板内部立柱的占用判定
 */
export function buildFrameGeometry(modelBox, raw, occupied) {
  const cfg = normalizeFrameConfig(raw);
  const chunks = [];
  const stats = {
    support: cfg.support,
    beams: 0,
    pillars: 0,
    braces: 0,
    holes: 0,
    inner: 0,
    arc: 0,
    plate: false,
    innerPoints: [],
    warnings: [],
  };
  if (!modelBox || !modelBox.min || !modelBox.max) {
    stats.warnings.push('没有模型包围盒');
    return { geometry: null, stats, config: cfg };
  }
  const spanX = modelBox.max.x - modelBox.min.x;
  const spanZ = modelBox.max.z - modelBox.min.z;
  const spanY = modelBox.max.y - modelBox.min.y;
  if (spanX < 0.2 || spanZ < 0.2 || spanY < 0.2) {
    stats.warnings.push('模型尺寸过小，无法生成边框');
    return { geometry: null, stats, config: cfg };
  }

  // 梁按中心线放。有支撑时，外扩至少要盖住半个梁宽，内壁才离得开支撑。
  const expand = cfg.supportWrapped
    ? Math.max(cfg.offset, cfg.supportGap + cfg.beam * 0.5)
    : cfg.offset;
  const min = {
    x: modelBox.min.x - expand,
    y: modelBox.min.y,
    z: modelBox.min.z - expand,
  };
  const max = {
    x: modelBox.max.x + expand,
    y: modelBox.max.y + cfg.top,
    z: modelBox.max.z + expand,
  };
  const w = cfg.beam;
  const plateH = cfg.plate ? cfg.plateH : 0;
  const plateTop = plateH;
  const overlap = cfg.plate ? Math.max(0.4, plateH * 0.5) : 0;
  const y0 = cfg.plate ? Math.max(0, plateH - overlap) : 0;
  const y1 = max.y;
  const inset = w * 0.5;

  const topBeams = [
    [[min.x + inset, y1, min.z], [max.x - inset, y1, min.z]],
    [[max.x, y1, min.z + inset], [max.x, y1, max.z - inset]],
    [[max.x - inset, y1, max.z], [min.x + inset, y1, max.z]],
    [[min.x, y1, max.z - inset], [min.x, y1, min.z + inset]],
  ];
  for (const [a, b] of topBeams) {
    if (addBeam(chunks, a, b, w)) stats.beams++;
  }
  const tops = [
    [min.x, y1, min.z],
    [max.x, y1, min.z],
    [max.x, y1, max.z],
    [min.x, y1, max.z],
  ];
  for (const [x, y, z] of tops) addBox(chunks, x, y, z, w, w, w);

  const cornerPts = tops.map(([x, , z]) => ({ x, z }));
  for (const c of cornerPts) {
    if (addUpright(chunks, c.x, c.z, y0, y1 + inset * 0.15, 'z', w, w)) stats.pillars++;
  }

  const edges = edgeList(min, max);
  const pillarsByEdge = { 前: [], 右: [], 后: [], 左: [] };
  const yByEdge = { 前: [], 右: [], 后: [], 左: [] };
  const aByEdge = { 前: [], 右: [], 后: [], 左: [] };

  if (cfg.support === 'pillar') {
    for (const edge of edges) {
      const len = Math.abs(edge.b - edge.a);
      const count = placeCount(len, cfg.pillarSpacing, 0.3);
      for (let i = 1; i <= count; i++) {
        const p = pointOn(edge, i / (count + 1));
        if (addUpright(chunks, p.x, p.z, y0, y1, edge.dir, cfg.pillarW, cfg.pillarD)) {
          stats.pillars++;
          pillarsByEdge[edge.label].push(p);
        }
      }
    }
    if (cfg.reinf && cfg.reinfType !== 'none') {
      const size = w * cfg.reinfRatio;
      const cornerMap = cornersOf(min, max, y1);
      for (const edge of edges) {
        const ends = cornerMap[edge.label];
        const mids = pillarsByEdge[edge.label].slice().sort((a, b) => (edge.dir === 'x' ? a.x - b.x : a.z - b.z));
        const all = [ends[0], ...mids, ends[1]];
        const layers = bayLayers(plateTop, y1, (y1 - plateTop) / cfg.reinfLayers, cfg.reinfLayers);
        for (let i = 0; i < all.length - 1; i++) {
          if (cfg.reinfType === 'rice') addRiceBay(chunks, all[i], all[i + 1], plateTop, y1, layers, size, stats);
          else addXBay(chunks, all[i], all[i + 1], plateTop, y1, layers, size, stats);
        }
      }
    }
    if (cfg.arc) {
      const cornerMap = cornersOf(min, max, y1);
      for (const edge of edges) {
        const ends = cornerMap[edge.label];
        const mids = pillarsByEdge[edge.label].slice();
        const all = [ends[0], ...mids, ends[1]].sort((a, b) => (edge.dir === 'x' ? a.x - b.x : a.z - b.z));
        const autoH = Math.min(Math.abs(edge.b - edge.a) * 0.18, (y1 - plateTop) * 0.35);
        const arcH = cfg.arcH > 0 ? cfg.arcH : Math.max(1.2, autoH);
        for (let i = 0; i < all.length - 1; i++) {
          addArcPanel(chunks, all[i], all[i + 1], y1 - w / 2, w, arcH, cfg.arcCurve, stats);
        }
      }
    }
  } else if (cfg.support === 'y') {
    const branch = Math.min(cfg.ySpacing * 0.4, cfg.yHeight * 1.6);
    for (const edge of edges) {
      const len = Math.abs(edge.b - edge.a);
      const minGap = cfg.ySpacing * 0.2;
      let count = Math.floor((len - minGap) / (cfg.ySpacing + minGap));
      count = Math.max(len > cfg.ySpacing * 0.8 ? 1 : 0, count);
      if (!count) {
        stats.warnings.push(`${edge.label}边太短，放不下 Y 型支撑`);
        continue;
      }
      const gap = (len - count * cfg.ySpacing) / (count + 1);
      const lo = Math.min(edge.a, edge.b);
      const hi = Math.max(edge.a, edge.b);
      const inset = w;
      const clampAlong = v => Math.min(hi - inset, Math.max(lo + inset, v));
      for (let i = 1; i <= count; i++) {
        const along = gap * i + cfg.ySpacing * (i - 0.5);
        const p = edge.dir === 'x' ? { x: lo + along, z: edge.z } : { x: edge.x, z: lo + along };
        const trunkTop = Math.max(plateTop + 1, y1 - Math.min(cfg.yHeight, y1 - plateTop - 1));
        if (addUpright(chunks, p.x, p.z, plateTop, trunkTop, edge.dir, w, w)) stats.pillars++;
        const off = Math.min(branch, Math.max(1, (y1 - trunkTop) * 1.2));
        const left = edge.dir === 'x'
          ? { x: clampAlong(p.x - off), z: p.z }
          : { x: p.x, z: clampAlong(p.z - off) };
        const right = edge.dir === 'x'
          ? { x: clampAlong(p.x + off), z: p.z }
          : { x: p.x, z: clampAlong(p.z + off) };
        if (addBeam(chunks, [p.x, trunkTop, p.z], [left.x, y1, left.z], w)) stats.beams++;
        if (addBeam(chunks, [p.x, trunkTop, p.z], [right.x, y1, right.z], w)) stats.beams++;
        yByEdge[edge.label].push({ ...p, trunkTop, left, right, dir: edge.dir });
      }
    }
    const size = w * cfg.reinfRatio;
    const yLayers = Math.max(1, Math.min(cfg.reinfLayers, 6));
    for (const edge of edges) {
      const list = yByEdge[edge.label].slice().sort((a, b) => (edge.dir === 'x' ? a.x - b.x : a.z - b.z));
      if (!list.length) continue;
      const start = edge.dir === 'x' ? { x: min.x, z: edge.z } : { x: edge.x, z: min.z };
      const end = edge.dir === 'x' ? { x: max.x, z: edge.z } : { x: edge.x, z: max.z };
      if (cfg.yBetween) {
        for (let i = 0; i < list.length - 1; i++) {
          const layers = bayLayers(plateTop, list[i].trunkTop, cfg.reinfSpacing, cfg.reinfLayers);
          addXBay(chunks, list[i], list[i + 1], plateTop, list[i].trunkTop, layers, size, stats);
        }
      }
      if (cfg.yWithin) {
        for (const s of list) {
          const fork = { x: s.x, y: s.trunkTop, z: s.z };
          const leftTip = { x: s.left.x, y: y1, z: s.left.z };
          const rightTip = { x: s.right.x, y: y1, z: s.right.z };
          addSlantedX(chunks, fork, leftTip, fork, rightTip, yLayers, size, stats);
        }
      }
      const toward = (s, corner) => {
        const dl = edge.dir === 'x' ? Math.abs(s.left.x - corner.x) : Math.abs(s.left.z - corner.z);
        const dr = edge.dir === 'x' ? Math.abs(s.right.x - corner.x) : Math.abs(s.right.z - corner.z);
        const tip = dl <= dr ? s.left : s.right;
        return { x: tip.x, y: y1, z: tip.z };
      };
      const first = list[0];
      const last = list[list.length - 1];
      if (cfg.yBranch) {
        const fork0 = { x: first.x, y: first.trunkTop, z: first.z };
        addSlantedX(chunks, fork0, toward(first, start), { ...start, y: first.trunkTop }, { ...start, y: y1 }, yLayers, size, stats);
        const fork1 = { x: last.x, y: last.trunkTop, z: last.z };
        addSlantedX(chunks, fork1, toward(last, end), { ...end, y: last.trunkTop }, { ...end, y: y1 }, yLayers, size, stats);
      }
      if (cfg.yTrunk) {
        const layers = bayLayers(plateTop, first.trunkTop, cfg.reinfSpacing, cfg.reinfLayers);
        addXBay(chunks, first, start, plateTop, first.trunkTop, layers, size, stats);
        addXBay(chunks, last, end, plateTop, last.trunkTop, layers, size, stats);
      }
    }
  } else if (cfg.support === 'aframe') {
    for (const edge of edges) {
      const len = Math.abs(edge.b - edge.a);
      const count = Math.max(len > cfg.aBase ? 1 : 0, Math.floor(len / cfg.aSpacing));
      if (!count) {
        stats.warnings.push(`${edge.label}边太短，放不下 A 字支撑`);
        continue;
      }
      const half = Math.min(cfg.aBase / 2, len / (count + 1) * 0.42);
      const convergeY = Math.min(y1 - w, Math.max(plateTop + 2, cfg.aConverge));
      for (let i = 1; i <= count; i++) {
        const p = pointOn(edge, i / (count + 1));
        const left = edge.dir === 'x' ? { x: p.x - half, z: p.z } : { x: p.x, z: p.z - half };
        const right = edge.dir === 'x' ? { x: p.x + half, z: p.z } : { x: p.x, z: p.z + half };
        if (addBeam(chunks, [left.x, plateTop, left.z], [p.x, convergeY, p.z], w)) stats.beams++;
        if (addBeam(chunks, [right.x, plateTop, right.z], [p.x, convergeY, p.z], w)) stats.beams++;
        if (addBeam(chunks, [p.x, convergeY, p.z], [p.x, y1, p.z], w)) stats.beams++;
        if (cfg.aCross) {
          const y = plateTop + (convergeY - plateTop) * cfg.aCrossRatio;
          const t = (y - plateTop) / Math.max(convergeY - plateTop, 0.01);
          const lx = left.x + (p.x - left.x) * t;
          const lz = left.z + (p.z - left.z) * t;
          const rx = right.x + (p.x - right.x) * t;
          const rz = right.z + (p.z - right.z) * t;
          if (addBeam(chunks, [lx, y, lz], [rx, y, rz], w * 0.85)) stats.beams++;
        }
        aByEdge[edge.label].push({ ...p, left, right, convergeY, dir: edge.dir });
      }
    }
    if (cfg.reinf) {
      const size = w * cfg.reinfRatio;
      const kind = ['ladder', 'diamond', 'radial'].includes(cfg.reinfType) ? cfg.reinfType : 'ladder';
      for (const edge of edges) {
        for (const s of aByEdge[edge.label]) {
          const layers = Math.max(2, Math.min(cfg.reinfLayers, 8));
          if (kind === 'ladder' || kind === 'diamond') {
            for (let i = 1; i < layers; i++) {
              const t = i / layers;
              const y = plateTop + (s.convergeY - plateTop) * t;
              const lx = s.left.x + (s.x - s.left.x) * t;
              const lz = s.left.z + (s.z - s.left.z) * t;
              const rx = s.right.x + (s.x - s.right.x) * t;
              const rz = s.right.z + (s.z - s.right.z) * t;
              if (kind === 'ladder' && addBeam(chunks, [lx, y, lz], [rx, y, rz], size)) stats.braces++;
              if (kind === 'diamond' && i > 1) {
                const pt = (i - 1) / layers;
                const py = plateTop + (s.convergeY - plateTop) * pt;
                const plx = s.left.x + (s.x - s.left.x) * pt;
                const plz = s.left.z + (s.z - s.left.z) * pt;
                const prx = s.right.x + (s.x - s.right.x) * pt;
                const prz = s.right.z + (s.z - s.right.z) * pt;
                if (addBeam(chunks, [plx, py, plz], [rx, y, rz], size)) stats.braces++;
                if (addBeam(chunks, [prx, py, prz], [lx, y, lz], size)) stats.braces++;
              }
            }
          } else {
            for (let i = 1; i < layers; i++) {
              const t = i / layers;
              const y = plateTop + (s.convergeY - plateTop) * t;
              const lx = s.left.x + (s.x - s.left.x) * t;
              const lz = s.left.z + (s.z - s.left.z) * t;
              if (addBeam(chunks, [s.x, s.convergeY, s.z], [lx, y, lz], size)) stats.braces++;
            }
          }
        }
      }
    }
    if (cfg.aToCorner) {
      const size = w * cfg.reinfRatio;
      const cornerMap = cornersOf(min, max, y1);
      for (const edge of edges) {
        for (const s of aByEdge[edge.label]) {
          for (const corner of cornerMap[edge.label]) {
            addXBay(chunks, s, corner, plateTop, Math.min(s.convergeY, y1), 2, size, stats);
          }
        }
      }
    }
  }

  if (cfg.plate) {
    const ext = Math.max(w, cfg.pillarW, cfg.pillarD) / 2 + cfg.plateH * Math.tan((cfg.plateAngle * Math.PI) / 180) + 0.45 + cfg.plateOffset;
    const width = (max.x - min.x) + ext * 2;
    const depth = (max.z - min.z) + ext * 2;
    const cx = (min.x + max.x) / 2;
    const cz = (min.z + max.z) / 2;
    addPlate(chunks, cx, cz, width, depth, cfg.plateH, cfg, stats);

    if (cfg.inner && typeof occupied === 'function') {
      let spacing = cfg.innerSpacing;
      const area = width * depth;
      if (area / (spacing * spacing) > 700) spacing = Math.sqrt(area / 700);
      const res = Math.max(0.8, cfg.innerR);
      const x0 = cx - width / 2 + spacing;
      const x1 = cx + width / 2 - spacing;
      const z0 = cz - depth / 2 + spacing;
      const z1 = cz + depth / 2 - spacing;
      const h = Math.max(0.4, y1 - plateTop);
      for (let x = x0; x <= x1; x += spacing) {
        for (let z = z0; z <= z1; z += spacing) {
          if (stats.inner >= 700) break;
          let blocked = false;
          for (let dx = -cfg.innerMargin; dx <= cfg.innerMargin && !blocked; dx += res) {
            for (let dz = -cfg.innerMargin; dz <= cfg.innerMargin; dz += res) {
              if (occupied(x + dx, z + dz)) { blocked = true; break; }
            }
          }
          if (blocked) continue;
          const d = cfg.innerR * 2;
          addBox(chunks, x, plateTop + h / 2, z, d, h, d);
          stats.inner++;
          stats.innerPoints.push({ x, z });
        }
      }
    }
  } else if (cfg.arc) {
    stats.warnings.push('圆弧角需要底板和立柱支撑');
  }

  if (!chunks.length) return { geometry: null, stats, config: cfg, box: { min, max } };
  let count = 0;
  for (const a of chunks) count += a.length;
  const pos = new Float32Array(count);
  let off = 0;
  for (const a of chunks) { pos.set(a, off); off += a.length; }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  stats.triangles = pos.length / 9;
  const bb = geometry.boundingBox;
  stats.min = { x: bb.min.x, y: bb.min.y, z: bb.min.z };
  stats.max = { x: bb.max.x, y: bb.max.y, z: bb.max.z };
  return { geometry, stats, config: cfg, box: { min, max } };
}

/** 把零件局部三角形投影成 XZ 占用函数。抬高只改高度，不改占地。 */
export function occupancyFromParts(parts, placeVertex, res = 0.8) {
  const tris = [];
  const tmp = [0, 0, 0];
  for (const part of parts || []) {
    const arr = part.geom && part.geom.attributes.position && part.geom.attributes.position.array;
    if (!arr) continue;
    for (let i = 0; i < arr.length; i += 9) {
      const xs = [];
      const zs = [];
      for (let k = 0; k < 3; k++) {
        placeVertex(part, arr[i + k * 3], arr[i + k * 3 + 1], arr[i + k * 3 + 2], tmp);
        xs.push(tmp[0]);
        zs.push(tmp[2]);
      }
      tris.push({
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minZ: Math.min(...zs), maxZ: Math.max(...zs),
      });
    }
  }
  return (x, z) => {
    for (const t of tris) {
      if (x >= t.minX - res && x <= t.maxX + res && z >= t.minZ - res && z <= t.maxZ + res) return true;
    }
    return false;
  };
}
