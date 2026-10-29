/* ================================================================
   画线切割前的网格自动修复（纯计算：不碰 DOM / store / three，主线程、Web Worker、Node 通用）
   ----------------------------------------------------------------
   为什么要有这一层：真实 STL 里有不少「不是水密」的网格（破洞、翻向、重复面、一条边挂三个面），
   manifold-3d 的构造函数会直接拒收（Not manifold），切割也跟着失败。这里只做拓扑层面的整理，
   不重建形状；修完是否真的水密，由调用方用 Manifold 构造终审（cutGeom.js 的 buildManifoldAuto）。
   链路（顺序不能换）：
     1 清理（退化面 / 重复面）→ 2 统一朝向 → 3 补洞 → 4 多面共边按方向各留一个 → 5 清理 → 6 朝向 → 7 补洞 → 8 朝向
   第 8 步是收尾：复杂 / 自交的环退回中心点扇形时，补出来的面绕序可能与环不一致，要再统一一次。
   为什么多面共边要放在统一朝向之后：只有先让相邻面沿共边走向相反，才能按「正向 / 反向各留一个」
   判断丢哪几张；反过来说，「按评分先挑面」「丢到 Manifold 通过为止」这两种做法在调查里都更差
   （前者留下同向的两张、配不成对；后者会把模型啃光）。
   性能：边表与重复面表都是数值键的开放寻址哈希 + 类型数组——原型用 Map + 字符串键，69 万面要 1.3 GB。
   许可证：链路是按本项目调查出来的规格自己写的，没有拷贝 PartCraft（GPL-3.0）等库的代码。
================================================================ */

/** 面数上限：再多就不尝试修复（WASM 堆与内存都吃不消），由调用方给用户提示 */
export const REPAIR_MAX_FACES = 1500000;
/** 顶点焊接精度档（snap 的倒数，mm）：修复先用细档，不过在 buildManifoldAuto 里再拿粗档整套重来 */
export const SNAP_FINE = 1e4;
export const SNAP_COARSE = 1e3;

/* 改动较大时的提醒阈值（只提醒、不拦着切）。依据：零件库调查里丢面 p95 1.4% / 最大 7.0%，
   补面 p95 2.8% / 最大 11.6%；最大的洞补上会把开口的壳封成实心，所以按包围盒对角线的比例提醒 */
const DROP_WARN = 0.02;
const PATCH_WARN = 0.05;
const HOLE_WARN = 0.25;
/** 2×面积小于这个数就算退化面（mm²）；与原型一致 */
const DEGEN_AREA = 1e-12;

/* ---------- 小工具 ---------- */

/** 3 个 32 位整数混成一个哈希（开放寻址表的下标） */
function mix3(a, b, c) {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(c, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return h;
}

/** 重复面按「排序三元组」判，哈希也按排序后的顺序算（不排序的话反向绕序会落到别的槽里，查不到） */
function mixSorted(a, b, c) {
  let s0 = a, s1 = b, s2 = c, t;
  if (s0 > s1) { t = s0; s0 = s1; s1 = t; }
  if (s1 > s2) { t = s1; s1 = s2; s2 = t; }
  if (s0 > s1) { t = s0; s0 = s1; s1 = t; }
  return mix3(s0, s1, s2);
}

/** 无向边的键：lo × nv + hi。nv < 9e7 时双精度能精确表示，不开字符串 */
const edgeKey = (lo, hi, nv) => lo * nv + hi;

/** 2×三角形面积（mm²） */
function triArea2(vert, a, b, c) {
  const ax = vert[3 * b] - vert[3 * a], ay = vert[3 * b + 1] - vert[3 * a + 1], az = vert[3 * b + 2] - vert[3 * a + 2];
  const bx = vert[3 * c] - vert[3 * a], by = vert[3 * c + 1] - vert[3 * a + 1], bz = vert[3 * c + 2] - vert[3 * a + 2];
  return Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
}

/**
 * 两张面是否同一组顶点：+1 同向（循环移位相同），-1 反向，0 不是同一组。
 * 重复面要按排序三元组判，这里直接逐项核对（哈希碰撞后再分方向）。
 */
function permType(p, q, r, a, b, c) {
  if (p === a && q === b && r === c) return 1;
  if (p === b && q === c && r === a) return 1;
  if (p === c && q === a && r === b) return 1;
  if (p === a && q === c && r === b) return -1;
  if (p === c && q === b && r === a) return -1;
  if (p === b && q === a && r === c) return -1;
  return 0;
}

/**
 * 无向边表：每条边（一条边挂几组面）记成一个槽。
 * 槽里存 keys（边的键，-1 = 空）、head（面边项链表的头，面边项 = 3×面号 + 第几条边）、
 * count（挂了几张面）、next（面边项链表的下一个）。
 * 开放寻址 + 线性探测，键是数值，不拼字符串。
 */
function buildEdges(tri, nv) {
  const nt = tri.length / 3;
  const need = nt * 3;
  let cap = 16;
  while (cap < need * 1.5 + 8) cap <<= 1;
  const mask = cap - 1;
  const keys = new Float64Array(cap).fill(-1);
  const head = new Int32Array(cap).fill(-1);
  const count = new Int32Array(cap);
  const next = new Int32Array(need).fill(-1);
  const order = new Int32Array(need);   // 边的插入顺序（与原型按面顺序遍历的口径一致，处理多面共边时结果才稳定）
  let nOrd = 0;
  for (let t = 0, e = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++, e++) {
      const a = tri[3 * t + k], b = tri[3 * t + (k + 1) % 3];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const key = edgeKey(lo, hi, nv);
      let h = mix3(lo, hi, 0) & mask;
      for (;;) {
        const kk = keys[h];
        if (kk === key) { next[e] = head[h]; head[h] = e; count[h]++; break; }
        if (kk < 0) {
          keys[h] = key; head[h] = e; count[h] = 1;
          order[nOrd++] = h;
          break;
        }
        h = (h + 1) & mask;
      }
    }
  }
  return { cap, mask, keys, head, count, next, order, nOrd };
}

