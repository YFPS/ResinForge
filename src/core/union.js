/* ================================================================
   manifold-3d 布尔并（WASM）
   ----------------------------------------------------------------
   支撑结构是一堆各自闭合的矩形棱柱「面贴面」堆出来的，导出时留下大量共面重复
   三角形与非流形边（实测 46 万面的导出里有 2.5 万个完全重合的三角形、9.5 万条
   被 3 个以上面共享的边），切片软件必须自己判并集，判不好就碎成几百个独立体。
   这里在导出前把所有构件做一次布尔并，只留一张水密外壳。

   构件边界来自生成侧记录的 geometry.userData.runs（见 TriBuf / mergeParts）：
   **不能**按顶点位置焊接去猜——不同构件的接触面本来就重合（那 2.5 万个重合三角形
   就是证据），焊完会变成一坨非流形的大壳，manifold 直接拒收。
   没有 runs 的输入（底板、筏层）退回按连通分量切分。

   精度：manifold 内部是 double，但 getMesh() 输出 float32。两个只差一个 ulp 的
   顶点在 STL 里会重合成同一点，切片软件看到的就是退化三角形与非流形边。因此输入
   先吸附到 1e-4 mm 网格（同一焊接点的坐标严格相等），输出再用 simplify(1e-5) 收掉
   亚微米短边。实测整座塔导出（改动前的原始并集 → 现在）：退化三角形 14,192 → 8,110，
   非流形边 16,843 → 9,318，开放边始终为 0。只是减半，并未清零，剩余部分需要输出后的
   专门焊接处理。

   代价：Manifold.union 是惰性求值，真正的计算发生在 status() / getMesh() 时。支撑塔现在交来的是
   每面墙一块挤出板 + 针凸包（towerSolid.js，几百个闭合实体），环面结约 5 秒；旧版几千个贴面零件要 45 秒。
   只在导出时调用，不进实时回路。
================================================================ */

/** 输出简化容差（mm）：收掉比它短的边，形状变化不超过这个量级 */
const SIMPLIFY_TOL = 1e-5;
/** 输入吸附网格（mm）：保证共面 / 共顶点的坐标在 float32 下完全相等 */
const SNAP = 1e4;
import { log } from '../store.js';

let modPromise = null;
/** 懒加载 WASM（0.52MB）：首次导出时才取，不进首屏 */
export function loadManifold() {
  if (!modPromise) {
    modPromise = (async () => {
      const [mod, wasm] = await Promise.all([
        import('manifold-3d/manifold.js'),
        import('manifold-3d/manifold.wasm?url'),
      ]);
      const m = await mod.default({ locateFile: f => (f.endsWith('.wasm') ? wasm.default : f) });
      m.setup();                       // 装上 Manifold.union / Mesh 等 JS 侧包装
      return m;
    })();
    modPromise.catch(() => { modPromise = null; });
  }
  return modPromise;
}

/** 把一批三角形按「顶点位置焊接后的连通分量」切开（没有 runs 信息时的退路） */
function componentsOf(pos, t0, t1) {
  const Q = 1e4;
  const ids = new Map();
  let nv = 0;
  const vid = new Int32Array((t1 - t0) * 3);
  for (let t = t0; t < t1; t++) {
    const o = t * 9;
    for (let k = 0; k < 3; k++) {
      const key = `${Math.round(pos[o + k * 3] * Q)},${Math.round(pos[o + k * 3 + 1] * Q)},${Math.round(pos[o + k * 3 + 2] * Q)}`;
      let id = ids.get(key);
      if (id === undefined) { id = nv++; ids.set(key, id); }
      vid[(t - t0) * 3 + k] = id;
    }
  }
  const pa = new Int32Array(nv);
  for (let i = 0; i < nv; i++) pa[i] = i;
  const find = a => { while (pa[a] !== a) { pa[a] = pa[pa[a]]; a = pa[a]; } return a; };
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) pa[rb] = ra; };
  for (let i = 0; i < vid.length; i += 3) { uni(vid[i], vid[i + 1]); uni(vid[i], vid[i + 2]); }
  const out = [];
  let cur = null, curRoot = -1;
  for (let t = t0; t < t1; t++) {
    const r = find(vid[(t - t0) * 3]);
    if (r !== curRoot) { cur = [t, t + 1]; out.push(cur); curRoot = r; }
    else cur[1] = t + 1;
  }
  // 分量在 soup 里通常不连续，再按全局位置并一次相邻同根区间
  return out;
}

