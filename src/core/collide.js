/* ================================================================
   碰撞检测：三角网格 BVH（包围体层次）+ 射线 / 点距 / 胶囊体查询
   支撑避让的几何基础——支撑头、分支、立柱、格架管、接触杆一律按「胶囊体（线段扫掠球）vs 模型」
   判定净空（对应 PrusaSlicer 的 beam_mesh_hit / pinhead_mesh_intersect），
   取代旧实现的单条竖直射线：射线没有粗细，杆身、锥头、倾斜后偏移的主干全部漏检。
   几何内核参考 Ericson《Real-Time Collision Detection》5.1（点-三角形、线段-线段最近点）。
   框架无关，不 import React / three。
================================================================ */

const LEAF = 4;   // 叶子最多三角形数

/* ---------- 构建 ---------- */
/* tri：Float32Array，每三角形 9 个浮点（世界系）。按包围盒最长轴的重心中位数二分。 */
export function buildBVH(tri) {
  const n = tri.length / 9;
  const cen = new Float32Array(n * 3);
  for (let f = 0; f < n; f++) {
    const i = f * 9;
    cen[f * 3] = (tri[i] + tri[i + 3] + tri[i + 6]) / 3;
    cen[f * 3 + 1] = (tri[i + 1] + tri[i + 4] + tri[i + 7]) / 3;
    cen[f * 3 + 2] = (tri[i + 2] + tri[i + 5] + tri[i + 8]) / 3;
  }
  const order = new Int32Array(n);
  for (let f = 0; f < n; f++) order[f] = f;
  const cap = Math.max(1, 2 * Math.ceil(n / LEAF) + 1);
  let bmin = new Float32Array(cap * 3), bmax = new Float32Array(cap * 3);
  let left = new Int32Array(cap), start = new Int32Array(cap), count = new Int32Array(cap);
  let nodes = 0;
  const grow = () => {
    const c2 = bmin.length / 3 * 2;
    const g = (a, T, k) => { const b = new T(c2 * k); b.set(a); return b; };
    bmin = g(bmin, Float32Array, 3); bmax = g(bmax, Float32Array, 3);
    left = g(left, Int32Array, 1); start = g(start, Int32Array, 1); count = g(count, Int32Array, 1);
  };
  // 显式栈迭代构建（避免深递归）
  const stack = [[0, n, -1, 0]];   // [s, e, parent, isRight]
  while (stack.length) {
    const [s, e, parent, isRight] = stack.pop();
    if (nodes >= left.length) grow();
    const id = nodes++;
    if (parent >= 0 && isRight) left[parent] = id;   // 左孩子 = parent+1（隐式），右孩子回填到 left[parent]
    let x0 = 1e30, y0 = 1e30, z0 = 1e30, x1 = -1e30, y1 = -1e30, z1 = -1e30;
    let cx0 = 1e30, cy0 = 1e30, cz0 = 1e30, cx1 = -1e30, cy1 = -1e30, cz1 = -1e30;
    for (let k = s; k < e; k++) {
      const f = order[k], i = f * 9;
      for (let v = 0; v < 9; v += 3) {
        const x = tri[i + v], y = tri[i + v + 1], z = tri[i + v + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const cx = cen[f * 3], cy = cen[f * 3 + 1], cz = cen[f * 3 + 2];
      if (cx < cx0) cx0 = cx; if (cx > cx1) cx1 = cx;
      if (cy < cy0) cy0 = cy; if (cy > cy1) cy1 = cy;
      if (cz < cz0) cz0 = cz; if (cz > cz1) cz1 = cz;
    }
    bmin[id * 3] = x0; bmin[id * 3 + 1] = y0; bmin[id * 3 + 2] = z0;
    bmax[id * 3] = x1; bmax[id * 3 + 1] = y1; bmax[id * 3 + 2] = z1;
    if (e - s <= LEAF) { left[id] = -1; start[id] = s; count[id] = e - s; continue; }
    const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
    const ax = ex >= ey && ex >= ez ? 0 : (ey >= ez ? 1 : 2);
    if (Math.max(ex, ey, ez) < 1e-9) { left[id] = -1; start[id] = s; count[id] = e - s; continue; }   // 重心重合：直接成叶
    // 中位数分割（nth_element 式快速选择）
    const mid = (s + e) >> 1;
    let lo = s, hi = e - 1;
    while (lo < hi) {
      const pv = cen[order[(lo + hi) >> 1] * 3 + ax];
      let a = lo, b = hi;
      while (a <= b) {
        while (cen[order[a] * 3 + ax] < pv) a++;
        while (cen[order[b] * 3 + ax] > pv) b--;
        if (a <= b) { const t = order[a]; order[a] = order[b]; order[b] = t; a++; b--; }
      }
      if (mid <= b) hi = b; else if (mid >= a) lo = a; else break;
    }
    count[id] = 0; start[id] = 0;
    left[id] = -2;   // 占位：右孩子出栈后回填
    stack.push([mid, e, id, 1]);   // 右孩子后处理（栈顶先出左孩子 → 左孩子恒为 id+1）
    stack.push([s, mid, id, 0]);
  }
  return { tri, order, bmin, bmax, left, start, count, nodes, n };
}
// 节点约定：叶子 left=-1（三角形 order[start .. start+count)）；内部节点左孩子 = id+1，右孩子 = left[id]

/* ---------- 基础几何 ---------- */
/* 点到三角形最近距离²（Ericson 5.1.5 Voronoi 区域法） */
function ptTri2(px, py, pz, t, i) {
  const ax = t[i], ay = t[i + 1], az = t[i + 2];
  const abx = t[i + 3] - ax, aby = t[i + 4] - ay, abz = t[i + 5] - az;
  const acx = t[i + 6] - ax, acy = t[i + 7] - ay, acz = t[i + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - t[i + 3], bpy = py - t[i + 4], bpz = pz - t[i + 5];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = apx - v * abx, qy = apy - v * aby, qz = apz - v * abz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - t[i + 6], cpy = py - t[i + 7], cpz = pz - t[i + 8];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = apx - w * acx, qy = apy - w * acy, qz = apz - w * acz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bpx - w * (acx - abx), qy = bpy - w * (acy - aby), qz = bpz - w * (acz - abz);
    return qx * qx + qy * qy + qz * qz;
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  const qx = apx - abx * v - acx * w, qy = apy - aby * v - acy * w, qz = apz - abz * v - acz * w;
  return qx * qx + qy * qy + qz * qz;
}

/* 线段-线段最近距离²（Ericson 5.1.9） */
function segSeg2(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) return rx * rx + ry * ry + rz * rz;
  if (a <= 1e-12) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-12) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const x = rx + d1x * s - d2x * t, y = ry + d1y * s - d2y * t, z = rz + d1z * s - d2z * t;
  return x * x + y * y + z * z;
}

/* 线段 ab 与三角形相交（Möller–Trumbore，参数 t∈[0,1]） */
function segHitsTri(ax, ay, az, dx, dy, dz, t, i) {
  const v0x = t[i], v0y = t[i + 1], v0z = t[i + 2];
  const e1x = t[i + 3] - v0x, e1y = t[i + 4] - v0y, e1z = t[i + 5] - v0z;
  const e2x = t[i + 6] - v0x, e2y = t[i + 7] - v0y, e2z = t[i + 8] - v0z;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return false;
  const inv = 1 / det;
  const tx = ax - v0x, ty = ay - v0y, tz = az - v0z;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return false;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return false;
  const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return tt >= 0 && tt <= 1;
}

/* 线段到三角形最近距离²：相交为 0；否则 = min(两端点到三角形, 线段到三条边) */
function segTri2(ax, ay, az, bx, by, bz, t, i) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  if (segHitsTri(ax, ay, az, dx, dy, dz, t, i)) return 0;
  let d = Math.min(ptTri2(ax, ay, az, t, i), ptTri2(bx, by, bz, t, i));
  d = Math.min(d,
    segSeg2(ax, ay, az, bx, by, bz, t[i], t[i + 1], t[i + 2], t[i + 3], t[i + 4], t[i + 5]),
    segSeg2(ax, ay, az, bx, by, bz, t[i + 3], t[i + 4], t[i + 5], t[i + 6], t[i + 7], t[i + 8]),
    segSeg2(ax, ay, az, bx, by, bz, t[i + 6], t[i + 7], t[i + 8], t[i], t[i + 1], t[i + 2]));
  return d;
}