/** 在边表里找一条无向边所在的槽；没有返回 -1 */
function findSlot(tbl, lo, hi, nv) {
  const key = edgeKey(lo, hi, nv);
  let h = mix3(lo, hi, 0) & tbl.mask;
  for (;;) {
    const kk = tbl.keys[h];
    if (kk === key) return h;
    if (kk < 0) return -1;
    h = (h + 1) & tbl.mask;
  }
}

/* ---------- 1 / 5 清理：退化面、重复面 ---------- */

/**
 * 丢掉退化面（三个下标有重复，或面积为 0）与重复面：
 * 同向重复留一个；反向成对重复（内部薄膜）两个都去掉。
 */
function cleanup(vert, tri) {
  const nt = tri.length / 3;
  let cap = 16;
  while (cap < nt * 1.5 + 8) cap <<= 1;
  const mask = cap - 1;
  const slot = new Int32Array(cap).fill(-1);   // 槽里存「已保留的那张面」的面号
  const kill = new Uint8Array(nt);
  let degenerate = 0, duplicate = 0;
  for (let t = 0; t < nt; t++) {
    const a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
    if (a === b || b === c || a === c) { kill[t] = 1; degenerate++; continue; }
    if (triArea2(vert, a, b, c) < DEGEN_AREA) { kill[t] = 1; degenerate++; continue; }
    let h = mixSorted(a, b, c) & mask;
    let found = -1;
    for (;;) {
      const s = slot[h];
      if (s < 0) break;
      if (permType(tri[3 * s], tri[3 * s + 1], tri[3 * s + 2], a, b, c)) { found = s; break; }
      h = (h + 1) & mask;
    }
    if (found >= 0) {
      kill[t] = 1; duplicate++;
      // 反向成对的两张都去掉；同向重复只去掉后出现的这一张
      if (permType(tri[3 * found], tri[3 * found + 1], tri[3 * found + 2], a, b, c) < 0 && !kill[found]) {
        kill[found] = 1; duplicate++;
      }
      continue;
    }
    slot[h] = t;
  }
  const res = new Uint32Array(nt * 3);
  let n = 0;
  for (let t = 0; t < nt; t++) {
    if (kill[t]) continue;
    res[n++] = tri[3 * t]; res[n++] = tri[3 * t + 1]; res[n++] = tri[3 * t + 2];
  }
  return { tri: res.slice(0, n), degenerate, duplicate };
}

/**
 * 这块壳是否真的在别的壳里面（抽壳模型的内腔）：从它的最小 x 顶点沿 −x 发射线，
 * 数别的壳的交点，奇数 = 在里面。包围盒只当预筛（必要条件），不能单独作数——
 * 很多手办的碎壳包围盒恰好落在主体包围盒里，按包围盒「保护」会把该翻的壳留下，最后 Manifold 还是拒收。
 * 擦边、擦顶点这类拿不准的情形按「在里面」处理（宁可多保护真空腔）。
 */
