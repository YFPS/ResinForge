/* ================================================================
   manifold-3d 内核封装（纯计算：不碰 DOM / store / three，主线程、Web Worker、Node 通用）
   ----------------------------------------------------------------
   - loadManifold：懒加载 WASM（0.52MB），同一线程只编译一次
   - solidifySpec：支撑塔几何规格 → 各闭合实体（墙面板 / 针与转接块凸包）的索引网格 + 视口用的非索引顶点与面法线
   - unionParts：导出前把支撑各构件布尔并成一张水密外壳
   - layoutPoints：支撑点布点（图块投影轮廓内缩出边缘环 + 内部按覆盖补点、Lloyd 松弛）
   调度（放进后台线程、排队、作废旧请求）见 geomClient.js；本模块只管算。
================================================================ */

let modPromise = null;
/** 懒加载 WASM（0.52MB）：首次用到时才取 */
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

/* ================================================================
   支撑塔实体化（manifold-3d：Clipper2 二维布尔 + 凸包）
   ----------------------------------------------------------------
   旧做法：几千个六面体（杆件）+ 手算轮廓的节点板 + 分段六面体（针）各自闭合、只是「贴着」摆放，
   接缝全靠端面切法与节点板轮廓凑齐。任何一个特例没凑上就是裂缝或台阶（「<」顶点锯齿、针脚台阶）。
   现做法（闭合与连续由库保证，不再手写拼缝）：
   1. 墙：每面墙在面内坐标 (s, y) 里把杆件条带、节点圆盘（圆形接头）、针根足迹、基础带并成一个区域
      （Clipper2 并集），再做半径 r 的闭运算（外扩 r 再内缩 r）——所有凹角自动成半径 r 的圆角，凸角不变；
      侧边切齐只作用在「柱」部分（竖杆 + 节点圆盘），斜边不受影响。整面墙是一张连续穿孔板，挤出成墙厚。
   2. 针 / 转接块：凸包（Manifold.hull）。
   3. 视口：各实体网格直接拼接显示（两向墙在「+」柱处互相穿插、针根埋进柱里——深度测试画出来的正是并集的外表面）；
      三维布尔并只在导出时做（unionParts）。
   约定：与墙面板轮廓面（经 Clipper 量化到 1e-8）相贴的面一律内缩 1µm（生成侧处理），
   免得两个实体「几乎共面」——布尔并在几乎共面处会切出四面体碎片。
   规格（spec）：
   t        墙厚（墙面板挤出厚度）
   rFil     凹角圆角半径（闭运算半径）
   seg      整圆分段数（节点圆盘、圆角）
   walls    [{ pl, c, col: [多边形], web: [多边形], clip: [多边形], sub: [多边形] }]
            pl 0 = z 固定墙（z = c，面内 s = x）/ 1 = x 固定墙（x = c，面内 s = z）
            col = 柱部分（竖杆 + 节点圆盘，可被侧边切齐）；web = 其余（斜边、针根足迹、基础带）；clip = 切齐条带；
            sub = 圆角之后再从整面墙减掉的区域（连接底板吞掉的那截格架）
   slabs    [{ pl, c, half, polys }]  独立厚度的墙面板（连接底板立板，厚 2·half）
   hulls    [[[x,y,z], ...], ...]     凸包（十字针、跨墙转接块）
   cuts     [{ pl, c, half, poly }]   贯穿孔棱柱（连接底板开孔，实体化时就从立板上布尔减去）
   多边形一律为 [[s, y], ...]，方向不限（内部统一转成逆时针）
================================================================ */
const SIMP = 1e-4;                                   // 轮廓简化容差（mm）：只收掉近乎重合 / 共线的点，圆弧（24 段，弦高 0.002）不受影响
const MIN_AREA = 1e-6;                               // 小于它的面内岛丢弃（mm²）
const area2 = p => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a; };
const ccw = p => (area2(p) < 0 ? p.slice().reverse() : p);

/** 面内坐标 → 世界系：挤出方向（局部 +Z）对齐墙法线，面内 s 对齐 x（pl 0）或 z（pl 1）。90° 旋转在 manifold 里是精确的 */
function place(K, m, pl, c) {
  return pl === 0 ? K(m.translate([0, 0, c])) : K(K(m.rotate([0, -90, 0])).translate([c, 0, 0]));
}

/** Manifold → 拷出索引网格（xyz） */
function meshOut(m) {
  const mesh = m.getMesh();
  const np = mesh.numProp, pv = mesh.vertProperties, nv = pv.length / np;
  const vert = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) { vert[i * 3] = pv[i * np]; vert[i * 3 + 1] = pv[i * np + 1]; vert[i * 3 + 2] = pv[i * np + 2]; }
  return { vert, tri: new Uint32Array(mesh.triVerts) };
}

/**
 * 规格 → 实体。MF = loadManifold() 的模块。
 * 返回 { parts: [{ vert, tri }]（每个闭合实体一份，导出布尔并直接用）, pos / nrm（视口：非索引顶点与面法线）, stats }；没有几何时返回 null
 */