/** [DEBUG] 拒收构件的诊断：焊接顶点后统计边-面关系（开放边 / 非流形边 / 重合面） */
function diagRange(pos, a, b) {
  const Q = 1e4, ids = new Map(), vert = [];
  const idx = [];
  for (let t = a; t < b; t++) {
    const o = t * 9;
    for (let k = 0; k < 3; k++) {
      const x = pos[o + k * 3], y = pos[o + k * 3 + 1], z = pos[o + k * 3 + 2];
      const key = `${Math.round(x * Q)},${Math.round(y * Q)},${Math.round(z * Q)}`;
      let id = ids.get(key);
      if (id === undefined) { id = vert.length / 3; ids.set(key, id); vert.push(x, y, z); }
      idx.push(id);
    }
  }
  const edges = new Map(), trisSig = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    const [p, q, r] = [idx[i], idx[i + 1], idx[i + 2]];
    for (const [u, v] of [[p, q], [q, r], [r, p]]) {
      const k = u < v ? u * 100000 + v : v * 100000 + u;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
    const sig = [p, q, r].sort((m, n2) => m - n2).join(',');
    trisSig.set(sig, (trisSig.get(sig) || 0) + 1);
  }
  let open = 0, multi = 0;
  const bad = [];
  for (const [k, cnt] of edges) {
    if (cnt === 1) open++;
    else if (cnt > 2) {
      multi++;
      if (bad.length < 6) {
        const u = Math.floor(k / 100000), v = k % 100000;
        bad.push({ n: cnt, a: [vert[u * 3], vert[u * 3 + 1], vert[u * 3 + 2]].map(w => +w.toFixed(3)), b: [vert[v * 3], vert[v * 3 + 1], vert[v * 3 + 2]].map(w => +w.toFixed(3)) });
      }
    }
  }
  let dup = 0;
  for (const c of trisSig.values()) if (c > 1) dup += c - 1;
  return { verts: vert.length / 3, trisIn: (b - a), openEdges: open, multiEdges: multi, dupTris: dup, bad };
}

/** 区间 [t0,t1) 的三角形 → 焊接顶点的 Mesh。
 *  顶点先吸附到 1/SNAP mm 网格，存进 vert 的也是吸附后的坐标：同一个焊接点的坐标完全相等，
 *  共面面在 float32 下也更容易严格共面，从而减少 ulp 级的缝与零面积碎片（效果见文件头的实测）。 */
function meshOf(pos, Manifold_mod, t0, t1) {
  const { Mesh } = Manifold_mod;
  const ids = new Map();
  const vert = []; const idx = [];
  for (let t = t0; t < t1; t++) {
    const o = t * 9;
    for (let k = 0; k < 3; k++) {
      const xi = Math.round(pos[o + k * 3] * SNAP), yi = Math.round(pos[o + k * 3 + 1] * SNAP), zi = Math.round(pos[o + k * 3 + 2] * SNAP);
      const key = `${xi},${yi},${zi}`;
      let id = ids.get(key);
      if (id === undefined) { id = ids.size; ids.set(key, id); vert.push(xi / SNAP, yi / SNAP, zi / SNAP); }
      idx.push(id);
    }
  }
  return new Mesh({ vertProperties: new Float32Array(vert), triVerts: new Uint32Array(idx) });
}

/**
 * 把一批构件并成一张水密外壳。
 * parts: [{ pos: Float32Array 世界系非索引三角形, runs?: [[起,止], ...], solids?: [{ vert, tri }] }]
 *   solids：生成侧给出的闭合流形（支撑塔的墙面板 / 针，见 towerSolid.js）——直接按索引网格建 Manifold，不拆、不焊
 * 返回 { pos, nTri, shells, skipped, ms }；整体失败时返回 null（调用方按原样导出）。
 */