function rayInsideOthers(vert, tri, comp, k, solid, px, py, pz) {
  const nt = tri.length / 3;
  let hits = 0;
  for (let t = 0; t < nt; t++) {
    const c = comp[t];
    if (c === k || !solid[c]) continue;   // 只看有实体体积的壳：空腔必须在「实心」里面
    const a3 = tri[3 * t] * 3, b3 = tri[3 * t + 1] * 3, c3 = tri[3 * t + 2] * 3;
    const ay = vert[a3 + 1], az = vert[a3 + 2];
    const by = vert[b3 + 1], bz = vert[b3 + 2];
    const cy = vert[c3 + 1], cz = vert[c3 + 2];
    const d = (by - ay) * (cz - az) - (cy - ay) * (bz - az);
    if (Math.abs(d) < 1e-12) continue;   // 三角形与射线平行（射线在它平面里）：不算交点
    const w1 = ((py - ay) * (cz - az) - (pz - az) * (cy - ay)) / d;
    const w2 = ((by - ay) * (pz - az) - (bz - az) * (py - ay)) / d;
    const w0 = 1 - w1 - w2;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
    if (Math.min(w0, w1, w2) < 1e-6) return true;   // 擦边：拿不准，按在里面
    const x = w0 * vert[a3] + w1 * vert[b3] + w2 * vert[c3];
    if (x < px) hits++;
  }
  return (hits & 1) === 1;
}

/* ---------- 2 / 6 统一朝向 ---------- */

/** 第 t 张面里有没有沿 p→q 这条有向边 */
function hasDir(tri, t, p, q) {
  const a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
  return (a === p && b === q) || (b === p && c === q) || (c === p && a === q);
}

/**
 * 沿「恰好两张面共用」的边传播朝向，让相邻面沿共边走向相反，必要时翻面；
 * 每个连通块如果有符号体积为负，整块翻回来——但独立的内壳空腔（抽壳模型）不能翻，
 * 翻了体积会从「外 − 内」变成「外 + 内」。保护规则：先按包围盒预筛，再沿 −x 射线确认
 * 它真的在别的实心壳里面；开口碎壳（体积在 0 附近打转）没有内外之分，跟原型一样整块翻。
 * 迭代栈，不用递归（几十万面会爆栈）；3 面以上共边与开边不参与传播。
 */
