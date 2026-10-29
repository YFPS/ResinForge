/* ================================================================
   画线切割的几何小工具（纯计算：不碰 DOM / store / three，主线程、Web Worker、Node 通用）
   画线 → 拟合平面、切面局部坐标系、三角形汤 ↔ 水密网格、截面多边形（点在内 / 距离 / 最大内切圆 / 主轴）。
   cutKit.js（平面切 + 调度）和 cutCurve.js（沿画线的曲面切）共用。
   buildManifoldAuto 在水密不过时先走 meshRepair.js 的自动修复（清理 / 朝向 / 补洞 / 多面共边）再重试。
================================================================ */

import { REPAIR_MAX_FACES, repairIndexed, topoCheck } from './meshRepair.js';

export const SNAP_FINE = 1e4;        // 输入吸附网格：1e-4 mm
export const SNAP_COARSE = 1e3;      // 焊接不成功时放宽到 1e-3 mm 再试一次
export const RING_SIMP = 0.02;       // 求内切圆前先把截面轮廓简化到这个容差（mm）
export const FIT_FRAC = 0.985;       // 母孔 / 公榫根部落在材料内的体积比下限
export const PIN_TRIES = 8;          // 放不下时最多缩小的次数
export const PIN_SHRINK = 0.85;      // 每次缩小的比例
export const PIN_MIN = 0.5;          // 销宽下限（mm）：再小就不加销（0.5 mm 约 2～3 个打印层，小件仍能打印）
export const SOCKET_OVER = 0.05;     // 母孔向切面外多开的一小截（mm），保证切透、不与切面共面
export const PIN_WALL = 0.6;         // 完整尺寸销的孔壁厚度（mm）；小销按销宽缩到 0.15～0.6，否则小切面永远塞不下
export const pinWallFor = size => Math.min(PIN_WALL, Math.max(0.15, 0.18 * size));
export const MIN_PIECE = 0.3;        // 切下来的一块沿切面法线至少这么厚（mm），更薄按薄片拒绝

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len3 = a => Math.hypot(a[0], a[1], a[2]);
export const unit = a => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const fail = (code, reason, extra) => ({ ok: false, code, reason, ...(extra || {}) });

/* ---------- 画线 → 切面 ---------- */

/** 点列规整成 xyz 平铺数组；首尾重合的闭合点去掉 */
export function flatPoints(points) {
  const out = [];
  if (points && points.length && typeof points[0] === 'object' && !Array.isArray(points[0]) && points[0].x != null) {
    for (const p of points) out.push(p.x, p.y, p.z);
  } else for (let i = 0; i < points.length; i++) out.push(points[i]);
  const n = out.length / 3;
  if (n > 2 && Math.hypot(out[0] - out[n * 3 - 3], out[1] - out[n * 3 - 2], out[2] - out[n * 3 - 1]) < 1e-9) out.length -= 3;
  return out;
}

/**
 * 画线（闭合圈，点可为 [{x,y,z}] 或 xyz 平铺数组）→ 最佳拟合切面。
 * c 线段长度加权的质心；n 面积加权（Newell）法线，单位向量，翻向朝上（竖直切面时取最大分量为正，保证稳定）；
 * dev 画线各点到切面的最大偏差；span 画线在切面里的外接尺寸；perimeter 周长。点太少或共线时返回 null。
 */
export function fitPlane(points) {
  const P = flatPoints(points);
  const n = P.length / 3;
  if (n < 3) return null;
  let nx = 0, ny = 0, nz = 0, L = 0;
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = P[i * 3], y0 = P[i * 3 + 1], z0 = P[i * 3 + 2];
    const x1 = P[j * 3], y1 = P[j * 3 + 1], z1 = P[j * 3 + 2];
    nx += (y0 - y1) * (z0 + z1);
    ny += (z0 - z1) * (x0 + x1);
    nz += (x0 - x1) * (y0 + y1);
    const e = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    L += e;
    c[0] += e * (x0 + x1) / 2; c[1] += e * (y0 + y1) / 2; c[2] += e * (z0 + z1) / 2;
  }
  if (L < 1e-9) return null;
  c[0] /= L; c[1] /= L; c[2] /= L;
  let nv = [nx, ny, nz];
  if (len3(nv) < 1e-9 * L * L) return null;
  nv = unit(nv);
  const lead = Math.abs(nv[1]) > 0.05 ? nv[1] : (Math.abs(nv[0]) > 0.05 ? nv[0] : nv[2]);
  if (lead < 0) nv = [-nv[0], -nv[1], -nv[2]];
  const fr = frameOf(c, nv);
  let dev = 0, lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = [P[i * 3] - c[0], P[i * 3 + 1] - c[1], P[i * 3 + 2] - c[2]];
    dev = Math.max(dev, Math.abs(dot(d, nv)));
    const a = dot(d, fr.u), b = dot(d, fr.v);
    lo0 = Math.min(lo0, a); hi0 = Math.max(hi0, a); lo1 = Math.min(lo1, b); hi1 = Math.max(hi1, b);
  }
  return { c, n: nv, dev, span: Math.max(hi0 - lo0, hi1 - lo1), perimeter: L, count: n };
}

