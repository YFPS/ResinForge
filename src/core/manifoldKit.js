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
      const wp = meshOut(place(K, K(cs.extrude(spec.t, 0, 0, [1, 1], true)), w.pl, w.c));
      wp.kind = 'wall';                      // 部件类型：墙面（格架塔）——视口「连接体」显示模式按它分流
      parts.push(wp);
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
      const sp = meshOut(place(K, K(cs.extrude(2 * s.half, 0, 0, [1, 1], true)), s.pl, s.c));
      sp.kind = 'slab';                      // 部件类型：立板（连接底板）
      parts.push(sp);
    }
    /* ---- 3. 十字针：凸包 ---- */
    for (const pts of spec.hulls) {
      if (pts.length < 4) continue;
      const h = K(Manifold.hull(pts));
      if (h.isEmpty()) continue;
      const hp = meshOut(h);
      hp.kind = 'hull';                      // 部件类型：凸包（十字针）——「连接体」显示模式的亮出部分
      parts.push(hp); nHull++;
    }
    /* ---- 3b. 格架节点件（跨墙转接块 / 柱顶针脚盖）：凸包；视口归格架组（2026-10-14：连接体视图只留针，不负节点件） ---- */
    for (const pts of spec.knuckles || []) {
      if (pts.length < 4) continue;
      const h = K(Manifold.hull(pts));
      if (h.isEmpty()) continue;
      const kp = meshOut(h);
      kp.kind = 'wall';
      parts.push(kp);
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
        const np = meshOut(K(m.subtract(cutM)));
        np.kind = 'slab';
        parts[i] = np;
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
   不同构件的接触面本来就重合，焊完会变成一坨非流形的大壳，manifold 直接拒收。没有 runs 的输入退回按连通分量切分。
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
   支撑点布点：边缘环与内部点放进同一次松弛（2026-10-17 重写）
   ----------------------------------------------------------------
   输入每个「图块」（一片支撑区域里同一 XZ 位置只有一层曲面的部分）的投影三角形 + 各顶点高度 + 贴墙的边：
   1. 区域：投影轮廓（三角形并集），减掉主线程按逐点校验判据铺的「禁放格」（贴面 / 已托住 / 贴壁根部 / 保护面附近）。
      原先布完点才逐点校验：模板边缘距离 0.5mm < 贴壁根部 0.8mm，贴墙那段边缘环整排被删，墙边一段空、兜底补点又补得乱；
      大三角形扇面盖住的已托住区域（双层平台的立柱顶）先铺满点再整片删掉。现在布点绕开这些地方，周围照样留边缘距离。
   2. 内缩区 E：区域内缩「边缘距离」再做半径 0.3 × 间距的开运算（太细的部分不画环、按窄条处理）；E 的轮廓就是边缘环所在的线。
   3. 站点四类：转角钉（E 轮廓上真正的凸角，不动）/ 环点（只能沿 E 轮廓滑动）/ 内部点（E 内自由移动）/
      窄条点（没有内缩区的条带，只能在 λ-中轴上移动）。初值：环上按弧长均分、E 里铺一层正六角格、窄条沿中线每隔约一个间距一个。
      落在本图块上的孤岛最低点也当钉（不动、不删、不输出，主线程按孤岛种子口径放它本身）：别的点绕着它排开，旁边不会挤出一对。
   4. 统一 Lloyd 松弛：采样按三维距离（XZ + 曲面高度）归最近的站点，站点挪到所管采样的重心，重心按坡面面积加权
      （一个采样代表的曲面面积 = 投影面积 / cos 坡度）；环点把重心投回轮廓、内部点吸回 E、窄条点吸回中线。
      距离和面积都在曲面上量：坡面上顺坡方向不再被拉开（旧版在 XZ 投影里排匀，45° 坡面上的实际点距是 1.41 倍）。
   5. 按管辖面积增删：内部点管的曲面面积 > 1.4 × 理想正六角面积（√3/2 × 间距²）就在它管辖区里最远的采样处加一个点，
      < 0.45 × 就删；环上相邻两点之间弧长 ≥ 1.6 × 间距、弧长中点离所有点都 ≥ 0.8 × 间距就在中点加一个环点；任意两点（三维）< 0.8 × 间距删一个
      （先删内部 / 窄条点、同类删管得少的；转角钉不删）；内缩区里离最近站点 > 0.85 × 间距、边缘带里 > max(0.85 × 间距, 边缘距离 + 半间距)、
      窄条里超过按深度放宽的覆盖半径的地方补点。每轮增删后再松弛几次，直到不再增删；最后太近的一对只在拿掉后仍处处覆盖时才拿。
   旧版的问题（2026-10-17 实测）：边缘环（固定）与对齐世界原点的六角格（固定）之间靠贪心补点硬拼，两套点的间距随处在变——
   不限最小距离时过渡带补出成坨的点（环面结细档 87 对 < 0.8 × 间距），限了 0.8 × 间距又补不进去（点数少 21%，
   环到内部第一排中位 1.1～1.2 × 间距、最差 2 ×）：只能在「坨」和「缝」之间换。现在两套点一起松弛，过渡带自己排开。
   离散化：区域上铺 h ≈ 间距/15 的采样格（到边界的距离、中轴、最近可放位置用 Felzenszwalb–Huttenlocher 精确欧氏距离变换），
   松弛与增删按 ≈ 间距/7.5 抽样。
   返回与输入同序的 Float64Array 数组，每个为 [x, z, 类别, ...]：0 = 边缘环（含转角钉），1 = 内部 / 窄条中线
================================================================ */
const OPEN_FRAC = 0.3;                               // 内缩区开运算半径 = 0.3 × 间距（窄于 0.6 × 间距的细条按中线处理）
const LAMBDA_FRAC = 0.6, LAMBDA_MIN = 0.3;           // 窄条中线（λ-中轴）：λ = max(0.3 × 间距, 0.6 × 附近带宽)
const COVER_NARROW = 1.2;                            // 窄条的覆盖半径按与中线的深度差放宽 × 1.2（弯曲窄带外侧的点距比中线大）
const DMIN_FRAC = 0.8;                               // 任意两点（三维）的最小距离 = 0.8 × 间距（正六角的间距是 1.0）
const SPLIT_AREA = 1.4, DROP_AREA = 0.45;            // 内部点管辖曲面面积 / 理想正六角面积：> 1.4 加点、< 0.45 删点（相差三倍，增删不会来回翻）
const HOLE_IN = 0.85;                                // 内缩区里离最近站点 > 0.85 × 间距就补（正六角的覆盖半径是 0.577 × 间距；补进去的点离邻点 ≥ 0.85 × 间距，不会被最小距离删掉）
const RING_GAP = 1.6;                                // 环上相邻两点之间弧长 ≥ 1.6 × 间距、弧长中点离所有点都 ≥ 最小距离，就在中点加一个环点
const LAT_INIT = 0.55;                               // 初值六角格只铺在离 E 轮廓 ≥ 0.55 × 间距的地方（再往外是环点的地盘）
const PIN = 0, RING = 1, INT = 2, MED = 3;           // 站点类别：转角钉 / 环点 / 内部点 / 窄条点

/** E 的轮廓 → 环结构与初始环点。每个闭合轮廓记顶点、各边长、累计弧长；初始点：真正的凸角钉住
 * （前后各 1mm 累计左转 ≥ 60°，且前后各 3mm 累计仍 ≥ 45°——台阶尖在 1mm 里够尖，大尺度上左转右转抵消，不再钉死；
 *  开运算磨成的小圆弧转不够 60°；带子端头这类真转角两个尺度都朝同一方向转）。转角之间按弧长均分；没有转角的整圈均分；
 *  很小的一圈只在圈心放一个钉。转角不钉的话，环点可能正好错开转角，尖角离最近的点超过兜底补点阈值，兜底补点就补在尖角里、贴着边 */
function ringSetup(cs, sp) {
  const rings = [], init = [];
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
      init.push({ x: cx / n, z: cz / n, t: PIN, r: -1, a: 0 });
      continue;
    }
    const R = { poly, seg, acc, P, n }, ri = rings.length;
    rings.push(R);
    // 各顶点的左转角（区域在边的左侧：外环逆时针、洞顺时针，凸角都是左转）
    const turn = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = poly[(i + n - 1) % n], b = poly[i], c = poly[(i + 1) % n];
      turn[i] = Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]));
    }
    // 以每个顶点为中心、前后各 1mm 弧长内的累计转角；取 ≥ 60° 的局部极大当转角。
    // 再要求前后各 3mm 累计仍 ≥ 45°：三角面台阶的尖在小尺度上够尖，大尺度上左转右转抵消，不再钉死
    const WIN = 1, WIDE = 3, need = Math.PI / 3, wideNeed = Math.PI / 4, sum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let t = turn[i];
      for (let j = 1, d = 0; j < n; j++) { d += seg[(i - j + n) % n]; if (d > WIN) break; t += turn[(i - j + n) % n]; }
      for (let j = 1, d = 0; j < n; j++) { d += seg[(i + j - 1) % n]; if (d > WIN) break; t += turn[(i + j) % n]; }
      sum[i] = t;
    }
    let corners = [];
    for (let i = 0; i < n; i++) {
      if (sum[i] < need) continue;
      let tw = turn[i];
      for (let j = 1, d = 0; j < n; j++) { d += seg[(i - j + n) % n]; if (d > WIDE) break; tw += turn[(i - j + n) % n]; }
      for (let j = 1, d = 0; j < n; j++) { d += seg[(i + j - 1) % n]; if (d > WIDE) break; tw += turn[(i + j) % n]; }
      if (tw < wideNeed) continue;
      let peak = true;
      for (let j = 1, d = 0; j < n && peak; j++) { d += seg[(i - j + n) % n]; if (d > WIN) break; if (sum[(i - j + n) % n] > sum[i]) peak = false; }
      for (let j = 1, d = 0; j < n && peak; j++) { d += seg[(i + j - 1) % n]; if (d > WIN) break; if (sum[(i + j) % n] >= sum[i]) peak = false; }
      if (peak) corners.push({ s: acc[i], w: sum[i] });
    }
    if (corners.length * sp * 0.5 > P) corners = [];          // 小圈里到处都是「转角」（整圈就是一个小圆）：按整圈均分
    // 相邻两个转角直线距离不到最小距离（轮廓锯齿在同一处折两次）：只钉较尖的那个
    if (corners.length > 1) {
      corners.sort((a, b) => b.w - a.w);
      const kept = [];
      for (const c of corners) {
        const v = ringAt(R, c.s);
        if (kept.every(k => { const q = ringAt(R, k.s); return Math.hypot(q[0] - v[0], q[1] - v[1]) >= DMIN_FRAC * sp; })) kept.push(c);
      }
      corners = kept.sort((a, b) => a.s - b.s).map(c => c.s);
    } else corners = corners.map(c => c.s);
    if (!corners.length) {
      // 起点固定取 x + 0.618·z 最小的顶点（同样的轮廓每次结果一致）
      let s0 = 0, best = Infinity;
      for (let i = 0; i < n; i++) { const v = poly[i][0] + 0.618 * poly[i][1]; if (v < best) { best = v; s0 = i; } }
      const m = Math.max(1, Math.round(P / sp));
      for (let q = 0; q < m; q++) init.push({ t: RING, r: ri, a: (acc[s0] + q * P / m) % P });
      continue;
    }
    for (let c = 0; c < corners.length; c++) {
      const s0 = corners[c], s1 = c + 1 < corners.length ? corners[c + 1] : corners[0] + P, L = s1 - s0;
      init.push({ t: PIN, r: ri, a: s0 });
      const m = Math.max(1, Math.round(L / sp));
      for (let q = 1; q < m; q++) init.push({ t: RING, r: ri, a: (s0 + q * L / m) % P });
    }
  }
  return { rings, init };
}