function orient(vert, tri, protect = true) {
  const nv = vert.length / 3, nt = tri.length / 3;
  if (!nt) return { flipped: 0, flippedShells: 0, keptInverted: 0, comps: 0 };
  const tbl = buildEdges(tri, nv);
  const { head, count, next } = tbl;
  const adj = new Int32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tri[3 * t + k], b = tri[3 * t + (k + 1) % 3];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const h = findSlot(tbl, lo, hi, nv);
      if (h < 0 || count[h] !== 2) { adj[3 * t + k] = -1; continue; }
      const e1 = head[h], e2 = next[e1];
      const f1 = (e1 / 3) | 0;
      adj[3 * t + k] = f1 === t ? ((e2 / 3) | 0) : f1;
    }
  }
  const flip = new Uint8Array(nt);
  const comp = new Int32Array(nt).fill(-1);
  const stack = new Int32Array(nt);
  let nc = 0, flips = 0;
  for (let s = 0; s < nt; s++) {
    if (comp[s] >= 0) continue;
    comp[s] = nc; stack[0] = s;
    let sp = 1;
    while (sp) {
      const t = stack[--sp];
      for (let k = 0; k < 3; k++) {
        const n = adj[3 * t + k];
        if (n < 0 || comp[n] >= 0) continue;
        const u = tri[3 * t + k], v = tri[3 * t + (k + 1) % 3];
        const p = flip[t] ? v : u, q = flip[t] ? u : v;   // t 在有效朝向下沿这条边走 p→q
        flip[n] = hasDir(tri, n, p, q) ? 1 : 0;            // 邻面必须走 q→p：它原来也走 p→q 就翻
        if (flip[n]) flips++;
        comp[n] = nc; stack[sp++] = n;
      }
    }
    nc++;
  }
  for (let t = 0; t < nt; t++) {
    if (!flip[t]) continue;
    const x = tri[3 * t + 1]; tri[3 * t + 1] = tri[3 * t + 2]; tri[3 * t + 2] = x;
  }
  /* 每个连通块的有符号体积与包围盒（体积为负 = 整块朝里） */
  const vol = new Float64Array(nc);
  const lo = new Float64Array(nc * 3).fill(Infinity);
  const hi = new Float64Array(nc * 3).fill(-Infinity);
  const minV = new Int32Array(nc);   // 每个块最小 x 的顶点（射线求内外用它当起点）
  for (let t = 0; t < nt; t++) {
    const a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
    const ax = vert[3 * a], ay = vert[3 * a + 1], az = vert[3 * a + 2];
    const bx = vert[3 * b], by = vert[3 * b + 1], bz = vert[3 * b + 2];
    const cx = vert[3 * c], cy = vert[3 * c + 1], cz = vert[3 * c + 2];
    vol[comp[t]] += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    const k3 = comp[t] * 3;
    for (let j = 0; j < 3; j++) {
      const vi = tri[3 * t + j] * 3;
      const x = vert[vi], y = vert[vi + 1], z = vert[vi + 2];
      if (x < lo[k3]) { lo[k3] = x; minV[comp[t]] = tri[3 * t + j]; }
      if (x > hi[k3]) hi[k3] = x;
      if (y < lo[k3 + 1]) lo[k3 + 1] = y; if (y > hi[k3 + 1]) hi[k3 + 1] = y;
      if (z < lo[k3 + 2]) lo[k3 + 2] = z; if (z > hi[k3 + 2]) hi[k3 + 2] = z;
    }
  }
  const flipComp = new Uint8Array(nc);
  const solid = new Uint8Array(nc);
  for (let k = 0; k < nc; k++) solid[k] = vol[k] > 0 ? 1 : 0;
  let flippedShells = 0, keptInverted = 0;
  for (let k = 0; k < nc; k++) {
    if (!(vol[k] < 0)) continue;
    const k3 = k * 3;
    const dx = hi[k3] - lo[k3], dy = hi[k3 + 1] - lo[k3 + 1], dz = hi[k3 + 2] - lo[k3 + 2];
    /* 开口的碎壳有符号体积只是在 0 附近打转，没有「内 / 外」可言：不按空腔处理，跟原型一样整块翻过去。
       真正要保护的只有有实体体积的内壳（阈值按对角线立方算，平的碎壳包围盒体积是 0） */
    const diag = Math.hypot(dx, dy, dz);
    if (Math.abs(vol[k]) <= diag * diag * diag * 1e-6) { flipComp[k] = 1; flippedShells++; continue; }
    if (!protect) { flipComp[k] = 1; flippedShells++; continue; }   // 退路：不分内腔，负体积一律翻（原型口径）
    let inside = false;
    if (nc > 1) {
      for (let j = 0; j < nc && !inside; j++) {
        if (j === k || !solid[j]) continue;
        const j3 = j * 3;
        inside = lo[j3] <= lo[k3] && lo[j3 + 1] <= lo[k3 + 1] && lo[j3 + 2] <= lo[k3 + 2]
          && hi[j3] >= hi[k3] && hi[j3 + 1] >= hi[k3 + 1] && hi[j3 + 2] >= hi[k3 + 2];
      }
      // 包围盒只是预筛：真的在别的（实心）壳里面才按空腔保护，否则照常翻回来
      if (inside) {
        const vi = minV[k] * 3;
        inside = rayInsideOthers(vert, tri, comp, k, solid, vert[vi], vert[vi + 1], vert[vi + 2]);
      }
    }
    if (inside) keptInverted++;
    else { flipComp[k] = 1; flippedShells++; }
  }
  if (flippedShells) {
    for (let t = 0; t < nt; t++) {
      if (!flipComp[comp[t]]) continue;
      const x = tri[3 * t + 1]; tri[3 * t + 1] = tri[3 * t + 2]; tri[3 * t + 2] = x;
    }
  }
  return { flipped: flips, flippedShells, keptInverted, comps: nc };
}

/* ---------- 4 多面共边：按方向各留一个 ---------- */

/**
 * 每条 ≥ 3 张面共用的边：按走向分成正向面、反向面，各留面积最大的一个，其余去掉。
 * 必须在统一朝向之后做（见文件头的顺序说明）；这一步会留下新的开口，所以后面还要再补一次洞。
 */
