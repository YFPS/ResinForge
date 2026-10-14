/* ================================================================
   自动底板（按支撑投影自动生成）——框架无关，core 层，不 import React
   ----------------------------------------------------------------
   形状与尺寸：落板支撑结构（state.supports 的 ground 组）顶点的 XZ 投影**凸包**——
   0.5mm 网格量化去重后求凸包、合并近似共线顶点，再等距向外扩 apOffset（圆角 join）：
   板形跟随支撑投影的实际轮廓，而不是外接矩形（用户 2026-10-14 定；塔身向下每级向外
   展宽，塔底比支撑点范围大，必须用结构而不是支撑点）。
   孔：蜂窝六边形阵（外接圆半径 apHoleR、孔壁厚 apWall；水平间距 = √3·r + 壁厚、
   垂直间距 = 1.5·r + 0.75·壁厚，奇行偏移半间距——与参考 base-plate-creator.js 公式一致），
   六边形 6 顶点必须完全落在「轮廓 − 边框宽 apBorder」的多边形内；**孔壁离支撑贴地面片
   （基础带底面 / 兜底件底端面——真正接触板顶的朝下面）不足 0.5mm 的孔避开不打**——
   桥在孔上的支撑底不悬空（2026-10-14 用户定）；放不下任何孔时退回实心板。
   栅角：底面轮廓 = 顶面轮廓等距内缩 apHeight × tan(apChamferAngle)，侧壁成斜面。
   几何在几何后台线程里算（manifoldKit.buildAutoPlate，经 geomClient.autoPlateAsync）；
   轮廓 / 孔在规格里是**相对底板中心**的 XZ 点列，中心 cx / cz 单独给（生成时平移）。
================================================================ */
import { state, params } from '../store.js';

const num = (v, d) => (Number.isFinite(v) ? v : d);

/* ---------- 投影凸包 ---------- */

/** Andrew 单调链：点集 → 逆时针凸包（去掉边上共线点，只保端点） */
function hull2D(pts) {
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** 合并近似共线的凸包顶点：边方向转角不足 12° 的中间点删掉（保留“大致轮廓”） */
function dropCollinear(poly, minTurnDeg = 12) {
  const n = poly.length;
  if (n < 4) return poly;
  const cosT = Math.cos(minTurnDeg * Math.PI / 180);
  const keep = [];
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p1 = poly[i], p2 = poly[(i + 1) % n];
    const ax = p1[0] - p0[0], az = p1[1] - p0[1];
    const bx = p2[0] - p1[0], bz = p2[1] - p1[1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-9 || lb < 1e-9) continue;                 // 重复点丢弃
    if ((ax * bx + az * bz) / (la * lb) <= cosT) keep.push(p1);   // 方向变化 ≥ 12° 才保留
  }
  return keep;
}

// 结构几何集合不变（对象引用逐一相等）就复用上次的凸包与足迹：拖动参数不重复遍历百万级顶点
let _hullMemo = { geoms: [], hull: null, foot: [] };

function groundGeoms() {
  const out = [];
  for (const s of state.supports || []) if (s.kind === 'ground' && s.mesh && s.mesh.geometry) out.push(s.mesh.geometry);
  return out;
}

/** 落板支撑结构投影数据（memo）：{ hull, pads }。
    hull = 全部顶点的 XZ 凸包（世界坐标，逆时针，简化后）；
    pads = 贴地面片的 2D 投影（平铺三角形 [x1,z1,x2,z2,x3,z3, …]——三个顶点都在贴地平面上的三角形，
    即基础带底面 / 兜底件底端面这些真正接触板顶的朝下面），蜂窝孔避让支撑落点用。
    没有落板结构（或退化到少于 3 点）时 hull 为 null（不出板——底板是支撑的地基）。 */
export function structProjection() {
  const geoms = groundGeoms();
  if (_hullMemo.hull && geoms.length === _hullMemo.geoms.length && geoms.every((g, i) => g === _hullMemo.geoms[i])) return _hullMemo;
  let fmin = Infinity;
  for (const g of geoms) {
    const a = g.attributes && g.attributes.position && g.attributes.position.array;
    if (!a) continue;
    for (let i = 1; i < a.length; i += 3) if (a[i] < fmin) fmin = a[i];
  }
  const set = new Set(), pads = [];
  const cut = fmin + 0.05;                       // 贴地平面（浮点容差内）
  for (const g of geoms) {
    const a = g.attributes && g.attributes.position && g.attributes.position.array;
    if (!a) continue;
    for (let i = 0; i < a.length; i += 3) set.add(Math.round(a[i] * 2) + ',' + Math.round(a[i + 2] * 2));
    const ix = g.index ? g.index.array : null;
    const nTri = ix ? ix.length / 3 : a.length / 9;
    for (let t = 0; t < nTri; t++) {
      const i0 = ix ? ix[t * 3] * 3 : t * 9, i1 = ix ? ix[t * 3 + 1] * 3 : t * 9 + 3, i2 = ix ? ix[t * 3 + 2] * 3 : t * 9 + 6;
      if (a[i0 + 1] <= cut && a[i1 + 1] <= cut && a[i2 + 1] <= cut) {
        pads.push(a[i0], a[i0 + 2], a[i1], a[i1 + 2], a[i2], a[i2 + 2]);
      }
    }
  }
  let hull = null;
  if (set.size >= 3) {
    const pts = [];
    for (const k of set) { const s = k.split(','); pts.push([+s[0], +s[1]]); }
    hull = hull2D(pts).map(([x, z]) => [x / 2, z / 2]);
    if (hull.length >= 3) hull = dropCollinear(hull, 12);
    if (hull.length < 3) hull = null;
  }
  _hullMemo = { geoms, hull, pads };
  return _hullMemo;
}