export async function unionShells(parts) {
  const t0 = performance.now();
  let total = 0, tris = 0;
  const solids = [];
  for (const p of parts) {
    tris += p.pos.length / 9;
    if (p.solids) solids.push(...p.solids); else total += p.pos.length;
  }
  const pos = new Float32Array(total);
  let off = 0;
  const ranges = [];
  for (const p of parts) {
    if (p.solids) continue;
    const base = off / 9;
    if (p.runs && p.runs.length) {
      for (const [s, e] of p.runs) if (e > s) ranges.push([base + s, base + e]);
    } else {
      // 没有 runs 的构件（实心筏层等）：按连通分量切开，下标用构件内部的局部值再平移到全局
      for (const [s, e] of componentsOf(p.pos, 0, p.pos.length / 9)) ranges.push([base + s, base + e]);
    }
    pos.set(p.pos, off); off += p.pos.length;
  }

  const ms = await loadManifold();
  const { Manifold, Mesh } = ms;
  const manifolds = [];
  const leftover = [];
  const rejected = [];   // [DEBUG] 被内核拒收的构件：面数 + 包围盒（定位生成端问题用）
  const gc = [];         // WASM 对象：结束统一 delete（旧版从不释放，每导出一次漏一份）
  try {
  for (const sd of solids) {
    try {
      const m = new Manifold(new Mesh({ vertProperties: sd.vert, triVerts: sd.tri }));
      gc.push(m);
      if (m.status() !== 'NoError' || m.isEmpty()) throw new Error(m.status());
      manifolds.push(m);
    } catch (err) {
      rejected.push({ tris: sd.tri.length / 3, why: err.message, lo: [], hi: [], pts: [], diag: null });
      for (let i = 0; i < sd.tri.length; i++) { const v = sd.tri[i] * 3; leftover.push(sd.vert[v], sd.vert[v + 1], sd.vert[v + 2]); }
    }
  }
  for (const [a, b] of ranges) {
    try {
      const m = new Manifold(meshOf(pos, ms, a, b));
      gc.push(m);
      if (m.status() !== 'NoError' || m.isEmpty()) throw new Error(m.status());
      manifolds.push(m);
    } catch (err) {
      let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      for (let t = a; t < b; t++) for (let k = 0; k < 3; k++) {
        const x = pos[t * 9 + k * 3], y = pos[t * 9 + k * 3 + 1], z = pos[t * 9 + k * 3 + 2];
        lo[0] = Math.min(lo[0], x); hi[0] = Math.max(hi[0], x);
        lo[1] = Math.min(lo[1], y); hi[1] = Math.max(hi[1], y);
        lo[2] = Math.min(lo[2], z); hi[2] = Math.max(hi[2], z);
      }
      const tri = [];
      for (let t = a; t < b; t++) for (let k = 0; k < 9; k++) tri.push(pos[t * 9 + k]);
      rejected.push({ tris: b - a, why: err.message, lo: lo.map(v => +v.toFixed(2)), hi: hi.map(v => +v.toFixed(2)), pts: tri, diag: diagRange(pos, a, b) });
      for (let t = a; t < b; t++) for (let k = 0; k < 9; k++) leftover.push(pos[t * 9 + k]);
    }
  }
  if (typeof window !== 'undefined') window.__rejected = rejected;
  if (!manifolds.length) return null;

  const tU = performance.now();
  // union 是惰性的：下面 simplify / status 才真正算
  let merged = Manifold.union(manifolds);
  gc.push(merged);
  /* 收掉比 SIMPLIFY_TOL 短的边（float32 输出时会坍成零面积三角形与非流形边），形状不变。 */
  merged = merged.simplify(SIMPLIFY_TOL);
  gc.push(merged);
  const status = merged.status();                    // 惰性求值在这里真正发生
  const unionMs = performance.now() - tU;
  if (status !== 'NoError') { log(`布尔并失败（${status}），已按原样导出`, 'warn'); return null; }
  const mesh = merged.getMesh();
  const tG = performance.now();
  const np = mesh.numProp, tv = mesh.triVerts, pv = mesh.vertProperties;
  const out = new Float32Array(tv.length * 3 + leftover.length);
  for (let i = 0; i < tv.length; i++) {
    const s = tv[i] * np, d = i * 3;
    out[d] = pv[s]; out[d + 1] = pv[s + 1]; out[d + 2] = pv[s + 2];
  }
  out.set(leftover, tv.length * 3);
  const nOut = tv.length / 3 + leftover.length / 9;
  // 输出外壳数（焊接后的连通分量）与其中的碎壳（< 20 面：布尔并在几乎共面处切出的四面体碎片 / 空腔）——自检用
  const nvO = pv.length / np, pa = new Int32Array(nvO);
  for (let i = 0; i < nvO; i++) pa[i] = i;
  const find = a => { while (pa[a] !== a) { pa[a] = pa[pa[a]]; a = pa[a]; } return a; };
  for (let i = 0; i < tv.length; i += 3) for (const k of [1, 2]) { const x = find(tv[i]), y = find(tv[i + k]); if (x !== y) pa[y] = x; }
  const cnt = new Map();
  for (let i = 0; i < tv.length; i += 3) { const r0 = find(tv[i]); cnt.set(r0, (cnt.get(r0) || 0) + 1); }
  const outShells = cnt.size, tinyShells = [...cnt.values()].filter(n => n < 20).length;
  log(`布尔并：${(ranges.length + solids.length).toLocaleString()} 个构件（${manifolds.length.toLocaleString()} 个被内核接受）→ `
    + `${nOut.toLocaleString()} 三角形（原 ${tris.toLocaleString()}），外壳 ${outShells}${tinyShells ? `（碎壳 ${tinyShells}）` : ''}、genus ${merged.genus()}、体积 ${merged.volume().toFixed(1)}mm³；`
    + `内核 ${unionMs.toFixed(0)}ms、取回 ${(performance.now() - tG).toFixed(0)}ms、合计 ${(performance.now() - t0).toFixed(0)}ms`
    + (leftover.length ? `；${(leftover.length / 9).toLocaleString()} 面内核拒收，原样保留` : ''), 'ok');
  if (rejected.length) {
    const show = rejected.slice(0, 8).map(r => `${r.tris}面@[${r.lo.join(',')}]×[${r.hi.join(',')}](${r.why})`).join('；');
    log(`内核拒收明细：${rejected.length} 个构件——${show}`, 'warn');
  }
  return { pos: out, nTri: nOut, shells: ranges.length + solids.length, outShells, tinyShells, skipped: leftover.length / 9, ms: performance.now() - t0 };
  } finally {
    for (const o of gc) { try { o.delete(); } catch { /* 已释放 */ } }
  }
}
