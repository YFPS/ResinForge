/* ================================================================
   支撑塔实体化（manifold-3d：Clipper2 二维布尔 + 凸包）
   ----------------------------------------------------------------
   旧做法：几千个六面体（杆件）+ 手算轮廓的节点板 + 分段六面体（针）各自闭合、只是「贴着」摆放，
   接缝全靠端面切法与节点板轮廓凑齐。任何一个特例没凑上就是裂缝或台阶，例如：
   - 「<」顶点：节点板被侧边切齐削平，两根斜杆的端角伸出平面，顶点成锯齿缺口；
   - 自由直针：针脚端面垂直针轴，而柱顶在节点高度水平切齐，针一斜，柱顶另一侧就露出一块平台。
   现做法（闭合与连续由库保证，不再手写拼缝）：
   1. 墙：每面墙在面内坐标 (s, y) 里把杆件条带、节点圆盘（圆形接头）、针根足迹、基础带并成一个区域
      （Clipper2 并集），再做半径 r 的闭运算（外扩 r 再内缩 r）——所有凹角自动成半径 r 的圆角，凸角不变；
      侧边切齐只作用在「柱」部分（竖杆 + 节点圆盘），斜边不受影响。整面墙是一张连续穿孔板，挤出成墙厚。
   2. 针：每片板一个凸包（Manifold.hull，自根部到过渡段末端），接触段另一个凸包、与之重叠 0.05；
      根部截面就是节点处的柱顶截面（并向柱内多包 0.05），柱顶不再外露。
   3. 视口：各实体网格直接拼接显示。两向墙在「+」柱处互相穿插、针根埋进柱里——深度测试画出来的正是并集的外表面；
      三维布尔并（实测环面结 2~4 秒）只在导出时做（union.js），视口不等它。
   约定：与墙面板轮廓面（经 Clipper 量化到 1e-8）相贴的面一律内缩 1µm（生成侧处理），
   免得两个实体「几乎共面」——布尔并在几乎共面处会切出四面体碎片（实测相邻凸包共用一圈斜截面时出过 80 个）。
   本模块与框架无关（不读 params / state），输入是 supportTower.js 给出的几何规格。
================================================================ */
import * as THREE from 'three';

/* 规格（spec）：
   t        墙厚（墙面板挤出厚度）
   rFil     凹角圆角半径（闭运算半径）
   seg      整圆分段数（节点圆盘、圆角）
   walls    [{ pl, c, col: [多边形], web: [多边形], clip: [多边形] }]
            pl 0 = z 固定墙（z = c，面内 s = x）/ 1 = x 固定墙（x = c，面内 s = z）
            col = 柱部分（竖杆 + 节点圆盘，可被侧边切齐）；web = 其余（斜边、针根足迹、基础带）；clip = 切齐条带
   slabs    [{ pl, c, half, polys }]  独立厚度的墙面板（连接底板立板，厚 2·half）
   hulls    [[[x,y,z], ...], ...]     凸包（十字针）
   cuts     [{ pl, c, half, poly }]   贯穿孔棱柱（连接底板开孔，实体化时就从立板上布尔减去）
   多边形一律为 [[s, y], ...]，方向不限（内部统一转成逆时针） */

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
 * 规格 → 实体。MF = loadManifold() 的模块（含 CrossSection / Manifold）。
 * 返回 { geometry（非索引、平直法线，供视口；userData.solids / cuts 供导出布尔并）, stats }；没有几何时返回 null
 */
export function solidifyTower(MF, spec) {
  const { CrossSection, Manifold } = MF;
  const T0 = performance.now();
  const gc = [];                                       // WASM 对象：用完统一 delete
  const K = o => { gc.push(o); return o; };
  const seg = Math.max(8, spec.seg || 16);
  const r = Math.max(0, spec.rFil || 0);
  const parts = [];                                    // [{ vert, tri }]：每个闭合实体一份
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
      // 偏置后清理（manifold 文档建议 Offset 之后接 Simplify）：共线杆边在节点高度相接处，偏置会留下面积≈0 的小三角岛，
      // 挤出后就是一个个独立的碎壳（实测 1~4 个 / 模型）。先收掉亚微米短边，再丢掉面积 < 1e-6 mm² 的岛
      cs = K(cs.simplify(SIMP));
      const comps = cs.decompose();
      if (comps.some(c => c.area() < MIN_AREA)) {
        const keep = comps.filter(c => c.area() >= MIN_AREA);
        cs = K(CrossSection.compose(keep));
      }
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
    /* ---- 3. 十字针：凸包 ---- */
    for (const pts of spec.hulls) {
      if (pts.length < 4) continue;
      const h = K(Manifold.hull(pts));
      if (h.isEmpty()) continue;
      parts.push(meshOut(h)); nHull++;
    }
    /* ---- 4. 连接底板的孔：贯穿棱柱，留给导出布尔并减去；视口里先把孔从立板上减掉（只涉及几块立板，很快） ---- */
    const cuts = [];
    for (const c of spec.cuts || []) {
      const cs = K(new CrossSection([ccw(c.poly)], 'Positive'));
      if (cs.isEmpty()) continue;
      cuts.push(meshOut(place(K, K(cs.extrude(2 * c.half, 0, 0, [1, 1], true)), c.pl, c.c)));
    }
    if (cuts.length) {
      // 立板 / 基础带是 slabs 与带孔墙段：孔只落在立板高度内，减孔只需对 slabs 部分做
      const cutM = K(Manifold.union(cuts.map(m => K(new Manifold(new MF.Mesh({ vertProperties: m.vert, triVerts: m.tri }))))));
      for (const i of slabIdx) {
        const m = K(new Manifold(new MF.Mesh({ vertProperties: parts[i].vert, triVerts: parts[i].tri })));
        parts[i] = meshOut(K(m.subtract(cutM)));
      }
    }
    if (!parts.length) return null;
    /* ---- 5. 视口几何：各实体直接拼接（非索引 + 平直法线） ---- */
    let nt = 0;
    for (const p of parts) nt += p.tri.length / 3;
    const pos = new Float32Array(nt * 9);
    let o = 0;
    for (const p of parts) {
      const { vert, tri } = p;
      for (let i = 0; i < tri.length; i++) { const s = tri[i] * 3; pos[o++] = vert[s]; pos[o++] = vert[s + 1]; pos[o++] = vert[s + 2]; }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.computeVertexNormals();
    // 导出：每份都是闭合流形，原样交给内核做三维布尔并（不拆、不焊）；孔已在视口几何里减过
    g.userData.solids = parts;
    let t0 = 0;
    g.userData.runs = parts.map(p => { const a = t0; t0 += p.tri.length / 3; return [a, t0]; });
    return {
      geometry: g,
      stats: { walls: nWall, hulls: nHull, parts: parts.length, tris: nt, ms: Math.round(performance.now() - T0) },
    };
  } finally {
    for (const o2 of gc) { try { o2.delete(); } catch { /* 已释放 */ } }
  }
}