/** 切面局部系：u 取水平方向（垂直于世界 y 与 n；n 接近竖直时取 x），v = n × u，右手系 (u, v, n)。toLocal / toWorld 为列主序 4×4 */
export function frameOf(c, n) {
  let u = cross([0, 1, 0], n);
  if (len3(u) < 1e-6) u = [1, 0, 0];
  u = unit(u);
  const v = unit(cross(n, u));
  const toLocal = [u[0], v[0], n[0], 0, u[1], v[1], n[1], 0, u[2], v[2], n[2], 0, -dot(u, c), -dot(v, c), -dot(n, c), 1];
  const toWorld = [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, c[0], c[1], c[2], 1];
  return { u, v, n, c, toLocal, toWorld };
}

/* ---------- 三角形汤 ↔ 水密网格 ---------- */

function hash3(x, y, z) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return h;
}

/** 三角形汤 → 焊接顶点的索引网格。顶点先吸附到 1/snap mm 网格再按位置焊接（开放寻址哈希，不拼字符串）；焊接后塌成线的三角形丢弃 */
export function weldSoup(pos, snap) {
  const nIdx = pos.length / 3;
  let cap = 1;
  while (cap < nIdx * 2) cap <<= 1;
  const mask = cap - 1;
  const kx = new Int32Array(cap), ky = new Int32Array(cap), kz = new Int32Array(cap);
  const slot = new Int32Array(cap).fill(-1);
  const vert = new Float32Array(nIdx * 3);
  const tmp = new Uint32Array(nIdx);
  let nv = 0;
  for (let i = 0; i < nIdx; i++) {
    const xi = Math.round(pos[i * 3] * snap), yi = Math.round(pos[i * 3 + 1] * snap), zi = Math.round(pos[i * 3 + 2] * snap);
    let h = hash3(xi, yi, zi) & mask;
    for (;;) {
      const s = slot[h];
      if (s < 0) {
        slot[h] = nv; kx[h] = xi; ky[h] = yi; kz[h] = zi;
        vert[nv * 3] = xi / snap; vert[nv * 3 + 1] = yi / snap; vert[nv * 3 + 2] = zi / snap;
        tmp[i] = nv++;
        break;
      }
      if (kx[h] === xi && ky[h] === yi && kz[h] === zi) { tmp[i] = s; break; }
      h = (h + 1) & mask;
    }
  }
  let nt = 0;
  const idx = new Uint32Array(nIdx);
  for (let t = 0; t < nIdx; t += 3) {
    const a = tmp[t], b = tmp[t + 1], c = tmp[t + 2];
    if (a === b || b === c || a === c) continue;
    idx[nt * 3] = a; idx[nt * 3 + 1] = b; idx[nt * 3 + 2] = c;
    nt++;
  }
  return { vert: vert.slice(0, nv * 3), idx: idx.slice(0, nt * 3), nTri: nt, dropped: nIdx / 3 - nt };
}

/** 三角形汤 → Manifold。先 1e-4 mm 吸附，不成再放宽到 1e-3 mm；整体朝里（体积为负）的翻转绕序重建 */
export function buildManifold(MF, pos, gc) {
  let lastStatus = 'NoError';
  for (const snap of [SNAP_FINE, SNAP_COARSE]) {
    const w = weldSoup(pos, snap);
    if (w.nTri < 4) return { err: 'TOO_SMALL' };
    const b = buildFromIndexed(MF, w.vert, w.idx, gc);
    if (b.M) return { M: b.M, snap, dropped: w.dropped, verts: w.vert.length / 3, tris: w.nTri };
    lastStatus = b.status;
  }
  return { err: 'NOT_MANIFOLD', status: lastStatus };
}