/** 落板支撑结构投影的凸包（世界 XZ，逆时针）；没有落板结构时返回 null */
export function projectionHull() {
  return structProjection().hull;
}

/** 点到 2D 三角形（ax,az / bx,bz / cx,cz）的距离平方（0 = 点在内部），Ericson 5.1.5 */
function dist2ToTri(px, pz, ax, az, bx, bz, cx, cz) {
  const abx = bx - ax, abz = bz - az, acx = cx - ax, acz = cz - az;
  const apx = px - ax, apz = pz - az;
  const d1 = abx * apx + abz * apz, d2 = acx * apx + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apz * apz;
  const bpx = px - bx, bpz = pz - bz;
  const d3 = abx * bpx + abz * bpz, d4 = acx * bpx + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = apx - v * abx, qz = apz - v * abz;
    return qx * qx + qz * qz;
  }
  const cpx = px - cx, cpz = pz - cz;
  const d5 = abx * cpx + abz * cpz, d6 = acx * cpx + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = apx - w * acx, qz = apz - w * acz;
    return qx * qx + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bpx + w * (cpx - bpx), qz = bpz + w * (cpz - bpz);
    return qx * qx + qz * qz;
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  const qx = apx - (v * abx + w * acx), qz = apz - (v * abz + w * acz);
  return qx * qx + qz * qz;
}

/* ---------- 凸多边形等距偏移 ---------- */

/** 外扩（round join）：边沿外法线平移 d，顶点处补半径 d 的圆弧（CCW 凸多边形） */
function offsetOut(poly, d) {
  if (d < 1e-6) return poly.map(p => [p[0], p[1]]);
  const n = poly.length, out = [];
  const segAngle = 2 * Math.asin(Math.min(0.9, 0.35 / d));   // 弦长 ≈ 0.7mm 的弧段角
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i - 1 + n) % n], p1 = poly[i], p2 = poly[(i + 1) % n];
    let ux = p1[0] - p0[0], uz = p1[1] - p0[1];
    const l1 = Math.hypot(ux, uz);
    if (l1 < 1e-9) continue;
    ux /= l1; uz /= l1;
    const n1x = uz, n1z = -ux;                              // 入边外法线（CCW：外 = 方向右转 90°）
    let vx = p2[0] - p1[0], vz = p2[1] - p1[1];
    const l2 = Math.hypot(vx, vz);
    if (l2 < 1e-9) continue;
    vx /= l2; vz /= l2;
    const n2x = vz, n2z = -vx;                              // 出边外法线
    let a0 = Math.atan2(n1z, n1x), a1 = Math.atan2(n2z, n2x);
    let diff = a1 - a0;
    while (diff <= 1e-9) diff += 2 * Math.PI;
    if (diff > Math.PI) diff -= 2 * Math.PI;                // 短弧（CCW 凸多边形的外角 ≤ π）
    const steps = Math.max(1, Math.ceil(Math.abs(diff) / segAngle));
    for (let k = 0; k <= steps; k++) {
      const a = a0 + diff * (k / steps);
      out.push([p1[0] + Math.cos(a) * d, p1[1] + Math.sin(a) * d]);
    }
  }
  return out.length >= 3 ? out : null;
}

/** 内缩（尖角）：逐边半平面裁剪（Sutherland–Hodgman）；退化返回 null */
function offsetIn(poly, m) {
  let p = poly;
  for (let i = 0; i < poly.length; i++) {
    if (p.length < 3) return null;
    const a = poly[i], b = poly[(i + 1) % poly.length];
    let ux = b[0] - a[0], uz = b[1] - a[1];
    const L = Math.hypot(ux, uz);
    if (L < 1e-9) continue;
    ux /= L; uz /= L;
    const px = a[0] - uz * m, pz = a[1] + ux * m;           // 内法线 = 左转 90°（-uz, ux）
    const out = [];
    for (let k = 0; k < p.length; k++) {
      const c = p[k], e = p[(k + 1) % p.length];
      const sc = ux * (c[1] - pz) - uz * (c[0] - px);
      const se = ux * (e[1] - pz) - uz * (e[0] - px);
      if (sc >= -1e-9) out.push(c);
      if ((sc > 1e-9 && se < -1e-9) || (sc < -1e-9 && se > 1e-9)) {
        const t = sc / (sc - se);
        out.push([c[0] + (e[0] - c[0]) * t, c[1] + (e[1] - c[1]) * t]);
      }
    }
    p = out;
  }
  return p.length >= 3 ? p : null;
}