function dropExtra(vert, tri) {
  const nv = vert.length / 3, nt = tri.length / 3;
  const { keys, head, count, next, order, nOrd } = buildEdges(tri, nv);
  const kill = new Uint8Array(nt);
  let dropped = 0;
  for (let oi = 0; oi < nOrd; oi++) {
    const h = order[oi];
    if (count[h] < 3) continue;
    const key = keys[h];
    let lo = Math.floor(key / nv);
    if ((lo + 1) * nv <= key) lo++;
    const hi = key - lo * nv;
    let bestF = -1, bestFArea = -1, bestB = -1, bestBArea = -1;
    /* 选「每个方向留哪个面」时不看它是否已被别的边杀过：与原型口径一致。
       跳过的话会多留一个本该在别处被杀的面，边界环跟着变，最后一轮补洞就可能冒出新的非流形边 */
    for (let e = head[h]; e >= 0; e = next[e]) {
      const t = (e / 3) | 0;
      let fw = false;
      for (let k = 0; k < 3; k++) {
        if (tri[3 * t + k] === lo && tri[3 * t + (k + 1) % 3] === hi) { fw = true; break; }
      }
      const ar = triArea2(vert, tri[3 * t], tri[3 * t + 1], tri[3 * t + 2]);
      if (fw) { if (ar > bestFArea) { bestFArea = ar; bestF = t; } }
      else if (ar > bestBArea) { bestBArea = ar; bestB = t; }
    }
    for (let e = head[h]; e >= 0; e = next[e]) {
      const t = (e / 3) | 0;
      if (kill[t] || t === bestF || t === bestB) continue;
      kill[t] = 1; dropped++;
    }
  }
  const res = new Uint32Array(nt * 3);
  let n = 0;
  for (let t = 0; t < nt; t++) {
    if (kill[t]) continue;
    res[n++] = tri[3 * t]; res[n++] = tri[3 * t + 1]; res[n++] = tri[3 * t + 2];
  }
  return { tri: res.slice(0, n), dropped };
}

/* ---------- 3 / 7 补洞 ---------- */

/**
 * 开边（只被一张面用到的无向边）沿走向连成环，每个环补成一张平面片。
 * 坑都在细节里：
 * · 环途中回到已经走过的顶点（顶点被夹住）时，把它之后走过的那一串拆成子环，主路径停在那个顶点上继续——
 *   同时要把子环里的点从 where 表删掉，否则会造出空环、再被中心点扇形补成 NaN 顶点（原型第一版就栽在这里）。
 * · 每个环用 Newell 法向投到平面基里，交给 MF.triangulate；三角形数与面积都要对得上，
 *   否则退回「中心点扇形」（多一个顶点，但一定补得上）。
 * · 补出来的面必须与环反向（环走 a→b，补面里是 b→a），否则相邻边又是同向，Manifold 还是拒收。
 */