/* ---------- 查询 ---------- */
/* 射线最近命中：返回 {t, f}（f = 三角形索引）或 null。方向无需单位化，t 以方向长度为单位。 */
export function raycast(bvh, ox, oy, oz, dx, dy, dz, tMin = 0, tMax = Infinity) {
  const { tri, order, bmin, bmax, left, start, count } = bvh;
  // 分量为 0 时用大数代替 Infinity：射线恰在包围盒边界上时 0·Infinity = NaN 会让 slab 判定误跳节点
  const safeInv = d => (Math.abs(d) > 1e-12 ? 1 / d : 1e30);
  const ix = safeInv(dx), iy = safeInv(dy), iz = safeInv(dz);
  let best = tMax, bestF = -1;
  const stack = [0];
  while (stack.length) {
    const id = stack.pop();
    // slab 测试
    let t0 = ((ix >= 0 ? bmin[id * 3] : bmax[id * 3]) - ox) * ix;
    let t1 = ((ix >= 0 ? bmax[id * 3] : bmin[id * 3]) - ox) * ix;
    const ty0 = ((iy >= 0 ? bmin[id * 3 + 1] : bmax[id * 3 + 1]) - oy) * iy;
    const ty1 = ((iy >= 0 ? bmax[id * 3 + 1] : bmin[id * 3 + 1]) - oy) * iy;
    if (ty0 > t0) t0 = ty0; if (ty1 < t1) t1 = ty1;
    const tz0 = ((iz >= 0 ? bmin[id * 3 + 2] : bmax[id * 3 + 2]) - oz) * iz;
    const tz1 = ((iz >= 0 ? bmax[id * 3 + 2] : bmin[id * 3 + 2]) - oz) * iz;
    if (tz0 > t0) t0 = tz0; if (tz1 < t1) t1 = tz1;
    if (!(t0 <= t1) || t1 < tMin || t0 > best) continue;
    if (left[id] === -1) {
      for (let k = start[id], e = start[id] + count[id]; k < e; k++) {
        const f = order[k], i = f * 9;
        const v0x = tri[i], v0y = tri[i + 1], v0z = tri[i + 2];
        const e1x = tri[i + 3] - v0x, e1y = tri[i + 4] - v0y, e1z = tri[i + 5] - v0z;
        const e2x = tri[i + 6] - v0x, e2y = tri[i + 7] - v0y, e2z = tri[i + 8] - v0z;
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-14) continue;
        const inv = 1 / det;
        const tx = ox - v0x, ty = oy - v0y, tz = oz - v0z;
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (tt > tMin && tt < best) { best = tt; bestF = f; }
      }
    } else { stack.push(left[id], id + 1); }
  }
  return bestF >= 0 ? { t: best, f: bestF } : null;
}