/** 凸多边形等距偏移：d > 0 外扩（圆角）、d < 0 内缩（尖角） */
function offsetConvex(poly, d) {
  if (d >= 0) return offsetOut(poly, d);
  return offsetIn(poly, -d);
}

/* ---------- 孔与辅助 ---------- */

/** 点在逆时针凸多边形内（含边界） */
function inConvex(poly, x, z) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < -1e-9) return false;
  }
  return true;
}

const polyArea = poly => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
};

const polyPerim = poly => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
};

/** 蜂窝孔（相对中心的六边形点列数组）：孔区为凸多边形；阵列按孔区 bbox 铺（奇行偏移半间距，
    与参考公式一致），六边形 6 顶点必须全在孔区内；放不下返回 [] */
export function honeycombHoles(zone, holeR, wall) {
  if (!zone || zone.length < 3) return [];
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of zone) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const innerW = x1 - x0, innerD = z1 - z0;
  if (innerW < 2 * holeR + wall || innerD < 2 * holeR + wall) return [];
  const sx = holeR * Math.sqrt(3) + wall;              // 水平：对边距 + 壁厚
  const sz = holeR * 1.5 + wall * 0.75;                // 垂直：0.75 × 高 + 0.75 × 壁厚
  const cols = Math.max(1, Math.floor(innerW / sx) + 1);
  const rows = Math.max(1, Math.floor(innerD / sz) + 1);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const out = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const offX = (row % 2 === 0) ? 0 : sx / 2;
      const px = cx - innerW / 2 + col * sx + offX;
      const pz = cz - innerD / 2 + row * sz;
      const poly = [];
      let ok = true;
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (Math.PI / 3) * i;     // 顶点朝上（同参考）
        const vx = px + holeR * Math.cos(a), vz = pz + holeR * Math.sin(a);
        if (!inConvex(zone, vx, vz)) { ok = false; break; }
        poly.push([vx, vz]);
      }
      if (ok) out.push(poly);
    }
  }
  return out;
}

/** 当前自动底板的完整规格（纯数据；轮廓 / 孔已算好，worker 直接用）。没有落板结构时返回 null */
export function autoPlateSpec() {
  const data = structProjection();
  const hull = data.hull;
  if (!hull) return null;
  const off = Math.max(0, num(params.apOffset, 2));
  const top = offsetConvex(hull, off);
  if (!top || top.length < 3) return null;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of top) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const outline = top.map(([x, z]) => [x - cx, z - cz]);
  const t = Math.max(0.4, num(params.apHeight, 1.3));
  const ang = Math.max(0, Math.min(60, num(params.apChamferAngle, 15))) * Math.PI / 180;
  const border = Math.max(0, num(params.apBorder, 2.5));
  const holeR = Math.max(0.5, num(params.apHoleR, 8.66));
  const wall = Math.max(0.2, num(params.apWall, 1.5));
  const zone = border > 1e-6 ? offsetConvex(outline, -border) : outline;
  let holes = zone ? honeycombHoles(zone, holeR, wall) : [];
  // 孔避让支撑落点（2026-10-14 用户定）：孔壁（⊂ 孔的外接圆）离「贴地面片」（基础带底面 /
  // 兜底件底端面——真正接触板顶的朝下面）不足 0.5mm 的孔不打——桥在孔上的支撑底不悬空
  if (holes.length && data.pads.length) {
    const lim2 = (holeR + 0.5) * (holeR + 0.5);
    holes = holes.filter(hh => {
      let hx = 0, hz = 0;
      for (const [x, z] of hh) { hx += x; hz += z; }
      hx = hx / 6 + cx; hz = hz / 6 + cz;
      for (let t = 0; t < data.pads.length; t += 6) {
        if (dist2ToTri(hx, hz, data.pads[t], data.pads[t + 1], data.pads[t + 2], data.pads[t + 3], data.pads[t + 4], data.pads[t + 5]) < lim2) return false;
      }
      return true;
    });
  }
  // 栅角量 = 板厚 × tan(角度)，钳到轮廓内切半径以内（2A/P 估计）
  const perim = polyPerim(outline);
  const inR = perim > 1e-9 ? 2 * polyArea(outline) / perim : 0;
  const chamferW = params.apChamfer ? Math.max(0, Math.min(t * Math.tan(ang), Math.max(0, inR - 0.2))) : 0;
  return { cx, cz, t, border, holeR, wall, chamferW, outline, holes };
}

/** 规格指纹：参数 / 轮廓 / 孔没变（1e-3 内）就不重算几何 */
export function plateFingerprint(s) {
  if (!s) return '';
  const q = v => Math.round(v * 1000) / 1000;
  return [q(s.cx), q(s.cz), q(s.t), q(s.border), q(s.holeR), q(s.wall), q(s.chamferW),
    s.outline.map(([x, z]) => q(x) + ',' + q(z)).join(';')].join('|');
}