/** 索引网格 → Manifold（整体朝里时翻转绕序重建）。construction 失败返回 { err, status } */
function buildFromIndexed(MF, vert, idx, gc) {
  /* 网格不合法时 manifold 的构造函数直接抛异常（消息就是状态名），不是返回带状态的对象 */
  const make = (v, i) => {
    try {
      const m = new MF.Manifold(new MF.Mesh({ numProp: 3, vertProperties: v, triVerts: i }));
      gc.push(m);
      return { m, st: m.status() };
    } catch (e) {
      return { m: null, st: (e && e.message) || 'NotManifold' };
    }
  };
  let { m, st } = make(vert, idx);
  if (m && st === 'NoError' && !m.isEmpty() && m.volume() < 0) {
    const flip = idx.slice();
    for (let i = 0; i < flip.length; i += 3) { const t = flip[i + 1]; flip[i + 1] = flip[i + 2]; flip[i + 2] = t; }
    ({ m, st } = make(vert, flip));
  }
  if (m && st === 'NoError' && !m.isEmpty()) return { M: m, status: st };
  return { err: 'NOT_MANIFOLD', status: st };
}

/** 索引网格的有符号体积（散度定理）与连通壳数：补洞后的网格是不是「一层没有厚度的面片」要靠它判断 */
function meshVolume(vert, tri) {
  let v = 0;
  for (let i = 0; i < tri.length; i += 3) {
    const a = tri[i] * 3, b = tri[i + 1] * 3, c = tri[i + 2] * 3;
    v += (vert[a] * (vert[b + 1] * vert[c + 2] - vert[b + 2] * vert[c + 1])
      + vert[a + 1] * (vert[b + 2] * vert[c] - vert[b] * vert[c + 2])
      + vert[a + 2] * (vert[b] * vert[c + 1] - vert[b + 1] * vert[c])) / 6;
  }
  return v;
}

function shellCount(tri, nv) {
  const par = new Int32Array(nv);
  for (let i = 0; i < nv; i++) par[i] = i;
  const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (let i = 0; i < tri.length; i += 3) {
    const a = find(tri[i]);
    par[find(tri[i + 1])] = a;
    par[find(tri[i + 2])] = find(a);
  }
  const roots = new Set();
  for (let i = 0; i < tri.length; i++) roots.add(find(tri[i]));
  return roots.size;
}

/**
 * 同 buildManifold；水密不过时自动修复后重试（见 meshRepair.js）。
 * 水密的网格走原路，不进修复，行为与改前逐位一致。
 * 成功：{ M, snap, dropped, verts, tris, repair: null | report, repairMs }（没修过 repair 为 null）
 * 失败：{ err: 'NOT_MANIFOLD', status, repair: report | null, left: { boundary, nonManifold, sameDir } | null, skipped?: 'TOO_BIG' | 'ZERO_VOLUME' }
 * { err: 'TOO_SMALL' } 照旧。
 */