/* 点到网格最近距离（仅在 < maxD 时精确，否则返回 maxD） */
export function pointDist(bvh, px, py, pz, maxD = Infinity) {
  const { tri, order, bmin, bmax, left, start, count } = bvh;
  let best2 = maxD * maxD;
  const stack = [0];
  while (stack.length) {
    const id = stack.pop();
    const o = id * 3;
    const dx = Math.max(bmin[o] - px, 0, px - bmax[o]);
    const dy = Math.max(bmin[o + 1] - py, 0, py - bmax[o + 1]);
    const dz = Math.max(bmin[o + 2] - pz, 0, pz - bmax[o + 2]);
    if (dx * dx + dy * dy + dz * dz >= best2) continue;
    if (left[id] === -1) {
      for (let k = start[id], e = start[id] + count[id]; k < e; k++) {
        const d2 = ptTri2(px, py, pz, tri, order[k] * 9);
        if (d2 < best2) best2 = d2;
      }
    } else { stack.push(left[id], id + 1); }
  }
  return Math.sqrt(best2);
}

/* 胶囊体净空：线段 ab 扫掠半径 r 的球体与网格无交（全部三角形到线段距离 ≥ r）→ true。
   命中任一三角形即提前返回 false。 */
export function capsuleClear(bvh, ax, ay, az, bx, by, bz, r) {
  const { tri, order, bmin, bmax, left, start, count } = bvh;
  const r2 = r * r;
  const qx0 = Math.min(ax, bx) - r, qy0 = Math.min(ay, by) - r, qz0 = Math.min(az, bz) - r;
  const qx1 = Math.max(ax, bx) + r, qy1 = Math.max(ay, by) + r, qz1 = Math.max(az, bz) + r;
  const stack = [0];
  while (stack.length) {
    const id = stack.pop();
    const o = id * 3;
    if (bmin[o] > qx1 || bmax[o] < qx0 || bmin[o + 1] > qy1 || bmax[o + 1] < qy0 || bmin[o + 2] > qz1 || bmax[o + 2] < qz0) continue;
    if (left[id] === -1) {
      for (let k = start[id], e = start[id] + count[id]; k < e; k++) {
        if (segTri2(ax, ay, az, bx, by, bz, tri, order[k] * 9) < r2) return false;
      }
    } else { stack.push(left[id], id + 1); }
  }
  return true;
}