export function solidifySpec(MF, spec) {
  const { CrossSection, Manifold } = MF;
  const T0 = performance.now();
  const gc = [];                                       // WASM 对象：用完统一 delete
  const K = o => { gc.push(o); return o; };
  const seg = Math.max(8, spec.seg || 16);
  const r = Math.max(0, spec.rFil || 0);
  const parts = [];
  let nWall = 0, nHull = 0;
  try {
    /* ---- 1. 墙：Clipper2 并集 → 柱部分切齐 → 闭运算圆角 → 挤出 ---- */
    for (const w of spec.walls) {
      const web = w.web.filter(p => p.length >= 3).map(ccw);
      const col = w.col.filter(p => p.length >= 3).map(ccw);
      if (!web.length && !col.length) continue;
      let cs = null;
      if (col.length) {
        cs = K(new CrossSection(col, 'Positive'));
        const clip = w.clip.filter(p => p.length >= 3).map(ccw);
        if (clip.length) cs = K(cs.subtract(K(new CrossSection(clip, 'Positive'))));
      }
      if (web.length) {
        const wcs = K(new CrossSection(web, 'Positive'));
        cs = cs ? K(cs.add(wcs)) : wcs;
      }
      if (r > 1e-4) cs = K(K(cs.offset(r, 'Round', 2, seg)).offset(-r, 'Round', 2, seg));
      // 减掉被连接底板吞掉的那截（sub）：板内不留墙面杆件，开孔不会露出杆件
      const sub = (w.sub || []).filter(p => p.length >= 3).map(ccw);
      if (sub.length) cs = K(cs.subtract(K(new CrossSection(sub, 'Positive'))));
      // 偏置后清理（manifold 文档建议 Offset 之后接 Simplify）：共线杆边在节点高度相接处，偏置会留下面积≈0 的小三角岛，
      // 挤出后就是一个个独立的碎壳（实测 1~4 个 / 模型）。先收掉亚微米短边，再丢掉面积 < 1e-6 mm² 的岛
      cs = K(cs.simplify(SIMP));
      const comps = cs.decompose();
      if (comps.some(c => c.area() < MIN_AREA)) cs = K(CrossSection.compose(comps.filter(c => c.area() >= MIN_AREA)));
      for (const c of comps) c.delete();
      if (cs.isEmpty()) continue;
      parts.push(meshOut(place(K, K(cs.extrude(spec.t, 0, 0, [1, 1], true)), w.pl, w.c)));
      nWall++;
    }
    /* ---- 2. 独立厚度的墙面板（连接底板立板） ---- */
    const slabIdx = [];
    for (const s of spec.slabs || []) {
      const polys = s.polys.filter(p => p.length >= 3).map(ccw);
      if (!polys.length) continue;
      const cs = K(new CrossSection(polys, 'Positive'));
      if (cs.isEmpty()) continue;
      slabIdx.push(parts.length);
      parts.push(meshOut(place(K, K(cs.extrude(2 * s.half, 0, 0, [1, 1], true)), s.pl, s.c)));
    }
    /* ---- 3. 十字针 / 转接块：凸包 ---- */
    for (const pts of spec.hulls) {
      if (pts.length < 4) continue;
      const h = K(Manifold.hull(pts));
      if (h.isEmpty()) continue;
      parts.push(meshOut(h)); nHull++;
    }
    /* ---- 4. 连接底板的孔：贯穿棱柱，从立板上布尔减（孔只落在立板高度内，只涉及几块立板，很快） ---- */
    const cuts = [];
    for (const c of spec.cuts || []) {
      const cs = K(new CrossSection([ccw(c.poly)], 'Positive'));
      if (cs.isEmpty()) continue;
      cuts.push(meshOut(place(K, K(cs.extrude(2 * c.half, 0, 0, [1, 1], true)), c.pl, c.c)));
    }
    if (cuts.length && slabIdx.length) {
      const cutM = K(Manifold.union(cuts.map(m => K(new Manifold(new MF.Mesh({ vertProperties: m.vert, triVerts: m.tri }))))));
      for (const i of slabIdx) {
        const m = K(new Manifold(new MF.Mesh({ vertProperties: parts[i].vert, triVerts: parts[i].tri })));
        parts[i] = meshOut(K(m.subtract(cutM)));
      }
    }
    if (!parts.length) return null;
    /* ---- 5. 视口几何：各实体直接拼接（非索引顶点 + 面法线，主线程拿到即可上屏，不再算法线） ---- */
    let nt = 0;
    for (const p of parts) nt += p.tri.length / 3;
    const pos = new Float32Array(nt * 9), nrm = new Float32Array(nt * 9);
    let o = 0;
    for (const p of parts) {
      const { vert, tri } = p;
      for (let i = 0; i < tri.length; i += 3) {
        const a = tri[i] * 3, b = tri[i + 1] * 3, c = tri[i + 2] * 3;
        const ax = vert[a], ay = vert[a + 1], az = vert[a + 2], bx = vert[b], by = vert[b + 1], bz = vert[b + 2], cx = vert[c], cy = vert[c + 1], cz = vert[c + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        pos[o] = ax; pos[o + 1] = ay; pos[o + 2] = az; pos[o + 3] = bx; pos[o + 4] = by; pos[o + 5] = bz; pos[o + 6] = cx; pos[o + 7] = cy; pos[o + 8] = cz;
        for (let k = 0; k < 9; k += 3) { nrm[o + k] = nx; nrm[o + k + 1] = ny; nrm[o + k + 2] = nz; }
        o += 9;
      }
    }
    return { parts, pos, nrm, stats: { walls: nWall, hulls: nHull, parts: parts.length, tris: nt, ms: Math.round(performance.now() - T0) } };
  } finally {
    for (const o2 of gc) { try { o2.delete(); } catch { /* 已释放 */ } }
  }
}

/* ================================================================
   导出前布尔并：把一批构件并成一张水密外壳
   ----------------------------------------------------------------
   构件边界来自生成侧：支撑塔给 solids（每份已是闭合流形，直接建 Manifold，不拆不焊）；
   兜底件给 runs（「一个构件 = 哪几段连续三角形」）。**不能**按顶点位置焊接去猜——
   不同构件的接触面本来就重合，焊完会变成一坨非流形的大壳，manifold 直接拒收。没有 runs 的输入（底板、筏层）退回按连通分量切分。
   精度：manifold 输出 float32，两个只差一个 ulp 的顶点在 STL 里会重合成退化三角形——
   runs 构件的输入先吸附到 1e-4 mm 网格，输出再 simplify(1e-5) 收掉亚微米短边。
================================================================ */
const SIMPLIFY_TOL = 1e-5;                           // 输出简化容差（mm）
const SLIVER_VOL = 1e-5;                             // 零体积碎片的体积上限（mm³）
const SNAP = 1e4;                                    // 输入吸附网格（1e-4 mm）

/** 把一批三角形按「顶点位置焊接后的连通分量」切开（没有 runs 信息时的退路） */
function componentsOf(pos, t0, t1) {
  const Q = 1e4, ids = new Map();
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
  return out;
}

/** 拒收构件的诊断：焊接顶点后统计边-面关系（开放边 / 非流形边 / 重合面） */
function diagRange(pos, a, b) {
  const Q = 1e4, ids = new Map(), vert = [], idx = [];
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
  for (const cnt of edges.values()) { if (cnt === 1) open++; else if (cnt > 2) multi++; }
  let dup = 0;
  for (const c of trisSig.values()) if (c > 1) dup += c - 1;
  return { verts: vert.length / 3, trisIn: b - a, openEdges: open, multiEdges: multi, dupTris: dup };
}

/** 区间 [t0,t1) 的三角形 → 焊接顶点的 Mesh（顶点先吸附到 1/SNAP mm 网格：同一焊接点坐标完全相等） */
function meshOf(pos, MF, t0, t1) {
  const ids = new Map(), vert = [], idx = [];
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
  return new MF.Mesh({ vertProperties: new Float32Array(vert), triVerts: new Uint32Array(idx) });
}

/**
 * parts: [{ pos?: Float32Array 世界系非索引三角形, runs?: [[起,止], ...], solids?: [{ vert, tri }] }]
 * 返回 { pos, nTri, inParts, accepted, inTris, outShells, tinyShells, genus, volume, skipped, rejected, msKernel, msFetch, ms }；
 * 没有一个构件被内核接受时返回 null；布尔并失败时返回 { failed: 状态 }
 */
export function unionParts(MF, parts) {
  const { Manifold, Mesh } = MF;
  const t0 = performance.now();
  let total = 0, inTris = 0;
  const solids = [];
  for (const p of parts) {
    if (p.solids) { solids.push(...p.solids); for (const s of p.solids) inTris += s.tri.length / 3; }
    else if (p.pos) { total += p.pos.length; inTris += p.pos.length / 9; }
  }
  const pos = new Float32Array(total);
  let off = 0;
  const ranges = [];
  for (const p of parts) {
    if (p.solids || !p.pos) continue;
    const base = off / 9;
    if (p.runs && p.runs.length) {
      for (const [s, e] of p.runs) if (e > s) ranges.push([base + s, base + e]);
    } else {
      for (const [s, e] of componentsOf(p.pos, 0, p.pos.length / 9)) ranges.push([base + s, base + e]);
    }
    pos.set(p.pos, off); off += p.pos.length;
  }
  const manifolds = [], leftover = [], rejected = [];
  const gc = [];                                       // WASM 对象：结束统一 delete
  try {
    for (const sd of solids) {
      try {
        const m = new Manifold(new Mesh({ vertProperties: sd.vert, triVerts: sd.tri }));
        gc.push(m);
        if (m.status() !== 'NoError' || m.isEmpty()) throw new Error(m.status());
        manifolds.push(m);
      } catch (err) {
        rejected.push({ tris: sd.tri.length / 3, why: err.message, lo: [], hi: [], diag: null });
        for (let i = 0; i < sd.tri.length; i++) { const v = sd.tri[i] * 3; leftover.push(sd.vert[v], sd.vert[v + 1], sd.vert[v + 2]); }
      }
    }
    for (const [a, b] of ranges) {
      try {
        const m = new Manifold(meshOf(pos, MF, a, b));
        gc.push(m);
        if (m.status() !== 'NoError' || m.isEmpty()) throw new Error(m.status());
        manifolds.push(m);
      } catch (err) {
        const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
        for (let t = a; t < b; t++) for (let k = 0; k < 3; k++) for (let d = 0; d < 3; d++) {
          const v = pos[t * 9 + k * 3 + d]; lo[d] = Math.min(lo[d], v); hi[d] = Math.max(hi[d], v);
        }
        rejected.push({ tris: b - a, why: err.message, lo: lo.map(v => +v.toFixed(2)), hi: hi.map(v => +v.toFixed(2)), diag: diagRange(pos, a, b) });
        for (let t = a; t < b; t++) for (let k = 0; k < 9; k++) leftover.push(pos[t * 9 + k]);
      }
    }
    if (!manifolds.length) return null;
    const tU = performance.now();
    let merged = Manifold.union(manifolds);              // 惰性：下面 simplify / status 才真正算
    gc.push(merged);
    merged = merged.simplify(SIMPLIFY_TOL);              // 收掉比它短的边（float32 输出时会坍成零面积三角形与非流形边），形状不变
    gc.push(merged);
    const status = merged.status();
    if (status !== 'NoError') return { failed: status };
    // 收掉零体积碎片：布尔并在几乎共面处（分叉的三根杆在汇合点相交、斜杆贴面）会切出 4～6 面的反向小四面体，|体积| ≤ 1e-6 mm³，
    // 不属于任何构件，却在切片软件里各算一个独立外壳（实测双层平台中细模板 4 个；开连接底板后兜底点变多，蘑菇中细模板 8 个）。
    // 拆成连通分量，丢掉面数 < 20 且 |体积| < SLIVER_VOL 的再合回去（0.1 mm 见方的小块也有 1e-3 mm³，真实构件不会被删）；
    // 面数 < 20 且体积为负的同样丢掉：那是反向的碎片或几根杆围出的封闭小空腔（悬臂雕像粗模板 + 连接底板：53 对分叉里有一个 8 面、
    // −1.7e-4 mm³ 的空腔），真实构件的体积一定为正，丢掉空腔等于把它填实
    let slivers = 0;
    {
      const comps = merged.decompose();
      for (const c of comps) gc.push(c);
      const keep = comps.filter(c => !(c.numTri() < 20 && (c.volume() < 0 || Math.abs(c.volume()) < SLIVER_VOL)));
      slivers = comps.length - keep.length;
      if (slivers && keep.length) { merged = Manifold.compose(keep); gc.push(merged); }
    }
    const msKernel = performance.now() - tU;
    const mesh = merged.getMesh();
    const tG = performance.now();
    const np = mesh.numProp, tv = mesh.triVerts, pv = mesh.vertProperties;
    const out = new Float32Array(tv.length * 3 + leftover.length);
    for (let i = 0; i < tv.length; i++) {
      const s = tv[i] * np, d = i * 3;
      out[d] = pv[s]; out[d + 1] = pv[s + 1]; out[d + 2] = pv[s + 2];
    }
    out.set(leftover, tv.length * 3);
    // 输出外壳数（焊接后的连通分量）与其中的碎壳（< 20 面：几乎共面处切出的四面体碎片 / 空腔）——自检用
    const nvO = pv.length / np, pa = new Int32Array(nvO);
    for (let i = 0; i < nvO; i++) pa[i] = i;
    const find = a => { while (pa[a] !== a) { pa[a] = pa[pa[a]]; a = pa[a]; } return a; };
    for (let i = 0; i < tv.length; i += 3) for (const k of [1, 2]) { const x = find(tv[i]), y = find(tv[i + k]); if (x !== y) pa[y] = x; }
    const cnt = new Map();
    for (let i = 0; i < tv.length; i += 3) { const r0 = find(tv[i]); cnt.set(r0, (cnt.get(r0) || 0) + 1); }
    return {
      pos: out, nTri: tv.length / 3 + leftover.length / 9, inParts: ranges.length + solids.length, accepted: manifolds.length, inTris,
      outShells: cnt.size, tinyShells: [...cnt.values()].filter(n => n < 20).length, genus: merged.genus(), volume: merged.volume(),
      skipped: leftover.length / 9, rejected, slivers, msKernel, msFetch: performance.now() - tG, ms: performance.now() - t0,
    };
  } finally {
    for (const o of gc) { try { o.delete(); } catch { /* 已释放 */ } }
  }
}

/* ================================================================
   支撑点布点：边缘环 + 内部六角格 + 窄条中线 + 按覆盖补点 + Lloyd 松弛
   ----------------------------------------------------------------
   输入每个「图块」（一片支撑区域里同一 XZ 位置只有一层曲面的部分）的投影三角形，在 XZ 投影平面上布点：
   1. 边缘环：投影轮廓（三角形并集）内缩「边缘距离」（再做半径 0.3 × 间距的开运算，太细的部分不画环），沿内缩线按弧长均分
      放点（点距 ≈ 支撑间距）。这一圈固定不动，边缘支撑到边的距离处处一致。
   2. 内缩区深处（离内缩线 ≥ 0.85 × 间距）铺正六角格（点距 = 支撑间距，对齐世界原点），也固定不动——开阔处整整齐齐，
      点距就是设定的间距。
   3. 窄条（没有内缩区的条带、开运算去掉的细条）：中线取 λ-中轴，沿中线从一头扫过去，每隔约一个间距放一个点。
   4. 按覆盖补点：内缩区里任一处离最近支撑点都不得超过覆盖半径（正六角排布的覆盖半径是 间距/√3 ≈ 0.577 × 间距，
      开阔处本来就满足）。补的是六角格铺不进去的窄带（覆盖半径 0.6 × 间距：中间那排沿排点距 ≈ 间距），以及边缘环与
      六角格之间的过渡带（放宽到 0.72 × 间距，≈ 边缘带本身的覆盖：两排之间超过约 1.3 倍理想行距才补一排，免得边上多出一圈挤着的点）。
      用贪心最大覆盖选位置（每次选能新盖住最多未覆盖采样的那个），点数接近最省。
   5. Lloyd 松弛：补出来的点挪到它所管辖采样（离它最近的那些采样）的重心，反复十几次，在固定点之间排匀；
      只在允许的地方（内缩区 / 窄条中线）移动，不会跑进边缘带。拿掉后仍处处覆盖的多余点删掉，再松弛。
   开阔处按间距，窄处按覆盖：条带宽度不是行距的整数倍时，只在需要的地方突破间距、把中间那排补上。
   离散化：区域上铺 h ≈ 间距/15 的采样格，到边界的距离、最近站点用 Felzenszwalb–Huttenlocher 精确欧氏距离变换。
   上一版（等距环）的问题：环距固定为 间距 × √3/2，条带宽度不是环距的整数倍时，最后剩下的一条放不下一环；
   「中线补一排」又取整个图块最深的那一处，只剩一个点大小。环面结 7.6～8.5mm 宽的管底带因此只剩两条边缘排，
   中间空出一道 2mm 多宽的带（用户截图「边缘均匀了，内部又没支撑了」）。
   返回与输入同序的 Float64Array 数组，每个为 [x, z, 类别, ...]：0 = 边缘环，1 = 内部 / 窄条中线
================================================================ */
const COVER_IN = 0.6;                                // 内缩区覆盖半径（窄带）= 0.6 × 间距：正六角排布的覆盖半径是 间距/√3 ≈ 0.577 × 间距，各排沿排点距 ≈ 间距
const COVER_LAT = 0.72;                              // 六角格旁的过渡带放宽到 0.72 × 间距（≈ 边缘带本身的覆盖 √(边缘距离² + 半间距²)）：边缘环与六角格之间超过约 1.3 倍理想行距才补一排
const COVER_NARROW = 1.2;                            // 窄条：沿中线点距 ≈ 间距（留 20% 余量：弯曲窄带外侧边缘的点距比中线大，5% 不够，平放圆环底带实测被补密一倍）
const OPEN_FRAC = 0.3;                               // 内缩区开运算半径 = 0.3 × 间距（窄于 0.6 × 间距的细条按中线处理）
const LAMBDA_FRAC = 0.6, LAMBDA_MIN = 0.3;           // 窄条中线（λ-中轴）：λ = max(0.3 × 间距, 0.6 × 附近带宽)
const LATTICE_KEEP = 0.85;                           // 正六角格只铺在离内缩线 ≥ 0.85 × 间距的深处
const LLOYD_ITERS = 16;

/** 沿闭合轮廓放点（点距 ≈ sp）：先在每个真正的转角上放一个点（沿轮廓 2mm 内累计左转 ≥ 60°——区域的凸角；内缩后轮廓锯齿留下的
 *  小尖点被开运算磨成半径 0.3 × 间距的小圆弧，转不够这个角度，不算），转角之间按弧长均分；没有转角的一圈整圈均分；很小的一圈放在圈心。
 *  转角不放点的话，等距均分的点可能正好错开转角，尖角离最近的点超过兜底补点阈值，兜底补点就补在尖角里、贴着边（实测手办底座的梯形四角） */
function sampleRing(cs, k, sp, pts) {
  for (const poly of cs.toPolygons()) {
    const n = poly.length;
    if (n < 2) continue;
    const seg = new Float64Array(n), acc = new Float64Array(n + 1);
    let P = 0;
    for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; seg[i] = Math.hypot(b[0] - a[0], b[1] - a[1]); acc[i] = P; P += seg[i]; }
    acc[n] = P;
    if (P < sp * 0.6) {
      let cx = 0, cz = 0;
      for (const v of poly) { cx += v[0]; cz += v[1]; }
      pts.push(cx / n, cz / n, k);
      continue;
    }
    // 各顶点的左转角（区域在边的左侧：外环逆时针、洞顺时针，凸角都是左转）
    const turn = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = poly[(i + n - 1) % n], b = poly[i], c = poly[(i + 1) % n];
      turn[i] = Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]));
    }
    // 以每个顶点为中心、前后各 1mm 弧长内的累计转角；取 ≥ 60° 的局部极大当转角
    const WIN = 1, need = Math.PI / 3, sum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let t = turn[i];
      for (let j = 1, d = 0; j < n; j++) { d += seg[(i - j + n) % n]; if (d > WIN) break; t += turn[(i - j + n) % n]; }
      for (let j = 1, d = 0; j < n; j++) { d += seg[(i + j - 1) % n]; if (d > WIN) break; t += turn[(i + j) % n]; }
      sum[i] = t;
    }
    let corners = [];
    for (let i = 0; i < n; i++) {
      if (sum[i] < need) continue;
      let peak = true;
      for (let j = 1, d = 0; j < n && peak; j++) { d += seg[(i - j + n) % n]; if (d > WIN) break; if (sum[(i - j + n) % n] > sum[i]) peak = false; }
      for (let j = 1, d = 0; j < n && peak; j++) { d += seg[(i + j - 1) % n]; if (d > WIN) break; if (sum[(i + j) % n] >= sum[i]) peak = false; }
      if (peak) corners.push(acc[i]);
    }
    if (corners.length * sp * 0.5 > P) corners = [];          // 小圈里到处都是「转角」（整圈就是一个小圆）：按整圈均分
    const at = target => {                                      // 弧长 → 点（target 取模 P）
      let t = ((target % P) + P) % P, lo = 0, hi = n;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (acc[mid] <= t) lo = mid; else hi = mid; }
      const a = poly[lo], b = poly[(lo + 1) % n], u = seg[lo] > 0 ? (t - acc[lo]) / seg[lo] : 0;
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    };
    if (!corners.length) {
      // 起点固定取 x + 0.618·z 最小的顶点（同样的轮廓每次结果一致）
      let s0 = 0, best = Infinity;
      for (let i = 0; i < n; i++) { const v = poly[i][0] + 0.618 * poly[i][1]; if (v < best) { best = v; s0 = i; } }
      const m = Math.max(1, Math.round(P / sp)), step = P / m;
      for (let q = 0; q < m; q++) { const v = at(acc[s0] + q * step); pts.push(v[0], v[1], k); }
      continue;
    }
    // 转角之间按弧长均分
    for (let c = 0; c < corners.length; c++) {
      const s0 = corners[c], s1 = c + 1 < corners.length ? corners[c + 1] : corners[0] + P, L = s1 - s0;
      const m = Math.max(1, Math.round(L / sp));
      for (let q = 0; q < m; q++) { const v = at(s0 + q * L / m); pts.push(v[0], v[1], k); }
    }
  }
}