/** 环上弧长 a 处的点（a 取模周长） */
function ringAt(R, a) {
  const { poly, seg, acc, P, n } = R;
  const t = ((a % P) + P) % P;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (acc[mid] <= t) lo = mid; else hi = mid; }
  const p = poly[lo], q = poly[(lo + 1) % n], u = seg[lo] > 0 ? (t - acc[lo]) / seg[lo] : 0;
  return [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u];
}

/** 把 (x, z) 投到环上：只在当前位置 a0 前后各 win 弧长内找最近点（不会跳到窄颈另一侧的那段轮廓），返回弧长 */
function ringProj(R, a0, x, z, win) {
  const { poly, seg, acc, P, n } = R;
  const t0 = ((a0 % P) + P) % P;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (acc[mid] <= t0) lo = mid; else hi = mid; }
  let best = Infinity, bestA = t0;
  const test = i => {
    const p = poly[i], q = poly[(i + 1) % n], dx = q[0] - p[0], dz = q[1] - p[1], L2 = dx * dx + dz * dz;
    let u = L2 > 0 ? ((x - p[0]) * dx + (z - p[1]) * dz) / L2 : 0;
    u = Math.max(0, Math.min(1, u));
    const d = (p[0] + dx * u - x) ** 2 + (p[1] + dz * u - z) ** 2;
    if (d < best) { best = d; bestA = acc[i] + u * seg[i]; }
  };
  test(lo);
  for (let k = 1, d = t0 - acc[lo]; k < n && d < win; k++) { const i = (lo - k + n) % n; test(i); d += seg[i]; }
  for (let k = 1, d = acc[lo] + seg[lo] - t0; k < n && d < win; k++) { const i = (lo + k) % n; test(i); d += seg[i]; }
  return bestA;
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