/* 线段到网格最近距离（剪枝上限 maxD；≥maxD 时返回 maxD）——避让方向搜索用作评分 */
export function segmentDist(bvh, ax, ay, az, bx, by, bz, maxD) {
  const { tri, order, bmin, bmax, left, start, count } = bvh;
  let best2 = maxD * maxD;
  const stack = [0];
  while (stack.length) {
    const id = stack.pop();
    const o = id * 3, m = Math.sqrt(best2);
    if (bmin[o] > Math.max(ax, bx) + m || bmax[o] < Math.min(ax, bx) - m ||
        bmin[o + 1] > Math.max(ay, by) + m || bmax[o + 1] < Math.min(ay, by) - m ||
        bmin[o + 2] > Math.max(az, bz) + m || bmax[o + 2] < Math.min(az, bz) - m) continue;
    if (left[id] === -1) {
      for (let k = start[id], e = start[id] + count[id]; k < e; k++) {
        const d2 = segTri2(ax, ay, az, bx, by, bz, tri, order[k] * 9);
        if (d2 < best2) best2 = d2;
      }
    } else { stack.push(left[id], id + 1); }
  }
  return Math.sqrt(best2);
}

/* 锥台净空（一端粗一端细的杆，如支撑头锥、接触锥）：沿轴等距采样，每点用插值半径做点距判定。
   skip0 = 起点端跳过长度（接触端紧贴模型，由调用方指定豁免段） */
export function coneClear(bvh, ax, ay, az, rA, bx, by, bz, rB, skip0 = 0, step = 0.15) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const L = Math.hypot(dx, dy, dz);
  if (L < 1e-9 || skip0 >= L) return true;   // 全段豁免（否则采样点会落到线段外）
  const n = Math.max(2, Math.ceil((L - skip0) / step));
  for (let k = 0; k <= n; k++) {
    const s = (skip0 + (L - skip0) * k / n) / L;
    const r = rA + (rB - rA) * s;
    if (pointDist(bvh, ax + dx * s, ay + dy * s, az + dz * s, r) < r) return false;
  }
  return true;
}

/* ---------- LDI 实体判定（并集语义，兼容重叠/非流形；像素级精度） ---------- */
export function ldiInside(ld, x, y, z, margin = 0) {
  const i = Math.floor((x - ld.x0) / ld.sx), j = Math.floor((z - ld.z0) / ld.sz);
  if (i < 0 || j < 0 || i >= ld.W || j >= ld.H) return false;
  const c = j * ld.W + i, b = ld.offs[c], e = b + ld.nInt[c];
  for (let k = b; k < e; k++) if (y > ld.ys[2 * k] - margin && y < ld.ys[2 * k + 1] + margin) return true;
  return false;
}