/** 多边形（Clipper 输出：互不相交，外环逆时针、洞顺时针）按格心扫描线栅格化（奇偶规则），区域内的格子置 1 */
function rasterize(polys, g, mask) {
  const { nx, nz, x0, z0, h } = g;
  const rows = Array.from({ length: nz }, () => []);
  for (const poly of polys) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      if (a[1] === b[1]) continue;
      const lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
      const r0 = Math.max(0, Math.ceil((lo - z0) / h - 0.5)), r1 = Math.min(nz - 1, Math.ceil((hi - z0) / h - 0.5) - 1);
      for (let r = r0; r <= r1; r++) {
        const zc = z0 + (r + 0.5) * h;
        rows[r].push(a[0] + (zc - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
    }
  }
  for (let r = 0; r < nz; r++) {
    const xs = rows[r];
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const c0 = Math.max(0, Math.ceil((xs[i] - x0) / h - 0.5)), c1 = Math.min(nx - 1, Math.ceil((xs[i + 1] - x0) / h - 0.5) - 1);
      for (let c = c0; c <= c1; c++) mask[r * nx + c] = 1;
    }
  }
}

/* 欧氏距离变换（Felzenszwalb & Huttenlocher 2012，可分离两趟，结果精确）：
   dt1 —— 一维平方距离变换：f 为代价（Infinity = 非站点），fi 为站点编号；输出 o（平方距离）与 oi（最近站点编号） */