export function buildManifoldAuto(MF, pos, gc) {
  const base = buildManifold(MF, pos, gc);
  if (base.M) return { ...base, repair: null };
  const facesIn = pos.length / 9;
  /* 输入本身就不到 4 个面：切也切不出两件，照旧报面数太少；面够多但焊完剩下的太少，仍可让修复试试
     （一张没有厚度的面片就是这种：补完是一层两面皮，终审会按体积 ≈ 0 拒绝） */
  if (base.err === 'TOO_SMALL' && facesIn < 2) return base;
  if (facesIn > REPAIR_MAX_FACES) {
    return { err: 'NOT_MANIFOLD', status: base.status, repair: null, left: null, skipped: 'TOO_BIG' };
  }
  const t0 = performance.now();
  let last = null, lastZero = false;
  /* 先用细档焊接修一遍；终审不过再放宽到 1e-3 mm 整套重来（顶点间距极小的手办实测要粗档才修得好）。
     每一档里先按「内腔保护」修（抽壳模型的内壳不能翻），修不好再关掉保护按「负体积一律翻」重来一次：
     保护判据在少数碎壳多的模型上会把该翻的壳留下，那一版修不出来，退路能救回来。 */
  for (const snap of [SNAP_FINE, SNAP_COARSE]) {
    const w = weldSoup(pos, snap);
    if (w.nTri < 2) continue;
    for (const protect of [true, false]) {
      const rep = repairIndexed(MF, w.vert, w.idx, { snap, protect });
      last = rep;
      lastZero = false;   // 只保留最后一次尝试的判断，免得前一轮的面片误判带到最后
      /* 一层没有厚度的面片：补完是一张「两面皮」，包住的有符号体积接近零。只有单个壳才按「给它加厚度」提示；
         一堆互不相连的碎片是好几个壳，仍按普通的不水密处理（补完也围不出实体） */
      {
        let lox = Infinity, loy = Infinity, loz = Infinity, hix = -Infinity, hiy = -Infinity, hiz = -Infinity;
        for (let i = 0; i < rep.vert.length; i += 3) {
          const x = rep.vert[i], y = rep.vert[i + 1], z = rep.vert[i + 2];
          if (x < lox) lox = x; if (x > hix) hix = x;
          if (y < loy) loy = y; if (y > hiy) hiy = y;
          if (z < loz) loz = z; if (z > hiz) hiz = z;
        }
        const diag = Math.hypot(hix - lox, hiy - loy, hiz - loz);
        const tiny = diag * diag * diag * 1e-6;   // 用对角线而不是包围盒体积：完全平的面片包围盒体积是 0
        if (tiny > 0 && Math.abs(meshVolume(rep.vert, rep.tri)) <= tiny
          && shellCount(rep.tri, rep.vert.length / 3) === 1) lastZero = true;
      }
      const b = buildFromIndexed(MF, rep.vert, rep.tri, gc);
      if (b.M) {
        /* 补洞会把一张没有厚度的面片补成「两面皮」：Manifold 能构造、体积却接近零，不能当实体切 */
        const bb = b.M.boundingBox();
        const boxVol = (bb.max[0] - bb.min[0]) * (bb.max[1] - bb.min[1]) * (bb.max[2] - bb.min[2]);
        const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
        const vol = b.M.volume();
        if (vol > 0 && vol > Math.max(boxVol * 1e-6, diag * diag * diag * 1e-6)) {
          return {
            M: b.M, snap, repair: rep.report,
            repairMs: +(performance.now() - t0).toFixed(1),
            dropped: w.dropped + (w.nTri - (rep.report.facesOut - rep.report.patchTris)),
            verts: rep.vert.length / 3, tris: rep.report.facesOut,
          };
        }
        lastZero = true;
      }
    }
  }
  return {
    err: 'NOT_MANIFOLD', status: base.status,
    repair: last ? last.report : null,
    left: last ? topoCheck(last.vert, last.tri) : null,
    ...(lastZero ? { skipped: 'ZERO_VOLUME' } : {}),
  };
}

/** Manifold → 非索引三角形汤（Float32Array，9 个数一个面） */
export function soupOf(m) {
  const mesh = m.getMesh();
  const np = mesh.numProp, pv = mesh.vertProperties, tv = mesh.triVerts;
  const out = new Float32Array(tv.length * 3);
  for (let i = 0; i < tv.length; i++) {
    const s = tv[i] * np, d = i * 3;
    out[d] = pv[s]; out[d + 1] = pv[s + 1]; out[d + 2] = pv[s + 2];
  }
  return out;
}

/* ---------- 截面多边形：点在内、距离、最大内切圆、主轴 ---------- */

/** 偶奇规则：点在这组环（外轮廓 + 孔）围出的区域内吗 */
export function inRings(rings, x, y) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** 点到这组环所有边的最短距离 */
export function distRings(rings, x, y) {
  let best = Infinity;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const ax = r[j][0], ay = r[j][1], bx = r[i][0], by = r[i][1];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - x, ey = ay + t * dy - y;
      const d2 = ex * ex + ey * ey;
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best);
}

/** 带符号距离：区域内为正（到最近边的距离），区域外为负 */
export const signedDist = (rings, x, y) => (inRings(rings, x, y) ? 1 : -1) * distRings(rings, x, y);

/**
 * 最大内切圆（难达极点）：把外接盒铺成格子，按「格心距离 + 半对角线」的上界优先细分，上界不超过当前最优 + prec 的格子丢弃。
 * rings 是外轮廓 + 孔；返回 { x, y, r }，r 是圆心到最近边的距离
 */
export function poleOf(rings, prec) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rings) for (const p of r) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  const w = maxX - minX, h = maxY - minY;
  const size = Math.min(w, h);
  if (!(size > 0)) return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, r: 0 };
  const cell = (x, y, half) => { const d = signedDist(rings, x, y); return { x, y, half, d, max: d + half * Math.SQRT2 }; };
  const heap = [];
  const push = c => {
    heap.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].max >= heap[i].max) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].max > heap[m].max) m = l;
        if (r < heap.length && heap[r].max > heap[m].max) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const half0 = size / 2;
  for (let x = minX; x < maxX; x += size) for (let y = minY; y < maxY; y += size) push(cell(x + half0, y + half0, half0));
  let best = cell((minX + maxX) / 2, (minY + maxY) / 2, 0);
  while (heap.length) {
    const c = pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= prec) continue;
    const half = c.half / 2;
    push(cell(c.x - half, c.y - half, half)); push(cell(c.x + half, c.y - half, half));
    push(cell(c.x - half, c.y + half, half)); push(cell(c.x + half, c.y + half, half));
  }
  return { x: best.x, y: best.y, r: Math.max(0, best.d) };
}