/** 单个图块布点。fp：投影轮廓 CrossSection；e：边缘距离；s：间距；pts：输出 [x, z, 类别, ...]；
 *  surf：{ t2, ty, mask, pins }——XZ 三角形 + 各顶点高度（给采样插曲面高度与坡面面积系数；没有就按平面算）、
 *  禁放格 { x0, z0, g, nx, nz, bits }（主线程按逐点校验判据铺的，1 = 放不了）、孤岛最低点 [x, z, ...]（当钉）；
 *  ext：先布好的图块输出的点 [x, y, z, ...]（接缝那边的当钉）；placed：本图块的输出点追加到这里（给后面的图块用） */
function layoutChart(K, CS, fp, e, s, pts, surf, ext, placed) {
  // 0. 禁放格（贴面 / 已托住 / 贴壁根部 / 保护面附近）从区域里减掉：布点绕开它们，在它们周围照样留边缘距离。
  //    先做半径约一格的开运算：零星的一两个格子（判据在格子边上抖动）不算
  const mask = surf && surf.mask;
  if (mask && mask.bits) {
    const { x0, z0, g, nx: mx, nz: mz, bits } = mask, polys = [];
    for (let r = 0; r < mz; r++) {
      for (let c = 0; c < mx; c++) {
        if (!bits[r * mx + c]) continue;
        let c1 = c;
        while (c1 + 1 < mx && bits[r * mx + c1 + 1]) c1++;
        const xa = x0 + (c - 0.5) * g, xb = x0 + (c1 + 0.5) * g, za = z0 + (r - 0.5) * g, zb = z0 + (r + 0.5) * g;
        polys.push([[xa, za], [xb, za], [xb, zb], [xa, zb]]);
        c = c1;
      }
    }
    if (polys.length) {
      let bad = K(new CS(polys, 'Positive'));
      bad = K(K(bad.offset(-0.6 * g, 'Square', 2, 8)).offset(0.6 * g, 'Square', 2, 8));
      if (!bad.isEmpty()) {
        fp = K(fp.subtract(bad));
        if (fp.isEmpty()) return;
      }
    }
  }
  // 1. 内缩区 E 与环（开运算：比 0.6 × 间距还窄的细条不画环——否则细条两侧各一排挤在一起，按窄条走中线）
  let E = e > 0 ? K(fp.offset(-e, 'Round', 2, 32)) : fp;
  if (!E.isEmpty()) E = K(K(E.offset(-OPEN_FRAC * s, 'Round', 2, 32)).offset(OPEN_FRAC * s, 'Round', 2, 32));
  const hasE = !E.isEmpty();
  const { rings, init } = hasE ? ringSetup(E, s) : { rings: [], init: [] };
  const initXZ = p => (p.r >= 0 ? ringAt(rings[p.r], p.a) : [p.x, p.z]);
  // 2. 采样格（四周各留两格在区域外）
  const bb = fp.bounds();
  const bw = bb.max[0] - bb.min[0], bh = bb.max[1] - bb.min[1];
  const h = Math.max(s / 15, Math.sqrt((bw + 1) * (bh + 1) / 250000));
  const nx = Math.ceil(bw / h) + 4, nz = Math.ceil(bh / h) + 4, N = nx * nz;
  const g = { nx, nz, x0: bb.min[0] - 2 * h, z0: bb.min[1] - 2 * h, h };
  const cx = j => g.x0 + (j % nx + 0.5) * h, cz = j => g.z0 + (((j / nx) | 0) + 0.5) * h;
  const cellOf = (x, z) => Math.min(nz - 1, Math.max(0, Math.floor((z - g.z0) / h))) * nx + Math.min(nx - 1, Math.max(0, Math.floor((x - g.x0) / h)));
  const inF = new Uint8Array(N), inE = new Uint8Array(N);
  rasterize(fp.toPolygons(), g, inF);
  if (hasE) rasterize(E.toPolygons(), g, inE);
  let nF = 0;
  for (let j = 0; j < N; j++) { inE[j] &= inF[j]; nF += inF[j]; }
  if (!nF) {                                         // 比一个采样格还小：环点原样输出，没有环就放在轮廓重心
    if (!init.length) pts.push((bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, 1);
    for (const p of init) { const v = initXZ(p); pts.push(v[0], v[1], 0); }
    return;
  }
  const W = edtWork(nx, nz), site = new Uint8Array(N);
  // 3. 每格到区域边界的距离（格心到区域外最近格心的距离 − 半格）、最近的区域外格（≈ 最近的边界点）、最近的区域内格（区域外的点取高度用）
  for (let j = 0; j < N; j++) site[j] = inF[j] ? 0 : 1;
  edt2(site, nx, nz, W);
  const dep = new Float32Array(N);
  for (let j = 0; j < N; j++) dep[j] = inF[j] ? Math.max(0, Math.sqrt(W.d2[j]) * h - h / 2) : -1;
  const ftOut = W.ft.slice();
  for (let j = 0; j < N; j++) site[j] = inF[j];
  edt2(site, nx, nz, W);
  const ftIn = W.ft.slice();
  // 4. 允许放点的地方 Ω = E ∪ 窄条中线。中线取 λ-中轴（Chazal & Lieutier 2005）：相邻两格各自最近的边界点相距 ≥ λ 的格子，
  //    λ = 附近带宽的 0.6 倍（至少 0.3 × 间距）——轮廓上三角面锯齿长出来的细枝两侧边界点只隔一个齿宽，剪掉；真正的中线两侧
  //    隔整条带宽，留下，弯道、粗细渐变都不断。离 E 不到「边缘距离 + 半间距」的中线不算：E 角部的分叉、锯齿齿尖归环点管
  const omega = new Uint8Array(N);
  let dE = null, ftE = null, dIn = null;
  if (hasE) {
    for (let j = 0; j < N; j++) site[j] = inE[j];
    edt2(site, nx, nz, W);
    dE = W.d2.slice(); ftE = W.ft.slice();          // 到 E 的距离、最近的 E 格（内部点吸回 E）
    for (let j = 0; j < N; j++) site[j] = inE[j] ? 0 : 1;
    edt2(site, nx, nz, W);
    dIn = new Float32Array(N);                       // E 内到 E 轮廓的距离（初值六角格只铺在深处）
    for (let j = 0; j < N; j++) dIn[j] = inE[j] ? Math.sqrt(W.d2[j]) * h - h / 2 : -1;
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
  const med = new Uint8Array(N);                     // 窄条中线（E 以外的 Ω）
  let nMed = 0;
  for (let j = 0; j < N; j++) if (omega[j] && !inE[j]) { med[j] = 1; nMed++; }
  let ftM = null;                                    // 最近的中线格（窄条点吸回中线）
  if (nMed) { for (let j = 0; j < N; j++) site[j] = med[j]; edt2(site, nx, nz, W); ftM = W.ft.slice(); }
  for (let j = 0; j < N; j++) site[j] = omega[j];
  edt2(site, nx, nz, W);
  const ftO = W.ft.slice();                          // 最近的可放点位置（判覆盖：窄条采样离它最近的中线有多远）
  // 5. 曲面高度与坡面面积系数：格心落在哪个三角形，就取它的插值高度与「曲面面积 / 投影面积 = 1 / cos 坡度」
  const Y = new Float32Array(N), SWt = new Float32Array(N).fill(1);
  if (surf && surf.t2 && surf.ty) {
    const t2 = surf.t2, ty = surf.ty, got = new Uint8Array(N);
    for (let k = 0, m = 0; k + 5 < t2.length; k += 6, m += 3) {
      const ax = t2[k], az = t2[k + 1], bx = t2[k + 2], bz = t2[k + 3], qx = t2[k + 4], qz = t2[k + 5];
      const ya = ty[m], yb = ty[m + 1], yc = ty[m + 2];
      const d = (bx - ax) * (qz - az) - (qx - ax) * (bz - az);
      if (Math.abs(d) < 1e-12) continue;
      const ux = bx - ax, uy = yb - ya, uz = bz - az, vx = qx - ax, vy = yc - ya, vz = qz - az;
      const nX = uy * vz - uz * vy, nY = uz * vx - ux * vz, nZ = ux * vy - uy * vx, ln = Math.hypot(nX, nY, nZ);
      const st = ln > 0 ? ln / Math.max(Math.abs(nY), 0.2 * ln) : 1;
      const c0 = Math.max(0, Math.ceil((Math.min(ax, bx, qx) - g.x0) / h - 0.5)), c1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, qx) - g.x0) / h - 0.5));
      const r0 = Math.max(0, Math.ceil((Math.min(az, bz, qz) - g.z0) / h - 0.5)), r1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, qz) - g.z0) / h - 0.5));
      for (let r = r0; r <= r1; r++) {
        const pz = g.z0 + (r + 0.5) * h;
        for (let c = c0; c <= c1; c++) {
          const px = g.x0 + (c + 0.5) * h;
          const w1 = ((px - ax) * (qz - az) - (qx - ax) * (pz - az)) / d, w2 = ((bx - ax) * (pz - az) - (px - ax) * (bz - az)) / d, w0 = 1 - w1 - w2;
          if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
          const j = r * nx + c;
          Y[j] = w0 * ya + w1 * yb + w2 * yc; SWt[j] = st; got[j] = 1;
        }
      }
    }
    let miss = false;
    for (let j = 0; j < N && !miss; j++) if (inF[j] && !got[j]) miss = true;
    if (miss) {                                      // 三角形之间的数值缝、闭运算补出来的边：取最近一个扫到的格子
      edt2(got, nx, nz, W);
      for (let j = 0; j < N; j++) if (inF[j] && !got[j] && W.ft[j] >= 0) { Y[j] = Y[W.ft[j]]; SWt[j] = SWt[W.ft[j]]; }
    }
  }
  const yAt = (x, z) => { const c = cellOf(x, z); return inF[c] ? Y[c] : (ftIn[c] >= 0 ? Y[ftIn[c]] : 0); };
  // 6. 松弛与增删用的抽样（≈ 间距/7.5 一个）：坐标、曲面高度、代表的曲面面积、覆盖要求。类别：
  //    0 = E 内（离最近站点 > 0.85 × 间距就补内部点）/ 1 = 归 E 管的边缘带（> max(0.85 × 间距, 边缘距离 + 半间距) 才补，补在环上，守住边缘距离）/
  //    2 = 窄条（按与中线的深度差放宽：沿中线点距 ≈ 间距；补在中线上）/ 3 = 不要求覆盖（离它最近的可放位置都盖不住：窄条末端两角，交给兜底补点）
  const ST = Math.max(1, Math.round(s / 7.5 / h)), hs = ST * h;
  const sj = [];
  for (let r = ST >> 1; r < nz; r += ST) for (let c = ST >> 1; c < nx; c += ST) { const j = r * nx + c; if (inF[j]) sj.push(j); }
  const nS = sj.length;
  const SX = new Float64Array(nS), SZ = new Float64Array(nS), SY = new Float64Array(nS), SA = new Float64Array(nS);
  const KIND = new Uint8Array(nS), THR = new Float64Array(nS);
  const holeEdge = Math.max(HOLE_IN * s, e + 0.5 * s) * 0.98;
  for (let i = 0; i < nS; i++) {
    const j = sj[i];
    SX[i] = cx(j); SZ[i] = cz(j); SY[i] = Y[j]; SA[i] = SWt[j] * hs * hs;
    if (inE[j]) { KIND[i] = 0; THR[i] = HOLE_IN * s; continue; }
    const f = ftO[j];
    if (f >= 0 && inE[f]) { KIND[i] = 1; THR[i] = holeEdge; continue; }
    if (f >= 0) {
      KIND[i] = 2; THR[i] = Math.hypot(Math.max(0, dep[f] - dep[j]), s / 2) * COVER_NARROW;
      if (Math.hypot(cx(f) - SX[i], cz(f) - SZ[i]) <= THR[i]) continue;
    }
    KIND[i] = 3; THR[i] = Infinity;
  }
  // 7. 初始站点：环点 / 转角钉、E 里一层正六角格（对齐世界原点，点距 = 间距；跟着一起松弛，不固定）、窄条沿中线扫一遍
  const S = [];
  const addSite = (x, z, t, r = -1, a = 0) => S.push({ x, z, y: yAt(x, z), t, r, a });
  for (const p of init) { const v = initXZ(p); addSite(v[0], v[1], p.t, p.r, p.a); }
  // 孤岛最低点：当转角钉用（不动、不删），布点绕着它排；不输出（主线程按孤岛种子口径自己放）
  const pins = surf && surf.pins;
  if (pins) for (let i = 0; i + 1 < pins.length; i += 2) { addSite(pins[i], pins[i + 1], PIN); S[S.length - 1].seed = true; }
  // 先布好的图块在接缝那边的点：离本图块不到一个间距、高度接得上（同一片曲面在接缝处连续；上下叠着的另一层不算）的，也当钉。
  // 各图块各自布点时，接缝两侧各放一排、挨在一起，主线程按 0.8 × 间距去重后，后放的那块少一个点、留下空当（实测手办左手）
  if (ext && ext.length) {
    const xLo = g.x0 - s, xHi = g.x0 + nx * h + s, zLo = g.z0 - s, zHi = g.z0 + nz * h + s;
    for (let i = 0; i + 2 < ext.length; i += 3) {
      const x = ext[i], y = ext[i + 1], z = ext[i + 2];
      if (x < xLo || x > xHi || z < zLo || z > zHi) continue;
      const f = ftIn[cellOf(x, z)];
      if (f < 0) continue;
      const dxz = Math.hypot(x - cx(f), z - cz(f));
      if (dxz > s || Math.abs(y - Y[f]) > Math.max(0.5, dxz)) continue;
      S.push({ x, z, y, t: PIN, r: -1, a: 0, seed: true });
    }
  }
  if (hasE) {
    const rowH = s * Math.sqrt(3) / 2;
    for (let jr = Math.floor(g.z0 / rowH), j1 = Math.ceil((g.z0 + nz * h) / rowH); jr <= j1; jr++) {
      const zz = jr * rowH, off = (jr & 1) ? s / 2 : 0;
      for (let ic = Math.floor((g.x0 - off) / s), i1 = Math.ceil((g.x0 + nx * h - off) / s); ic <= i1; ic++) {
        const xx = ic * s + off, c = cellOf(xx, zz);
        if (inE[c] && dIn[c] >= LAT_INIT * s) addSite(xx, zz, INT);
      }
    }
  }
  if (nMed) {
    // 窄条是一维问题：每条中线（8 邻接连通片）先两遍广度优先找到一端，再按广度优先的顺序（= 沿线顺序）走，离已有点 ≥ 0.95 × 间距就放一个
    const dist = new Float32Array(N).fill(Infinity);
    const stamp = (px, pz) => {
      const w = Math.ceil((s + h) / h), c0 = Math.floor((px - g.x0) / h), r0 = Math.floor((pz - g.z0) / h);
      for (let r = Math.max(0, r0 - w); r <= Math.min(nz - 1, r0 + w); r++) {
        const zz = g.z0 + (r + 0.5) * h - pz;
        for (let c = Math.max(0, c0 - w); c <= Math.min(nx - 1, c0 + w); c++) {
          const d = Math.hypot(g.x0 + (c + 0.5) * h - px, zz), j = r * nx + c;
          if (d < dist[j]) dist[j] = d;
        }
      }
    };
    for (const q of S) stamp(q.x, q.z);
    const seen = new Uint8Array(N), tmp = new Uint8Array(N), queue = new Int32Array(N);
    const NB8 = [1, -1, nx, -nx, nx + 1, nx - 1, -nx + 1, -nx - 1];
    const bfs = (start, mark) => {
      let head = 0, tail = 0;
      queue[tail++] = start; mark[start] = 1;
      while (head < tail) {
        const j = queue[head++];
        for (const o of NB8) {
          const k = j + o;
          if (k < 0 || k >= N || mark[k] || !med[k]) continue;
          if (Math.abs((k % nx) - (j % nx)) > 1) continue;     // 不跨行首尾
          mark[k] = 1; queue[tail++] = k;
        }
      }
      return tail;
    };
    for (let j0 = 0; j0 < N; j0++) {
      if (!med[j0] || seen[j0]) continue;
      const far = queue[bfs(j0, seen) - 1];                    // 第一遍最后出队的格 ≈ 一端
      const n2 = bfs(far, tmp);
      for (let i = 0; i < n2; i++) {
        const j = queue[i];
        if (dist[j] < 0.95 * s) continue;
        addSite(cx(j), cz(j), MED); stamp(cx(j), cz(j));
      }
      for (let i = 0; i < n2; i++) tmp[queue[i]] = 0;
    }
  }
  // 8. 站点分桶（桶宽 ≥ 间距）：最近站点按三维距离找
  const B = Math.max(s, 4 * h);
  const nbx = Math.max(1, Math.ceil(nx * h / B)), nbz = Math.max(1, Math.ceil(nz * h / B));
  const head = new Int32Array(nbx * nbz);
  let nxt = new Int32Array(Math.max(64, S.length * 2));
  const bxOf = x => Math.min(nbx - 1, Math.max(0, Math.floor((x - g.x0) / B)));
  const bzOf = z => Math.min(nbz - 1, Math.max(0, Math.floor((z - g.z0) / B)));
  const buildBuckets = () => {
    head.fill(-1);
    if (nxt.length < S.length) nxt = new Int32Array(S.length * 2);
    for (let k = 0; k < S.length; k++) { const b = bzOf(S[k].z) * nbx + bxOf(S[k].x); nxt[k] = head[b]; head[b] = k; }
  };
  let nk = -1, nd2 = Infinity;                       // nearest 的结果：站点号与三维距离平方
  const nearest = (x, z, y, skip, gone) => {
    const bx = bxOf(x), bz = bzOf(z);
    nk = -1; nd2 = Infinity;
    for (let rr = 0; ; rr++) {
      for (let b = bz - rr; b <= bz + rr; b++) {
        if (b < 0 || b >= nbz) continue;
        const full = rr === 0 || b === bz - rr || b === bz + rr;
        for (let a = bx - rr; a <= bx + rr; a += full ? 1 : 2 * rr) {
          if (a < 0 || a >= nbx) continue;
          for (let k = head[b * nbx + a]; k >= 0; k = nxt[k]) {
            if (k === skip || (gone && gone[k])) continue;
            const q = S[k], d = (q.x - x) ** 2 + (q.z - z) ** 2 + (q.y - y) ** 2;
            if (d < nd2) { nd2 = d; nk = k; }
          }
        }
      }
      // 第 rr 圈以外的站点 XZ 距离都超过 rr × 桶宽，三维距离只会更大
      if (nd2 <= (rr * B) ** 2 || (bx - rr <= 0 && bz - rr <= 0 && bx + rr >= nbx - 1 && bz + rr >= nbz - 1)) return;
    }
  };
  const own = new Int32Array(nS), dmin = new Float64Array(nS);
  const assign = () => {
    buildBuckets();
    for (let i = 0; i < nS; i++) { nearest(SX[i], SZ[i], SY[i], -1, null); own[i] = nk; dmin[i] = Math.sqrt(nd2); }
  };
  // 9. Lloyd：站点挪到所管采样的重心（按曲面面积加权）；环点投回轮廓（只在前后 0.6 × 间距弧长内找）、内部点吸回 E、窄条点吸回中线，转角钉不动
  const lloyd = iters => {
    for (let it = 0; it < iters; it++) {
      assign();
      const n = S.length, ax = new Float64Array(n), az = new Float64Array(n), aw = new Float64Array(n);
      for (let i = 0; i < nS; i++) { const k = own[i]; if (k < 0) continue; const w = SA[i]; ax[k] += SX[i] * w; az[k] += SZ[i] * w; aw[k] += w; }
      let moved = 0;
      for (let k = 0; k < n; k++) {
        const q = S[k];
        if (q.t === PIN || !aw[k]) continue;
        let x = ax[k] / aw[k], z = az[k] / aw[k];
        if (q.t === RING) {
          const R = rings[q.r];
          q.a = ringProj(R, q.a, x, z, 0.6 * s);
          [x, z] = ringAt(R, q.a);
        } else {
          const c = cellOf(x, z), inside = q.t === INT ? inE[c] : med[c], ft = q.t === INT ? ftE : ftM;
          if (!inside && ft[c] >= 0) { x = cx(ft[c]); z = cz(ft[c]); }
        }
        const dm = Math.hypot(x - q.x, z - q.z);
        if (dm > moved) moved = dm;
        q.x = x; q.z = z; q.y = yAt(x, z);
      }
      if (moved < h * 0.25) break;
    }
  };
  // 10. 按管辖面积增删（见文件头第 5 条）
  const A0 = Math.sqrt(3) / 2 * s * s, dMin2 = (DMIN_FRAC * s) ** 2, s2 = s * s;
  // 删点的先后：内部 / 窄条点（1）→ 环点（2）→ 转角钉（3）；孤岛最低点与接缝钉（4）不删
  const rankOf = q => (q.seed ? 4 : q.t === PIN ? 3 : q.t === RING ? 2 : 1);
  const nearestRing = (x, z) => {
    let best = Infinity, out = null;
    for (let ri = 0; ri < rings.length; ri++) {
      const R = rings[ri];
      for (let i = 0; i < R.n; i++) {
        const p = R.poly[i], q = R.poly[(i + 1) % R.n], dx = q[0] - p[0], dz = q[1] - p[1], L2 = dx * dx + dz * dz;
        let u = L2 > 0 ? ((x - p[0]) * dx + (z - p[1]) * dz) / L2 : 0;
        u = Math.max(0, Math.min(1, u));
        const d = (p[0] + dx * u - x) ** 2 + (p[1] + dz * u - z) ** 2;
        if (d < best) { best = d; out = { r: ri, a: R.acc[i] + u * R.seg[i] }; }
      }
    }
    return out;
  };
  const adapt = () => {
    assign();
    const n = S.length, area = new Float64Array(n), farI = new Int32Array(n).fill(-1), farD = new Float64Array(n);
    for (let i = 0; i < nS; i++) {
      const k = own[i];
      if (k < 0) continue;
      area[k] += SA[i];
      if (KIND[i] === 0 && dmin[i] > farD[k]) { farD[k] = dmin[i]; farI[k] = i; }
    }
    const gone = new Uint8Array(n);
    let changes = 0;
    // ① 太近的两点删一个：按 rankOf 先删等级低的（孤岛最低点、接缝钉不删），同级删管得少的——两个轮廓的转角钉挨着时也只留一个
    for (let k = 0; k < n; k++) {
      if (gone[k]) continue;
      const q = S[k], bx = bxOf(q.x), bz = bzOf(q.z);
      for (let b = Math.max(0, bz - 1); b <= Math.min(nbz - 1, bz + 1) && !gone[k]; b++) {
        for (let a = Math.max(0, bx - 1); a <= Math.min(nbx - 1, bx + 1) && !gone[k]; a++) {
          for (let m = head[b * nbx + a]; m >= 0 && !gone[k]; m = nxt[m]) {
            if (m <= k || gone[m]) continue;
            const o = S[m];
            if ((o.x - q.x) ** 2 + (o.z - q.z) ** 2 + (o.y - q.y) ** 2 >= dMin2) continue;
            const rk = rankOf(q), rm = rankOf(o);
            if (rk === 4 && rm === 4) continue;
            gone[rk !== rm ? (rk < rm ? k : m) : (area[k] <= area[m] ? k : m)] = 1;
            changes++;
          }
        }
      }
    }
    // ② 管得太少的内部点删掉
    for (let k = 0; k < n; k++) if (!gone[k] && S[k].t === INT && area[k] < DROP_AREA * A0) { gone[k] = 1; changes++; }
    // ③ 加点。新点之间至少隔一个间距（同一片空当一轮只补一个，补完松弛再看），离已有的点至少隔最小距离
    const adds = [];
    const nearAdd = (x, z, y, r2) => adds.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 + (p.y - y) ** 2 < r2);
    const roomy = (x, z, y) => { nearest(x, z, y, -1, gone); return nd2 >= dMin2 && !nearAdd(x, z, y, dMin2); };
    // 环上的空当：每圈按弧长排序，相邻两点之间弧长中点离两边都超过最小距离就加一个环点
    const byRing = rings.map(() => []);
    for (let k = 0; k < n; k++) if (!gone[k] && S[k].r >= 0) byRing[S[k].r].push(S[k]);
    for (let ri = 0; ri < rings.length; ri++) {
      const arr = byRing[ri], R = rings[ri];
      if (!arr.length) continue;
      arr.sort((p, q) => p.a - q.a);
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i], q = arr[(i + 1) % arr.length];
        let L = q.a - p.a;
        if (L <= 1e-9) L += R.P;
        if (L < RING_GAP * s) continue;
        const a = (p.a + L / 2) % R.P, [x, z] = ringAt(R, a), y = yAt(x, z);
        if (!roomy(x, z, y)) continue;
        adds.push({ x, z, y, t: RING, r: ri, a });
      }
    }
    // 内部点管得太多：在它管辖区里离它最远的内缩区采样处加一个
    for (let k = 0; k < n; k++) {
      if (gone[k] || S[k].t !== INT || area[k] <= SPLIT_AREA * A0 || farI[k] < 0 || farD[k] < 0.6 * s) continue;
      const i = farI[k];
      if (nearAdd(SX[i], SZ[i], SY[i], s2)) continue;
      nearest(SX[i], SZ[i], SY[i], -1, gone);
      if (nd2 < (0.6 * s) ** 2) continue;
      adds.push({ x: SX[i], z: SZ[i], y: SY[i], t: INT, r: -1, a: 0 });
    }
    // 覆盖不到的空当：按离最近站点的距离从大到小，超过各自的覆盖半径就补（内缩区 → 原地加内部点；边缘带 → 环上最近处；窄条 → 中线上最近处）
    const holes = [];
    for (let i = 0; i < nS; i++) if (KIND[i] < 3 && dmin[i] > THR[i]) holes.push(i);
    holes.sort((p, q) => dmin[q] - dmin[p]);
    for (const i of holes) {
      if (nearAdd(SX[i], SZ[i], SY[i], s2)) continue;
      let x = SX[i], z = SZ[i], t = INT, r = -1, a = 0;
      if (KIND[i] === 1) {
        const nr = nearestRing(x, z);
        if (!nr) continue;
        t = RING; r = nr.r; a = nr.a;
        [x, z] = ringAt(rings[r], a);
      } else if (KIND[i] === 2) {
        const f = ftO[sj[i]];
        x = cx(f); z = cz(f); t = MED;
      }
      const y = yAt(x, z);
      if (Math.hypot(x - SX[i], z - SZ[i], y - SY[i]) > THR[i] || !roomy(x, z, y)) continue;
      adds.push({ x, z, y, t, r, a });
    }
    if (!changes && !adds.length) return 0;
    const keep = S.filter((_, k) => !gone[k]);
    S.length = 0;
    for (const q of keep) S.push(q);
    for (const q of adds) S.push(q);
    return changes + adds.length;
  };
  // 11. 收尾：太近的一对（三维 < 0.8 × 间距）里拿掉一个——只在拿掉后它管的采样仍都有别的点按覆盖半径盖着时才拿
  //     （覆盖优先于均匀：窄尖、末端这类地方两点挨得近是为了盖住尖角）
  const finalCull = () => {
    assign();
    const n = S.length, lists = Array.from({ length: n }, () => []);
    for (let i = 0; i < nS; i++) if (own[i] >= 0) lists[own[i]].push(i);
    const gone = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      if (gone[k]) continue;
      const q = S[k], bx = bxOf(q.x), bz = bzOf(q.z);
      for (let b = Math.max(0, bz - 1); b <= Math.min(nbz - 1, bz + 1) && !gone[k]; b++) {
        for (let a = Math.max(0, bx - 1); a <= Math.min(nbx - 1, bx + 1) && !gone[k]; a++) {
          for (let m = head[b * nbx + a]; m >= 0 && !gone[k]; m = nxt[m]) {
            if (m <= k || gone[m]) continue;
            const o = S[m];
            if ((o.x - q.x) ** 2 + (o.z - q.z) ** 2 + (o.y - q.y) ** 2 >= dMin2) continue;
            const cands = [k, m].filter(c => !S[c].seed).sort((u, v) => rankOf(S[u]) - rankOf(S[v]) || lists[u].length - lists[v].length);
            for (const c of cands) {
              let ok = true;
              for (const i of lists[c]) {
                if (KIND[i] === 3) continue;
                nearest(SX[i], SZ[i], SY[i], c, gone);
                if (nk < 0 || nd2 > THR[i] * THR[i]) { ok = false; break; }
              }
              if (!ok) continue;
              gone[c] = 1;
              for (const i of lists[c]) { nearest(SX[i], SZ[i], SY[i], c, gone); if (nk >= 0) lists[nk].push(i); }
              lists[c] = [];
              break;
            }
          }
        }
      }
    }
    const keep = S.filter((_, k) => !gone[k]);
    S.length = 0;
    for (const q of keep) S.push(q);
  };
  // 12. 松弛 → 增删 → 再松弛……直到不再增删；最后再查一遍空当与太近的一对
  lloyd(10);
  for (let round = 0; round < 16; round++) {
    if (!adapt()) break;
    lloyd(6);
  }
  if (adapt()) lloyd(4);
  finalCull();
  for (const q of S) {
    if (q.seed) continue;
    pts.push(q.x, q.z, q.t === PIN || q.t === RING ? 0 : 1);
    if (placed) placed.push(q.x, q.y, q.z);          // 给后面的图块当接缝钉
  }
}