function fillHoles(MF, vert, tri) {
  const nv = vert.length / 3, nt = tri.length / 3;
  const tbl = buildEdges(tri, nv);
  /* 开边按「起点 → 终点」建链表（每个顶点一条链，边从链头取） */
  let nb = 0;
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tri[3 * t + k], b = tri[3 * t + (k + 1) % 3];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const h = findSlot(tbl, lo, hi, nv);
      if (h >= 0 && tbl.count[h] === 1) nb++;
    }
  }
  const outHead = new Int32Array(nv).fill(-1);
  const outNext = new Int32Array(nb).fill(-1);
  const outTo = new Int32Array(nb);
  let bi = 0;
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = tri[3 * t + k], b = tri[3 * t + (k + 1) % 3];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const h = findSlot(tbl, lo, hi, nv);
      if (h < 0 || tbl.count[h] !== 1) continue;
      outTo[bi] = b; outNext[bi] = outHead[a]; outHead[a] = bi; bi++;
    }
  }
  /* 连成环；断链（走不回起点）计入 broken，跳过 */
  const loops = [];
  const where = new Int32Array(nv).fill(-1);
  let broken = 0;
  for (let a0 = 0; a0 < nv; a0++) {
    while (outHead[a0] >= 0) {
      const path = [a0];
      where[a0] = 0;
      let cur = a0, ok = true;
      for (;;) {
        const ei = outHead[cur];
        if (ei < 0) { ok = false; break; }
        outHead[cur] = outNext[ei];
        const nxt = outTo[ei];
        if (nxt === a0) break;
        const w = where[nxt];
        if (w >= 0) {
          const sub = path.splice(w + 1);
          for (let i = 0; i < sub.length; i++) where[sub[i]] = -1;
          if (sub.length >= 2) loops.push(Int32Array.from([nxt, ...sub]));
          cur = nxt;
          continue;
        }
        where[nxt] = path.length;
        path.push(nxt);
        cur = nxt;
      }
      for (let i = 0; i < path.length; i++) where[path[i]] = -1;
      if (ok && path.length >= 3) loops.push(Int32Array.from(path));
      else if (!ok) broken++;
    }
  }
  /* 逐环补面 */
  const added = [];
  const extra = [];
  let patchTris = 0, fanHoles = 0, maxHoleSpan = 0;
  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li];
    const n = loop.length;
    let lox = Infinity, loy = Infinity, loz = Infinity, hix = -Infinity, hiy = -Infinity, hiz = -Infinity;
    for (let i = 0; i < n; i++) {
      const p3 = loop[i] * 3;
      const x = vert[p3], y = vert[p3 + 1], z = vert[p3 + 2];
      if (x < lox) lox = x; if (x > hix) hix = x;
      if (y < loy) loy = y; if (y > hiy) hiy = y;
      if (z < loz) loz = z; if (z > hiz) hiz = z;
    }
    const span = Math.hypot(hix - lox, hiy - loy, hiz - loz);
    if (span > maxHoleSpan) maxHoleSpan = span;
    if (n === 3) { added.push(loop[2], loop[1], loop[0]); patchTris++; continue; }
    const fanFill = () => {
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < n; i++) {
        const p3 = loop[i] * 3;
        cx += vert[p3]; cy += vert[p3 + 1]; cz += vert[p3 + 2];
      }
      const id = nv + extra.length / 3;
      extra.push(cx / n, cy / n, cz / n);
      for (let i = 0; i < n; i++) added.push(id, loop[(i + 1) % n], loop[i]);
      fanHoles++;
      patchTris += n;
    };
    /* Newell 法向 → 平面基 (u, v, n)：右手系，环在 (u, v) 里是逆时针的 */
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const p3 = loop[i] * 3, q3 = loop[(i + 1) % n] * 3;
      const px = vert[p3], py = vert[p3 + 1], pz = vert[p3 + 2];
      const qx = vert[q3], qy = vert[q3 + 1], qz = vert[q3 + 2];
      nx += (py - qy) * (pz + qz);
      ny += (pz - qz) * (px + qx);
      nz += (px - qx) * (py + qy);
    }
    const nl = Math.hypot(nx, ny, nz);
    if (!(nl > 1e-14)) { fanFill(); continue; }   // 全共线的环：法向退化，别把三角化器喂进去
    nx /= nl; ny /= nl; nz /= nl;
    // u = n × 轴（轴取 x 或 y，与 n 不平行的那个）的展开，避免每次分配数组
    let ux, uy, uz;
    if (Math.abs(nx) < 0.9) { ux = 0; uy = nz; uz = -ny; }
    else { ux = -nz; uy = 0; uz = nx; }
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
    const pts = new Array(n);
    for (let i = 0; i < n; i++) {
      const p3 = loop[i] * 3;
      const px = vert[p3], py = vert[p3 + 1], pz = vert[p3 + 2];
      pts[i] = [px * ux + py * uy + pz * uz, px * vx + py * vy + pz * vz];
    }
    let area2 = 0;
    for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; area2 += p[0] * q[1] - q[0] * p[1]; }
    const area = Math.abs(area2) / 2;
    let tris = null;
    try { tris = MF.triangulate([pts], Math.max(1e-9, span * 1e-7)); } catch { tris = null; }
    let sum = 0, valid = !!tris && tris.length === n - 2;
    if (valid) {
      for (let i = 0; i < tris.length; i++) {
        const t = tris[i];
        sum += Math.abs((pts[t[1]][0] - pts[t[0]][0]) * (pts[t[2]][1] - pts[t[0]][1])
          - (pts[t[2]][0] - pts[t[0]][0]) * (pts[t[1]][1] - pts[t[0]][1])) / 2;
      }
    }
    // 自交的环（蝴蝶结）给出的三角形有向面积互相抵消，面积对不上就退回中心点扇形
    if (!valid || Math.abs(sum - area) > 1e-6 * area + 1e-12) { fanFill(); continue; }
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      const s = (pts[t[1]][0] - pts[t[0]][0]) * (pts[t[2]][1] - pts[t[0]][1])
        - (pts[t[2]][0] - pts[t[0]][0]) * (pts[t[1]][1] - pts[t[0]][1]);
      // 补面与环反向：二维里取顺时针（s > 0 时交换两个下标）
      if (s > 0) added.push(loop[t[0]], loop[t[2]], loop[t[1]]);
      else added.push(loop[t[0]], loop[t[1]], loop[t[2]]);
    }
    patchTris += tris.length;
  }
  const outV = new Float32Array(nv * 3 + extra.length);
  outV.set(vert);
  outV.set(extra, nv * 3);
  const outT = new Uint32Array(nt * 3 + added.length);
  outT.set(tri);
  outT.set(added, nt * 3);
  return { vert: outV, tri: outT, loops: loops.length, broken, patchTris, fanHoles, maxHoleSpan };
}