/** 外轮廓的长轴方向（面积二阶矩的最大特征向量）与长短轴之比；接近圆形时取 0，免得方向随噪声乱跳 */
export function principalAngle(ring) {
  let pts = ring;
  let A = 0;
  for (let i = 0; i < pts.length; i++) { const q = pts[(i + 1) % pts.length]; A += pts[i][0] * q[1] - q[0] * pts[i][1]; }
  if (A < 0) pts = pts.slice().reverse();
  A = 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
    const cr = x0 * y1 - x1 * y0;
    A += cr; sx += (x0 + x1) * cr; sy += (y0 + y1) * cr;
    sxx += (x0 * x0 + x0 * x1 + x1 * x1) * cr;
    syy += (y0 * y0 + y0 * y1 + y1 * y1) * cr;
    sxy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cr;
  }
  A /= 2;
  if (A < 1e-9) return { theta: 0, ecc: 1 };
  const cx = sx / (6 * A), cy = sy / (6 * A);
  const mxx = sxx / 12 - A * cx * cx, myy = syy / 12 - A * cy * cy, mxy = sxy / 24 - A * cx * cy;
  const mid = (mxx + myy) / 2, rad = Math.hypot((mxx - myy) / 2, mxy);
  const l1 = mid + rad, l2 = Math.max(mid - rad, 1e-12);
  const ecc = Math.sqrt(l1 / l2);
  return { theta: ecc < 1.1 ? 0 : 0.5 * Math.atan2(2 * mxy, mxx - myy), ecc };
}

export function ringArea(r) { let a = 0; for (let i = 0; i < r.length; i++) { const q = r[(i + 1) % r.length]; a += r[i][0] * q[1] - q[0] * r[i][1]; } return a / 2; }

/** 截面岛 → 简化后的环（外轮廓 + 孔） */
export const ringsOf = isl => isl.simplify(RING_SIMP).toPolygons();
export const outerOf = rings => rings.reduce((a, b) => (Math.abs(ringArea(b)) > Math.abs(ringArea(a)) ? b : a));

/**
 * 画线投影到切面后，与哪个截面岛的交并比最高就切哪个岛；与哪个岛都几乎不重叠时退一步取离画线重心最近的岛，太远就认为没圈住。
 * islands 是 CrossSection 数组，loop2 是画线在切面里的 [[x, y]]，T 登记临时对象，warn 收提示。返回 { star, ious } 或 { err }
 */
export function pickStar(MF, islands, loop2, T, warn) {
  const { CrossSection } = MF;
  let gx = 0, gy = 0;
  for (const p of loop2) { gx += p[0]; gy += p[1]; }
  gx /= loop2.length; gy /= loop2.length;
  const Lcs = T(new CrossSection([loop2], 'EvenOdd'));
  if (Lcs.area() < 1e-6) return { err: fail('LINE_FLAT', '画线围不出面积（点几乎在一条直线上）') };
  const ious = islands.map(isl => {
    const it = T(CrossSection.intersection([Lcs, isl])), un = T(CrossSection.union([Lcs, isl]));
    const ua = un.area();
    return ua > 0 ? it.area() / ua : 0;
  });
  let star = 0;
  ious.forEach((v, i) => { if (v > ious[star]) star = i; });
  if (!(ious[star] > 0.01)) {
    // 画线投影与哪个岛都几乎不重叠：退一步取离画线重心最近的岛，太远就认为没圈住
    let bd = Infinity;
    islands.forEach((isl, i) => {
      const rg = ringsOf(isl);
      const d = inRings(rg, gx, gy) ? 0 : distRings(rg, gx, gy);
      if (d < bd) { bd = d; star = i; }
    });
    const b = Lcs.bounds();
    const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
    if (bd > span * 0.5) return { err: fail('LINE_MISS', '画线圈住的位置和切面对不上：切面没有穿过圈内的模型。请让线绕模型一周，或把线画得更平整') };
    warn.push('画线与切面的重合度很低，已按离画线最近的一处切面切割');
  }
  return { star, ious };
}