export function layoutPoints(MF, charts, opts) {
  const { CrossSection } = MF;
  const e = Math.max(0, opts.edgeInset || 0), s = Math.max(0.3, opts.spacing || 3);
  const out = [], placed = [];                       // placed：已布好的点 [x, y, z, ...]，后面的图块拿来当接缝钉
  for (const ch of charts) {
    // 图块可以只给投影三角形（Float64Array，按平面算），也可以是 { t2, ty, mask, pins }（带曲面高度、禁放格与孤岛最低点）
    const tris = ch && ch.t2 ? ch.t2 : ch, surf = ch && ch.t2 ? ch : null;
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
        if (!fp.isEmpty()) layoutChart(K, CrossSection, fp, e, s, pts, surf, placed, placed);
      }
    } finally {
      for (const o of gc) { try { o.delete(); } catch { /* 已释放 */ } }
    }
    out.push(Float64Array.from(pts));
  }
  return out;
}

/* ---------- 自动底板（按支撑投影，spec 由 basePlate.js 生成） ---------- */
/** 凸多边形等距内缩（世界 XZ）：每边沿内向法线平移 w、相邻边求交；法线用「朝形心」自校正，不依赖绕向 */
function insetPolygon(poly, w) {
  const n = poly.length;
  let cx = 0, cz = 0;
  for (const [x, z] of poly) { cx += x; cz += z; }
  cx /= n; cz /= n;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    let nx = -dz, nz = dx;
    if ((a[0] + nx - cx) ** 2 + (a[1] + nz - cz) ** 2 > (a[0] - cx) ** 2 + (a[1] - cz) ** 2) { nx = -nx; nz = -nz; }
    lines.push([a[0] + nx * w, a[1] + nz * w, dx, dz]);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const [p1x, p1z, d1x, d1z] = lines[(i - 1 + n) % n], [p2x, p2z, d2x, d2z] = lines[i];
    const den = d1x * d2z - d1z * d2x;
    if (Math.abs(den) < 1e-9) { out.push([p2x, p2z]); continue; }
    const t = ((p2x - p1x) * d2z - (p2z - p1z) * d2x) / den;
    out.push([p1x + d1x * t, p1z + d1z * t]);
  }
  return out;
}