/* ---------- 入口 ---------- */

/**
 * 修复一份索引网格。输入是 weldSoup 焊好的网格；不改输入数组，返回新数组与报告。
 * 只管拓扑修复，不判断「是不是真水密」——终审由调用方用 Manifold 构造来做。
 * opts.snap 只用于报告（顶点焊接精度档），不在这里重新焊接。
 */
export function repairIndexed(MF, vert, idx, opts = {}) {
  const t0 = performance.now();
  const facesIn = idx.length / 3;
  const snap = (opts && opts.snap) || SNAP_FINE;
  const protect = !(opts && opts.protect === false);   // 内腔保护（P1-3）；退路那一轮关掉
  let v = vert;
  let tri = idx;
  let degenerate = 0, duplicate = 0, flipped = 0, flippedShells = 0, keptInverted = 0;
  let holes = 0, patchTris = 0, fanHoles = 0, maxHoleSpan = 0, overlapDropped = 0;
  const absorbFill = f => {
    holes += f.loops; patchTris += f.patchTris; fanHoles += f.fanHoles;
    if (f.maxHoleSpan > maxHoleSpan) maxHoleSpan = f.maxHoleSpan;
  };
  try {
    /* 1 清理 → 2 朝向 → 3 补洞 → 4 多面共边 → 5 清理 → 6 朝向 → 7 补洞 → 8 朝向 */
    let c = cleanup(v, tri);
    tri = c.tri; degenerate += c.degenerate; duplicate += c.duplicate;
    let o = orient(v, tri, protect);
    flipped += o.flipped; flippedShells += o.flippedShells;
    let f = fillHoles(MF, v, tri);
    v = f.vert; tri = f.tri; absorbFill(f);
    const d = dropExtra(v, tri);
    tri = d.tri; overlapDropped += d.dropped;
    c = cleanup(v, tri);
    tri = c.tri; degenerate += c.degenerate; duplicate += c.duplicate;
    o = orient(v, tri, protect);
    flipped += o.flipped; flippedShells += o.flippedShells; keptInverted = o.keptInverted;
    f = fillHoles(MF, v, tri);
    v = f.vert; tri = f.tri; absorbFill(f);
    /* 收尾再统一一次朝向：复杂 / 自交的环退回中心点扇形时，补出来的面绕序可能与环不一致，
       这里按「相邻面沿共边走向相反」纠正过来（Manifold 要求每条边一正一反） */
    o = orient(v, tri, protect);
    flipped += o.flipped; flippedShells += o.flippedShells; keptInverted = o.keptInverted;
  } catch (e) {
    /* 修复是「尽力而为」：算不动时把已经修到的半成品交回去，由 Manifold 终审决定成败 */
    if (!(tri instanceof Uint32Array)) tri = idx;
    if (!(v instanceof Float32Array)) v = vert;
  }
  const facesOut = tri.length / 3;
  const removed = Math.max(0, facesIn - (facesOut - patchTris));   // 丢掉的原始面（不含补进来的）
  const droppedFrac = facesIn ? +(removed / facesIn).toFixed(4) : 0;
  const patchFrac = facesIn ? +(patchTris / facesIn).toFixed(4) : 0;
  let diag = 0;
  {
    let lox = Infinity, loy = Infinity, loz = Infinity, hix = -Infinity, hiy = -Infinity, hiz = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i], y = v[i + 1], z = v[i + 2];
      if (x < lox) lox = x; if (x > hix) hix = x;
      if (y < loy) loy = y; if (y > hiy) hiy = y;
      if (z < loz) loz = z; if (z > hiz) hiz = z;
    }
    if (hix >= lox) diag = Math.hypot(hix - lox, hiy - loy, hiz - loz);
  }
  const warn = [];
  if (droppedFrac > DROP_WARN) {
    warn.push(`修复时去掉了 ${(droppedFrac * 100).toFixed(1)}% 的面（重叠或重复的面较多），请检查切口两侧的模型是否与原件一致`);
  }
  if (patchFrac > PATCH_WARN) {
    warn.push(`补洞新增了 ${(patchFrac * 100).toFixed(1)}% 的面，原模型的洞较多，补出来的面可能与原来的形状有出入`);
  }
  if (diag > 0 && maxHoleSpan > diag * HOLE_WARN) {
    warn.push(`有一个很大的洞（跨度 ${maxHoleSpan.toFixed(1)} mm，约占模型的 ${Math.round(maxHoleSpan / diag * 100)}%），补上之后切出的体积可能和预期不同（开口的壳会被封成实心）`);
  }
  return {
    vert: v, tri,
    report: {
      snap, facesIn, facesOut, degenerate, duplicate, flipped, flippedShells, keptInverted,
      holes, patchTris, fanHoles, maxHoleSpan, overlapDropped,
      droppedFrac, patchFrac,
      ms: +(performance.now() - t0).toFixed(1),
      warn,
    },
  };
}