function dt1(f, fi, n, o, oi, v, z) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    const fq = f[q];
    if (fq === Infinity) continue;
    if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
    let s = (fq + q * q - f[v[k]] - v[k] * v[k]) / (2 * (q - v[k]));
    while (s <= z[k]) { k--; s = (fq + q * q - f[v[k]] - v[k] * v[k]) / (2 * (q - v[k])); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  if (k < 0) { for (let q = 0; q < n; q++) { o[q] = Infinity; oi[q] = -1; } return; }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    const p = v[j];
    o[q] = (q - p) * (q - p) + f[p]; oi[q] = fi[p];
  }
}
/** 二维：site[j] = 1 的格子为站点；W.d2 = 到最近站点的格距平方，W.ft = 最近站点的格子下标（-1 = 没有站点） */
function edt2(site, nx, nz, W) {
  const { f, fi, o, oi, v, z, g, gi, d2, ft } = W;
  for (let r = 0; r < nz; r++) {
    const b = r * nx;
    for (let c = 0; c < nx; c++) { f[c] = site[b + c] ? 0 : Infinity; fi[c] = b + c; }
    dt1(f, fi, nx, o, oi, v, z);
    for (let c = 0; c < nx; c++) { g[b + c] = o[c]; gi[b + c] = oi[c]; }
  }
  for (let c = 0; c < nx; c++) {
    for (let r = 0; r < nz; r++) { f[r] = g[r * nx + c]; fi[r] = gi[r * nx + c]; }
    dt1(f, fi, nz, o, oi, v, z);
    for (let r = 0; r < nz; r++) { d2[r * nx + c] = o[r]; ft[r * nx + c] = oi[r]; }
  }
}
function edtWork(nx, nz) {
  const n = Math.max(nx, nz), N = nx * nz;
  return {
    f: new Float64Array(n), fi: new Int32Array(n), o: new Float64Array(n), oi: new Int32Array(n), v: new Int32Array(n), z: new Float64Array(n + 1),
    g: new Float64Array(N), gi: new Int32Array(N), d2: new Float64Array(N), ft: new Int32Array(N),
  };
}