/**
 * 自动底板实体：顶轮廓（支撑投影轮廓，主线程算好）打出蜂窝孔 → 挤出板厚 → 与「栅角棱台」求交
 * （底面等距内缩 spec.chamferW，侧壁成斜面）。spec.outline / spec.holes 是相对底板中心的 XZ 点列，
 * spec.cx / cz 平移到位。返回 { vert: Float32Array, tri: Uint32Array }（世界系，y∈[0, t]）或 null。
 * 坐标约定：CrossSection 面内取 (x, −z)——挤出沿面内 +z、绕 X −90° 后 (x, y, w) → (x, w, −y)，(−z) 恰好还原 z。
 */
export function buildAutoPlate(MF, spec) {
  const { CrossSection, Manifold } = MF;
  const gc = [];
  const K = o => { gc.push(o); return o; };
  try {
    const toIn = p => p.map(([x, z]) => [x, -z]);
    let cs = K(new CrossSection([ccw(toIn(spec.outline))], 'Positive'));
    const holes = (spec.holes || []).filter(h => h.length >= 3).map(h => ccw(toIn(h)));
    if (holes.length) cs = K(cs.subtract(K(new CrossSection(holes, 'Positive'))));
    cs = K(cs.simplify(SIMP));
    if (cs.isEmpty()) return null;
    let board = K(K(cs.extrude(spec.t, 0, 0, [1, 1], false)).rotate([-90, 0, 0]));   // center: false——板从 y=0 挤到 y=t（墙用 true 居中）
    if (spec.chamferW > 1e-3) {
      // 栅角棱台：顶轮廓（y = t）与底内缩轮廓（y = 0）的凸包（凸轮廓 + 等距内缩，凸包即棱台；hull 输入为平铺点数组）
      // 内缩量的钳制（不超轮廓内切半径）已在主线程 basePlate.js 做
      const botPts = insetPolygon(spec.outline, spec.chamferW);
      const pts = [];
      for (const [x, z] of spec.outline) pts.push([x, spec.t, z]);
      for (const [x, z] of botPts) pts.push([x, 0, z]);
      const podium = K(Manifold.hull(pts));
      if (podium.isEmpty()) return null;
      board = K(board.intersect(podium));
      if (board.isEmpty()) return null;
    }
    board = K(board.translate([spec.cx, 0, spec.cz]));
    if (board.isEmpty()) return null;
    const m = meshOut(board);
    return m.tri.length ? m : null;
  } catch (e) {
    if (typeof window !== 'undefined') window.__apErr = String((e && e.stack) || e);
    return null;
  } finally {
    for (const o of gc) { try { o.delete(); } catch { /* 已释放 */ } }
  }
}