/** 报告 → 一句中文（只列非零项），调用方自己加「已自动修复再切：」之类的开头 */
export function describeRepair(r) {
  if (!r) return '';
  const items = [];
  if (r.holes > 0) {
    // 洞跨度小到 0.0x mm 时保留两位，免得日志写成「跨度 0.0 mm」让人以为没补上
    const span = r.maxHoleSpan >= 1 ? r.maxHoleSpan.toFixed(1) : r.maxHoleSpan.toFixed(2);
    let s = `补了 ${r.holes} 个洞（新增 ${r.patchTris} 个面，最大一个跨度 ${span} mm`;
    if (r.fanHoles > 0) s += `，其中 ${r.fanHoles} 个用中心点扇形补`;
    items.push(s + '）');
  }
  if (r.flipped > 0) items.push(`翻转了 ${r.flipped} 个面的朝向`);
  if (r.flippedShells > 0) items.push(`整块翻回 ${r.flippedShells} 个朝里的壳`);
  if (r.keptInverted > 0) items.push(`保留了 ${r.keptInverted} 个朝里的内壳空腔`);
  if (r.duplicate > 0) items.push(`去掉 ${r.duplicate} 个重复面`);
  if (r.overlapDropped > 0) items.push(`去掉 ${r.overlapDropped} 个重叠面`);
  if (r.degenerate > 0) items.push(`去掉 ${r.degenerate} 个退化面`);
  if (r.snap && r.snap <= SNAP_COARSE) items.push(`顶点焊接精度放宽到 ${(1 / r.snap).toFixed(3)} mm`);
  const ms = r.ms >= 1000 ? `${(r.ms / 1000).toFixed(1)} s` : `${Math.round(r.ms)} ms`;
  return (items.length ? items.join('、') : '没有可修的拓扑问题') + `（耗时 ${ms}）`;
}

/** 拓扑体检：修不好时给失败文案用，测试也用（与调查脚本同一口径） */
export function topoCheck(vert, idx) {
  const nv = vert.length / 3, nt = idx.length / 3;
  let boundary = 0, nonManifold = 0, sameDir = 0, dupFaces = 0;
  if (!nt) return { boundary, nonManifold, sameDir, dupFaces };
  const tbl = buildEdges(idx, nv);
  for (let h = 0; h < tbl.cap; h++) {
    const c = tbl.count[h];
    if (c === 1) boundary++;
    else if (c > 2) nonManifold++;
  }
  /* 有向边重复 = 相邻面沿共边同向（朝向冲突） */
  let cap = 16;
  while (cap < nt * 3 + 8) cap <<= 1;
  const dmask = cap - 1;
  const dkeys = new Float64Array(cap).fill(-1);
  const dcnt = new Int32Array(cap);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[3 * t + k], b = idx[3 * t + (k + 1) % 3];
      const key = a * nv + b;
      let h = mix3(a, b, 1) & dmask;
      for (;;) {
        const kk = dkeys[h];
        if (kk === key) { dcnt[h]++; break; }
        if (kk < 0) { dkeys[h] = key; dcnt[h] = 1; break; }
        h = (h + 1) & dmask;
      }
    }
  }
  for (let h = 0; h < cap; h++) if (dcnt[h] > 1) sameDir++;
  /* 重复面（同顶点的面出现不止一次） */
  let fcap = 16;
  while (fcap < nt * 1.5 + 8) fcap <<= 1;
  const fmask = fcap - 1;
  const fslot = new Int32Array(fcap).fill(-1);
  for (let t = 0; t < nt; t++) {
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    let h = mixSorted(a, b, c) & fmask;
    for (;;) {
      const s = fslot[h];
      if (s < 0) { fslot[h] = t; break; }
      if (permType(idx[3 * s], idx[3 * s + 1], idx[3 * s + 2], a, b, c)) { dupFaces++; break; }
      h = (h + 1) & fmask;
    }
  }
  return { boundary, nonManifold, sameDir, dupFaces };
}