/** 方窗最大值滤波（半宽 rw 格，可分离：先逐行再逐列，单调队列 O(N)）：返回每格窗内的最大值 */
function maxFilter(src, nx, nz, rw) {
  const tmp = new Float32Array(nx * nz), out = new Float32Array(nx * nz);
  const n = Math.max(nx, nz), dq = new Int32Array(n);
  const pass = (get, set, len, count) => {
    for (let line = 0; line < count; line++) {
      let h = 0, t = 0;
      for (let i = 0; i < len + rw; i++) {
        if (i < len) {
          const v = get(line, i);
          while (t > h && get(line, dq[t - 1]) <= v) t--;
          dq[t++] = i;
        }
        const c = i - rw;
        if (c < 0) continue;
        while (dq[h] < c - rw) h++;
        set(line, c, get(line, dq[h]));
      }
    }
  };
  pass((r, c) => src[r * nx + c], (r, c, v) => { tmp[r * nx + c] = v; }, nx, nz);
  pass((c, r) => tmp[r * nx + c], (c, r, v) => { out[r * nx + c] = v; }, nz, nx);
  return out;
}

/** 单个图块布点（fp：投影轮廓 CrossSection）；点追加到 pts：[x, z, 类别, ...] */
function layoutChart(K, fp, e, s, pts) {
  // 内缩区再做一次开运算（半径 0.3 × 间距）：比 0.6 × 间距还窄的细条不画边缘环——否则细条两侧各一排，两排挤在 1mm 里
  // （悬臂雕像 4mm 宽的悬臂实测如此）；这种细条和没有内缩区的窄带一样，点吸到中线上
  let E = e > 0 ? K(fp.offset(-e, 'Round', 2, 32)) : fp;
  if (!E.isEmpty()) E = K(K(E.offset(-OPEN_FRAC * s, 'Round', 2, 32)).offset(OPEN_FRAC * s, 'Round', 2, 32));
  const hasE = !E.isEmpty();
  // 1. 边缘环（固定）
  const ring = [];
  if (hasE) sampleRing(E, 0, s, ring);
  // 2. 采样格（四周各留两格在区域外）
  const bb = fp.bounds();
  const bw = bb.max[0] - bb.min[0], bh = bb.max[1] - bb.min[1];
  const h = Math.max(s / 15, Math.sqrt((bw + 1) * (bh + 1) / 250000));
  const nx = Math.ceil(bw / h) + 4, nz = Math.ceil(bh / h) + 4, N = nx * nz;
  const g = { nx, nz, x0: bb.min[0] - 2 * h, z0: bb.min[1] - 2 * h, h };
  const cx = j => g.x0 + (j % nx + 0.5) * h, cz = j => g.z0 + (((j / nx) | 0) + 0.5) * h;
  const g_x = c => g.x0 + (c + 0.5) * h, g_z = r => g.z0 + (r + 0.5) * h;
  const cellOf = (x, z) => Math.min(nz - 1, Math.max(0, Math.floor((z - g.z0) / h))) * nx + Math.min(nx - 1, Math.max(0, Math.floor((x - g.x0) / h)));
  const inF = new Uint8Array(N), inE = new Uint8Array(N);
  rasterize(fp.toPolygons(), g, inF);
  if (hasE) rasterize(E.toPolygons(), g, inE);
  let nF = 0;
  for (let j = 0; j < N; j++) { inE[j] &= inF[j]; nF += inF[j]; }
  if (!nF) {                                         // 比一个采样格还小：放在轮廓重心
    if (!ring.length) pts.push((bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, 1);
    for (let i = 0; i < ring.length; i++) pts.push(ring[i]);
    return;
  }
  const W = edtWork(nx, nz), site = new Uint8Array(N);
  // 3. 每个采样到区域边界的距离（格心到区域外最近格心的距离 − 半格）
  for (let j = 0; j < N; j++) site[j] = inF[j] ? 0 : 1;
  edt2(site, nx, nz, W);
  const dep = new Float32Array(N);
  for (let j = 0; j < N; j++) dep[j] = inF[j] ? Math.max(0, Math.sqrt(W.d2[j]) * h - h / 2) : -1;
  const ftOut = W.ft.slice();                       // 每格最近的区域外格子（≈ 最近的边界点）
  // 4. 允许放内部点的地方 Ω = 内缩区 ∪ 窄条中线。中线取 λ-中轴（Chazal & Lieutier 2005）：相邻两格各自最近的边界点相距 ≥ λ
  //    的格子。λ = 附近带宽的 0.6 倍（至少 0.3 × 间距）——轮廓上三角面锯齿长出来的细枝，两侧边界点只隔一个齿宽，剪掉；真正的
  //    中线两侧边界点隔整条带宽，留下，弯道、粗细渐变都不断（曾用「比两侧邻格深」的脊线 + 深度显著性：锯齿细枝剪不干净，
  //    阈值一收紧弯道处中线又断了）。
  //    离内缩区不到「边缘距离 + 半间距」的中线不算：内缩区角部的分叉、锯齿齿尖都在这个范围里，归边缘环管
  const omega = new Uint8Array(N);
  let dE = null;
  if (hasE) {
    for (let j = 0; j < N; j++) site[j] = inE[j];
    edt2(site, nx, nz, W);
    dE = W.d2.slice();
  }
  const reach2 = ((e + s / 2) / h) ** 2;
  const depMax = maxFilter(dep, nx, nz, Math.ceil((e + OPEN_FRAC * s) / h) + 1);
  const NB4 = [1, -1, nx, -nx];
  for (let j = 0; j < N; j++) {
    if (inE[j]) { omega[j] = 1; continue; }
    if (!inF[j] || dep[j] < h * 0.5 || (dE && dE[j] <= reach2)) continue;
    const lam2 = (Math.max(LAMBDA_MIN * s, LAMBDA_FRAC * 2 * depMax[j]) / h) ** 2;
    const fj = ftOut[j], xj = fj % nx, zj = (fj / nx) | 0;
    for (const o of NB4) {
      const k = j + o;
      if (k < 0 || k >= N || !inF[k]) continue;
      const fk = ftOut[k], xk = fk % nx, zk = (fk / nx) | 0;
      if ((xk - xj) ** 2 + (zk - zj) ** 2 >= lam2) { omega[j] = 1; break; }
    }
  }
  // 最近的 Ω 站点（插点、松弛后吸附用）
  for (let j = 0; j < N; j++) site[j] = omega[j];
  edt2(site, nx, nz, W);
  const ftO = W.ft.slice();
  // 5. 正六角格（点距 = 支撑间距，对齐世界原点）只铺在离内缩线 ≥ 0.85 × 间距的深处，固定不动：开阔处整整齐齐、点距就是
  //    设定的间距。内缩线与六角格之间的过渡带、以及窄带（内缩区不够宽，格子对不上条带走向）留给下面按覆盖补点 + 松弛
  //    最外一排（离内缩线 0.85 × 间距 ～ 再往里一个行距）不固定，和补出来的点一起松弛：边缘环顺着轮廓走、六角格对齐世界原点，
  //    两者之间的距离随处在变，固定死的话间距刚好比覆盖要求宽一点的地方会被硬塞进一排（用户截图：底座边上一溜挤着的点）
  const rowH = s * Math.sqrt(3) / 2, keep = e + LATTICE_KEEP * s;
  const lat = [], latLoose = [];
  for (let jr = Math.floor(g.z0 / rowH), j1 = Math.ceil((g.z0 + nz * h) / rowH); jr <= j1; jr++) {
    const zz = jr * rowH, off = (jr & 1) ? s / 2 : 0;
    for (let ic = Math.floor((g.x0 - off) / s), i1 = Math.ceil((g.x0 + nx * h - off) / s); ic <= i1; ic++) {
      const xx = ic * s + off, c = cellOf(xx, zz);
      if (!inE[c] || dep[c] < keep) continue;
      if (dep[c] >= keep + rowH) lat.push(xx, zz); else latLoose.push(xx, zz);
    }
  }
  // 窗口内逐格取最小距离（点附近 rad 以内）
  const stampInto = (arr, px, pz, rad) => {
    const w = Math.ceil((rad + h) / h), c0 = Math.floor((px - g.x0) / h), r0 = Math.floor((pz - g.z0) / h);
    for (let r = Math.max(0, r0 - w); r <= Math.min(nz - 1, r0 + w); r++) {
      const zz = g.z0 + (r + 0.5) * h - pz;
      for (let c = Math.max(0, c0 - w); c <= Math.min(nx - 1, c0 + w); c++) {
        const d = Math.hypot(g.x0 + (c + 0.5) * h - px, zz), j = r * nx + c;
        if (d < arr[j]) arr[j] = d;
      }
    }
  };
  const nearLat = new Float32Array(N).fill(Infinity);
  for (let i = 0; i < lat.length; i += 2) stampInto(nearLat, lat[i], lat[i + 1], 1.5 * s);
  for (let i = 0; i < latLoose.length; i += 2) stampInto(nearLat, latLoose[i], latLoose[i + 1], 1.5 * s);
  // 6. 覆盖要求：内缩区里离六角格 1.5 × 间距以内 0.72 × 间距（过渡带别补得太密），其余（窄带）0.6 × 间距（各排沿排点距 ≈ 间距）；
  //    归窄条中线管的采样按与中线的深度差放宽（沿中线点距 ≈ 间距；按中线自身深度算，不封顶到边缘距离——开运算去掉的带子
  //    中线可能比边缘距离还深，封顶会把中线两侧一溜当成内部、点被逼密）；归内缩区管的边缘带交给边缘环。
  //    窄内缩区（中线离内缩线不到 0.75 个行距，中间放一排会离两边太近）里离边缘环不到半个行距的采样由边缘环自己负责：要求放宽到
  //    「点距一半 × 离环深度」的斜边——细长内缩区两侧的边缘排从转角起步、彼此对齐时，两排之间最远处离支撑 √(1.5² + 1.3²) ≈ 1.98mm，
  //    按 1.8mm 卡会在中间再塞一排、离两边只有 1.3mm（平躺圆柱实测）。宽一些的内缩区不放宽：环面结管底带中间那排按原来的点距排
  const half = s / 2, need = [], R = new Float32Array(N), rowHalf = s * Math.sqrt(3) / 4;
  let Rmax = 0;
  for (let j = 0; j < N; j++) {
    if (!inF[j]) continue;
    const f = ftO[j];
    if (f < 0 || (!inE[j] && inE[f])) continue;
    const base = (nearLat[j] <= 1.5 * s ? COVER_LAT : COVER_IN) * s;
    R[j] = inE[j]
      ? (depMax[j] - e < 1.5 * rowHalf ? Math.max(base, Math.hypot(half, Math.min(Math.max(0, dep[j] - e), rowHalf)) * 1.02) : base)
      : Math.hypot(Math.max(0, dep[f] - dep[j]), half) * COVER_NARROW;
    if (R[j] > Rmax) Rmax = R[j];
    need.push(j);
  }
  // 到最近支撑点的距离（只更新点附近 max(Rmax, 间距) 以内的格子：更远的不影响「是否被覆盖」，窄条扫描查的是一个间距以内）
  const dist = new Float32Array(N).fill(Infinity);
  const stamp = (px, pz) => stampInto(dist, px, pz, Math.max(Rmax, s));
  // 固定点：边缘环 + 六角格；补出来的点（mov）才参与松弛
  const fix = [];
  for (let i = 0; i < ring.length; i += 3) { fix.push(ring[i], ring[i + 1]); stamp(ring[i], ring[i + 1]); }
  const nRing = fix.length / 2;
  for (let i = 0; i < lat.length; i += 2) { fix.push(lat[i], lat[i + 1]); stamp(lat[i], lat[i + 1]); }
  // 7. 按覆盖补点：贪心最大覆盖——候选位置是 Ω 站点（每 2 格取一个、只取未覆盖采样附近的），每次选能新盖住最多未覆盖采样的
  //    那个放点（增益只会变小，惰性更新：出堆时重算，仍不小于堆顶才选中），直到处处覆盖；之后松弛把点摊匀。面上的点数接近最省。
  //    曾用「哪里最空插哪里」（最远点插入）：在线上对半切空当，间距最后落在要求的 1～2 倍之间（50mm 窄条放了 23 点，应为 17 点）；
  //    贪心在线上也会因为同分时任意挑而留下短空当多放点，所以窄条另用沿线扫描（7a），这里主要补面上的
  const mov = [];
  const dead = new Uint8Array(N);
  const fill = thr => {
    const unc = new Uint8Array(N);
    let nUnc = 0;
    for (let i = 0; i < need.length; i++) {
      const j = need[i];
      if (dead[j] || dist[j] <= thr * R[j]) continue;
      // 离它最近的可放点位置（Ω 站点）都盖不住它（如窄条末端的两个角）：放弃，交给兜底补点——否则会在中线末端反复放
      // 「只多盖一点点」的点，堆成一簇
      const f = ftO[j];
      if (f < 0 || Math.hypot(cx(f) - cx(j), cz(f) - cz(j)) > thr * R[j]) { dead[j] = 1; continue; }
      unc[j] = 1; nUnc++;
    }
    if (!nUnc) return 0;
    const wr = Math.ceil(thr * Rmax / h) + 1;
    // 候选：未覆盖采样 thr·Rmax 以内的 Ω 站点（隔一格取一个）
    const near = new Uint8Array(N);
    for (let j = 0; j < N; j++) {
      if (!unc[j]) continue;
      const c0 = j % nx, r0 = (j / nx) | 0;
      for (let r = Math.max(0, r0 - wr); r <= Math.min(nz - 1, r0 + wr); r++) for (let c = Math.max(0, c0 - wr); c <= Math.min(nx - 1, c0 + wr); c++) near[r * nx + c] = 1;
    }
    const cand = [];
    for (let r = 0; r < nz; r += 2) for (let c = 0; c < nx; c += 2) { const j = r * nx + c; if (omega[j] && near[j]) cand.push(j); }
    if (!cand.length) { for (let j = 0; j < N; j++) if (unc[j]) dead[j] = 1; return 0; }
    const gainOf = q => {
      const c0 = q % nx, r0 = (q / nx) | 0, qx = cx(q), qz = cz(q);
      let g = 0;
      for (let r = Math.max(0, r0 - wr); r <= Math.min(nz - 1, r0 + wr); r++) {
        const dz = g_z(r) - qz, dz2 = dz * dz;
        for (let c = Math.max(0, c0 - wr); c <= Math.min(nx - 1, c0 + wr); c++) {
          const j = r * nx + c;
          if (!unc[j]) continue;
          const rr = thr * R[j], dx = g_x(c) - qx;
          if (dx * dx + dz2 <= rr * rr) g++;
        }
      }
      return g;
    };
    // 最大堆（键 = 增益），惰性更新
    const hk = [], hv = [];
    const up = i => { while (i > 0) { const p2 = (i - 1) >> 1; if (hk[p2] >= hk[i]) break; [hk[p2], hk[i]] = [hk[i], hk[p2]]; [hv[p2], hv[i]] = [hv[i], hv[p2]]; i = p2; } };
    const down = i => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < hk.length && hk[l] > hk[m]) m = l; if (r < hk.length && hk[r] > hk[m]) m = r; if (m === i) break; [hk[m], hk[i]] = [hk[i], hk[m]]; [hv[m], hv[i]] = [hv[i], hv[m]]; i = m; } };
    const push = (k, v) => { hk.push(k); hv.push(v); up(hk.length - 1); };
    const pop = () => { const k = hk[0], v = hv[0], lk = hk.pop(), lv = hv.pop(); if (hk.length) { hk[0] = lk; hv[0] = lv; down(0); } return [k, v]; };
    for (const q of cand) { const g = gainOf(q); if (g > 0) push(g, q); }
    let added = 0;
    while (nUnc > 0 && hk.length) {
      const [, q] = pop();
      const g = gainOf(q);
      if (g <= 0) continue;
      if (hk.length && g < hk[0]) { push(g, q); continue; }
      const qx = cx(q), qz = cz(q);
      mov.push(qx, qz); stamp(qx, qz); added++;
      const c0 = q % nx, r0 = (q / nx) | 0;
      for (let r = Math.max(0, r0 - wr); r <= Math.min(nz - 1, r0 + wr); r++) for (let c = Math.max(0, c0 - wr); c <= Math.min(nx - 1, c0 + wr); c++) {
        const j = r * nx + c;
        if (unc[j] && dist[j] <= thr * R[j]) { unc[j] = 0; nUnc--; }
      }
    }
    for (let j = 0; j < N; j++) if (unc[j]) dead[j] = 1;   // 哪个候选都盖不住（不该发生），放弃
    return added;
  };
  // 8. Lloyd 松弛：Ω 内的采样归最近的点，补出来的点挪到归它的采样的重心（落到 Ω 外就吸附回最近的 Ω 站点）；固定点不动
  const nFix = fix.length / 2;
  const owner = new Int32Array(N);
  // 每个采样归最近的点：W.ft[j] 是最近点所在格，owner[格] 是点号（0..nFix-1 固定点，其后为补出来的点）
  const assign = () => {
    site.fill(0); owner.fill(-1);
    const nMov = mov.length / 2;
    for (let p = 0; p < nFix; p++) { const c = cellOf(fix[p * 2], fix[p * 2 + 1]); if (owner[c] < 0) { owner[c] = p; site[c] = 1; } }
    for (let p = 0; p < nMov; p++) { const c = cellOf(mov[p * 2], mov[p * 2 + 1]); if (owner[c] < 0) { owner[c] = nFix + p; site[c] = 1; } }
    edt2(site, nx, nz, W);
  };
  const lloyd = iters => {
    const nMov = mov.length / 2;
    if (!nMov) return;
    const sx = new Float64Array(nMov), sz = new Float64Array(nMov), cnt = new Int32Array(nMov);
    for (let it = 0; it < iters; it++) {
      assign();
      sx.fill(0); sz.fill(0); cnt.fill(0);
      // 重心按点实际要管的采样（需求采样）算，再吸附回 Ω：窄条的中线比条带短一截（到不了末端），只按中线上的格子算的话，
      // 末端的点拉不过去，末端还得另补一个点挤在旁边
      for (let i = 0; i < need.length; i++) {
        const j = need[i], o = owner[W.ft[j]] - nFix;
        if (o < 0) continue;
        sx[o] += cx(j); sz[o] += cz(j); cnt[o]++;
      }
      let moved = 0;
      for (let p = 0; p < nMov; p++) {
        if (!cnt[p]) continue;
        let x = sx[p] / cnt[p], z = sz[p] / cnt[p];
        const c = cellOf(x, z);
        if (!omega[c]) { const f = ftO[c]; if (f >= 0) { x = cx(f); z = cz(f); } }
        moved = Math.max(moved, Math.hypot(x - mov[p * 2], z - mov[p * 2 + 1]));
        mov[p * 2] = x; mov[p * 2 + 1] = z;
      }
      if (moved < h * 0.25) break;
    }
  };
  const restamp = () => {
    dist.fill(Infinity);
    for (let i = 0; i < fix.length; i += 2) stamp(fix[i], fix[i + 1]);
    for (let i = 0; i < mov.length; i += 2) stamp(mov[i], mov[i + 1]);
  };
  // 9. 删多余的点（松弛只挪位置、不改点数）：把某个补出来的点拿掉后，它所管的每个采样都还能被别的点按要求覆盖，它就是多余的。
  //    每轮从管得最少的点删起，同一轮删掉的点之间至少隔 2 倍覆盖要求（它们的采样不会互相依赖），删完再松弛、再查覆盖
  //    （曾按「所管采样最远处 < 0.7 × 要求」判：宽窄条里靠边的采样离中线本来就远，比例总在 0.9 上下，一个都删不掉）
  const thin = () => {
    const nMov = mov.length / 2;
    if (!nMov) return 0;
    assign();
    const lists = Array.from({ length: nMov }, () => []);
    const rMaxOf = new Float32Array(nMov);
    for (let i = 0; i < need.length; i++) {
      const j = need[i], o = owner[W.ft[j]] - nFix;
      if (o < 0) continue;
      lists[o].push(j);
      if (R[j] > rMaxOf[o]) rMaxOf[o] = R[j];
    }
    // 全部点（固定 + 补出来的）按 Rmax 分桶，查「除它以外」最近的点
    const B = Math.max(Rmax, h), bk = new Map(), key = (x, z) => Math.floor(x / B) * 73856093 ^ Math.floor(z / B) * 19349663;
    const P = fix.concat(mov), nAll = P.length / 2, gone = new Uint8Array(nAll);
    for (let q = 0; q < nAll; q++) { const k = key(P[q * 2], P[q * 2 + 1]); let arr = bk.get(k); if (!arr) bk.set(k, arr = []); arr.push(q); }
    const coveredWithout = (j, skip) => {
      const x = cx(j), z = cz(j), gx = Math.floor(x / B), gz = Math.floor(z / B), r2 = R[j] * R[j];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const arr = bk.get((gx + a) * 73856093 ^ (gz + b) * 19349663);
        if (arr) for (const q of arr) if (q !== skip && !gone[q] && (P[q * 2] - x) ** 2 + (P[q * 2 + 1] - z) ** 2 <= r2) return true;
      }
      return false;
    };
    const order = [];
    for (let p = 0; p < nMov; p++) order.push(p);
    order.sort((a, b) => lists[a].length - lists[b].length);
    const picked = [];
    for (const p of order) {
      const x = mov[p * 2], z = mov[p * 2 + 1], keep = 2 * Math.max(rMaxOf[p], COVER_IN * s);
      if (picked.some(q => (mov[q * 2] - x) ** 2 + (mov[q * 2 + 1] - z) ** 2 < keep * keep)) continue;
      let red = true;
      for (const j of lists[p]) if (!coveredWithout(j, nFix + p)) { red = false; break; }
      if (!red) continue;
      picked.push(p); gone[nFix + p] = 1;
    }
    if (!picked.length) return 0;
    let w = 0;
    for (let p = 0; p < nMov; p++) if (!gone[nFix + p]) { mov[w++] = mov[p * 2]; mov[w++] = mov[p * 2 + 1]; }
    mov.length = w;
    return picked.length;
  };
  for (let i = 0; i < latLoose.length; i += 2) { mov.push(latLoose[i], latLoose[i + 1]); stamp(latLoose[i], latLoose[i + 1]); }
  // 7a. 窄条（内缩区以外的中线）：一维问题，最省的放法是从一头沿线扫过去——每条中线（8 邻接连通片）先两遍广度优先找到一端，
  //     再按广度优先的顺序（= 沿线顺序）走，离已有的点 ≥ 0.95 × 间距 就放一个；分叉各自成段，闭环两路在对面会合（点距由距离判定把关）
  {
    const seen = new Uint8Array(N), queue = new Int32Array(N);
    const NB8 = [1, -1, nx, -nx, nx + 1, nx - 1, -nx + 1, -nx - 1];
    const bfs = (start, mark) => {
      let head = 0, tail = 0;
      queue[tail++] = start; mark[start] = 1;
      while (head < tail) {
        const j = queue[head++];
        for (const o of NB8) {
          const k = j + o;
          if (k < 0 || k >= N || mark[k] || !omega[k] || inE[k]) continue;
          if (Math.abs((k % nx) - (j % nx)) > 1) continue;     // 不跨行首尾
          mark[k] = 1; queue[tail++] = k;
        }
      }
      return tail;
    };
    const tmp = new Uint8Array(N), gap = 0.95 * s;
    for (let j0 = 0; j0 < N; j0++) {
      if (!omega[j0] || inE[j0] || seen[j0]) continue;
      const n1 = bfs(j0, seen);
      const far = queue[n1 - 1];                                 // 第一遍最后出队的格 ≈ 一端
      for (let i = 0; i < n1; i++) tmp[queue[i]] = 0;
      const n2 = bfs(far, tmp);
      for (let i = 0; i < n2; i++) {
        const j = queue[i];
        if (dist[j] < gap) continue;
        const x = cx(j), z = cz(j);
        mov.push(x, z); stamp(x, z);
      }
      for (let i = 0; i < n2; i++) tmp[queue[i]] = 0;
    }
  }
  lloyd(LLOYD_ITERS);                                       // 松动的那排格点与窄条点先排开、错开，再看哪里还缺
  restamp();
  // 7b. 其余（内缩区里六角格以外的过渡带、窄带中间那排）贪心补到处处覆盖，再整体松弛；多余的点删掉后再松弛、再查
  fill(1);
  lloyd(LLOYD_ITERS);
  for (let round = 0; round < 10 && thin(); round++) {
    lloyd(LLOYD_ITERS);
    restamp();
    if (fill(1)) lloyd(6);
  }
  // 松弛后个别地方可能又露出空当：按放宽 10% 的要求再查一遍，有补点就再松弛几轮
  restamp();
  if (fill(1.1)) lloyd(6);
  // 10. 边缘带的空当：边缘带归边缘环管、不参与上面的覆盖要求；这里按兜底补点的阈值（max(0.85 × 间距, 边缘距离 + 半间距)）查一遍，
  //     离支撑还是太远的地方，在离它最近的可放位置（内缩线上或以内）补一个点——守住边缘距离。不在这里补的话，主线程的兜底补点会把点
  //     补在空当里、贴着边（实测手办底座细长梯形两头的短斜边：边缘环只在两个转角上有点，斜边中段离它们刚过 3mm）。
  //     内缩线都够不着的空当（尖角）仍交给兜底补点
  {
    restamp();
    const hole = Math.max(0.85 * s, e + 0.5 * s) * 0.98, cand = [];
    for (let j = 0; j < N; j++) {
      if (!inF[j] || dist[j] <= hole) continue;
      const f = ftO[j];
      if (f >= 0 && inE[f] && !inE[j]) cand.push(j);                // 归内缩区管的边缘带采样
    }
    cand.sort((a, b) => dist[b] - dist[a]);
    for (const j of cand) {
      if (dist[j] <= hole) continue;
      const f = ftO[j], fx = cx(f), fz = cz(f);
      if (Math.hypot(fx - cx(j), fz - cz(j)) > hole) continue;      // 最近的可放位置也盖不住：留给兜底补点
      mov.push(fx, fz); stamp(fx, fz);
    }
  }
  // 兜底：补出来的点两两不到 0.35 × 间距（松弛把几个点吸进同一小片中线时会这样）只留一个
  {
    const keep = [], lim = (0.35 * s) ** 2;
    for (let i = 0; i < mov.length; i += 2) {
      let dup = false;
      for (let k = 0; k < keep.length && !dup; k += 2) dup = (keep[k] - mov[i]) ** 2 + (keep[k + 1] - mov[i + 1]) ** 2 < lim;
      if (!dup) keep.push(mov[i], mov[i + 1]);
    }
    mov.length = 0; mov.push(...keep);
  }
  for (let i = 0; i < fix.length; i += 2) pts.push(fix[i], fix[i + 1], i / 2 < nRing ? 0 : 1);
  for (let i = 0; i < mov.length; i += 2) pts.push(mov[i], mov[i + 1], 1);
}

export function layoutPoints(MF, charts, opts) {
  const { CrossSection } = MF;
  const e = Math.max(0, opts.edgeInset || 0), s = Math.max(0.3, opts.spacing || 3);
  const out = [];
  for (const tris of charts) {
    const gc = [], pts = [];
    const K = o => { gc.push(o); return o; };
    try {
      const polys = [];
      for (let i = 0; i + 5 < tris.length; i += 6) {
        const p = [[tris[i], tris[i + 1]], [tris[i + 2], tris[i + 3]], [tris[i + 4], tris[i + 5]]];
        if (Math.abs(area2(p)) > 1e-10) polys.push(ccw(p));
      }
      if (polys.length) {
        // 投影轮廓：三角形并集，再做一次极小的闭运算收掉相邻三角形之间的数值缝
        let fp = K(new CrossSection(polys, 'Positive'));
        fp = K(K(fp.offset(0.02, 'Round', 2, 16)).offset(-0.02, 'Round', 2, 16));
        if (!fp.isEmpty()) layoutChart(K, fp, e, s, pts);
      }
    } finally {
      for (const o of gc) { try { o.delete(); } catch { /* 已释放 */ } }
    }
    out.push(Float64Array.from(pts));
  }
  return out;
}
