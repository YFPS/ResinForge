/* ================================================================
   画线切割 · 沿画线切：切面 = 穿过画线的窄带 + 画线往里收一圈后张开的膜
   ----------------------------------------------------------------
   纯计算（manifold-3d），主线程、Web Worker、Node 通用。入参与返回值同 cutCurve.js 的 cutCurved：
   局部系 (u, v, w) 里切（w = 拟合平面法线方向），+w 一侧是上件。
   为什么这样做：画线是用户点在模型表面上的一圈点，切口必须正好落在这圈点上，切面又必须整片在材料里面。
   · 旧做法（拓扑切）把接缝吸附到网格顶点再沿面平滑，接缝离画线最多 1.7 mm；封盖用画线投影直接三角化，
     是一把从一个顶点放射出去的细长扇形，有折痕，还会伸出模型外面（实测伸出 4～85 mm²，就是飞边）。
   · 膜片棱柱 / 高度场：切刀有竖墙或整张面，会在悬檐下、画线圈外顺带切到别处。
   做法：
   1. 画线加密到 ≤ DS（插入点吸回最近表面；弦明显离开表面时改走表面路径，路径沿面平滑后按 DS 重采样），去掉投影上几乎原路折回的尖刺点；
      每点取附近表面的法线 N（半径 RN 内面积加权，沿线平滑，再拧回到与该处外法线夹角不超过 ~72°）。
   2. 窄带：每点 L 沿 −N 进材料 b 到 L′、沿 +N 出表面 FLANGE 到 F，相邻两点连成四边形。窄带在 L 处与表面垂直相交，
      切缝就是画线本身。表面越正对切面法线（掠射：沟底、台阶面），b 越深（B_MIN → B_MAX），膜不会贴着表面削出一层。
      凹拐角处 b 超过局部弯曲半径，L′ 会自己穿过自己：把那一段投到 (u, v) 上局部平滑、抹直小结，进材料方向跟着略微偏开，
      深度 b 不缩——旧办法把深度乘 0.5，连乘几轮压到 0.01～0.04 mm，窄带薄得切不动、切刀在那里漏缝。
      窄带逐点逐边校验（伪法线判内外）：辐条要从材料里穿到外面、F 边在外、L′ 边在里；过不了的点改用外法线或去掉，
      过不了的边在中间沿表面补点（棱、沟、细凸起处画线跟着表面走），最多 5 轮。
   3. 膜：L′ 投到 (u, v) 的多边形做约束 Delaunay 细分（中点加点 + 翻边），内部点高度取调和插值（光滑、不越过 L′ 的高度范围）。
   4. 切刀 K = 「窄带 + 膜」沿 + 侧加厚 EPS 的闭合薄片（每个顶点的加厚方向与周围各面法线的点积都为正，薄片处处厚度为正），
      每个三角形用 faceID 记来源：膜 / 窄带内段是真切口，窄带外段（伸进空气的那截）与侧壁是假切口。
      Mp.split(K) 得到薄片里的一层（Lin）和其余部分（Mout）。切不开、而切面在某几个画线点处折过来了（加厚方向怎么拧都朝某张面的背面），
      就去掉 / 加密那几个点再整套重来（最多 2 次）。
   5. 分件：Mout 各块看挨着的真切口在哪一面分上下；薄片层与被假切口切开的块按「同一位置的顶点」认邻居粘回去
      （split 两份输出在切面上的顶点逐位相同），零碎的薄块（飞边）也粘回挨着的一侧；体积 ≈ 0 的小四面体（布尔在几乎共面处
      切出来的）丢掉。最后同一侧里相挨的块布尔并、互不相挨的直接拼成一件。
   6. 梯形销沿用 cutPin.js：切刀 C = 膜沿 +w 挤出的棱柱，切面高度 = 膜高。
================================================================ */
import { fail, principalAngle, ringsOf, outerOf, MIN_PIECE, pickStar } from './cutGeom.js';
import { placePinCurved } from './cutPin.js';
import { buildBVH, raycast } from './collide.js';

const DS = 0.3;             // 画线加密间距（mm）
const RN = 0.4;             // 估表面法线的半径（mm）
const SMOOTH_N = 0.6;       // 法线沿画线平滑的弧长尺度（mm）
const B_MIN = 0.08;         // 窄带进材料的最小深度（表面与切面法线垂直时，mm）
const B_MAX = 0.6;          // 最大深度（表面正对切面法线：沟底、台阶面，mm）
const FLANGE = 0.3;         // 窄带伸出表面的长度（mm）
const EPS = 0.02;           // 切刀薄片厚度（mm）
const CATS = 8;             // faceID = 三角形序号 × CATS + 类别
const MEM = 0, IN = 1, OUT = 2, MEM_T = 3, IN_T = 4, OUT_T = 5, RIM = 6;
const DEBRIS_FRAC = 0.03;   // 比主体小这么多（体积比）的零碎块粘回去
const DEBRIS_THICK = 0.3;   // 平均厚度（2 × 体积 / 面积）薄于这么多的零碎块粘回去（飞边）
const MAX_MEM_VERTS = 30000;
const SPIKE = Math.cos(Math.PI / 6);   // 某点前后两段在 (u, v) 上夹角小于 30°（几乎原路折回）就算尖刺
const OUT_MIN = 0.3;        // 窄带方向与画线处外法线的夹角余弦下限（≈ 72°）
const BLUNT = 0.01;         // 切缝原路折回（尖刺的尖）处拉开的半宽（mm）：窄带外段在这里转一个窄 U 形弯而不是对折，加厚方向才有解
const FLOAT_TOL = 0.1;      // 切缝点离表面超过这么多（mm）算悬空：不按它切
const WHISK = 0.05;         // 切缝上宽不到这么多的毛刺（画线去了又原路回来）按零宽度剥掉（mm，约一个打印像素）；补不出底板时依次放宽到 2 倍、4 倍

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist3 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const norm3 = a => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };

/* ---------- 表面查询（局部系） ---------- */

/** 取 Mp 在包围盒 [lo, hi] 里的三角形建 BVH：最近点、附近面积加权法线 */
function surfaceIndex(Mp, lo, hi) {
  const m = Mp.getMesh();
  const np = m.numProp, vp = m.vertProperties, tv = m.triVerts;
  const nt = tv.length / 3;
  const keep = [];
  /* 三角形外接盒与 [lo, hi] 相交就留（大三角形的顶点可能都在盒子外） */
  for (let f = 0; f < nt; f++) {
    const a = tv[f * 3] * np, b = tv[f * 3 + 1] * np, c = tv[f * 3 + 2] * np;
    let ok = true;
    for (let k = 0; k < 3 && ok; k++) {
      const mn = Math.min(vp[a + k], vp[b + k], vp[c + k]), mx = Math.max(vp[a + k], vp[b + k], vp[c + k]);
      ok = mx >= lo[k] && mn <= hi[k];
    }
    if (ok) keep.push(f);
  }
  const n = keep.length;
  const soup = new Float32Array(n * 9), nrm = new Float64Array(n * 3), area = new Float64Array(n);
  /* 带索引的局部网格（走表面路径用）：顶点重新编号，邻接表 CSR */
  const remap = new Int32Array(vp.length / np).fill(-1);
  const tri = new Int32Array(n * 3);
  const vx3 = [];
  let edgeSum = 0;
  for (let j = 0; j < n; j++) {
    const f = keep[j];
    for (let k = 0; k < 3; k++) {
      const g = tv[f * 3 + k], i = g * np;
      soup[j * 9 + k * 3] = vp[i]; soup[j * 9 + k * 3 + 1] = vp[i + 1]; soup[j * 9 + k * 3 + 2] = vp[i + 2];
      if (remap[g] < 0) { remap[g] = vx3.length / 3; vx3.push(vp[i], vp[i + 1], vp[i + 2]); }
      tri[j * 3 + k] = remap[g];
    }
    const o = j * 9;
    const ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
    const vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const l = Math.hypot(cx, cy, cz);
    area[j] = l / 2;
    if (l > 0) { nrm[j * 3] = cx / l; nrm[j * 3 + 1] = cy / l; nrm[j * 3 + 2] = cz / l; }
    edgeSum += Math.hypot(ux, uy, uz);
  }
  const bvh = n ? buildBVH(soup) : null;
  const nv = vx3.length / 3;
  const deg = new Int32Array(nv + 1);
  for (let j = 0; j < n * 3; j++) deg[tri[j] + 1] += 2;
  for (let v = 0; v < nv; v++) deg[v + 1] += deg[v];
  const adj = new Int32Array(deg[nv]);
  const fill = deg.slice(0, nv);
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < 3; k++) {
      const a = tri[j * 3 + k], b = tri[j * 3 + (k + 1) % 3];
      adj[fill[a]++] = b; adj[fill[b]++] = a;
    }
  }
  /* 伪法线：顶点 = 各面法线按该角加权，边 = 两侧面法线之和 */
  const vpos = Float64Array.from(vx3);
  const vn = new Float64Array(nv * 3);
  const en = new Map();
  for (let j = 0; j < n; j++) {
    const nx = nrm[j * 3], ny = nrm[j * 3 + 1], nz = nrm[j * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const a = tri[j * 3 + k], b = tri[j * 3 + (k + 1) % 3], c = tri[j * 3 + (k + 2) % 3];
      const ux = vpos[b * 3] - vpos[a * 3], uy = vpos[b * 3 + 1] - vpos[a * 3 + 1], uz = vpos[b * 3 + 2] - vpos[a * 3 + 2];
      const wx = vpos[c * 3] - vpos[a * 3], wy = vpos[c * 3 + 1] - vpos[a * 3 + 1], wz = vpos[c * 3 + 2] - vpos[a * 3 + 2];
      const lu = Math.hypot(ux, uy, uz), lw = Math.hypot(wx, wy, wz);
      const ang = lu > 0 && lw > 0 ? Math.acos(clamp((ux * wx + uy * wy + uz * wz) / (lu * lw), -1, 1)) : 0;
      vn[a * 3] += ang * nx; vn[a * 3 + 1] += ang * ny; vn[a * 3 + 2] += ang * nz;
      const key = a < b ? a * nv + b : b * nv + a;
      const e = en.get(key);
      if (e) { e[0] += nx; e[1] += ny; e[2] += nz; } else en.set(key, [nx, ny, nz]);
    }
  }
  return { soup, nrm, area, bvh, n, edge: n ? edgeSum / n : 1, tri, vpos, nv, deg, adj, vn, en };
}

/** 二叉堆（A* 用） */
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const K = this.k, V = this.v;
    let i = K.length; K.push(key); V.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v;
    const top = V[0], key = K.pop(), val = V.pop();
    if (K.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= K.length) break;
        if (c + 1 < K.length && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = key; V[i] = val;
    }
    return top;
  }
}

/**
 * 表面上从 a 到 b 的路径（沿网格边的 A*）；找不到返回 null。不含 a、b 两端。
 * lane = true：只走「这段弦在 (u, v) 上的投影」两侧各 cw 以内的窄道，并且沿弦的方向不往回走。这样架出来的桥投到 (u, v) 上
 * 就是画线的这段弦（与预览、与用户看到的线一致），不会横着绕出去、与旁边的线交叉——遮挡边、悬崖处的跳点就是这种情形：
 * 不限道时最短路会在竖墙上斜着走、来回折，两座相邻的桥在投影上叠在一起，整条线就成了「自交」。走不通返回 null。
 * lane = false：在弦中点附近的球里找最短路。
 */
function surfacePath(S, a, b, lane) {
  const ca = closest(S, a), cb = closest(S, b);
  if (!ca || !cb) return null;
  const { tri, vpos, deg, adj } = S;
  const near = (c, p) => {
    let best = -1, bd = Infinity;
    for (let k = 0; k < 3; k++) {
      const v = tri[c.f * 3 + k];
      const d = (vpos[v * 3] - p[0]) ** 2 + (vpos[v * 3 + 1] - p[1]) ** 2 + (vpos[v * 3 + 2] - p[2]) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  };
  const s = near(ca, a), g = near(cb, b);
  if (s === g) return [];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const R2 = (len * 0.75 + 2) ** 2;
  const gx = vpos[g * 3], gy = vpos[g * 3 + 1], gz = vpos[g * 3 + 2];
  /* 窄道：宽取起点附近网格边长的 1.5 倍（至少 0.3 mm）；弦在 (u, v) 上够长时沿 (u, v) 方向单调，
     几乎竖直的弦（(u, v) 上短于两倍道宽）沿三维弦方向单调 */
  let pass = null, rank = null;
  if (lane) {
    let el = 0, ne = 0;
    for (let e = deg[s]; e < deg[s + 1]; e++) {
      const w = adj[e];
      el += Math.hypot(vpos[w * 3] - vpos[s * 3], vpos[w * 3 + 1] - vpos[s * 3 + 1], vpos[w * 3 + 2] - vpos[s * 3 + 2]); ne++;
    }
    const cw = Math.max(0.3, 1.5 * (ne ? el / ne : 0.3));
    const du = b[0] - a[0], dv = b[1] - a[1], luv = Math.hypot(du, dv);
    pass = (x, y) => {
      if (luv < 1e-9) return Math.hypot(x - a[0], y - a[1]) <= cw;
      const t = ((x - a[0]) * du + (y - a[1]) * dv) / luv, q = ((x - a[0]) * dv - (y - a[1]) * du) / luv;
      return q <= cw && q >= -cw && t >= -cw && t <= luv + cw;
    };
    rank = luv >= 2 * cw
      ? (x, y) => ((x - a[0]) * du + (y - a[1]) * dv) / luv
      : (x, y, z) => ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1]) + (z - a[2]) * (b[2] - a[2])) / len;
    if (!pass(vpos[s * 3], vpos[s * 3 + 1]) || !pass(gx, gy)) return null;
  }
  const dist = new Map(), prev = new Map();
  const H = new Heap();
  dist.set(s, 0); H.push(0, s);
  let pops = 0;
  while (H.size && pops++ < 60000) {
    const v = H.pop();
    if (v === g) break;
    const dv = dist.get(v);
    const rv = rank ? rank(vpos[v * 3], vpos[v * 3 + 1], vpos[v * 3 + 2]) : 0;
    for (let e = deg[v]; e < deg[v + 1]; e++) {
      const w = adj[e];
      const wx = vpos[w * 3], wy = vpos[w * 3 + 1], wz = vpos[w * 3 + 2];
      if ((wx - mid[0]) ** 2 + (wy - mid[1]) ** 2 + (wz - mid[2]) ** 2 > R2) continue;
      if (pass && (!pass(wx, wy) || rank(wx, wy, wz) < rv - 0.02)) continue;
      const nd = dv + Math.hypot(wx - vpos[v * 3], wy - vpos[v * 3 + 1], wz - vpos[v * 3 + 2]);
      if (nd < (dist.has(w) ? dist.get(w) : Infinity)) {
        dist.set(w, nd); prev.set(w, v);
        H.push(nd + Math.hypot(wx - gx, wy - gy, wz - gz), w);
      }
    }
  }
  if (!prev.has(g)) return null;
  const path = [];
  for (let v = g; v !== s; v = prev.get(v)) path.push([vpos[v * 3], vpos[v * 3 + 1], vpos[v * 3 + 2]]);
  path.push([vpos[s * 3], vpos[s * 3 + 1], vpos[s * 3 + 2]]);
  path.reverse();
  /* 两端吸到的顶点离 a / b 很近时去掉，免得来回折 */
  const far = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 0.05;
  while (path.length && !far(path[0], a)) path.shift();
  while (path.length && !far(path[path.length - 1], b)) path.pop();
  return path;
}

/** 点到三角形最近点（Ericson 5.1.5），写进 out（out[3] = 最近特征：0/1/2 顶点 A/B/C、3 边 AB、4 边 BC、5 边 CA、6 面内），返回距离² */
function closestOnTri(px, py, pz, t, i, out) {
  const ax = t[i], ay = t[i + 1], az = t[i + 2];
  const abx = t[i + 3] - ax, aby = t[i + 4] - ay, abz = t[i + 5] - az;
  const acx = t[i + 6] - ax, acy = t[i + 7] - ay, acz = t[i + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz, ft = 6;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; ft = 0; }
  else {
    const bpx = px - t[i + 3], bpy = py - t[i + 4], bpz = pz - t[i + 5];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = t[i + 3]; qy = t[i + 4]; qz = t[i + 5]; ft = 1; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v; ft = 3; }
      else {
        const cpx = px - t[i + 6], cpy = py - t[i + 7], cpz = pz - t[i + 8];
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = t[i + 6]; qy = t[i + 7]; qz = t[i + 8]; ft = 2; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w; ft = 5; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = t[i + 3] + (t[i + 6] - t[i + 3]) * w; qy = t[i + 4] + (t[i + 7] - t[i + 4]) * w; qz = t[i + 5] + (t[i + 8] - t[i + 5]) * w; ft = 4;
            } else {
              const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  out[0] = qx; out[1] = qy; out[2] = qz; out[3] = ft;
  return (qx - px) ** 2 + (qy - py) ** 2 + (qz - pz) ** 2;
}

/** 最近的表面点：{ p, f（soup 里的三角形序号）, d, ft（最近特征，见 closestOnTri） }；maxD 内没有返回 null */
function closest(S, p, maxD = Infinity) {
  const { soup, bvh } = S;
  if (!bvh) return null;
  const { order, bmin, bmax, left, start, count } = bvh;
  let best2 = maxD === Infinity ? Infinity : maxD * maxD, bf = -1, bft = 6;
  const bp = [0, 0, 0], out = [0, 0, 0, 6];
  const px = p[0], py = p[1], pz = p[2];
  const boxD = id => {
    const o = id * 3;
    const dx = Math.max(bmin[o] - px, 0, px - bmax[o]);
    const dy = Math.max(bmin[o + 1] - py, 0, py - bmax[o + 1]);
    const dz = Math.max(bmin[o + 2] - pz, 0, pz - bmax[o + 2]);
    return dx * dx + dy * dy + dz * dz;
  };
  /* 近的孩子先走（栈里先压远的），最近距离很快收紧，剪枝多 */
  const stack = [0], sd = [boxD(0)];
  while (stack.length) {
    const id = stack.pop(), d0 = sd.pop();
    if (d0 >= best2) continue;
    if (left[id] === -1) {
      for (let k = start[id], e = start[id] + count[id]; k < e; k++) {
        const d2 = closestOnTri(px, py, pz, soup, order[k] * 9, out);
        if (d2 < best2) { best2 = d2; bf = order[k]; bft = out[3]; bp[0] = out[0]; bp[1] = out[1]; bp[2] = out[2]; }
      }
    } else {
      const a = id + 1, b = left[id];
      const da = boxD(a), db = boxD(b);
      if (da <= db) { if (db < best2) { stack.push(b); sd.push(db); } if (da < best2) { stack.push(a); sd.push(da); } }
      else { if (da < best2) { stack.push(a); sd.push(da); } if (db < best2) { stack.push(b); sd.push(db); } }
    }
  }
  return bf < 0 ? null : { p: bp, f: bf, d: Math.sqrt(best2), ft: bft };
}

/**
 * 最近特征的伪法线（Bærentzen & Aanæs 2005）：面内取面法线，边上取两侧面法线之和，顶点取按角度加权的面法线。
 * 闭合流形网格上，p 减去最近点再点乘伪法线，符号就是 p 在实体外（+）还是里（−）——只用到 p 附近的三角形，
 * 不像数射线穿面次数那样怕射线擦着边。
 */
function pseudoNormal(S, f, ft) {
  if (ft === 6) return [S.nrm[f * 3], S.nrm[f * 3 + 1], S.nrm[f * 3 + 2]];
  const t = S.tri;
  if (ft < 3) { const v = t[f * 3 + ft]; return [S.vn[v * 3], S.vn[v * 3 + 1], S.vn[v * 3 + 2]]; }
  const a = t[f * 3 + ft - 3], b = t[f * 3 + (ft - 2) % 3];
  const e = S.en.get(a < b ? a * S.nv + b : b * S.nv + a);
  return e ? e.slice() : [S.nrm[f * 3], S.nrm[f * 3 + 1], S.nrm[f * 3 + 2]];
}

/** p 在实体外为正、里为负（量级 = 到表面的距离）；附近没有三角形返回 NaN */
function sideOf(S, p) {
  const c = closest(S, p);
  if (!c) return NaN;
  const n = pseudoNormal(S, c.f, c.ft);
  const s = (p[0] - c.p[0]) * n[0] + (p[1] - c.p[1]) * n[1] + (p[2] - c.p[2]) * n[2];
  return s >= 0 ? c.d : -c.d;
}

/** p 附近（半径 r）表面的面积加权法线；与最近那张面 n0 夹角超过 60° 的不算（棱另一侧的面、薄片的另一面） */
function normalNear(S, p, r, n0) {
  const { soup, nrm, area, bvh } = S;
  const { order, bmin, bmax, left, start, count } = bvh;
  const r2 = r * r, out = [0, 0, 0];
  let sx = 0, sy = 0, sz = 0;
  const stack = [0];
  while (stack.length) {
    const id = stack.pop(), o = id * 3;
    const dx = Math.max(bmin[o] - p[0], 0, p[0] - bmax[o]);
    const dy = Math.max(bmin[o + 1] - p[1], 0, p[1] - bmax[o + 1]);
    const dz = Math.max(bmin[o + 2] - p[2], 0, p[2] - bmax[o + 2]);
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    if (left[id] === -1) {
      for (let k = start[id], e = start[id] + count[id]; k < e; k++) {
        const f = order[k];
        if (nrm[f * 3] * n0[0] + nrm[f * 3 + 1] * n0[1] + nrm[f * 3 + 2] * n0[2] < 0.5) continue;
        if (closestOnTri(p[0], p[1], p[2], soup, f * 9, out) > r2) continue;
        sx += nrm[f * 3] * area[f]; sy += nrm[f * 3 + 1] * area[f]; sz += nrm[f * 3 + 2] * area[f];
      }
    } else stack.push(left[id], id + 1);
  }
  const l = Math.hypot(sx, sy, sz);
  return l > 1e-12 ? [sx / l, sy / l, sz / l] : n0.slice();
}

/* ---------- 画线：加密、法线、窄带 ---------- */

const area2 = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a; };

/** 闭合折线在 (u, v) 上自己交叉的边对 [i, j]（i < j，相邻边不算，最多 limit 对）；按网格分桶，几千个点也快 */
function crossings(P, limit = 1) {
  const n = P.length;
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const p of P) { if (p[0] < u0) u0 = p[0]; if (p[0] > u1) u1 = p[0]; if (p[1] < v0) v0 = p[1]; if (p[1] > v1) v1 = p[1]; }
  const G = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cu = (u1 - u0) / G || 1, cv = (v1 - v0) / G || 1;
  const cells = new Map();
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    const gx0 = Math.floor((Math.min(a[0], b[0]) - u0) / cu), gx1 = Math.floor((Math.max(a[0], b[0]) - u0) / cu);
    const gy0 = Math.floor((Math.min(a[1], b[1]) - v0) / cv), gy1 = Math.floor((Math.max(a[1], b[1]) - v0) / cv);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const k = gx * 100003 + gy;
      let c = cells.get(k);
      if (!c) cells.set(k, c = []);
      c.push(i);
    }
  }
  const cr = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const out = [], seen = new Set();
  for (const c of cells.values()) {
    for (let x = 0; x < c.length; x++) for (let y = x + 1; y < c.length; y++) {
      const i = Math.min(c[x], c[y]), j = Math.max(c[x], c[y]);
      if (j - i <= 1 || j - i === n - 1 || seen.has(i * n + j)) continue;
      const a = P[i], b = P[(i + 1) % n], p = P[j], q = P[(j + 1) % n];
      const o1 = cr(a, b, p), o2 = cr(a, b, q), o3 = cr(p, q, a), o4 = cr(p, q, b);
      if (o1 * o2 < 0 && o3 * o4 < 0) {
        seen.add(i * n + j);
        out.push([i, j, o1 / (o1 - o2)]);   // 第三项：交点在 j 段上的参数
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
const selfCross = P => crossings(P, 1).length > 0;

/** 沿闭合折线从 i 走到 j（往前）的弧长 */
function arcLen(P, i, j) {
  const n = P.length;
  let s = 0;
  for (let k = i; k !== j; k = (k + 1) % n) { const a = P[k], b = P[(k + 1) % n]; s += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); }
  return s;
}

/**
 * 去掉画线在 (u, v) 上的小结：两段交叉、夹在中间的一截短于 maxArc（吸附 / 架桥的路径在拐角来回折出来的），
 * 把这一截剪掉，换成交点（吸回表面；S 为 null 时不吸，预览用）。大的交叉（真的绕成「8」字）不动，交给后面报错。
 */
function untangle(L, S, maxArc) {
  let P = L;
  for (let it = 0; it < 200; it++) {
    const pairs = crossings(P, 64);
    let fixed = false;
    for (const [i, j, t] of pairs) {
      const n = P.length;
      const fwd = arcLen(P, (i + 1) % n, j), back = arcLen(P, (j + 1) % n, i);
      if (Math.min(fwd, back) > maxArc) continue;
      const p = P[j], q = P[(j + 1) % n];
      let X = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
      const c = S && closest(S, X);
      if (c && c.d < 0.3) X = c.p.slice();
      if (fwd <= back) P = [...P.slice(0, i + 1), X, ...P.slice(j + 1)];
      else P = [...P.slice(i + 1, j + 1), X];
      fixed = true;
      break;
    }
    if (!fixed) break;
  }
  return P;
}

/**
 * 去掉画线在 (u, v) 上的折返尖刺：某点前后两段几乎原路折回（夹角 < 30°）。常见于棱边处吸附 / 屏幕采样来回跳一下，
 * 这样的点让窄带叠成 Z 字（前后两片在投影上重叠），切刀自己穿过自己，切开的两侧在叠住的地方连在一起。
 * 两段都很短的竖直台阶（投影几乎重合）不算，留着。
 * keepReflex：往圈里凹进去的尖（逆时针圈上右转，下件伸进上件的一道窄缺口）只在几乎完全原路折回（< 3°）时才去掉——
 * 窄带往圈里收时缺口只会变宽、L′ 不会自交，留在核心线上切缝最准；往外凸的尖（上件伸出去的窄舌头）照旧去掉，
 * 由切缝上孤点自己的窄带与底板接回（见 seamPlan / orphanRun）。切割时用，预览不用（预览只要整理出一圈不自交的线）。
 */
const RETRACE = Math.cos(Math.PI / 60);   // 前后两段夹角小于 3°：几乎完全原路折回
function despike(L, keepReflex = false) {
  let idx = L.map((_, i) => i);
  for (let it = 0; it < 64 && idx.length > 3; it++) {
    const n = idx.length;
    const keep = new Uint8Array(n).fill(1);
    let removed = 0;
    for (let i = 0; i < n; i++) {
      if (!keep[(i + n - 1) % n]) continue;
      const a = L[idx[(i + n - 1) % n]], p = L[idx[i]], c = L[idx[(i + 1) % n]];
      const ux = a[0] - p[0], uy = a[1] - p[1], vx = c[0] - p[0], vy = c[1] - p[1];
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu < 1e-6 || lv < 1e-6) continue;
      const cos = (ux * vx + uy * vy) / (lu * lv);
      if (!(cos > SPIKE)) continue;
      /* (p − a) × (c − p) < 0：逆时针圈上右转 = 凹进去的尖 */
      if (keepReflex && cos <= RETRACE && (-ux) * vy - (-uy) * vx < 0) continue;
      keep[i] = 0; removed++;
    }
    if (!removed) break;
    idx = idx.filter((_, i) => keep[i]);
  }
  return idx;
}

/**
 * 表面路径（沿网格边走出来的）是锯齿：每一步都顺着某条网格边，在 (u, v) 上来回折，窄带跟着拧成一串小折，切刀在折处翻面漏缝
 * （实测躯干件两处 4～5 mm 的桥各 130 多个点，切不开）。端点不动，内部点向两邻中点挪一半再吸回表面，做 8 轮，
 * 再按弧长每 DS 取一点（吸回表面），返回不含两端的点列。
 */
function smoothPath(S, a, path, b) {
  let P = [a, ...path, b].map(q => q.slice());
  for (let it = 0; it < 8; it++) {
    const Q = P.map(q => q.slice());
    for (let i = 1; i < P.length - 1; i++) {
      const x = [(2 * P[i][0] + P[i - 1][0] + P[i + 1][0]) / 4, (2 * P[i][1] + P[i - 1][1] + P[i + 1][1]) / 4, (2 * P[i][2] + P[i - 1][2] + P[i + 1][2]) / 4];
      const c = closest(S, x);
      Q[i] = c && c.d < 0.5 ? c.p.slice() : x;
    }
    P = Q;
  }
  const acc = [0];
  for (let i = 1; i < P.length; i++) acc.push(acc[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]));
  const tot = acc[acc.length - 1];
  const m = Math.max(1, Math.round(tot / DS));
  const out = [];
  for (let k = 1, j = 0; k < m; k++) {
    const t = (k / m) * tot;
    while (j < P.length - 2 && acc[j + 1] < t) j++;
    const f = (t - acc[j]) / Math.max(acc[j + 1] - acc[j], 1e-12);
    const x = [P[j][0] + (P[j + 1][0] - P[j][0]) * f, P[j][1] + (P[j + 1][1] - P[j][1]) * f, P[j][2] + (P[j + 1][2] - P[j][2]) * f];
    const c = closest(S, x);
    out.push(c && c.d < 0.5 ? c.p.slice() : x);
  }
  return out;
}

/**
 * 画线加密：相邻两点超过 DS 就在弦上插点并吸回最近表面（离弦太远的不吸，保持弦上）。
 * 弦明显离开表面（跨过遮挡边、沟、凸起：应用里屏幕采样在轮廓处会跳过一截）时改走表面路径（平滑后），切缝才连续地落在表面上。
 */
function densify(L, S) {
  const out = [], dev = [];
  let bridged = 0, refilled = 0;
  const n = L.length;
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const d3 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const fillChord = (a, b, depth = 0) => {
    const len = d3(a, b);
    const k = Math.ceil(len / DS);
    let prev = a;
    for (let s = 1; s <= k; s++) {
      let p = b;
      if (s < k) {
        const q = lerp(a, b, s / k);
        const c = closest(S, q);
        if (c && c.d <= 0.35 * len) { p = c.p.slice(); dev.push(c.d); } else p = q;
      }
      /* 长弦跨过凹处时，相邻两个插点会各自吸到两边的表面上，中间空出一截（实测腿部件空出 1.6 mm，切刀在那里漏了缝）：
         两点之间再加密一次，直到不再空出 */
      if (depth < 3 && d3(prev, p) > 2 * DS) { fillChord(prev, p, depth + 1); refilled++; }
      if (s < k) out.push(p);
      prev = p;
    }
  };
  for (let i = 0; i < n; i++) {
    const a = L[i], b = L[(i + 1) % n];
    const len = d3(a, b);
    out.push(a);
    if (len <= DS) continue;
    /* 弦离开表面：取弦上三处看离表面多远（只看中点会漏掉凹在一侧的情形） */
    let off = 0;
    if (len > 0.8) {
      for (const t of [0.25, 0.5, 0.75]) {
        const c = closest(S, lerp(a, b, t));
        off = Math.max(off, c ? c.d : Infinity);
      }
    }
    /* 先走窄道（投影就是这段弦），走不通再放开找最短路 */
    const path = len > 0.8 && off > 0.05 * len + 0.03 ? (surfacePath(S, a, b, true) || surfacePath(S, a, b, false)) : null;
    if (path) {
      bridged++;
      let p = a;
      for (const q of [...smoothPath(S, a, path, b), b]) { fillChord(p, q); if (q !== b) out.push(q); p = q; }
    } else fillChord(a, b);
  }
  return { L: out, dev, bridged, refilled };
}

/**
 * 点 i 处的「圈内」单位方向：逆时针多边形在 i 处的左法线。
 * 用于把窄带的进材料方向限制在圈外一侧（指向圈内的分量会让窄带外段压到圈内的表面上）。
 */
function innerDir(L, i) {
  const n = L.length, p = L[(i + n - 1) % n], q = L[(i + 1) % n];
  let tu = q[0] - p[0], tv = q[1] - p[1];
  const tl = Math.hypot(tu, tv) || 1;
  return [-tv / tl, tu / tl];
}

/** 进材料方向 v 去掉指向圈内（du, dv）的分量；剩下的太短就往圈外偏一点 */
function clampInward(v, du, dv) {
  const s0 = v[0] * du + v[1] * dv;
  let w = s0 > 0 ? [v[0] - s0 * du, v[1] - s0 * dv, v[2]] : v;
  if (Math.hypot(w[0], w[1], w[2]) < 0.35) w = [w[0] - 0.5 * du, w[1] - 0.5 * dv, w[2]];
  return norm3(w);
}

/**
 * 窄带：每点的表面法线 N、进材料深度 b → L′ = L − bN、F = L + f·N。
 * b 不超过沿 −N 量到的材料厚度的 0.45（薄的凸起、薄壁不会被窄带捅穿，否则切缝会跑到另一面去）；
 * f 不超过沿 +N 到对面表面距离的一半（窄缝里外段不扎进对面）。
 */
function stripOf(L, S, req, A) {
  let thinN = 0, thinN0 = 0;
  const n = L.length;
  const N = new Array(n), nl = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = closest(S, L[i]);
    const n0 = c ? [S.nrm[c.f * 3], S.nrm[c.f * 3 + 1], S.nrm[c.f * 3 + 2]] : [0, 0, 1];
    nl[i] = c ? norm3(pseudoNormal(S, c.f, c.ft)) : n0;
    N[i] = normalNear(S, L[i], RN, n0);
  }
  /* N 指向圈内（朝上件）的分量去掉：否则窄带外段会从画线压到圈内的表面上。平滑前后各做一次 */
  const din = L.map((_, i) => innerDir(L, i));
  const clampIn = (v, i) => clampInward(v, din[i][0], din[i][1]);
  for (let i = 0; i < n; i++) N[i] = clampInward(norm3(N[i]), din[i][0], din[i][1]);
  /* 沿线按弧长做高斯平滑（σ ≈ SMOOTH_N）：尖角、凸起尖上的法线会乱跳，窄带跟着拧，切缝就在那里起毛 */
  const arc = new Float64Array(n);
  for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1], L[i][2] - L[i - 1][2]);
  const per = arc[n - 1] + Math.hypot(L[0][0] - L[n - 1][0], L[0][1] - L[n - 1][1], L[0][2] - L[n - 1][2]);
  const sig = SMOOTH_N, M = [];
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, sz = 0;
    for (let dir = -1; dir <= 1; dir += 2) {
      for (let k = dir < 0 ? 0 : 1; k < n; k++) {
        const j = (i + dir * k + n * 4) % n;
        let d = Math.abs(arc[j] - arc[i]); d = Math.min(d, per - d);
        if (d > 3 * sig) break;
        const w = Math.exp(-0.5 * (d / sig) ** 2);
        sx += w * N[j][0]; sy += w * N[j][1]; sz += w * N[j][2];
      }
    }
    M.push([sx, sy, sz]);
  }
  for (let i = 0; i < n; i++) N[i] = clampIn(norm3(M[i]), i);
  /* 平滑过的法线在尖棱、窄沟里可能已经不朝外了（两侧面的法线被平均掉）：窄带必须在画线处从里穿到外，
     所以 N 与画线所在处的外法线（伪法线）夹角不超过 ~72°，不够就往外法线拧；校验过不了的点（A.mode = 1）直接用外法线 */
  for (let i = 0; i < n; i++) {
    if (A.mode[i]) { N[i] = nl[i].slice(); continue; }
    let v = N[i];
    for (let k = 0; k < 8 && v[0] * nl[i][0] + v[1] * nl[i][1] + v[2] * nl[i][2] < OUT_MIN; k++) v = norm3([v[0] + nl[i][0], v[1] + nl[i][1], v[2] + nl[i][2]]);
    N[i] = clampIn(v, i);
  }
  /* 凹拐角处的方向覆盖（主循环的 fixCorners 定的）：L′ 那一圈小结被平滑抹直后，这几个点的进材料方向略微偏开，
     深度 b 照常按下面的规矩取，不再靠「深度乘 0.5」把窄带压到 0.01～0.04 mm（压那么浅，切刀薄得切不动） */
  if (A.nd) for (let i = 0; i < n; i++) { const d = A.nd[i]; if (d) N[i] = clampIn(norm3(d), i); }
  /* 深度（下沉量）：沿 −w（切面法线反向）直下 wall——不跟着表面法线走。
     跟法线走的话，画线经过矮处 / 凹处时深度会跟着变浅，那里就切不透：切完留一块皮、
     该分离的一段还留在原地，拼合时那块料顶住（用户 2026-10-28 实测：破洞 + 拼不上）。
     上限仍是「沿 −w 量到的材料厚度 × 0.45」，免得薄壁被捅穿；出材料了就往浅里退 */
  let b;
  if (req.wall > 0) {
    b = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = L[i], v = N[i];
      let d = req.wall;
      /* 深度按「沿 −N」量到的材料厚度封顶（0.45 倍）：画线在侧壁 / 悬垂上时，正下方是空的，
         按 −w 量会把深度压到接近零、L′ 落到材料外，切刀那一段就断了（实测 Butt / Head / Torso 全部切不开）。
         沿表面法线量才是材料厚度的正确口径 */
      const hin = raycast(S.bvh, p[0], p[1], p[2], -v[0], -v[1], -v[2], 0.02, req.wall + 2);
      if (hin && d > 0.45 * hin.t) { d = 0.45 * hin.t; thinN0++; }
      b[i] = Math.max(0.05, d);
    }
    thinN = thinN0;
  } else {
    /* 老口径：表面越正对 ±w（掠射），越深；先取窗口最大再平滑，深的地方不会被邻居拉浅 */
    const raw = N.map(v => B_MIN + (B_MAX - B_MIN) * clamp((Math.abs(v[2]) - 0.4) / 0.45, 0, 1));
    const W = 4;
    const mx = raw.map((_, i) => { let m = 0; for (let k = -W; k <= W; k++) m = Math.max(m, raw[(i + k + n) % n]); return m; });
    b = mx.map((_, i) => { let s = 0; for (let k = -W; k <= W; k++) s += mx[(i + k + n) % n]; return Math.min(req.bCap, s / (2 * W + 1)) * A.scale[i]; });
    /* 凹拐角处平滑修正过的点：深度沿用修正时锁定的值。不锁的话重算深度 / 法线又让 L′ 挪回去，
       修一处、另一处又交叉，来回打乒乓（实测 Butt：平滑 3 轮 + 减深度 3 轮才切开） */
    if (A.bfix) for (let i = 0; i < n; i++) { const v = A.bfix[i]; if (v > 0) b[i] = v; }
  }
  const fl = new Float64Array(n).fill(FLANGE);
  for (let i = 0; i < n; i++) {
    const p = L[i], v = N[i];
    if (req.wall <= 0) {
      const hin = raycast(S.bvh, p[0], p[1], p[2], -v[0], -v[1], -v[2], 0.02, 4);
      if (hin && b[i] > 0.45 * hin.t) { b[i] = 0.45 * hin.t; thinN++; }
    }
    const hout = raycast(S.bvh, p[0], p[1], p[2], v[0], v[1], v[2], 0.02, 2 * FLANGE);
    if (hout) fl[i] = clamp(0.5 * hout.t, 0.01, FLANGE);
    fl[i] *= A.fmul[i];
  }
  /* L′（下沉模式）：表面点不动，沿「圈内方向」只收 inset（默认 0.5 mm，小到不会自交），再垂直下扎 wall。
     剖面就是一小段斜墙：表面上切口仍在画线上，往下 2 mm 才偏移 0.5 → 既切透，又不是直角城墙。
     老模式：沿 −N 走自适应深度 0.08～0.6 */
  const Lp = req.wall > 0
    ? L.map((p, i) => {
      const [du, dv] = innerDir(L, i);
      return [p[0] + req.inset * du, p[1] + req.inset * dv, p[2] - b[i]];
    })
    : L.map((p, i) => [p[0] - b[i] * N[i][0], p[1] - b[i] * N[i][1], p[2] - b[i] * N[i][2]]);

  const F = L.map((p, i) => [p[0] + fl[i] * N[i][0], p[1] + fl[i] * N[i][1], p[2] + fl[i] * N[i][2]]);
  return { N, nl, b, fl, Lp, F, thinN };
}

/**
 * 窄带逐点逐边校验（伪法线判内外，见 sideOf）：每根辐条 L′→L 段在材料里、L→F 段在材料外；
 * 相邻两点之间 F 边在外（F 边进了材料 = 切刀的外沿埋在实体里，两侧会绕过它连在一起：切不开）、
 * L′ 边在里（出了材料，膜就从别处穿出表面，切缝偏离画线）。返回各点 / 各边是否有问题。
 */
function checkStrip(L, st, S) {
  const n = L.length;
  const spoke = new Uint8Array(n), edge = new Uint8Array(n);
  let count = 0;
  const at = (p, d, t) => [p[0] + d[0] * t, p[1] + d[1] * t, p[2] + d[2] * t];
  for (let i = 0; i < n; i++) {
    const p = L[i], v = st.N[i], b = st.b[i], f = st.fl[i];
    if (!(sideOf(S, at(p, v, -0.5 * b)) < 0) || !(sideOf(S, st.Lp[i]) < 0) || !(sideOf(S, at(p, v, 0.5 * f)) > 0) || !(sideOf(S, st.F[i]) > 0)) { spoke[i] = 1; count++; }
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (spoke[i] || spoke[j]) continue;
    const Fi = st.F[i], Fj = st.F[j], Li = st.Lp[i], Lj = st.Lp[j];
    for (const s of [0.25, 0.5, 0.75]) {
      const f = [Fi[0] + (Fj[0] - Fi[0]) * s, Fi[1] + (Fj[1] - Fi[1]) * s, Fi[2] + (Fj[2] - Fi[2]) * s];
      const l = [Li[0] + (Lj[0] - Li[0]) * s, Li[1] + (Lj[1] - Li[1]) * s, Li[2] + (Lj[2] - Li[2]) * s];
      if (!(sideOf(S, f) > 0) || !(sideOf(S, l) < 0)) { edge[i] = 1; count++; break; }
    }
  }
  return { spoke, edge, count };
}

/* ---------- 切缝：用户画线本身，按一整条轮廓的规矩过筛 ---------- */

const SEG_W = 1.2;          // 切缝的边不得比两头窄带深度之和（2 × B_MAX）还短：再短眼线就会像发夹弯一样把两段夹点捏成夹点，L′ 交叉
const SEAM_CLEAR = 0.03;    // 切缝边上留出的量（mm）：L′ 落点离表面、外段端点离表面的最小距离

/** 轮廓是否简单：自身不交叉、面积为正（切缝必须自己满足这两条，内核才能不经去结 / 去刺直接走这一圈） */
function simpleLoop(P) {
  return P.length >= 3 && !selfCross(P) && area2(P) > 0;
}

/**
 * 悬空：线段 a→b 在 (u, v) 上有一截（两端各让一点、3/8 处开始取样）离表面超过 FLOAT_TOL。
 * 画线在轮廓处跳面（屏幕采样从可见面跳到被挡住的面、点头等）留下的长弦会从凹处上方跨过去，
 * 这一截既不在材料里、也不是一条真轮廓；点还在表面上，只有弦空着。
 */
function floatSeg(S, a, b) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (len < 2 * FLOAT_TOL + 0.05) return false;
  const lo = FLOAT_TOL / len;
  for (let k = 0; k < 6; k++) {
    const t = lo + (1 - 2 * lo) * (k + 1) / 7;
    const c = closest(S, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    if (!c || c.d > FLOAT_TOL) return true;
  }
  return false;
}

/** 轮廓的第 i 条边是悬空的（见 floatSeg） */
const floatEdge = (S, P, i) => floatSeg(S, P[i], P[(i + 1) % P.length]);

/** 轮廓在第 i 条边的长度（mm） */
const segLen = (P, i) => { const a = P[i], b = P[(i + 1) % P.length]; return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); };

/** 沿轮廓从 i 走到 j（往前）的弧长 */
function arcLen2(P, i, j) {
  const n = P.length;
  let s = 0;
  for (let k = i; k !== j; k = (k + 1) % n) s += segLen(P, k);
  return s;
}

/**
 * 两条线段在 (u, v) 上是否真交叉：叉积异号，且交点不在任何一条段的端点上（容差按段长给）。
 * 端点正好落在另一条线上的「T 字接触」不算——那是同一圈上相邻边、同一顶点很多圈以里才有的情形
 */
function segCross2(a, b, p, q) {
  const cr = (o, u, v) => (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
  const o1 = cr(a, b, p), o2 = cr(a, b, q), o3 = cr(p, q, a), o4 = cr(p, q, b);
  return (o1 * o2 < 0 && o3 * o4 < 0) || (o1 * o2 < 0 && Math.min(Math.abs(o3), Math.abs(o4)) < 1e-9) || (o3 * o4 < 0 && Math.min(Math.abs(o1), Math.abs(o2)) < 1e-9);
}
const segCross = (P, i, j) => segCross2(P[i], P[(i + 1) % P.length], P[j], P[(j + 1) % P.length]);

/** 眼线（两条相邻边，中间那个点 i 是尖）：夹角 < 90°（朝圈外凸）或 180°（原路折回），且最短一条边不短于 SEG_W。桥接 / 点距不足造出来的长边仿出的眼线不算 */
function eyeLineAt(P, i, n) {
  const m = n || P.length;
  const a = P[(i - 1 + m) % m], p = P[i], b = P[(i + 1) % m];
  const ux = p[0] - a[0], uy = p[1] - a[1], vx = b[0] - p[0], vy = b[1] - p[1];
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  if (!(lu > 0) || !(lv > 0)) return false;
  if (Math.min(lu, lv) < SEG_W) return false;
  return (ux * vx + uy * vy) / (lu * lv) <= 0;
}

/**
 * 轮廓的最小宽（mm）与最窄处：每条边取最近的非相邻边，算边到边的距离，实时更新最近的一条变窄就重查一遍。
 * 切开要求每一条边与对面不属于同一条眼线的边都离得比两项窄带深度之和还远——更近的地方 L′ 会交叉（夹点），
 * 内核要么自己剪掉（两侧切缝失真），要么保留交叉（切刀漏缝，切缝从别处穿出表面）。
 * 返回 { w, i, j, quick }：quick = true 时 w 还不是真正的最小值，调用方可以拿一个够用的上界先停
 */
function minWidth2(P, k0 = -1) {
  const n = P.length;
  let best = Infinity, bi = -1, bj = -1;
  for (let i = 0; i < n; i++) {
    if (i === k0) continue;
    const b = nearestEyes(P, i);
    if (b.d < best) { best = b.d; bi = i; bj = b.j; }
  }
  return { w: best, i: bi, j: bj };
}

/** 边 i 到最近的「别的眼线」边的距离与那条边的序号（k0 = 跳过那条刚被改短的边） */
function nearestEyes(P, k0 = -1) {
  const n = P.length;
  let best = Infinity, bj = -1;
  if (!(n > 4)) return { d: best, j: bj };
  for (let j = 0; j < n; j++) {
    if (j === k0 || Math.abs(j - k0) <= 1 || Math.abs(j - k0) >= n - 1) continue;
    const d = segSeg2(P[k0], P[(k0 + 1) % n], P[j], P[(j + 1) % n]);
    if (d < best) { best = d; bj = j; }
  }
  return { d: best, j: bj };
}

/** (u, v) 上两条线段的距离 */
function segSeg2(a, b, c, d) {
  const px = (o, u, v) => { const dx = u[0] - o[0], dy = u[1] - o[1], ex = v[0] - o[0], ey = v[1] - o[1]; const l = Math.hypot(dx, dy) || 1; return Math.abs(dx * ey - dy * ex) / l; };
  const ptSeg = (p, a1, b1) => {
    const ex = b1[0] - a1[0], ey = b1[1] - a1[1];
    const l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? clamp(((p[0] - a1[0]) * ex + (p[1] - a1[1]) * ey) / l2, 0, 1) : 0;
    return Math.hypot(a1[0] + ex * t - p[0], a1[1] + ey * t - p[1]);
  };
  if (segCross2(a, b, c, d)) return 0;
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}

/**
 * 切缝过筛：把画线加密吸回表面后的 Lf 整理成「一整条能直接用来张膜」的轮廓 S。
 * 内核以前对整圈做小结解开 / 去尖刺 / 减深度 / 剪发夹弯，切缝随之变形；现在这些都在切缝上做，
 * 而且只在过不了下面几条时动它——每条都只改一处，改完从头再查：
 *   ① 自交：先试红黑剥法（单独剥一条最短路到干净线 < 2 mm 的），不行把交叉处的边互相劈开（交点吸回表面）；
 *   ② 最小宽 < 2 × B_MAX（1.2 mm）：窄处是一截眼线（朝外凸 < 90° 或原路折回）就从它的尖上一层层剥（一次剥一层眼线，
 *      30° 往里的尖剥它的背面那个点），剥到宽够、或者眼线没了为止；剥下来的一截短于 WHISK 才算毛刺，不算切缝；
 *      剥完不是一截眼线，或者剥完最小宽仍不够（真的窄缝），这颗点就只能是内核自己的核心线了（coreOnly）；
 *   ③ 自交 / 宽之后还有问题：切缝本身就不是一条简单轮廓，报 LINE_TANGLED。
 * 返回 { S, peels, coreOnly, why }：S = 离切缝点（孤点）——按 Lf 的走向；peels = 剥下来的代数；coreOnly = 交给核心线的 Lf 序号集合；
 * why = 自交 / 窄缝各自落在 Lf 的哪一段（调试用）。closest 用来把劈开处吸回表面。
 */
function seamRing(Lf, S, closestFn) {
  let P = Lf.slice();
  const kept = new Set();
  const peels = new Map();
  const why = { cross: 0, narrow: 0, float: 0, floatT: 0 };
  const coreOut = new Set();
  const sealed = [];   // 悬空口子里补出来走法的两端（左端点 → 右端点）
  /**
   * 悬空边（长弦跨凹处 / 跳面）断开：这一截既不在材料里、也不是一条真轮廓，从空处跨过去的样子会把后面「眼线」的
   * 两头的点挪开，眼线就成了一颗颗没头没尾的窄洞。
   * 做法：悬空边（以及夹在两头悬空边之间的点）都记成「口子里的点」只交给核心线；口子的两头各补一个贴回表面的点
   * （左端沿最后一条非悬空边往里走，右端对称），并沿表面补一条同形的走法（smoothPath，两端不动）——与内核
   * 原来给这些边走的路一样，只是不再从空处过。补不出（口子两头隔太远 / 不在同一片上）就把整个口子让给核心线。
   */
  for (let guard = 0; guard < 16; guard++) {
    const n = P.length;
    if (n < 6) break;
    let found = -1, run = 0;
    for (let i = 0; i < n && found < 0; i++) {
      if (!floatEdge(S, P, i)) continue;
      found = i;
      for (let d = 0; d < n && floatEdge(S, P, (i + d) % n); d++) run++;
      /* 夹在两头悬空边之间、又不是一对「眼线」的点（两头都在空处）也算口子里，与悬空边一起处理 */
      for (let d = 1; d < n - 2; d++) {
        const k = (i + d) % n;
        if (eyeLineAt(P, k)) break;
        if (floatEdge(S, P, (k - 1 + n) % n) || floatEdge(S, P, k)) continue;
        const k1 = (i + d + 1) % n;
        if (!floatEdge(S, P, (k1 - 1 + n) % n) && !floatEdge(S, P, k1)) continue;
        run = d;   // 到 k 为止（含 k）都在空口子里，口子右端是 k1-1 那条悬空边的起点
        break;
      }
    }
    if (found < 0) break;
    /* 悬空边 (found … found+run−1)，口子里的点 = found+1 … found+run（两头是还挨着非悬空边的点）。只剩悬空边就整圈让给核心线 */
    const inside = new Set();
    for (let k = found + 1; k <= found + run; k++) inside.add(k % n);
    if (!run) inside.add(found);
    if (inside.size >= n - 3) { for (const p of P) coreOut.add(p); P = []; why.float += inside.size; break; }
    const a1 = P[found], b1 = P[(found + run + 1) % n];
    const d1 = P[(found + n - 1) % n], c1 = P[(found + run + 2) % n];
    const near = (p, q) => {
      const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      const c = closestFn ? closestFn(m) : null;
      return c && c.d < 0.5 ? c.p.slice() : null;
    };
    const X = near(a1, d1), Y = near(b1, c1);
    let route = null;
    if (X && Y && !floatSeg(S, X, Y)) {
      /* surfacePath 返回的点列两端已经去掉（首尾由 X / Y 接上），沿用内核给画线补路的做法：先平滑到 DS 一步，两端不动 */
      const mid = surfacePath(S, X, Y, true) || surfacePath(S, X, Y, false);
      if (mid && mid.length) route = [X, ...smoothPath(S, X, mid, Y)];
    }
    let ok = route && !route.some((q, i) => i > 0 && floatSeg(S, route[i - 1], q));
    let R = route;
    /* 走法里有悬空的那一截（多半是 surfacePath 的直弦从空处再跨了一次）：把这一截（两头各一个适合的点）也交给核心线，
       再在两端之间沿表面补一次——画线从凹处上方跳过一截时，表面上的真走法常常要绕好几次 */
    for (let tries = 0; ok && R && tries < 3; tries++) {
      let l = -1;
      for (let i = 1; i < R.length; i++) if (floatSeg(S, R[i - 1], R[i])) { l = i - 1; break; }
      if (l < 0) break;
      let r = l + 1;
      while (r + 1 < R.length && floatSeg(S, R[r], R[r + 1])) r++;
      const P0 = [...R.slice(0, Math.max(0, l)), R[l], R[r], ...R.slice(r + 1)];
      const A2 = P0[l] || null, B2 = P0[r] || null;
      const mid = A2 && B2 ? (surfacePath(S, A2, B2, true) || surfacePath(S, A2, B2, false)) : null;
      const R2 = mid && mid.length ? [...R.slice(0, l), ...smoothPath(S, A2, mid, B2), ...R.slice(r + 1)] : null;
      if (!R2) { ok = false; break; }
      R = R2;
      ok = R.every((q, i) => i === 0 || !floatSeg(S, R[i - 1], q));
      if (!ok) { ok = R.every((q, i) => i === 0 || !floatSeg(S, R[i - 1], q)); }
    }
    /* 补出来的走法要在 (u, v) 上不打结：弧长与两头直连差不多、也跟两头直连差不多（不是绕别的面转了一大圈 / 来回穿插） */
    if (ok && R) {
      const clen = Math.hypot(Y[0] - X[0], Y[1] - X[1]);
      let rlen = 0;
      for (let i = 1; i < R.length; i++) rlen += Math.hypot(R[i][0] - R[i - 1][0], R[i][1] - R[i - 1][1]);
      let rd = 0;
      for (const q of R) {
        let best = Infinity;
        for (let i = 0; i < R.length - 1; i++) {
          const p0 = R[i], p1 = R[i + 1];
          const ex = p1[0] - p0[0], ey = p1[1] - p0[1], l2 = ex * ex + ey * ey;
          const t = l2 > 0 ? clamp(((q[0] - p0[0]) * ex + (q[1] - p0[1]) * ey) / l2, 0, 1) : 0;
          best = Math.min(best, Math.hypot(p0[0] + ex * t - q[0], p0[1] + ey * t - q[1]));
        }
        rd = Math.max(rd, best);
      }
      if (globalThis.__finRoute) globalThis.__finRoute({ a1, b1, X, Y, route: R, clen, rlen, rd });
      if (rlen > 2 * clen + 1 || rd > Math.max(1, 0.6 * clen)) ok = false;
    }
    if (!ok || !R) {
      /* 补不出：口子两头的点让给核心线（内核在这两点之间自己补路，那里的走法由内核定），口子另一头的画线留着 */
      if (run > 0) { inside.add(a1); inside.add(b1); }
      P = P.filter((_, k) => !inside.has(k));
      why.float += inside.size;
      continue;
    }
    /* 补出了：口子里的点让给核心线，补出来的走法留在切缝上（贴回表面、沿表面走）。
       补出来的走法记进 sealed（左端点 → 右端点），后面剥眼线时认得出它是内核补的路、不是用户画线 */
    const inner = [];
    for (let k = found + 1; k <= found + run; k++) inner.push(P[k % n]);
    for (const p of inner) coreOut.add(p);
    const N = [];
    for (let k = 0; k < n; k++) {
      if (inside.has(k)) continue;
      N.push(P[k]);
      if (k % n === found) for (const q of R) N.push(q);
    }
    P = N;
    why.float += inner.length;
    why.floatT++;
    sealed.push({ a: a1, b: b1 });
  }
  const peelOff = i => {
    let p = peels.get(P[i]) || 0;
    peels.set(P[i], ++p);
    why.narrow++;
    P.splice(i, 1);
  };
  const unknot = () => {
    /* ① 自交：红黑剥法——交叉的边交替着色，两个交叉各自回干净线的走法撞成同一种颜色时就翻一侧再来，
       最后拿掉红 / 黑里代价（弧长）小的那一侧；超过 6 mm 的簇不在这一层、交给劈开 */
    if (!selfCross(P)) return 'none';
    const n = P.length;
    const dirty = new Uint8Array(n);
    const hit = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segCross(P, i, j)) { hit[i].push(j); hit[j].push(i); dirty[i] = 1; dirty[j] = 1; }
    }
    if (dirty.some(x => x)) {
      let best = null, bestCost = Infinity;
      for (const first of [1, -1]) {
        const mk = new Int8Array(n);
        for (let start = 0; start < n; start++) {
          if (!dirty[start] || mk[start]) continue;
          const q = [start];
          mk[start] = first;
          while (q.length) {
            const k = q.pop();
            for (const j of hit[k]) {
              if (j === k + 1 || j === k - 1) continue;
              if (!mk[j]) { mk[j] = -mk[k]; q.push(j); }
            }
          }
        }
        for (const col of [1, -1]) {
          const sel = [];
          for (let k = 0; k < n; k++) if (mk[k] === col) sel.push(k);
          const cost = sel.reduce((t, k) => t + segLen(P, k), 0);
          if (sel.length && cost < bestCost) { bestCost = cost; best = sel; }
        }
      }
      if (best && bestCost <= 6.0) {
        const rs = new Set(best);
        for (const k of best) kept.add(P[k]);
        P = P.filter((_, k) => !rs.has(k));
        peels.set('unknot', (peels.get('unknot') || 0) + best.length);
        return 'unpeel';
      }
    }
    /* ② 劈开交叉处：两边各插一个交点（吸回表面） */
    const cr = crossings(P, 1);
    if (!cr.length) return 'none';
    const [i, j, t] = cr[0];
    const p = P[j], q = P[(j + 1) % P.length];
    let X = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
    const cc = closestFn ? closestFn(X) : null;
    if (cc && cc.d < 0.3) X = cc.p.slice();
    let Q = [...P.slice(0, j + 1), X, ...P.slice(j + 1)];
    const i2 = i, j2 = j + 1;
    const fwd = arcLen2(Q, i2 + 1, j2), back = arcLen2(Q, j2 + 1, i2);
    if (fwd <= back) Q = [X, ...Q.slice(i2 + 1, j2 + 1)];
    else Q = [...Q.slice(i2 + 1, j2 + 1), X];
    P = Q;
    why.cross++;
    return 'split';
  };
  /**
   * 「眼线」：两条边都够长（≥ SEG_W）、夹角 < 90°（往圈外凸）或 180°（原路折回）的尖。
   * 只看它过不过——长度按指数加权（最近的邻点权重最大，短边把尖磨圆了也不藏），不直接拿来剥。
   * 悬空口子的左端点自带一个尖（补出来的走法从那里斜着离开），那个尖不是用户的线，不算。
   */
  const sealedA = new Set(sealed.map(e => e.a));
  const eyesOf = () => {
    const out = [];
    for (let i = 0; i < P.length; i++) {
      if (sealedA.has(P[i])) continue;
      if (!eyeLineAt(P, i)) continue;
      const n = P.length;
      let w = 0, sx = 0, sy = 0, fp = Infinity;
      for (let d = 1; d < Math.min(n - 1, 30); d++) {
        const wd = 0.75 ** (d - 1);
        for (const sg of [1, -1]) {
          const U = P[(i - sg * d + n * 4) % n], Q = P[i];
          const ex = U[0] - Q[0], ey = U[1] - Q[1], l = Math.hypot(ex, ey) || 1;
          sx += wd * ex / l; sy += wd * ey / l; w += wd;
          /* 沿这条腿找最远点（在 ~2.8 mm 内）：反面的「腿」的端点 */
          for (let e = 1; e <= d; e++) {
            const F2 = P[(i - sg * e + n * 4) % n];
            const fx = F2[0] - Q[0], fy = F2[1] - Q[1];
            const fl = Math.hypot(fx, fy);
            if (fl >= 1.0 && fl < 4.0 && fl / Math.hypot(ex, ey) > 0.9) fp = Math.min(fp, (e - 1 + d) * 0.3);
          }
        }
      }
      const bu = -sx / (w || 1), bv = -sy / (w || 1), bl = Math.hypot(bu, bv) || 1;
      const back = [bu / bl, bv / bl];
      /* 往对方腿里伸的穿透程度：沿对方平均方向走 d 步（max 3 mm）投影 */
      let t = Infinity, at = -1;
      for (let d = 1; d < Math.min(n - 1, 16); d++) {
        const Q = P[(i + d) % n];
        const vx = Q[0] - P[i][0], vy = Q[1] - P[i][1], l = Math.hypot(vx, vy);
        if (l < 1e-9) continue;
        const proj = (vx * back[0] + vy * back[1]);
        if (proj > 1e-3 && proj < t) { t = proj; at = d; }
        if (l > 3) break;
      }
      if (!(t < 3 * SEG_W) || at < 0) continue;
      /* 腿伸到对面时，对过去的那个尖是不是补出来的走法的另一端：是的话那条腿不该参与窄处判定 */
      out.push({ i, t, at, fp });
    }
    return out;
  };
  /* 剥一颗眼线点：朝圈外凸的剥尖本身；原路折回 / 往里凹的剥它背面那颗，少了再退一颗 */
  const peelOne = e => {
    const n = P.length;
    if (e >= n) e = n - 1;
    const a1 = P[(e - 1 + n) % n], p = P[e], b1 = P[(e + 1) % n];
    const lu = Math.hypot(p[0] - a1[0], p[1] - a1[1]), lv = Math.hypot(b1[0] - p[0], b1[1] - p[1]);
    const cos = lu * lv > 0 ? ((p[0] - a1[0]) * (b1[0] - p[0]) + (p[1] - a1[1]) * (b1[1] - p[1])) / (lu * lv) : 1;
    if (cos >= 0) peelOff(e);
    else { peelOff((e + 1) % n); if (P.length > 4) { if (e + 1 < P.length) peelOff(e + 1); else peelOff(0); } }
  };
  for (let guard = 0; guard < 400; guard++) {
    if (P.length < 3) return { S: [], peels, coreOnly: coreOut, why, ok: false };
    if (selfCross(P)) { unknot(); continue; }
    if (!(area2(P) > 0)) return { S: P, peels, coreOnly: coreOut, why, ok: false };
    const n = P.length;
    const eyes = eyesOf();
    if (!eyes.length) break;
    /* 只在两条眼线「对起来」的窄处剥、且窄处必须比两条腿贴得还近（< 2 × min(DS, 腿间距)）：
       那是两条腿互相穿插、中间没有料可切的来回线，内核单靠自己切不出来（它会沿原路折回处把两侧拉开切一条小缝）；
       普通的窄缝（两条腿分得开、中间真有材料）不归这里管——那是内核原路折回的那条路在切，
       在这里剥只会把整段用户画线一笔勾掉（实测 P #33 的一截 L 形舌头就是这样被 50 颗 50 颗地剥光的） */
    let pair = null;
    for (const e of eyes) for (const f2 of eyes) {
      if (f2.i === e.i) continue;
      if (sealedA.has(P[(e.i + f2.at) % n]) || sealedA.has(P[(f2.i + e.at) % n])) continue;
      const d = segSeg2(P[e.i], P[(e.i + 1) % n], P[f2.i], P[(f2.i + 1) % n]);
      if (!pair || d < pair.d) pair = { d, a: e, b: f2 };
    }
    if (!pair) break;
    const fmin = Math.min(pair.a.fp, pair.b.fp);
    if (globalThis.__finEyes) globalThis.__finEyes(eyes.map(e => ({ ...e, p: P[e.i] })), pair, fmin, SEG_W, DS);
    if (!(pair.d < Math.min(2 * DS, 2 * fmin))) break;
    /* 两条轮流剥：剥离对方更近的那条；剥完重头再查 */
    const first = pair.a.t <= pair.b.t ? pair.a : pair.b, second = first === pair.a ? pair.b : pair.a;
    const pos = first.i;
    peelOne(pos);
    if (second.i > pos + 1 && second.i < P.length + 1) peelOne(Math.min(second.i - 1, P.length - 1));
  }
  return { S: P, peels, coreOnly: coreOut, why, ok: P.length >= 3 && !selfCross(P) && area2(P) > 0 };
}

/* ---------- （旧）切缝：用户画线本身 ---------- */

/** 切缝上一点的外段（伸出表面的那截）：附近表面法线，拧到与外法线夹角不超过 ~72°，长度不超过到对面表面距离的一半；中点、端点不在材料外就改用外法线。nl = 该处外法线（伪法线） */
function flangeOf(S, p) {
  const c = closest(S, p);
  if (!c) return { N: [0, 0, 1], F: [p[0], p[1], p[2] + FLANGE], nl: null };
  const n0 = [S.nrm[c.f * 3], S.nrm[c.f * 3 + 1], S.nrm[c.f * 3 + 2]];
  const nl = norm3(pseudoNormal(S, c.f, c.ft));
  let v = normalNear(S, p, RN, n0);
  for (let k = 0; k < 8 && v[0] * nl[0] + v[1] * nl[1] + v[2] * nl[2] < OUT_MIN; k++) v = norm3([v[0] + nl[0], v[1] + nl[1], v[2] + nl[2]]);
  const along = d => {
    let fl = FLANGE;
    const h = raycast(S.bvh, p[0], p[1], p[2], d[0], d[1], d[2], 0.02, 2 * FLANGE);
    if (h) fl = clamp(0.5 * h.t, 0.01, FLANGE);
    const at = t => [p[0] + t * d[0], p[1] + t * d[1], p[2] + t * d[2]];
    return { N: d, F: at(fl), ok: sideOf(S, at(fl)) > 0 && sideOf(S, at(0.5 * fl)) > 0, nl };
  };
  let r = along(v);
  if (!r.ok) { const r2 = along(nl); if (r2.ok) r = r2; }
  return r;
}

/**
 * 核心线在相邻两个公共点 A、Bn 之间删掉的一段画线点（孤点）怎么接进切刀。
 * 每个孤点沿 −N 进材料到自己的 L′（深度取 A、Bn 两点深度按弧长插值，不超过沿 −N 量到的材料厚度的 0.45；
 * L′ 与辐条中点都要在材料里，不行换外法线、深度减半），孤点的 L′ 链与核心线在这一段的 L′（膜的边，倒着走）
 * 围成一个小多边形，在它自己的拟合平面里三角化成「底板」：尖刺两条腿的窄带是两壁，底板把膜接到尖刺底下。
 * 两条腿各有各的 L′，不再共用一个核心点（旧的扇形做法两条腿收到同一个 L′，薄片在那里对折、加厚方向无解，切刀漏缝）。
 * 先剥毛刺（见 peel）：去了又原路回来、两条腿间距不到 WHISK 的一截没有料可分；剥完与核心线这一段几乎重合就不补底板。
 * 补不出底板时把剥毛刺的宽度放宽到 2 倍、4 倍再试（剥掉的只是更宽一点的细缝）。
 * 切线平面上原路折回的尖拉开成 ±BLUNT 两点，窄带外段在尖上转一个窄 U 形弯。
 * edgeN[c] = 膜在边界边 c → c+1 处那个三角形的法线，用来量底板与膜在共用边上折了多少（fold = 最小点积；< 0 表示底板翻到膜底下）。
 * 返回 { pts: [{ p, F }], Lx, tris（顶点 [0, 核心点] / [2, Lx 总表序号]）, blunt, out, fold, thr }；
 * 剥完毛刺不剩孤点（或与核心线重合）返回 { empty: true }；补不出底板返回 { bad: 原因 }（spoke = 辐条出了材料，flat = 底板退化，cross = 底板多边形自交，tri = 三角化失败，fold = 底板翻到了膜底下）。
 */
function orphanRun(MF, S, st, L, A, Bn, pts0, coreOnly, xBase, edgeN) {
  const pA = L[A], pB = L[Bn];
  /* 段里有悬空的点（离表面超过 FLOAT_TOL：画线有一段长弦从凹处上方跨过，加密插的点没能吸回表面）：
     这一段本来就不在表面上，核心线在这里已经沿表面补了点，就用核心线 */
  for (const p of pts0) { const c = closest(S, p, 2 * FLOAT_TOL); if (!c || c.d > FLOAT_TOL) return { empty: true, float: true }; }
  const core = [pA, ...coreOnly.map(c => L[c]), pB];
  let last = null;
  for (const thr of [WHISK, 2 * WHISK, 4 * WHISK]) {
    const P = peel(pA, pts0, pB, thr);
    /* 剥完不剩点、或剩下的与核心线这一段处处相距不到 thr：两者分出来的料只差一条打印不出来的细缝，这一段就用核心线 */
    if (!P.length || hausdorff([pA, ...P, pB], core) < thr) return { empty: true, thr };
    last = patchOf(MF, S, st, L, A, Bn, P, coreOnly, xBase, edgeN);
    if (!last.bad) return { ...last, thr };
  }
  return last;
}

/**
 * 剥毛刺：画线在尖角处（前后两段夹角 < 90°）那个小三角形的最小高不到 thr，就去掉尖上的点，反复做到没有为止；
 * 前后两段几乎原路折回（< 3°）或有重合点的也去掉。去掉一个点只是把这个小三角形里的料划到另一侧——宽不到 thr，打印不出来。
 * 来回穿插的毛刺（去和回两条腿互相穿过、间距只有百分之几毫米）会一层层剥到根；真正有宽度的尖只削掉最尖的一点。
 */
function peel(pA, P0, pB, thr) {
  const ch = [pA, ...P0, pB];
  return peelIdx(ch, false, thr).slice(1, -1).map(i => ch[i]);
}

/** p 是不是毛刺的尖（见 peel）：与前后两点围成的小三角形在尖角处、最小高不到 thr，或有重合点、几乎原路折回 */
function thinTip(a, p, b, thr) {
  const ux = a[0] - p[0], uy = a[1] - p[1], uz = a[2] - p[2], vx = b[0] - p[0], vy = b[1] - p[1], vz = b[2] - p[2];
  const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
  if (lu < 1e-6 || lv < 1e-6) return true;
  const c = (ux * vx + uy * vy + uz * vz) / (lu * lv);
  if (c > RETRACE) return true;
  if (c <= 0) return false;
  const cr = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  return cr / Math.max(lu, lv, dist3(a, b)) < thr;
}

/** 折线 P（closed = 闭合环；不闭合时两个端点不动）剥毛刺后留下的点的序号：去掉一个点就把它的两个邻居重新排进待查队列 */
function peelIdx(P, closed, thr) {
  const n = P.length;
  const prev = new Int32Array(n), next = new Int32Array(n), alive = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) { prev[i] = i - 1; next[i] = i + 1; }
  if (closed) { prev[0] = n - 1; next[n - 1] = 0; } else next[n - 1] = -1;
  let left = n;
  const todo = [];
  for (let i = n - 1; i >= 0; i--) todo.push(i);
  const minLeft = closed ? 3 : 2;
  while (todo.length && left > minLeft) {
    const i = todo.pop();
    const a = prev[i], b = next[i];
    if (!alive[i] || a < 0 || b < 0) continue;
    if (!thinTip(P[a], P[i], P[b], thr)) continue;
    alive[i] = 0; left--;
    next[a] = b; prev[b] = a;
    todo.push(b, a);
  }
  const keep = [];
  for (let i = 0; i < n; i++) if (alive[i]) keep.push(i);
  return keep;
}

/** 两条折线之间的（对称）豪斯多夫距离：各自的点到对方折线的最远距离 */
function hausdorff(P, Q) {
  const far = (X, Y) => {
    let m = 0;
    for (const p of X) {
      let best = Infinity;
      for (let i = 0; i + 1 < Y.length; i++) {
        const a = Y[i], b = Y[i + 1];
        const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
        const l2 = ex * ex + ey * ey + ez * ez;
        const t = l2 > 0 ? clamp(((p[0] - a[0]) * ex + (p[1] - a[1]) * ey + (p[2] - a[2]) * ez) / l2, 0, 1) : 0;
        best = Math.min(best, Math.hypot(a[0] + ex * t - p[0], a[1] + ey * t - p[1], a[2] + ez * t - p[2]));
      }
      m = Math.max(m, best);
    }
    return m;
  };
  return Math.max(far(P, Q), far(Q, P));
}

/** 剥过毛刺的一段孤点 P 补底板（orphanRun 的正文）；补不出来返回 { bad: 原因 } */
function patchOf(MF, S, st, L, A, Bn, P, coreOnly, xBase, edgeN) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const pA = L[A], pB = L[Bn];
  /* 外段与外法线；切线平面上原路折回的尖拉开 */
  const pts = [];
  let blunt = 0;
  for (let i = 0; i < P.length; i++) {
    const p = P[i], fo = flangeOf(S, p), N = fo.N;
    const a = i ? P[i - 1] : pA, b = i < P.length - 1 ? P[i + 1] : pB;
    const proj = v => { const d = dot(v, N); return [v[0] - d * N[0], v[1] - d * N[1], v[2] - d * N[2]]; };
    const di = proj(sub(p, a)), dout = proj(sub(b, p));
    const li = Math.hypot(di[0], di[1], di[2]), lo = Math.hypot(dout[0], dout[1], dout[2]);
    if (li < 1e-6 || lo < 1e-6 || dot(di, dout) / (li * lo) > -0.9) { pts.push({ p, F: fo.F, N, nl: fo.nl }); continue; }
    const t = [di[0] / li, di[1] / li, di[2] / li];
    let w = proj(sub(b, a));
    const wt = dot(w, t);
    w = [w[0] - wt * t[0], w[1] - wt * t[1], w[2] - wt * t[2]];
    const u = Math.hypot(w[0], w[1], w[2]) > 1e-6 ? norm3(w) : norm3([N[1] * t[2] - N[2] * t[1], N[2] * t[0] - N[0] * t[2], N[0] * t[1] - N[1] * t[0]]);
    for (const k of [-BLUNT, BLUNT]) {
      pts.push({ p: [p[0] + k * u[0], p[1] + k * u[1], p[2] + k * u[2]], F: [fo.F[0] + k * u[0], fo.F[1] + k * u[1], fo.F[2] + k * u[2]], N, nl: fo.nl });
    }
    blunt++;
  }
  /* 各孤点的 L′ */
  const chain = [pA, ...pts.map(o => o.p), pB];
  const acc = [0];
  for (let i = 1; i < chain.length; i++) acc.push(acc[i - 1] + dist3(chain[i - 1], chain[i]));
  const tot = acc[acc.length - 1] || 1;
  const Lx = [];
  for (let i = 0; i < pts.length; i++) {
    const { p, N, nl } = pts[i];
    const b0 = st.b[A] + (st.b[Bn] - st.b[A]) * (acc[i + 1] / tot);
    let found = null;
    for (const d of [N, nl]) {
      if (!d) continue;
      let bb = b0;
      const h = raycast(S.bvh, p[0], p[1], p[2], -d[0], -d[1], -d[2], 0.02, bb + 2);
      if (h && bb > 0.45 * h.t) bb = 0.45 * h.t;
      for (let k = 0; k < 3 && !found; k++, bb *= 0.5) {
        const q = [p[0] - bb * d[0], p[1] - bb * d[1], p[2] - bb * d[2]];
        const mid = [p[0] - 0.5 * bb * d[0], p[1] - 0.5 * bb * d[1], p[2] - 0.5 * bb * d[2]];
        if (sideOf(S, q) < 0 && sideOf(S, mid) < 0) found = q;
      }
      if (found) break;
    }
    if (!found) { if (globalThis.__finSpoke) globalThis.__finSpoke({ p, N, nl, b0, A, Bn, i, P, pts, L, st, S, sideOf, raycast }); return { bad: 'spoke' }; }
    Lx.push(found);
  }
  /* 底板：L′_A → 孤点的 L′ … → L′_Bn → 核心线这一段的 L′ 倒着回到 L′_A；在它的 Newell 平面里三角化，三角形沿用这个绕向 */
  const back = coreOnly.slice().reverse();
  const Q = [st.Lp[A], ...Lx, st.Lp[Bn], ...back.map(c => st.Lp[c])];
  const ref = [[0, A], ...Lx.map((_, i) => [2, xBase + i]), [0, Bn], ...back.map(c => [0, c])];
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < Q.length; i++) {
    const a = Q[i], b = Q[(i + 1) % Q.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const nn = Math.hypot(nx, ny, nz);
  if (!(nn > 1e-12)) return { bad: 'flat' };
  const n = [nx / nn, ny / nn, nz / nn];
  const e1 = norm3(Math.abs(n[0]) < 0.9 ? [0, -n[2], n[1]] : [-n[2], 0, n[0]]);
  const e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  let Q2 = Q.map(q => [dot(q, e1), dot(q, e2)]);
  if (area2(Q2) < 0) Q2 = Q2.map(q => [-q[0], q[1]]);
  if (!(area2(Q2) > 0)) return { bad: 'flat' };
  if (globalThis.__finPatch) globalThis.__finPatch({ Q, Q2, ref, P, pts, Lx, A, Bn, coreOnly, L, st, cross: selfCross(Q2) ? crossings(Q2, 64) : [] });
  if (selfCross(Q2)) return { bad: 'cross' };
  let T0 = null;
  try { T0 = MF.triangulate([Q2], Math.max(1e-9, spanOf(Q2) * 1e-7)); } catch { T0 = null; }
  if (!T0 || T0.length !== Q.length - 2) return { bad: 'tri' };
  for (const t of T0) if (!(or2(Q2, t) > 0)) return { bad: 'tri' };
  /* 统计：重心在材料外的底板三角形；与膜在共用边上的最小法线点积 */
  let out = 0, fold = 1;
  const nB = st.Lp.length;
  for (const t of T0) {
    const a = Q[t[0]], b = Q[t[1]], c = Q[t[2]];
    if (!(sideOf(S, [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]) < 0)) out++;
    const fn = norm3([(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]);
    for (let k = 0; k < 3; k++) {
      const x = ref[t[k]], y = ref[t[(k + 1) % 3]];
      /* 底板倒着走核心边：y → x 且 x 是 y 的下一个核心点（膜上这条边是 y → x 正着走） */
      if (x[0] === 0 && y[0] === 0 && x[1] === (y[1] + 1) % nB && edgeN && edgeN[y[1]]) fold = Math.min(fold, dot(fn, edgeN[y[1]]));
    }
  }
  /* 底板翻到了膜底下（往圈里凹进去的缺口被核心线截掉时会这样）：薄片在共用边上对折，加厚方向无解，切刀会漏 */
  if (fold < 0) return { bad: 'fold' };
  return { pts: pts.map(o => ({ p: o.p, F: o.F })), Lx, tris: T0.map(t => [ref[t[0]], ref[t[1]], ref[t[2]]]), blunt, out, fold };
}

/** 膜各条边界边（c → c+1）所在三角形的法线 */
function boundaryNormals(mem) {
  const { P, T, nB } = mem;
  const edgeN = new Array(nB).fill(null);
  for (const t of T) {
    for (let k = 0; k < 3; k++) {
      const x = t[k], y = t[(k + 1) % 3];
      if (x < nB && y === (x + 1) % nB) {
        const a = P[t[0]], b = P[t[1]], c = P[t[2]];
        edgeN[x] = norm3([(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])]);
      }
    }
  }
  return edgeN;
}

/**
 * 切缝 = 过筛后的 S（seamRing 剥掉眼线 / 毛刺之后的那一圈；内核不必再对它去结、去刺、减深度）。
 * 所以没有孤点段：核心线 L 里每个点如果就在 S 上，它就是切缝点（同一个数组对象的点，靠这个认）；不在 S 上的核心点
 * （解结自己补的交点、窄带校验补的表面点、窄缝处退回老做法的点）只在核心线上。cut 为 null 时整圈退回老做法（核心线就是切缝）。
 * 返回 { S, F, sc, Lx, xs, tris, … }：S / F = 切缝各点与外段端点，sc = 切缝点对应的核心点序号（−1 = 只在切缝上），
 * tris = 窄带内段的三角形，顶点写成 [种类, 序号]（0 = 膜顶点：核心点 c 的 L′ 就是膜的第 c 个顶点；1 = 切缝点），朝向与膜一致。
 */
function seamPlan(L, sOn, st, mem, em = null) {
  const nC = L.length;
  /* 只有打上 sOn（核心线上留给切缝的点）的才算切缝点；其余核心点（悬空口子里的、窄带校验补的）只在核心线上 */
  const nS = nC;
  const iL = i => nC + i;
  const on = c => sOn && sOn[c] && sOn[c].s >= 0;
  const recs = [];
  for (let c = 0; c < nC; c++) recs.push({ p: L[c], c: on(c) ? c : -1, F: st.F[c] });
  /* 接回来的画线点（emulsify）：排在切缝点之后（1 + nC + nEm 起），外段照用；它们的 L′（em.Lx）接在 X 排后面 */
  const nEm = em ? em.S.length : 0;
  const tris = [];
  for (let i = 0; i < nS; i++) {
    const j = (i + 1) % nS;
    const Li = [0, i], Lj = [0, j];
    tris.push([Lj, Li, [1, i]], [Lj, [1, i], [1, j]]);
  }
  const emTris = [];
  if (nEm) {
    /* 接回来的点逐个连到它们自己的 L′，再在 A、B 之间连成一条窄带 */
    let prev = em.A;
    for (let i = 0; i < nEm; i++) {
      emTris.push([[0, em.B], [3, i], [2, prev]], [[0, em.B], [2, i], [3, i]]);
      prev = i;
    }
    /* A → 第一个：靠近 A 的一小段，用 A 的 L′ 连一下（像膜的边一样铺平） */
    emTris.unshift([[0, em.B], [0, em.A], [3, 0]]);
    /* 底板 */
    for (const t of em.tris) emTris.push(t);
  }
  const k = recs.filter(r => r.c >= 0).length;
  return {
    S: recs.map(r => r.p).concat(em ? em.S : []), F: recs.map(r => r.F).concat(em ? em.F : []), sc: recs.map(r => r.c), xs: recs.map(() => -1),
    Lx: em ? em.Lx : [], tris: tris.concat(emTris), nC, nEm,
    runList: [], runOfS: recs.map(() => -1), runOfX: [], runsOfCore: new Map(),
    exact: !!(sOn && k >= 3), peeled: 0, orphans: recs.filter(r => r.c < 0).length, coreOnly: nC - k,
    blunt: 0, runs: 0, runsBad: 0, badWhy: {}, whisker: 0, floating: 0, skipped: 0, peelMax: 0, patchOut: 0, fold: 1,
  };
}

/** 精确切缝切不开时，加厚方向拧不开的顶点落在哪几段孤点段上（返回这些段起点的核心点序号；下一次这几段退回老做法） */
function stuckRuns(plan, g) {
  const hit = new Set();
  const add = r => { if (r >= 0) hit.add(plan.runList[r].A); };
  const addCore = c => { const rs = plan.runsOfCore.get(c); if (rs) rs.forEach(add); };
  for (const v of g.stuck) {
    if (v < g.nB) addCore(v);
    else if (v < g.nM) continue;
    else if (v < g.nM + 2 * g.nS) { const s = (v - g.nM) % g.nS; if (plan.sc[s] >= 0) addCore(plan.sc[s]); else add(plan.runOfS[s]); }
    else add(plan.runOfX[v - g.nM - 2 * g.nS]);
  }
  return hit;
}

/* ---------- 膜：约束 Delaunay 细分 + 调和插值 ---------- */

/** 点集在 (u, v) 上的外接盒对角线长 */
function spanOf(P2) {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of P2) { if (p[0] < u0) u0 = p[0]; if (p[0] > u1) u1 = p[0]; if (p[1] < v0) v0 = p[1]; if (p[1] > v1) v1 = p[1]; }
  return Math.hypot(u1 - u0, v1 - v0);
}

/**
 * 多边形 P2（逆时针 [[u, v]]）的初始三角化 T0（逆时针，只用边界点）细分：内部边长于 h 的从中点劈开，
 * 再翻边保持 Delaunay（边界边不动），最后松弛内部点位置。返回 { V: [[u, v]], T: [[a, b, c]] }（逆时针），
 * 前 P2.length 个顶点是边界。初始三角化由调用方给：切割时用 manifold 的 triangulate，主线程预览用 earcut。
 */
function refineMesh(T0, P2, h, maxVerts = MAX_MEM_VERTS) {
  const nB = P2.length;
  const span = spanOf(P2);
  const V = P2.map(p => [p[0], p[1]]);
  const T = T0.map(t => [t[0], t[1], t[2]]);
  const SH = 4194304;
  const K = (a, b) => a * SH + b;
  const E = new Map();
  const put = i => { const t = T[i]; E.set(K(t[0], t[1]), i); E.set(K(t[1], t[2]), i); E.set(K(t[2], t[0]), i); };
  const del = i => { const t = T[i]; for (let k = 0; k < 3; k++) { const key = K(t[k], t[(k + 1) % 3]); if (E.get(key) === i) E.delete(key); } };
  for (let i = 0; i < T.length; i++) put(i);
  const opp = (i, a, b) => { const t = T[i]; for (let k = 0; k < 3; k++) if (t[k] === a && t[(k + 1) % 3] === b) return t[(k + 2) % 3]; return -1; };
  const orient = (a, b, c) => (V[b][0] - V[a][0]) * (V[c][1] - V[a][1]) - (V[b][1] - V[a][1]) * (V[c][0] - V[a][0]);
  const incircle = (a, b, c, d) => {
    const ax = V[a][0] - V[d][0], ay = V[a][1] - V[d][1], bx = V[b][0] - V[d][0], by = V[b][1] - V[d][1], cx = V[c][0] - V[d][0], cy = V[c][1] - V[d][1];
    return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
  };
  const tol = 1e-12 * span ** 4;
  /* 翻边：a→b 两侧三角形 (a,b,c)、(b,a,d)，d 落在 abc 外接圆里就翻成 (a,d,c)、(d,b,c) */
  const flip = (a, b) => {
    const i = E.get(K(a, b)), j = E.get(K(b, a));
    if (i === undefined || j === undefined) return false;
    const c = opp(i, a, b), d = opp(j, b, a);
    if (c < 0 || d < 0 || c === d) return false;
    if (!(incircle(a, b, c, d) > tol)) return false;
    if (!(orient(a, d, c) > 0) || !(orient(d, b, c) > 0)) return false;
    del(i); del(j);
    T[i] = [a, d, c]; T[j] = [d, b, c];
    put(i); put(j);
    return true;
  };
  /* 翻完 (a,d,c)、(d,b,c) 后，外围四条边 a–d、d–b、b–c、c–a 要再查 */
  const legalizeAll = stack => {
    let guard = 0;
    while (stack.length && guard++ < 400000) {
      const [a, b] = stack.pop();
      const i = E.get(K(a, b)), j = E.get(K(b, a));
      if (i === undefined || j === undefined) continue;
      const c = opp(i, a, b), d = opp(j, b, a);
      if (flip(a, b)) stack.push([a, d], [d, b], [b, c], [c, a]);
    }
  };
  const interiorEdges = () => {
    const out = [];
    for (let i = 0; i < T.length; i++) {
      const t = T[i];
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3];
        if (a < b && E.has(K(b, a))) out.push([a, b]);
      }
    }
    return out;
  };
  legalizeAll(interiorEdges());
  const len2 = (a, b) => (V[a][0] - V[b][0]) ** 2 + (V[a][1] - V[b][1]) ** 2;
  const h2 = h * h;
  for (let pass = 0; pass < 40 && V.length < maxVerts; pass++) {
    const long = interiorEdges().filter(([a, b]) => len2(a, b) > h2).sort((x, y) => len2(y[0], y[1]) - len2(x[0], x[1]));
    if (!long.length) break;
    for (const [a, b] of long) {
      if (V.length >= maxVerts) break;
      const i = E.get(K(a, b)), j = E.get(K(b, a));
      if (i === undefined || j === undefined || !(len2(a, b) > h2)) continue;
      const c = opp(i, a, b), d = opp(j, b, a);
      const m = V.length;
      V.push([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2]);
      del(i); del(j);
      T[i] = [a, m, c]; T[j] = [m, b, c];
      const k1 = T.length; T.push([b, m, d]); const k2 = T.length; T.push([m, a, d]);
      put(i); put(j); put(k1); put(k2);
      legalizeAll([[c, a], [b, c], [d, b], [a, d]]);
    }
  }
  /* 内部点松弛：挪到邻点重心，挪了会让任何一个相邻三角形翻面就不挪 */
  const nbr = Array.from({ length: V.length }, () => []);
  const inc = Array.from({ length: V.length }, () => []);
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    for (let k = 0; k < 3; k++) { inc[t[k]].push(i); const a = t[k], b = t[(k + 1) % 3]; nbr[a].push(b); nbr[b].push(a); }
  }
  for (let it = 0; it < 4; it++) {
    for (let v = nB; v < V.length; v++) {
      const nb = nbr[v];
      if (!nb.length) continue;
      let su = 0, sv = 0;
      for (const w of nb) { su += V[w][0]; sv += V[w][1]; }
      const old = V[v];
      V[v] = [su / nb.length, sv / nb.length];
      let ok = true;
      for (const i of inc[v]) { const t = T[i]; if (!(orient(t[0], t[1], t[2]) > 1e-12 * span * span)) { ok = false; break; } }
      if (!ok) V[v] = old;
    }
  }
  legalizeAll(interiorEdges());
  return { V, T };
}

/** 膜：L′ 的 (u, v) 多边形细分后，内部点高度取调和插值（边界高度 = L′ 的 w） */
function buildMembrane(MF, Lp, h) {
  const P2 = Lp.map(p => [p[0], p[1]]);
  let T0 = null;
  try { T0 = MF.triangulate([P2], Math.max(1e-9, spanOf(P2) * 1e-7)); } catch { T0 = null; }
  if (!T0 || T0.length !== P2.length - 2) return null;
  const R = refineMesh(T0, P2, h);
  if (!R) return null;
  const { V, T } = R;
  for (const t of T) {
    const a = V[t[0]], b = V[t[1]], c = V[t[2]];
    if (!((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0)) return null;
  }
  const W = harmonic(V, T, Lp);
  const P = V.map((p, i) => [p[0], p[1], W[i]]);
  return { P, T, nB: Lp.length };
}

/** 网格（前 Lp.length 个顶点是边界）上的调和插值：边界高度 = Lp 的 w，内部点取邻点平均的不动点 */
function harmonic(V, T, Lp) {
  const nB = Lp.length, nV = V.length;
  const W = new Float64Array(nV);
  for (let i = 0; i < nB; i++) W[i] = Lp[i][2];
  /* 初值：边界高度按距离反比加权；再超松弛迭代逼近调和函数 */
  const step = Math.max(1, Math.floor(nB / 400));
  for (let v = nB; v < nV; v++) {
    let s = 0, ws = 0;
    for (let i = 0; i < nB; i += step) {
      const d2 = (V[v][0] - Lp[i][0]) ** 2 + (V[v][1] - Lp[i][1]) ** 2 + 1e-9;
      const w = 1 / (d2 * d2);
      s += w * Lp[i][2]; ws += w;
    }
    W[v] = s / ws;
  }
  const nbr = Array.from({ length: nV }, () => new Set());
  for (const t of T) for (let k = 0; k < 3; k++) { nbr[t[k]].add(t[(k + 1) % 3]); nbr[t[(k + 1) % 3]].add(t[k]); }
  const NB = nbr.map(s => Int32Array.from(s));
  for (let it = 0; it < 400; it++) {
    let delta = 0;
    for (let v = nB; v < nV; v++) {
      const nb = NB[v];
      if (!nb.length) continue;
      let s = 0;
      for (let k = 0; k < nb.length; k++) s += W[nb[k]];
      const target = s / nb.length;
      const nw = W[v] + 1.7 * (target - W[v]);
      delta = Math.max(delta, Math.abs(nw - W[v]));
      W[v] = nw;
    }
    if (delta < 1e-6) break;
  }
  return W;
}

/* ---------- 膜不出材料 ---------- */

const PUSH_MAX = 1.5;       // 膜露出表面、沿 −w 往下这么远（mm）以内能回到材料里的，才压回去；更远的是膜穿过空腔 / 内腔，本来就该切开那里

/**
 * 膜是调和插值出来的高度场，只认边界（L′）的高度，不知道中间的表面长什么样：画线两段挨得近、中间的表面往下凹
 * （尖刺跨在一道折沟上），或画线围住的一片表面比边界低（洼地、擦边），膜就从表面露出来——切口落在露出来的地方，
 * 切下一片薄皮挂到另一件上（孤岛），或者斜着横穿尖刺（看上去是从画线处伸出来的一片刀片）。
 * 这里把这种浅的露出压回去：查膜的内部顶点、内部边的中点、三角形的重心，露出表面或离表面不到 clear 的地方
 * （边从中点劈开、三角形从重心劈开）加点，沿 −w 找到下面的表面，压到表面以下 clear（材料薄就压到一半厚），这些点固定，
 * 其余内部点重新做调和插值；最多 4 轮。沿 −w 往下超过 PUSH_MAX 才进材料的不动：那是膜穿过空腔 / 内腔，切空心件时必须这样。
 * 只看离表面 R 以内的地方：再远的要么深在材料里，要么悬在空腔中。边界（L′）不动——窄带校验已经保证它在材料里。
 * 返回 { pushed, split, left, rounds }
 */
function keepInside(mem, S, clear) {
  const nB = mem.nB;
  let P = mem.P, T = mem.T;
  let fixed = new Uint8Array(P.length);
  for (let i = 0; i < nB; i++) fixed[i] = 1;
  const R = PUSH_MAX + clear;
  let pushed = 0, split = 0, left = 0, rounds = 0;
  /* 带符号的离表面距离（外为正）；R 以内没有表面返回 null（深在材料里或悬在空腔中，都不管） */
  const probe = p => {
    const c = closest(S, p, R);
    if (!c) return null;
    const n = pseudoNormal(S, c.f, c.ft);
    const s = (p[0] - c.p[0]) * n[0] + (p[1] - c.p[1]) * n[1] + (p[2] - c.p[2]) * n[2];
    return s >= 0 ? c.d : -c.d;
  };
  /* 把点压到表面以下 clear；压不了（下面不是材料、或要压得太深）返回 null */
  const sink = (p, s) => {
    if (s < 0) {
      /* 在材料里、只是离表面太近：往下挪一点，不超过下面材料厚度的一半 */
      const ex = raycast(S.bvh, p[0], p[1], p[2], 0, 0, -1, 0, R);
      const room = ex ? 0.45 * ex.t : clear;
      const dz = Math.min(2 * (clear + s), room);
      return dz > 1e-4 ? [p[0], p[1], p[2] - dz] : null;
    }
    const hit = raycast(S.bvh, p[0], p[1], p[2], 0, 0, -1, 0, PUSH_MAX);
    if (!hit || !(S.nrm[hit.f * 3 + 2] > 0)) return null;
    const q = [p[0], p[1], p[2] - hit.t];
    const ex = raycast(S.bvh, q[0], q[1], q[2] - 1e-4, 0, 0, -1, 0, R);
    return [p[0], p[1], q[2] - Math.min(clear, ex ? 0.45 * ex.t : clear)];
  };
  for (; rounds < 4; rounds++) {
    const nV = P.length;
    const d = new Float64Array(nV).fill(NaN);
    let moved = 0;
    for (let v = 0; v < nV; v++) {
      const s = probe(P[v]);
      if (s === null) continue;
      d[v] = s;
      if (v < nB || s < -clear) continue;
      const q = sink(P[v], s);
      if (q) { P[v] = q; fixed[v] = 1; d[v] = -clear; moved++; } else left++;
    }
    /* 内部边：两端都在表面附近、两端「离表面的球」盖不住整条边的，查中点 */
    const eTri = new Map();
    const key = (a, b) => (a < b ? a * nV + b : b * nV + a);
    T.forEach((t, i) => { for (let k = 0; k < 3; k++) { const kk = key(t[k], t[(k + 1) % 3]); const e = eTri.get(kk); if (e) e.push(i); else eTri.set(kk, [i]); } });
    const mid = new Map();
    const NP = P.slice(), NF = Array.from(fixed);
    for (const [kk, ts] of eTri) {
      if (ts.length !== 2) continue;
      const a = Math.floor(kk / nV), b = kk % nV;
      if (!(d[a] < 0) || !(d[b] < 0)) continue;
      const len = dist3(P[a], P[b]);
      /* 两端的球（半径 = 离表面的距离）在边上相交处离表面最近，至少 (|da| + |db| − len) / 2 */
      if (-d[a] - d[b] - len >= 2 * clear) continue;
      const m = [(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2, (P[a][2] + P[b][2]) / 2];
      const s = probe(m);
      if (s === null || s < -clear) continue;
      const q = sink(m, s);
      if (!q) { left++; continue; }
      mid.set(kk, NP.length); NP.push(q); NF.push(1); split++; moved++;
    }
    /* 三角形：三个顶点都在表面附近、又没有边要劈的，查重心 */
    const NT = [];
    for (const t of T) {
      const e = [mid.get(key(t[0], t[1])) ?? -1, mid.get(key(t[1], t[2])) ?? -1, mid.get(key(t[2], t[0])) ?? -1];
      const k = (e[0] >= 0) + (e[1] >= 0) + (e[2] >= 0);
      if (k === 0) {
        if (d[t[0]] < 0 && d[t[1]] < 0 && d[t[2]] < 0) {
          const g = [0, 1, 2].map(q => (P[t[0]][q] + P[t[1]][q] + P[t[2]][q]) / 3);
          /* 重心落在某个顶点的球里、离表面还有 clear 就不用查 */
          const r = Math.min(...t.map(v => dist3(P[v], g) + d[v]));
          if (r > -clear) {
            const s = probe(g);
            const q = s !== null && s >= -clear ? sink(g, s) : null;
            if (q) {
              const gi = NP.length; NP.push(q); NF.push(1); split++; moved++;
              NT.push([t[0], t[1], gi], [t[1], t[2], gi], [t[2], t[0], gi]);
              continue;
            }
            if (s !== null && s >= -clear) left++;
          }
        }
        NT.push(t);
        continue;
      }
      /* 有边劈开：转到第一条劈开的边在 0 号位，分 1 / 2 / 3 条三种情况 */
      let r = 0;
      if (k === 2) { while (!(e[r] >= 0 && e[(r + 1) % 3] >= 0)) r++; } else while (!(e[r] >= 0)) r++;
      const v0 = t[r], v1 = t[(r + 1) % 3], v2 = t[(r + 2) % 3];
      const m01 = e[r], m12 = e[(r + 1) % 3], m20 = e[(r + 2) % 3];
      if (k === 1) NT.push([v0, m01, v2], [m01, v1, v2]);
      else if (k === 2) NT.push([m01, v1, m12], [v0, m01, m12], [v0, m12, v2]);
      else NT.push([v0, m01, m20], [m01, v1, m12], [m20, m12, v2], [m01, m12, m20]);
    }
    P = NP; T = NT; fixed = Uint8Array.from(NF);
    pushed += moved;
    if (!moved) break;
    /* 固定的点（边界 + 压过的）不动，其余内部点重新调和插值（从现在的高度起步，收敛很快） */
    relax(P, T, fixed);
  }
  mem.P = P; mem.T = T;
  return { pushed, split, left, rounds };
}

/** 调和插值：fixed 的点高度不动，其余点取邻点平均的不动点（超松弛；从 P 现在的高度起步） */
function relax(P, T, fixed) {
  const nV = P.length;
  const nbr = Array.from({ length: nV }, () => new Set());
  for (const t of T) for (let k = 0; k < 3; k++) { nbr[t[k]].add(t[(k + 1) % 3]); nbr[t[(k + 1) % 3]].add(t[k]); }
  const NB = nbr.map(x => Int32Array.from(x));
  for (let it = 0; it < 400; it++) {
    let delta = 0;
    for (let v = 0; v < nV; v++) {
      if (fixed[v]) continue;
      const nb = NB[v];
      if (!nb.length) continue;
      let s = 0;
      for (let k = 0; k < nb.length; k++) s += P[nb[k]][2];
      const nw = P[v][2] + 1.7 * (s / nb.length - P[v][2]);
      delta = Math.max(delta, Math.abs(nw - P[v][2]));
      P[v] = [P[v][0], P[v][1], nw];
    }
    if (delta < 1e-6) break;
  }
}

/* ---------- 预览（主线程） ---------- */

/** 画线去掉小结与折返尖刺（与切割时同一套，只是不吸回表面）；还自己交叉就返回 null。结果逆时针 */
function tidyLoop(L0) {
  if (L0.length < 3) return null;
  let L = L0.map(p => p.slice());
  if (area2(L) < 0) L.reverse();
  L = untangle(L, null, 2.0);
  L = despike(L).map(i => L[i]);
  return L.length < 3 || selfCross(L) || !(area2(L) > 0) ? null : L;
}

/** 画线（局部系 [[u, v, w]]）在切面方向上自己交叉、围不出一张切面：界面据此禁用「切割」。拐角处的小结、折返尖刺不算（切割时会去掉） */
export const loopTangled = L0 => L0.length >= 3 && !tidyLoop(L0);

/**
 * 切面预览（主线程，不碰模型）：与切割时同一种膜——画线围成的一圈在 (u, v) 上三角化、加密，内部高度取调和插值。
 * 切割时膜挂在画线往材料里收 0.1～0.6 mm 的那一圈上，预览直接挂在画线上（差这一圈窄带，看不出来）。
 * triangulate(P2) → [[a, b, c]]：主线程没有 manifold，由调用方给（cutLine.js 用 three 自带的 earcut）。
 * 返回 { P: [[u, v, w]]（前 nB 个是整理后的画线）, T: [[a, b, c]], nB, heightAt(u, v) }（不在膜上 NaN），画线自交 / 三角化失败返回 null。
 */
export function previewMembrane(L0, triangulate, opts = {}) {
  const L = tidyLoop(L0);
  if (!L) return null;
  const P2 = L.map(p => [p[0], p[1]]);
  let T0 = null;
  try { T0 = triangulate(P2); } catch { T0 = null; }
  if (!T0 || !T0.length) return null;
  const or = t => (P2[t[1]][0] - P2[t[0]][0]) * (P2[t[2]][1] - P2[t[0]][1]) - (P2[t[1]][1] - P2[t[0]][1]) * (P2[t[2]][0] - P2[t[0]][0]);
  /* earcut 的绕向不一定与我们一致，统一成逆时针；面积为 0 的（共线点）去掉 */
  T0 = T0.filter(t => or(t) !== 0).map(t => (or(t) > 0 ? [t[0], t[1], t[2]] : [t[0], t[2], t[1]]));
  if (!T0.length) return null;
  const h = clamp(Math.sqrt(area2(L) / 2) / (opts.cells || 18), 0.25, 4);
  const R = refineMesh(T0, P2, h, opts.maxVerts || 3000);
  if (!R) return null;
  const T = R.T.filter(t => or2(R.V, t) > 0);
  if (!T.length) return null;
  const W = harmonic(R.V, T, L);
  const mem = { P: R.V.map((p, i) => [p[0], p[1], W[i]]), T, nB: L.length };
  return { P: mem.P, T, nB: L.length, heightAt: heightLookup(mem) };
}
const or2 = (V, t) => (V[t[1]][0] - V[t[0]][0]) * (V[t[2]][1] - V[t[0]][1]) - (V[t[1]][1] - V[t[0]][1]) * (V[t[2]][0] - V[t[0]][0]);

/** 膜上 (u, v) 处的高度（重心插值，网格分桶）；不在膜上返回 NaN */
function heightLookup(mem) {
  const { P, T } = mem;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of P) { if (p[0] < u0) u0 = p[0]; if (p[0] > u1) u1 = p[0]; if (p[1] < v0) v0 = p[1]; if (p[1] > v1) v1 = p[1]; }
  const G = Math.max(4, Math.ceil(Math.sqrt(T.length / 2)));
  const cu = (u1 - u0) / G || 1, cv = (v1 - v0) / G || 1;
  const cells = Array.from({ length: G * G }, () => []);
  T.forEach((t, i) => {
    const xs = t.map(k => P[k][0]), ys = t.map(k => P[k][1]);
    const gx0 = clamp(Math.floor((Math.min(...xs) - u0) / cu), 0, G - 1), gx1 = clamp(Math.floor((Math.max(...xs) - u0) / cu), 0, G - 1);
    const gy0 = clamp(Math.floor((Math.min(...ys) - v0) / cv), 0, G - 1), gy1 = clamp(Math.floor((Math.max(...ys) - v0) / cv), 0, G - 1);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) cells[gy * G + gx].push(i);
  });
  return (u, v) => {
    const gx = Math.floor((u - u0) / cu), gy = Math.floor((v - v0) / cv);
    if (gx < 0 || gy < 0 || gx >= G || gy >= G) return NaN;
    for (const i of cells[gy * G + gx]) {
      const [i0, i1, i2] = T[i];
      const p0 = P[i0], p1 = P[i1], p2 = P[i2];
      const den = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1]);
      if (Math.abs(den) < 1e-14) continue;
      const w1 = ((p1[1] - p2[1]) * (u - p2[0]) + (p2[0] - p1[0]) * (v - p2[1])) / den;
      const w2 = ((p2[1] - p0[1]) * (u - p2[0]) + (p0[0] - p2[0]) * (v - p2[1])) / den;
      const w0 = 1 - w1 - w2;
      if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
      return w0 * p0[2] + w1 * p1[2] + w2 * p2[2];
    }
    return NaN;
  };
}

/* ---------- 切刀 ---------- */

/**
 * 切面的几何（还没建 Manifold）：膜（顶点 0..nM−1，前 nB 个是核心线的 L′）+ 窄带（切缝 S、外段 F 两排；内段按 plan.tris
 * 连到核心线的 L′ 或孤点自己的 L′，后者排在最后）的三角形与类别，以及每个顶点往 + 侧加厚的方向。
 * 加厚方向先取面积加权的顶点法线，再朝点积最小的那张面拧，直到与周围每张面的法线点积都 ≥ 0.25：窄带在急拐角、法线突变处扭过来时，
 * 面积平均的法线会落到某些面的背面，那里薄片厚度为负，split 时这一小块不算在切刀里，切刀就漏了（实测躯干件漏在这种地方）。
 * 怎么拧都有面在背面（窄带真的折过来了）的顶点记进 stuck。
 */
function cutterGeom(mem, plan) {
  const { P, T } = mem;
  const SS = plan.S, F = plan.F;
  const nS = SS.length, nM = P.length;
  const iL = i => nM + i, iF = i => nM + nS + i;
  const NB = nM + 2 * nS + plan.Lx.length;
  const base = [...P, ...SS, ...F, ...plan.Lx];
  for (const t of plan.tris) for (const r of t) if (!base[r[0] === 0 ? r[1] : r[0] === 1 ? nM + r[1] : nM + 2 * nS + r[1]]) { if (globalThis.__finK) globalThis.__finK({ badRef: r, nM, nS, P: P.length, S: SS.length, F: F.length, tris: plan.tris.slice(0, 5) }); }
  /* 切面（+ 朝向，法线指向上件一侧）的三角形与类别 */
  const tri = [], cat = [];
  for (const t of T) { tri.push(t[0], t[1], t[2]); cat.push(MEM); }
  const vx = r => (r[0] === 0 ? r[1] : r[0] === 1 ? nM + r[1] : r[0] === 3 ? nM + plan.nC + r[1] : nM + 2 * nS + r[1]);
  for (const t of plan.tris) { tri.push(vx(t[0]), vx(t[1]), vx(t[2])); cat.push(IN); }
  for (let i = 0; i < nS; i++) {
    const j = (i + 1) % nS;
    tri.push(iL(j), iL(i), iF(i), iL(j), iF(i), iF(j)); cat.push(OUT, OUT);
  }
  const nf = tri.length / 3;
  const fn = new Float64Array(nf * 3), ok = new Uint8Array(nf), vn = new Float64Array(NB * 3);
  const deg = new Int32Array(NB + 1);
  for (let k = 0; k < tri.length; k++) deg[tri[k] + 1]++;
  for (let v = 0; v < NB; v++) deg[v + 1] += deg[v];
  const inc = new Int32Array(tri.length), fill = deg.slice(0, NB);
  for (let f = 0; f < nf; f++) {
    const a = base[tri[f * 3]], b = base[tri[f * 3 + 1]], c = base[tri[f * 3 + 2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 1e-14) { fn[f * 3] = nx / l; fn[f * 3 + 1] = ny / l; fn[f * 3 + 2] = nz / l; ok[f] = 1; }
    for (let q = 0; q < 3; q++) { const v = tri[f * 3 + q]; inc[fill[v]++] = f; vn[v * 3] += nx; vn[v * 3 + 1] += ny; vn[v * 3 + 2] += nz; }
  }
  const dir = new Float64Array(NB * 3);
  const stuck = [];
  for (let v = 0; v < NB; v++) {
    let d = norm3([vn[v * 3], vn[v * 3 + 1], vn[v * 3 + 2]]);
    let worst = Infinity;
    for (let it = 0; it < 32; it++) {
      worst = Infinity;
      let wf = -1;
      for (let e = deg[v]; e < deg[v + 1]; e++) {
        const f = inc[e];
        if (!ok[f]) continue;
        const s = d[0] * fn[f * 3] + d[1] * fn[f * 3 + 1] + d[2] * fn[f * 3 + 2];
        if (s < worst) { worst = s; wf = f; }
      }
      if (wf < 0 || worst >= 0.25) break;
      d = norm3([d[0] + 0.5 * fn[wf * 3], d[1] + 0.5 * fn[wf * 3 + 1], d[2] + 0.5 * fn[wf * 3 + 2]]);
    }
    if (worst < 0.02) stuck.push(v);
    dir[v * 3] = d[0]; dir[v * 3 + 1] = d[1]; dir[v * 3 + 2] = d[2];
  }
  const xSeam = new Int32Array(plan.Lx.length);
  plan.xs.forEach((x, s) => { if (x >= 0) xSeam[x] = s; });
  return { base, tri, cat, NB, nM, nS, nB: mem.nB, sc: plan.sc, xSeam, dir, stuck };
}

/**
 * 切面在哪几个核心点处折过来了（L′ / 切缝 / F / 孤点 L′ 各排顶点拧不开的），返回核心点序号；膜内部的点不算（膜是 (u, v) 上的图，不会折）。
 * 切缝上的孤点（及其 L′）折了，算到最近的核心点上（重试只改核心线）
 */
function foldsOf(g) {
  const s = new Set();
  for (const v of g.stuck) {
    if (v < g.nB) { s.add(v); continue; }
    if (v < g.nM) continue;
    const si = v >= g.nM + 2 * g.nS ? g.xSeam[v - g.nM - 2 * g.nS] : (v - g.nM) % g.nS;
    let c = g.sc[si];
    for (let k = 1; c < 0 && k < g.nS; k++) {
      c = g.sc[(si + k) % g.nS];
      if (c < 0) c = g.sc[(si - k + g.nS) % g.nS];
    }
    if (c >= 0) s.add(c);
  }
  return s;
}

/** 切刀：切面沿各顶点的加厚方向向两侧各让 gap/2，薄片总厚 = gap（装配间隙），faceID 带类别 */
function cutterOf(MF, g, id, gap = 0) {
  const { base, tri, cat, NB, nM, nS: n, dir } = g;
  /* gap > 0：薄片以切面为中心、总厚 = gap（两件各让 gap/2，留装配间隙）；
     gap = 0：回到老行为——薄片只往 + 侧厚 EPS（两件零间隙贴合，严格互补） */
  const lo = gap > 0 ? gap / 2 : 0;
  const hi = gap > 0 ? gap / 2 : EPS;
  const iF = i => nM + n + i;
  const V = new Float32Array(NB * 6);
  for (let v = 0; v < NB; v++) {
    const p = base[v];
    V[v * 3] = p[0] - lo * dir[v * 3]; V[v * 3 + 1] = p[1] - lo * dir[v * 3 + 1]; V[v * 3 + 2] = p[2] - lo * dir[v * 3 + 2];
    V[(NB + v) * 3] = p[0] + hi * dir[v * 3]; V[(NB + v) * 3 + 1] = p[1] + hi * dir[v * 3 + 1]; V[(NB + v) * 3 + 2] = p[2] + hi * dir[v * 3 + 2];
  }
  const out = [], oc = [];
  const TOP = { [MEM]: MEM_T, [IN]: IN_T, [OUT]: OUT_T };
  for (let k = 0, f = 0; k < tri.length; k += 3, f++) {
    out.push(tri[k], tri[k + 2], tri[k + 1]); oc.push(cat[f]);                          // 底面（朝 −）
    out.push(NB + tri[k], NB + tri[k + 1], NB + tri[k + 2]); oc.push(TOP[cat[f]]);        // 顶面（朝 +）
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    out.push(iF(i), iF(j), NB + iF(j), iF(i), NB + iF(j), NB + iF(i)); oc.push(RIM, RIM);
  }
  const nt = out.length / 3;
  const faceID = new Uint32Array(nt);
  for (let f = 0; f < nt; f++) faceID[f] = f * CATS + oc[f];
  const mk = idx => {
    try {
      const m = new MF.Manifold(new MF.Mesh({
        numProp: 3, vertProperties: V, triVerts: Uint32Array.from(idx),
        runIndex: Uint32Array.from([0, idx.length]), runOriginalID: Uint32Array.from([id]), faceID,
      }));
      if (m.status() === 'NoError' && !m.isEmpty()) return m;
      m.delete();
    } catch { /* 下面报错 */ }
    return null;
  };
  return mk(out);
}

/** 膜沿 +w 挤出的棱柱（销用的切刀 C）：底面 = 膜，顶面 = 膜 + depth，四周沿 L′ 封墙 */
function prismOf(MF, mem, depth) {
  const { P, T, nB } = mem;
  const nV = P.length;
  const V = new Float32Array(nV * 6);
  for (let i = 0; i < nV; i++) {
    V[i * 3] = P[i][0]; V[i * 3 + 1] = P[i][1]; V[i * 3 + 2] = P[i][2];
    V[(nV + i) * 3] = P[i][0]; V[(nV + i) * 3 + 1] = P[i][1]; V[(nV + i) * 3 + 2] = P[i][2] + depth;
  }
  const idx = [];
  for (const t of T) { idx.push(t[0], t[2], t[1]); idx.push(nV + t[0], nV + t[1], nV + t[2]); }
  for (let i = 0; i < nB; i++) { const j = (i + 1) % nB; idx.push(i, j, nV + j, i, nV + j, nV + i); }
  try {
    const m = new MF.Manifold(new MF.Mesh({ numProp: 3, vertProperties: V, triVerts: Uint32Array.from(idx) }));
    if (m.status() === 'NoError' && !m.isEmpty() && m.volume() > 0) return m;
    m.delete();
  } catch { /* 不加销 */ }
  return null;
}

/* ---------- 分件 ---------- */

/** 一块（split 的输出分量）：体积、面积、切刀各类别的面积、切刀面上的顶点（位置逐位做键） */
function partInfo(m, kid) {
  const mesh = m.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts;
  const ri = mesh.runIndex, ro = mesh.runOriginalID, fid = mesh.faceID;
  const catArea = new Float64Array(CATS);
  const keys = new Map();   // 键 → 类别位（1 = 真切口底、2 = 真切口顶、4 = 假切口）
  const bits = new Uint32Array(vp.buffer, vp.byteOffset, vp.length);
  for (let r = 0; r < ro.length; r++) {
    if (ro[r] !== kid) continue;
    for (let t = ri[r] / 3; t < ri[r + 1] / 3; t++) {
      const c = fid[t] % CATS;
      const a = tv[t * 3] * np, b = tv[t * 3 + 1] * np, d = tv[t * 3 + 2] * np;
      const ux = vp[b] - vp[a], uy = vp[b + 1] - vp[a + 1], uz = vp[b + 2] - vp[a + 2];
      const wx = vp[d] - vp[a], wy = vp[d + 1] - vp[a + 1], wz = vp[d + 2] - vp[a + 2];
      catArea[c] += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
      const bit = c === MEM || c === IN ? 1 : c === MEM_T || c === IN_T ? 2 : 4;
      for (const o of [a, b, d]) {
        const k = bits[o] + ',' + bits[o + 1] + ',' + bits[o + 2];
        keys.set(k, (keys.get(k) || 0) | bit);
      }
    }
  }
  return {
    m, vol: m.volume(), area: m.surfaceArea(), tris: tv.length / 3,
    top: catArea[MEM_T] + catArea[IN_T], bot: catArea[MEM] + catArea[IN],
    art: catArea[OUT] + catArea[OUT_T] + catArea[RIM], keys,
  };
}

/**
 * 分件：A（上件）/ B（下件）。
 * 1. Mout 各块：挨着真切口顶面（+ 侧）的归 A，挨着真切口底面的归 B；两面都大量挨着 = 这一刀切不开。
 * 2. 薄片层（Lin）各块：有真切口、且顶面挨着 A 块 → 粘到 A（切口就在薄片底面 = 切面上）；其余按接触最多的邻居。
 * 3. 没归属的块（假切口切下来的、没碰到切刀的）：按接触最多的已归属邻居，反复传播；最后还没有的看位置。
 * 4. 零碎块（体积远小于同侧主体、或薄成一片）且挨着另一侧的，粘回另一侧——不留飞边。
 */
function classify(parts, nOut, ctx) {
  const n = parts.length;
  const side = new Array(n).fill(0);   // 1 = A，−1 = B，0 = 未定
  /* 接触：同一位置的切刀顶点 */
  const owners = new Map();
  parts.forEach((p, i) => { for (const [k, bit] of p.keys) { let o = owners.get(k); if (!o) owners.set(k, o = []); o.push([i, bit]); } });
  const contact = Array.from({ length: n }, () => new Map());   // i → (j → [次数, 经过真切口顶面的次数])
  for (const o of owners.values()) {
    if (o.length < 2) continue;
    for (let x = 0; x < o.length; x++) for (let y = 0; y < o.length; y++) {
      if (x === y) continue;
      const [i, bi] = o[x], [j] = o[y];
      const c = contact[i].get(j) || [0, 0];
      c[0]++;
      if (bi & 2) c[1]++;
      contact[i].set(j, c);
    }
  }
  for (let i = 0; i < nOut; i++) {
    const p = parts[i];
    const hi = Math.max(p.top, p.bot), lo = Math.min(p.top, p.bot);
    if (hi <= 0) continue;
    if (lo > 0.05 * hi && lo > 0.5) return { err: 'NOT_SEPARATING' };
    side[i] = p.top >= p.bot ? 1 : -1;
  }
  for (let i = nOut; i < n; i++) {
    const p = parts[i];
    if (p.top + p.bot <= 0) continue;
    let best = -1, bc = 0;
    for (const [j, c] of contact[i]) if (j < nOut && side[j] === 1 && c[1] > bc) { bc = c[1]; best = j; }
    if (best >= 0) side[i] = 1;
  }
  for (let round = 0; round < n + 2; round++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (side[i]) continue;
      let best = 0, bc = 0;
      for (const [j, c] of contact[i]) if (side[j] && c[0] > bc) { bc = c[0]; best = side[j]; }
      if (best) { side[i] = best; changed = true; }
    }
    if (!changed) break;
  }
  for (let i = 0; i < n; i++) if (!side[i]) side[i] = ctx.place(parts[i]);
  const side0 = side.slice();
  /* 零碎块：同侧按接触连成组，比主体小很多或很薄、又挨着另一侧的整组翻过去 */
  let flipped = 0;
  for (let pass = 0; pass < 3; pass++) {
    const grp = new Int32Array(n).fill(-1);
    const groups = [];
    for (let i = 0; i < n; i++) {
      if (grp[i] >= 0) continue;
      const g = { members: [], vol: 0, area: 0, side: side[i], other: 0 };
      const st = [i]; grp[i] = groups.length;
      while (st.length) {
        const x = st.pop();
        g.members.push(x); g.vol += parts[x].vol; g.area += parts[x].area;
        for (const [y, c] of contact[x]) {
          if (side[y] === side[x]) { if (grp[y] < 0) { grp[y] = groups.length; st.push(y); } }
          else g.other += c[0];
        }
      }
      groups.push(g);
    }
    let changed = false;
    for (const s of [1, -1]) {
      const gs = groups.filter(g => g.side === s);
      if (gs.length < 2) continue;
      const main = gs.reduce((a, b) => (b.vol > a.vol ? b : a));
      for (const g of gs) {
        if (g === main || !g.other) continue;
        const thick = 2 * g.vol / Math.max(g.area, 1e-12);
        if (g.vol < DEBRIS_FRAC * main.vol || thick < DEBRIS_THICK) {
          for (const x of g.members) side[x] = -s;
          flipped += g.members.length; changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return { side, flipped, contact, side0 };
}

/* ---------- 入口 ---------- */

/**
 * 沿画线切。ctx = { Mp, bb, fr, loop, spec, T, ms, warn }（同 cutCurved）；L = 局部系画线 [[u, v, w]]。
 * 返回 { upper, lower, pin, islands, picked, iou, area, merged, comps, sheet } 或 { err }。
 */
export function cutSeam(MF, ctx, L0) {
  try { return cutSeam2(MF, ctx, L0); } catch (e) {
    if (globalThis.__finErrSave) globalThis.__finErrSave(e);
    console.error("CUTSEAM ERROR", e && e.stack);
    throw e;
  }
}
function cutSeam2(MF, ctx, L0) {
  const { Manifold } = MF;
  const { Mp, bb, fr, spec, T, ms, warn } = ctx;
  /* 装配间隙：切刀按这个厚度切，两件之间就留这么宽的缝（打印公差、拼合顶住都靠它）。
     内核默认 0 = 老行为：薄片只有 EPS 厚，两件零间隙贴合（严格的几何互补，测试与基准都用这个口径）；
     应用里由 params.cutGap 传进来（默认 0.1 mm） */
  const gap = clamp(typeof ctx.gap === 'number' ? ctx.gap : 0, 0, 0.8);
  const dropLayer = gap > EPS + 1e-6;      // 有间隙时，切刀内部那一层材料整层挖掉（两件各让 gap/2）
  let t = performance.now();
  const lap = key => { ms[key] = +(performance.now() - t).toFixed(1); t = performance.now(); };
  const notSeparating = () => ({ err: fail('NOT_SEPARATING', '沿这条画线没能把模型分开，原模型没有改动。请调整画线位置，或换一个方向画线；切口不会延伸到画线以外') });

  let L = L0.map(p => p.slice());
  if (area2(L) < 0) L.reverse();
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of L) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const pad = 3;
  const S = surfaceIndex(Mp, lo.map(v => v - pad), hi.map(v => v + pad));
  if (!S.n) return { err: fail('PLANE_MISS', '画线不在模型表面上，请重画') };
  const Sscan = S;   // 调试：表面索引
  lap('index');

  const dz = densify(L, S);
  L = [];
  for (const p of dz.L) {
    const q = L[L.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) >= 0.02) L.push(p);
  }
  while (L.length > 3 && Math.hypot(L[0][0] - L[L.length - 1][0], L[0][1] - L[L.length - 1][1], L[0][2] - L[L.length - 1][2]) < 0.02) L.pop();
  /* 画线点吸回表面（应用里取的点本来就在表面上，差的只是浮点误差；窄带要从表面上起步） */
  L = L.map(p => { const c = closest(S, p); return c && c.d < 0.3 ? c.p.slice() : p; });
  if (globalThis.__finStage) globalThis.__finStage("snap", L, ctx.fr);
  const LfDbg = L.slice();
  const S0 = S;
  /* 切缝就是这一圈（用户画线加密、吸回表面后的全部点）：先过筛成 S（seamRing——剥掉眼线 / 毛刺、拆开自交，
     让切缝自己就是一条最小宽够、不自交的轮廓），再交给核心线：核心线从 S 起步，S 就是它最初的一圈，L 里的点与 S 里的是同一个数组对象 */
  const ring = seamRing(L, S, p => closest(S, p));
  if (globalThis.__finRing) globalThis.__finRing(ring, LfDbg, S);
  const Lf = L.slice();
  const __ring = ring;
  let cut0 = ring.S;      // 切缝点集（null = 整圈退回：核心线就是切缝）
  if (globalThis.__finRing) globalThis.__finRing(ring, Lf);
  /* 切缝圈已经验过是自己不交叉的简单轮廓：核心线就从它起步，不再解结 / 去刺（那样会把切缝挤歪）。
     只有画线本身围不出一张切面（绕成「8」字）时才报错——那是真的分不开 */
  L = cut0;
  if (!(area2(L) > 0) || selfCross(L)) {
    /* 画线本身（预览用的同一套整理）不交叉、沿表面接起来才交叉：多半是线在边缘处从一个面跳到了被挡住的另一个面上，
       沿表面绕过边缘的那一截在切面方向上与旁边的线叠在一起。界面上预览是好的，提示要说清楚是哪种情况 */
    if (tidyLoop(L0)) {
      return { err: fail('LINE_TANGLED', '画线有一段在边缘处从一个面跳到了被挡住的另一个面上，沿表面接起来后与旁边的线在切面方向上叠在一起了。请转到能看清这一段的角度，在边缘处多点几个点重画；或把「切面」改成「平面」') };
    }
    return { err: fail('LINE_TANGLED', '画线在切面方向上自己交叉了（线绕成了「8」字或重叠），围不出一张切面。请重画一圈：不要交叉、不要重叠') };
  }
  const areaUV = Math.abs(area2(L)) / 2;
  const req = {
    bCap: Math.max(0.05, 0.12 * Math.sqrt(areaUV / Math.PI)),
    /* 切口下沉量（mm，沿 −w 直下）：0 = 老口径（窄带跟着表面法线，0.08～0.6，矮处会切不透）。
       应用里由 params.cutWall 传进 ctx.wall（默认 2 mm） */
    wall: clamp(typeof ctx.wall === 'number' ? ctx.wall : 0, 0, 8),
    /* 下沉时往下偏移的水平量（mm）：0.5 足够做出斜度，又远小于局部曲率半径，不会让 L′ 自交 */
    inset: clamp(typeof ctx.inset === 'number' ? ctx.inset : 0.5, 0, 1.5),
    /* 倒角（mm，沿 −N 贴着表面斜切的那一段）：下沉模式先斜着走这么深再垂直下扎，
       既顺着表面的褶皱（不削出城墙垛口），边缘也不是直角 */
    chamfer: clamp(typeof ctx.chamfer === 'number' ? ctx.chamfer : 0.5, 0.1, 3),
  };
  /* 每点的附加属性：scale = L′ 深度系数，mode = 1 时窄带改用画线处的外法线，fmul = 外段长度系数，
     nd = 进材料方向覆盖（凹拐角平滑用，null = 用算出来的法线），bfix = 深度锁定（0 = 不锁）；插点 / 删点时一起维护 */
  let n0 = ring.S.length;   // 切缝圈的点数（剥完眼线 / 毛刺之后，记序号用）
  let sOn = null;   // 每个核心点：{ s: 在切缝 S 上的序号，s0: 剥之前画线上的序号，adj: 下一颗就是 S 上的下一颗 }，null = 只是核心线上的点
  let PA = {
    scale: new Float64Array(L.length).fill(1), mode: new Uint8Array(L.length),
    fmul: new Float64Array(L.length).fill(1), nd: new Array(L.length).fill(null), bfix: new Float64Array(L.length), excl: new Uint8Array(L.length),
  };
  const pick = idx => {
    L = idx.map(i => L[i]);
    PA = {
      scale: Float64Array.from(idx, i => PA.scale[i]), mode: Uint8Array.from(idx, i => PA.mode[i]),
      fmul: Float64Array.from(idx, i => PA.fmul[i]), nd: idx.map(i => PA.nd[i]), bfix: Float64Array.from(idx, i => PA.bfix[i]), excl: Uint8Array.from(idx, i => PA.excl[i]),
    };
    if (sOn) sOn = idx.map((i, k) => { const e = sOn[i]; if (!e) return null; const adj = (k + 1 < idx.length ? idx[k + 1] : idx[0] + L.length) - idx[k]; return { s: e.s, adj: adj === 1 ? 1 : 0 }; });
  };
  const h = clamp(Math.sqrt(areaUV) / 24, 0.35, 2.5);
  const kid = Manifold.reserveIDs(1);
  /* 体积 ≈ 0 的小块直接丢掉：布尔在几乎共面处切出的小四面体，以及原网格自带、挂在主体顶点上的零体积碎片
     （Head 有 64 个，最多 78 个面，所以不按面数判）。留着既没用，又让后面的并集 / 拼合慢好几倍。
     不到 1e-5 mm³ 的真材料只可能是切刀薄层在边上削下的一粒，丢掉只少一个打印不出来的小点 */
  const real = m => Math.abs(m.volume()) >= 1e-5;
  let st = null, mem = null, geo = null, plan = null, inside = null, fellBack = false, trimmed = 0, crossFix = 0, smoothFix = 0, fixRounds = 0, badLeft = 0, inserted = 0, dropped = 0, folds = 0;
  let outs = null, ins = null, parts = null, look = null, loopUV = null, cl = null;
  /* 窄带校验过不了的点怎么补：过不了的辐条先改用外法线（mode）、还不行就去掉这个点；过不了的边在中间补一个表面点。
     逐点 / 逐边有一份状态（drop / mode1 / ins），换上一圈点时一起维护 */
  const patchOf = bad => {
    const n = L.length;
    const drop = new Uint8Array(n), mode1 = new Uint8Array(n), ins = new Array(n).fill(null);
    for (let i = 0; i < n; i++) if (bad.spoke[i]) (PA.mode[i] ? drop : mode1)[i] = 1;
    for (let i = 0; i < n; i++) {
      if (!bad.edge[i]) continue;
      const j = (i + 1) % n, a = L[i], b = L[j];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const c = len > 0.03 ? closest(S, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]) : null;
      if (c && c.d < 0.5 * len) ins[i] = c.p.slice();
      else if (!PA.mode[i] || !PA.mode[j]) mode1[i] = mode1[j] = 1;
      else drop[j] = 1;
    }
    return { drop, mode1, ins };
  };
  /** 按 patchOf 的补法换上一圈核心线（去掉的点、补的表面点都记数） */
  const applyPatch = pt => {
    const n = L.length;
    const NL = [], sc = [], md = [], fm = [], nn = [], bf = [], ex = [], so = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (!pt.drop[i]) { NL.push(L[i]); sc.push(PA.scale[i]); md.push(PA.mode[i] | pt.mode1[i]); fm.push(PA.fmul[i]); nn.push(PA.nd[i]); bf.push(PA.bfix[i]); ex.push(PA.excl[i]); so.push(sOn ? sOn[i] : null); } else dropped++;
      if (pt.ins[i]) {
        NL.push(pt.ins[i]); sc.push((PA.scale[i] + PA.scale[j]) / 2); md.push(PA.mode[i] & PA.mode[j]);
        fm.push(Math.min(PA.fmul[i], PA.fmul[j])); nn.push(null); bf.push(0); ex.push(0); so.push(null); inserted++;
      }
    }
    L = NL;
    PA = { scale: Float64Array.from(sc), mode: Uint8Array.from(md), fmul: Float64Array.from(fm), nd: nn, bfix: Float64Array.from(bf), excl: Uint8Array.from(ex) };
    sOn = so;
  };
  /** 切缝点还在核心线上吗：核心线被解结 / 修折大动过后序号可能对不上，那就整圈退回老做法 */
  const here = () => sOn && sOn.filter(Boolean).length >= 3;
  /**
   * 核心线 L′ 交叉、而切缝不许动：只对离切缝最近的几对交叉点做局部平滑（fixCorners），
   * 不动切缝点本身（它们连着切缝，L′ 一挪切缝就歪）。改的是核心线自己补的点 / 窄带的进材料方向。
   * 一处都改不了就整圈退回老做法（不能用交叉着的 L′ 下刀：切刀在交叉处翻面漏缝、切缝从别处穿出去）
   */
  const repairCore = () => {
    if (smoothFix >= 12) return false;
    const n = L.length;
    const onCut = new Uint8Array(n);
    let nOn = 0;
    for (let i = 0; i < n; i++) if (sOn && sOn[i]) { onCut[i] = 1; nOn++; }
    if (!nOn || nOn === n) return false;
    const distToCut = i => {
      const p = L[i];
      let best = Infinity;
      for (let k = 0; k < n; k++) if (onCut[k]) { const q = L[k]; const d = Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]); if (d < best) best = d; }
      return best;
    };
    const rank = [];
    for (const [i, j] of crossings(st.Lp, 256)) rank.push([Math.min(distToCut(i), distToCut(j)), i, j]);
    rank.sort((x, y) => x[0] - y[0]);
    smoothFix++;
    return fixCorners(rank.slice(0, 6).map(r => [r[1], r[2]]), onCut) > 0;
  };
  /** 每个核心点上挂的（或它附近最近的）切缝点序号：sOn[k] 有就用，没有就顺着核心线往两边找最近的那个（补进来的点跟着它邻居） */
  const seamNear = () => {
    const out = new Int32Array(L.length).fill(-1);
    if (!sOn) return out;
    for (let k = 0; k < L.length; k++) if (sOn[k]) out[k] = sOn[k].s;
    for (let k = 0; k < L.length; k++) {
      if (out[k] >= 0) continue;
      for (let d = 1; d < L.length && out[k] < 0; d++) {
        const a1 = (k - d + L.length) % L.length, b1 = (k + d) % L.length;
        if (sOn[a1]) out[k] = sOn[a1].s; else if (sOn[b1]) out[k] = sOn[b1].s;
      }
    }
    return out;
  };
  /**
   * 切缝圈逐点逐边校验（延后处理）：这些点会在下刀前由核心线配一块底板接到膜上（见 seamPlan），
   * 切缝本身最要紧的是：辐条从材料里穿到外、L′ 在材料里（L′ 不在时切缝从别处穿出表面 = 切缝偏离）、
   * 外段端点在材料外（在里的那一截埋在材料里，两侧绕过它连在一起）、相邻两点的 L′ 边在材料里。
   * 返回按 S 序号排的过不了的点 / 边
   */
  const checkSeam = () => {
    const badI = [], badE = [];
    const near = seamNear();
    const nS = n0;
    const first = sOn ? sOn.findIndex(x => x) : -1;
    if (first < 0) return { badI: [], badE: [] };
    for (let i = 0; i < nS; i++) {
      /* S 上的第 i 个点在核心线上的序号（绕一圈找；一个 S 点只会对应一个核心点） */
      const k = sOn.findIndex(x => x && x.s === i);
      if (k < 0) { badI.push(i); continue; }
      const p = L[k], v = st.N[k], b = st.b[k], fl = st.fl[k];
      const at = t => sideOf(S, [p[0] + v[0] * t, p[1] + v[1] * t, p[2] + v[2] * t]);
      if (!(at(-0.5 * b) < 0) || !(sideOf(S, st.Lp[k]) < -SEAM_CLEAR) || !(at(0.5 * fl) > 0) || !(sideOf(S, st.F[k]) > SEAM_CLEAR / 2)) badI.push(i);
    }
    for (let i = 0; i < nS; i++) {
      const ka = sOn.findIndex(x => x && x.s === i), kb = sOn.findIndex(x => x && x.s === (i + 1) % nS);
      if (ka < 0 || kb < 0 || !sOn[ka].adj || sOn[ka].adj !== (kb - ka + L.length) % L.length) { badE.push(i); continue; }
      const la = st.Lp[ka], lb = st.Lp[kb];
      for (const t of [0.25, 0.5, 0.75]) {
        const l = [0, 1, 2].map(q => la[q] + (lb[q] - la[q]) * t);
        if (!(sideOf(S, l) < -(SEAM_CLEAR + (gap > 0 ? gap / 2 : 0)))) { badE.push(i); break; }
      }
    }
    return { badI, badE };
  };
  /**
   * 切缝点自己的进材料方向（辐条）与外段长度：
   *   辐条换成「往圈的斜下方、离表面 RIPE 以上」的最近方向，L′ 落在材料里；
   *   外段伸到材料外；伸不出去（在坑里 / 窄缝里）就把这一段让给核心线。
   * 与核心线同一套口径（表面法线 + 外法线拧），切缝点过不了，核心线就配不到底板。
   */
  const RIPE = 2 * SEAM_CLEAR + 0.04;
  const ripen = () => {
    if (!sOn) return 0;
    let fixed = 0;
    for (let k = 0; k < L.length; k++) {
      const c = sOn[k];
      if (!c) continue;
      const p = L[k];
      if (c.fix) { st.N[k] = c.fix.N.slice(); st.fl[k] = c.fix.fl; st.Lp[k] = c.fix.Lp.slice(); st.F[k] = c.fix.F.slice(); continue; }
      let okN = sideOf(S, st.Lp[k]) < -RIPE;
      if (!okN) {
        /* 优先保持「圈外一侧」：以内法线的左法线为基准，两边各转一个角度试，取第一个 L′ 落进材料的 */
        const [du, dv] = innerDir(L, k);
        let best = null;
        for (const deg of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 135, 150, 165]) {
          for (const sg of [-1, 1]) {
            const a = deg * Math.PI / 180 * sg;
            const ex = du * Math.cos(a) - dv * Math.sin(a), ey = du * Math.sin(a) + dv * Math.cos(a);
            const v0 = norm3([-ex, -ey, 0]);
            const q = [p[0] - st.b[k] * v0[0], p[1] - st.b[k] * v0[1], p[2] - st.b[k] * v0[2]];
            if (sideOf(S, q) < -RIPE) { best = v0; break; }
          }
          if (best) break;
        }
        if (best) { st.N[k] = best; st.Lp[k] = [p[0] - st.b[k] * best[0], p[1] - st.b[k] * best[1], p[2] - st.b[k] * best[2]]; okN = true; fixed++; }
      }
      if (!okN) { c.fix = { N: st.N[k], fl: st.fl[k], Lp: st.Lp[k], F: st.F[k] }; continue; }
      /* 外段：沿窄带方向往外找第一个在外面、离表面 SEAM_CLEAR 的点 */
      let fl = 0.02;
      for (const step of [0.02, 0.04, 0.06, 0.08, 0.1, 0.14, 0.2, 0.3, 0.45, 0.6]) {
        const q = [p[0] + st.N[k][0] * step, p[1] + st.N[k][1] * step, p[2] + st.N[k][2] * step];
        if (sideOf(S, q) > SEAM_CLEAR) { fl = step; break; }
      }
      const F = [p[0] + st.N[k][0] * fl, p[1] + st.N[k][1] * fl, p[2] + st.N[k][2] * fl];
      st.fl[k] = fl; st.F[k] = F;
      if (!(sideOf(S, F) > SEAM_CLEAR / 2)) { c.fix = { N: st.N[k], fl, Lp: st.Lp[k], F }; continue; }
      /* 外段那半截也要在外面（别埋在坑沿下面） */
      if (!(sideOf(S, [p[0] + st.N[k][0] * 0.5 * fl, p[1] + st.N[k][1] * 0.5 * fl, p[2] + st.N[k][2] * 0.5 * fl]) > 0)) { c.fix = { N: st.N[k], fl, Lp: st.Lp[k], F }; continue; }
    }
    return fixed;
  };
  /** 把切缝上过不了的点拿走（只留给核心线）：返回是否改动了 */
  const slimCut = () => {
    const b = checkSeam();
    if (!b.badI.length && !b.badE.length) return 'none';
    const bad = new Uint8Array(n0);
    let nb = 0;
    for (const i of b.badE) { if (!bad[i]) { bad[i] = 1; nb++; } if (!bad[(i + 1) % n0]) { bad[(i + 1) % n0] = 1; nb++; } }
    for (const i of b.badI) if (!bad[i]) { bad[i] = 1; nb++; }
    if (nb > n0 / 4) return 'giveup';
    for (let i = 0; i < n0; i++) if (bad[i]) sOn[i] = null;
    return 'slim';
  };
  /* 凹拐角：L′ 往里收的深度超过局部弯曲半径，(u, v) 上就折出一圈小结、自己穿过自己。
     旧办法把那一带的深度乘 0.5（连乘几轮就到 0.01～0.04 mm，窄带薄得切不动、切刀在那里漏缝）。
     改成在 L′ 上局部平滑：把交叉那一段投到 (u, v) 上做几轮拉普拉斯平滑（每段两端固定），把小结抹直，
     再把「画线点 → 平滑后的位置」当新的进材料方向记进 PA.nd（深度 b 仍按窄带的规矩取，不再缩）。
     返回真正改掉的点数；0 = 这一段没一个点能改（画线本身在这里折回，交给后面的发夹弯剪裁） */
  const fixCorners = (pairs, skipPt = null) => {
    const n = L.length;
    if (n < 8) return 0;
    const mark = new Uint8Array(n);
    for (const [i, j] of pairs) {
      if (j <= i || j - i >= n - 1) continue;
      const gap = Math.min(j - i, n - (j - i));
      /* 沿线隔得远的两段交叉（画线在这里两边挨得很近），只抹两头，不把中间一大段都拉直 */
      const wins = gap <= 24 ? [[i - 4, j + 4]] : [[i - 6, i + 6], [j - 6, j + 6]];
      for (const [k0, k1] of wins) for (let k = k0; k <= k1; k++) mark[((k % n) + n) % n] = 1;
    }
    /* 切缝点（skipPt）不挪：要改核心线才能解开的交叉，交给整圈退回 */
    if (skipPt) for (let i = 0; i < n; i++) if (skipPt[i]) mark[i] = 0;
    let any = false;
    for (let i = 0; i < n; i++) if (mark[i]) { any = true; break; }
    if (!any) return 0;
    /* 每段的两端固定：整段都在动的话，平滑会把这一段一起往圈里拽 */
    const fixed = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (mark[i] && !(mark[(i + n - 1) % n] && mark[(i + 1) % n])) fixed[i] = 1;
    const uv = st.Lp.map(q => [q[0], q[1]]);
    for (let it = 0; it < 24; it++) {
      const nx = uv.map(q => q.slice());
      for (let i = 0; i < n; i++) {
        if (!mark[i] || fixed[i]) continue;
        const a = uv[(i + n - 1) % n], c = uv[(i + 1) % n];
        nx[i][0] = 0.5 * uv[i][0] + 0.25 * (a[0] + c[0]);
        nx[i][1] = 0.5 * uv[i][1] + 0.25 * (a[1] + c[1]);
      }
      for (let i = 0; i < n; i++) { uv[i][0] = nx[i][0]; uv[i][1] = nx[i][1]; }
    }
    let changed = 0;
    for (let i = 0; i < n; i++) {
      if (!mark[i]) continue;
      const p = L[i], q = st.Lp[i];
      const dx = uv[i][0] - p[0], dy = uv[i][1] - p[1], dz = q[2] - p[2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 0.02) continue;
      const [du, dv] = innerDir(L, i);
      const full = norm3([-dx / len, -dy / len, -dz / len]);
      /* 偏得太多时窄带外段会被压进圈内表面、或者这个深度处已经不在材料里：与现在的方向按比例混合往回让一步，
         让到能过为止（越靠近平滑位置越好，能过就不减深度） */
      let d = null;
      for (const t of [1, 0.6, 0.3, 0.15]) {
        const v = t >= 1 ? full : norm3([
          st.N[i][0] * (1 - t) + full[0] * t,
          st.N[i][1] * (1 - t) + full[1] * t,
          st.N[i][2] * (1 - t) + full[2] * t,
        ]);
        const w = clampInward(v, du, dv);
        if (w[0] * st.nl[i][0] + w[1] * st.nl[i][1] + w[2] * st.nl[i][2] < 0.2) continue;
        if (!(sideOf(S, [p[0] + w[0] * st.b[i], p[1] + w[1] * st.b[i], p[2] + w[2] * st.b[i]]) < 0)) continue;
        d = w;
        break;
      }
      if (!d) continue;
      PA.nd[i] = d;
      PA.bfix[i] = st.b[i];      // 深度锁住：重算时别再变，否则修一处、另一处又交叉
      changed++;
    }
    return changed;
  };
  /**
   * 从切缝圈造核心线：核心线从 S 起步，打上 sOn（每个 S 点对应的核心点序号与它下一颗的增量 adj）。
   * 内核修核心线时只动自己补的点，切缝点留在「最新一圈」上（pick / applyPatch / 剪短都会把 sOn 跟着挪）；
   * useSeam = false 时只是核心线（老做法：核心线就是切缝）。
   */
  const makeCore = (pts, useSeam = true) => {
    L = pts;
    PA = {
      scale: new Float64Array(L.length).fill(1), mode: new Uint8Array(L.length),
      fmul: new Float64Array(L.length).fill(1), nd: new Array(L.length).fill(null), bfix: new Float64Array(L.length), excl: new Uint8Array(L.length),
    };
    if (useSeam) {
      const m = new Map(pts.map((p, i) => [p, i]));
      sOn = L.map(p => (m.has(p) ? { s: m.get(p), s0: m.get(p), adj: 0 } : null));
      for (let k = 0; k < L.length; k++) {
        const a1 = sOn[k], b1 = sOn[(k + 1) % L.length];
        if (a1 && b1 && b1.s === (a1.s + 1) % n0) a1.adj = 1;
      }
    } else sOn = null;
  };
  /* 切不开、而切面上又有折过来的地方（加厚方向拧不开的顶点）时，修那几个画线点再整套重来（最多 2 次）。
     只在切不开时才修：折处多数并不漏，去点 / 加点反而会在凸棱处把线拉长、漏得更厉害（实测头部件）。
     折处落在切缝点附近时不动那几个点（切缝点连在切缝上），整圈退回老做法 */
  /**
   * 内核给跳过的画线补出来的口子：切缝圈（S）在这里跳过了一段（多半是从凹处上方跨过去的悬空弦），
   * 核心线沿表面绕了进来。按切缝圈那一刀切出来是对的，切口在绕过去的那一段上；但断口两头仍是内核自己的点（差 0.1～0.6 mm）。
   * 这里把这一段的 Lf 点（断口两头之间、在表面上的那些）接回切缝：各点自己进材料到自己的 L′（不超过沿 −N 量到的厚度 0.45，
   * 且落在材料里、内外的辐条与端点都过得了），接上一颗就在内核那一圈上插一颗（sOn 打上序号、adj 断开）；
   * 接着是底板（capOf）：断口两头的 L′ 与接回来的 L′ 连成的闭环三角化，把膜接到这一截底下。
   * 返回 { ins, cap, refused }（接回几颗 / 底板三角形数 / 接不回来的 Lf 点数），没有断口返回 null。
   */
  const emulsify = () => {
    if (!sOn || !__ring || !__ring.coreOnly || !__ring.ok) return null;
    const Z = sOn.findIndex(z => !z);
    if (Z < 0) return null;
    const N = L.length;
    let A = Z; while (sOn[(A - 1 + N) % N]) A = (A - 1 + N) % N;   // 口子左边第一颗切缝点
    let B = Z; while (sOn[(B + 1) % N]) B = (B + 1) % N;           // 口子右边第一颗切缝点
    if (!sOn[A] || !sOn[B] || (B - A + N) % N < 2) return null;
    /* 这一段被跳过的画线（Lf 里的序号） */
    const sA = sOn[A].s, sB = sOn[B].s, nS = n0;
    const LfIdx = new Map(Lf.map((p, k) => [p, k]));
    const extra = [];
    for (let k = (sA + 1) % nS; k !== sB; k = (k + 1) % nS) {
      const j = LfIdx.get(__ring.S[k]);
      if (j !== undefined) extra.push(j);
    }
    if (!extra.length) return null;
    /* 断口两头之间、在表面上的 Lf 点（原本就有的顺序、只取这一段） */
    const back = [];
    let refused = 0;
    for (const j of extra) {
      const p = Lf[j];
      const c = closest(S, p);
      if (!c || c.d > 0.05) { refused++; continue; }
      const nl = norm3(pseudoNormal(S, c.f, c.ft));
      const n0f = [S.nrm[c.f * 3], S.nrm[c.f * 3 + 1], S.nrm[c.f * 3 + 2]];
      let v = normalNear(S, p, RN, n0f);
      for (let t = 0; t < 8 && v[0] * nl[0] + v[1] * nl[1] + v[2] * nl[2] < OUT_MIN; t++) v = norm3([v[0] + nl[0], v[1] + nl[1], v[2] + nl[2]]);
      let found = null;
      for (const d of [v, nl]) {
        let b = req.bCap;
        const hin = raycast(S.bvh, p[0], p[1], p[2], -d[0], -d[1], -d[2], 0.02, b + 2);
        if (hin && b > 0.45 * hin.t) b = 0.45 * hin.t;
        for (let t = 0; t < 3 && !found; t++, b *= 0.5) {
          const q = [p[0] - b * d[0], p[1] - b * d[1], p[2] - b * d[2]];
          if (sideOf(S, q) < -SEAM_CLEAR && sideOf(S, [p[0] - 0.5 * b * d[0], p[1] - 0.5 * b * d[1], p[2] - 0.5 * b * d[2]]) < 0) found = { q, N: d, b };
        }
        if (found) break;
      }
      if (!found) { refused++; continue; }
      /* 外段 */
      let fl = 0.02, F = null;
      for (const step of [0.02, 0.04, 0.06, 0.08, 0.1, 0.14, 0.2, 0.3, 0.45, 0.6]) {
        const q = [p[0] + found.N[0] * step, p[1] + found.N[1] * step, p[2] + found.N[2] * step];
        if (sideOf(S, q) > SEAM_CLEAR) { fl = step; F = q; break; }
      }
      if (!F) { refused++; continue; }
      back.push({ p, Lp: found.q, F, N: found.N, b: found.b, fl });
    }
    if (!back.length) return { ins: 0, cap: 0, refused };
    /* 底板：门的两头（A / B 的 L′）→ 接回来的 L′（Lf 的走向）→ 回到 A，在它的 Newell 平面里三角化 */
    const Q = [st.Lp[A], ...back.map(o => o.Lp), st.Lp[B]];
    const ref = [[0, A], ...back.map((_, k) => [3, k]), [0, B]];
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < Q.length; k++) {
      const a1 = Q[k], b1 = Q[(k + 1) % Q.length];
      nx += (a1[1] - b1[1]) * (a1[2] + b1[2]); ny += (a1[2] - b1[2]) * (a1[0] + b1[0]); nz += (a1[0] - b1[0]) * (a1[1] + b1[1]);
    }
    const nn = Math.hypot(nx, ny, nz);
    if (!(nn > 1e-12)) return { ins: 0, cap: 0, refused: refused + back.length };
    const nrm = [nx / nn, ny / nn, nz / nn];
    const e1 = norm3(Math.abs(nrm[0]) < 0.9 ? [0, -nrm[2], nrm[1]] : [-nrm[2], 0, nrm[0]]);
    const e2 = [nrm[1] * e1[2] - nrm[2] * e1[1], nrm[2] * e1[0] - nrm[0] * e1[2], nrm[0] * e1[1] - nrm[1] * e1[0]];
    let Q2 = Q.map(q => [q[0] * e1[0] + q[1] * e1[1] + q[2] * e1[2], q[0] * e2[0] + q[1] * e2[1] + q[2] * e2[2]]);
    if (area2(Q2) < 0) Q2 = Q2.map(q => [-q[0], q[1]]);
    if (!(area2(Q2) > 0) || selfCross(Q2)) return { ins: 0, cap: 0, refused: refused + back.length };
    let T0 = null;
    try { T0 = MF.triangulate([Q2], Math.max(1e-9, spanOf(Q2) * 1e-7)); } catch { T0 = null; }
    if (!T0 || T0.length !== Q.length - 2) return { ins: 0, cap: 0, refused: refused + back.length };
    /* 接上去：在 A 后面插进 Lf 点（切缝点）与它们的 L′（em），B 的序号往后挪 */
    const em = [], toS = [], toN = [], toF = [];
    for (let k = 1; k <= back.length; k++) {
      const o = back[k - 1];
      em.push(o.Lp); toS.push(o.p); toN.push(o.N); toF.push(o.F);
    }
    /* 不往核心线里加点了（只在切缝点前面插点会把口子撑大，和 B 之间又空出一条断口）：
       接回来的点排在 F 排之后，它们的 L′ 由底板单独接到膜上（seamPlan / cutterGeom 的 em） */
    return { ins: back.length, cap: T0.length, refused, tris: T0.map(t => [ref[t[0]], ref[t[1]], ref[t[2]]]), S: back.map(o => o.p), F: back.map(o => o.F), Lx: em };
  };
  let rawNoCut = false, prevNoCut = false, fallbacks = 0;   // 切缝圈切不开 / 修不顺、已整圈退回老做法：之后都按核心线切缝
  for (let retry = 0; ; retry++) {
    /* 每次重来都从切缝圈重新起步（不拿上一次修过的核心线：那些点带着上一次的修整属性，切缝点也早就不在上面了）。
       刚整圈退回过的这一轮用核心线起步；这一轮不再往下退时才记下来，免得无限来回 */
    const useSeam = !prevNoCut;
    makeCore(useSeam ? cut0 : Lf, useSeam);
    if (useSeam) {
      /* 切缝点自己的辐条 / 外段先修好（换成能落进 / 伸出材料的方向）；修不好的点让给核心线 */
      for (let guard = 0; guard < 4; guard++) {
        st = stripOf(L, S, req, PA);
        ripen();
        const r = slimCut();
        if (r === 'none') break;
        if (r === 'giveup') { rawNoCut = true; break; }
      }
      if (rawNoCut) { prevNoCut = true; continue; }
    }
    const giveUp = () => { rawNoCut = true; };
    for (let guard = 0; guard < 48; guard++) {
      st = stripOf(L, S, req, PA);
      if (sOn && !here()) { sOn = null; rawNoCut = true; st = null; break; }
      if (sOn) { const cn = ripen(); if (cn) { st = null; continue; } }
      /* 以下几步只改核心线自己补的点、不进切缝 */
      const pairs = crossings(st.Lp, 256);
      if (pairs.length || !(area2(st.Lp) > 0)) {
        /* 先用 L′ 上的局部平滑把小结抹直（深度锁住不动）；解开了就重算窄带，不走减深度那条路。
           一处修好、重算后别处又冒出来是常事（L′ 是整条曲线，改这里会牵动邻居），所以给足轮数。切缝点不挪 */
        if (smoothFix < 12 && fixCorners(pairs, sOn ? Uint8Array.from(sOn, x => (x ? 1 : 0)) : null)) { smoothFix++; continue; }
        if (sOn) { giveUp(); st = null; break; }
        st = null;
        const n = L.length;
        if (crossFix++ < 3) {
          /* 每轮每点最多减半一次（几百对交叉叠在一起时，旧写法会把同一段连减十几次，窄带薄到 0.01 mm，膜贴着表面钻出来）；
             沿线隔得远的两段在窄处交叉（画线在这里两边挨得很近），只减交叉点附近，不把中间一大段都减浅 */
          const half = new Uint8Array(n);
          for (const [i, j] of pairs) {
            const gap = Math.min(j - i, n - (j - i));
            const wins = gap <= 24 ? [j - i <= n / 2 ? [i - 4, j + 4] : [j - 4, i + n + 4]] : [[i - 6, i + 6], [j - 6, j + 6]];
            for (const [k0, k1] of wins) for (let k = k0; k <= k1; k++) half[((k % n) + n) % n] = 1;
          }
          if (!pairs.length) half.fill(1);
          for (let k = 0; k < n; k++) if (half[k]) PA.scale[k] *= 0.5;
          continue;
        }
        /* 减深也解不开：画线在这里几乎折回（发夹弯），把这一小截从画线里剪掉 */
        let snipped = false;
        for (const [i, j] of pairs) {
          const fwd = arcLen(L, (i + 1) % n, j), back = arcLen(L, (j + 1) % n, i);
          if (Math.min(fwd, back) > 2.0) continue;
          const keep = [];
          for (let k = 0; k < n; k++) if (fwd <= back ? !(k > i && k <= j) : (k > i && k <= j)) keep.push(k);
          pick(keep);
          snipped = true;
          break;
        }
        if (!snipped || L.length < 3) break;
        continue;
      }
      /* L′ 上相邻两点投到 (u, v) 重合（画线顺着竖墙往下走，两点只差高度）：膜在这里只能剖出面积为 0 的三角形，
         整张膜建不起来（实测手臂件）。去掉后一个点再来 */
      {
        const n = L.length, keep = [];
        for (let i = 0; i < n; i++) {
          const q = keep.length ? st.Lp[keep[keep.length - 1]] : null, p = st.Lp[i];
          if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-3) continue;
          keep.push(i);
        }
        if (keep.length > 3 && keep.length < n) {
          if (sOn && keep.some(k => sOn[k])) { giveUp(); st = null; break; }
          dropped += n - keep.length; pick(keep); continue;
        }
      }
      /* 窄带校验：过不了的辐条先改用外法线、还不行就去掉这个点；过不了的边在中间加一个表面点
         （棱、沟、薄凸起处画线跟着表面走，窄带不会从棱里穿过去或埋进沟底）。
         切缝点本身不在这里动：切缝要由核心线配底板接到膜上，下刀前用 checkSeam 统一验收 */
      const bad = checkStrip(L, st, S);
      badLeft = bad.count;
      if (globalThis.__finBad && bad.count) globalThis.__finBad({ bad, L, Lp: st.Lp, sOn, st });
      if (globalThis.__finBad && bad.count) globalThis.__finBad({ bad, L, Lp: st.Lp, sOn, st });
      if (!bad.count || fixRounds >= 5) break;
      if (sOn) { giveUp(); st = null; break; }
      fixRounds++;
      applyPatch(patchOf(bad));
      pick(despike(L, true));
      if (L.length < 3 || selfCross(L)) { st = null; break; }
    }
    /* 这一轮整圈退回了：拿退回后的核心线再走一轮（最多 4 次）；核心线一样、再退也是同样的结果，别无限来回 */
    if (rawNoCut) {
      rawNoCut = false;
      prevNoCut = true;
      if (++fallbacks < 4) continue;
    } else prevNoCut = false;
    if (!st) {
      return { err: fail('LINE_TANGLED', '画线在切面方向上折得太紧（或自己交叉），围不出一张切面。请重画一圈：不要交叉、不要重叠、拐角放缓一些') };
    }
    mem = buildMembrane(MF, st.Lp, h);
    if (!mem) return { err: fail('LINE_TANGLED', '这条画线围不出一张有效的切面，请重画一圈：不要交叉、重叠或折回') };
    /* 膜露出表面的浅处压回材料里（离表面至少留出切刀的厚度：零间隙时薄片往 + 侧厚 EPS，有间隙时两侧各 gap/2）。
       压下去的点是一个个钉子，钉子周围的膜成小坑，个别地方切刀在坑里加厚方向拧不开、漏缝；所以留一份没压过的膜，
       压过的切不开就换回它再切（见下面的 attempt 循环），宁可留着原来的小毛病，也不能切不开 */
    const memPlain = { P: mem.P.slice(), T: mem.T, nB: mem.nB };
    inside = keepInside(mem, S, Math.max(0.05, (gap > 0 ? gap / 2 : EPS) + 0.03));
    lap('inside');
    look = heightLookup(mem);
    loopUV = st.Lp.map(q => [q[0], q[1]]);
    const inLoop = (u, v) => {
      let c = false;
      for (let i = 0, j = loopUV.length - 1; i < loopUV.length; j = i++) {
        const a = loopUV[i], b = loopUV[j];
        if ((a[1] > v) !== (b[1] > v) && u < (b[0] - a[0]) * (v - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
      }
      return c;
    };
    /* 没碰到切刀的块（别的壳 / 内腔）：重心在圈内、膜之上归 A，否则 B */
    const place = q => {
      const bb = q.m.boundingBox();
      const cu = (bb.min[0] + bb.max[0]) / 2, cv = (bb.min[1] + bb.max[1]) / 2, cw = (bb.min[2] + bb.max[2]) / 2;
      if (!inLoop(cu, cv)) return -1;
      const hw = look(cu, cv);
      return Number.isFinite(hw) && cw > hw ? 1 : -1;
    };
    /* 按切缝圈（用户画线本身）切；切不开就整圈退回老做法（核心线当切缝）再切一次——
       切缝圈在少数怪形状上可能漏缝，宁可切缝差一点也不能切不开。压过的膜切不开时先换回没压过的膜 */
    let sep = false, pushedTry = inside.pushed > 0, handedOver = false, emHold = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      plan = seamPlan(L, sOn, st, mem, emHold);
      geo = cutterGeom(mem, plan);
      lap('sheet');
      const K = cutterOf(MF, geo, kid, gap);
      if (!K) { if (globalThis.__finK) globalThis.__finK({ geo, plan, L, ring: __ring }); return { err: fail('KERNEL', '切刀建不起来（画线太乱或太小），请重画') }; }
      T(K);
      const [Lin, Mout] = Mp.split(K).map(T);
      if (Lin.isEmpty()) return { err: fail('PLANE_MISS', '画线圈出的切面没有切到模型，请把画线圈在模型的某一圈上') };
      lap('split');
      outs = Mout.decompose().map(T).filter(real);
      ins = Lin.decompose().map(T).filter(real);
      lap('decompose');
      parts = [...outs.map(m => partInfo(m, kid)), ...ins.map(m => partInfo(m, kid))];
      lap('partInfo');
      cl = classify(parts, outs.length, { place });
      if (globalThis.__finCls) globalThis.__finCls({ parts, nOut: outs.length, cl, L, st, mem, S, geo, PA, plan, Lf: LfDbg, S0, sOn, ring, em: emHold, crossings, area2, closest, sideOf, pseudoNormal, normalNear, norm3, raycast, keepInside, checkStrip, req, fr: ctx.fr, trace: null });
      /* 切开了、而切缝上还有内核给跳过的画线补的底板（emulsify）：把这些点接进切缝再切一刀，切缝就回到画线上；
         接不进去（plan.exact = false）或接进去切不开，就保留这一刀的结果 */
      const em = globalThis.NOEM || sep || cl.err || emHold ? null : emulsify();
      if (em && em.ins) { emHold = em; attempt = -1; continue; }
      if (!cl.err && cl.side.some(v => v > 0) && cl.side.some(v => v < 0)) { sep = true; break; }
      /* 没切开：压过的膜先换回没压过的膜再切；按切缝圈那一刀没切开就交给核心线那一刀 */
      if (pushedTry) {
        pushedTry = false;
        mem = memPlain;
        look = heightLookup(mem);
        inside.reverted = true;
        attempt = -1;
        continue;
      }
      if (plan.exact && !handedOver) { handedOver = true; sOn = null; continue; }
      sep = -1;
      break;
    }
    if (sep === true) break;
    if (sep === -1) {
      /* 两刀都没切开（也没说折）：按原来的流程走「没切开」 */
      const foldF = foldsOf(geo);
      if (!foldF.size || retry >= 2) return notSeparating();
      sOn = null; st = null; fixRounds = 0; folds += foldF.size; continue;
    }
    const fold = foldsOf(geo);
    if (!fold.size || retry >= 2) return notSeparating();
    /* 折处的点：两侧有一段很短（< DS / 2：沿网格边走出来的小锯齿、边缘处一点跳到侧面上）就去掉，
       否则在两侧各加一个中点（吸回表面），让窄带转得缓一些 */
    const n = L.length;
    const drop = new Uint8Array(n);
    for (const i of fold) {
      const pr = L[(i + n - 1) % n], nx = L[(i + 1) % n];
      if (Math.min(dist3(pr, L[i]), dist3(L[i], nx)) < DS / 2) drop[i] = 1;
    }
    /* 切缝点不在这里动：它们让给核心线，切缝圈也就整圈退回老做法 */
    if (sOn && sOn.some(x => x)) { sOn = null; st = null; fixRounds = 0; continue; }
    const NL = [], sc = [], md = [], fm = [], nn = [], bf = [], ex = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (drop[i]) { dropped++; continue; }
      NL.push(L[i]); sc.push(PA.scale[i]); md.push(PA.mode[i]); fm.push(PA.fmul[i]); nn.push(PA.nd[i]); bf.push(PA.bfix[i]); ex.push(PA.excl[i]);
      if ((fold.has(i) || fold.has(j)) && !drop[j] && dist3(L[i], L[j]) >= DS / 2) {
        const m = [(L[i][0] + L[j][0]) / 2, (L[i][1] + L[j][1]) / 2, (L[i][2] + L[j][2]) / 2];
        const c = closest(S, m);
        NL.push(c && c.d < 0.5 * dist3(L[i], L[j]) ? c.p.slice() : m);
        sc.push((PA.scale[i] + PA.scale[j]) / 2); md.push(PA.mode[i] & PA.mode[j]); fm.push(Math.min(PA.fmul[i], PA.fmul[j])); nn.push(null); bf.push(0); ex.push(0);
        inserted++;
      }
    }
    if (NL.length < 3) return notSeparating();
    L = NL;
    PA = { scale: Float64Array.from(sc), mode: Uint8Array.from(md), fmul: Float64Array.from(fm), nd: nn, bfix: Float64Array.from(bf), excl: Uint8Array.from(ex) };
    folds += fold.size;
    fixRounds = 0;
    st = null;
  }
  lap('classify');
  /* 并集在共面接缝上同样会留下零体积小块（实测 4 面、24 面各一个，体积 0）：拆开丢掉再合回。
     只对真做了并集的那组做（拆一次大网格也要几十毫秒） */
  let slivers = 0;
  const clean = m => {
    const cs = m.decompose().map(T);
    const keep = cs.filter(real);
    if (keep.length === cs.length || !keep.length) return m;
    slivers += cs.length - keep.length;
    return keep.length === 1 ? keep[0] : T(Manifold.compose(keep));
  };
  /* 合成两件：同一侧里挨着的块（共用切刀上的顶点）才要布尔并，互不相挨的（别的壳）直接拼进来，省掉大网格上的并集。
     有装配间隙时，切刀内部那一层（idx >= outs.length）整层挖掉——两件各让出 gap/2 */
  const nOutLen = outs.length;
  const keepBlk = i => !dropLayer || i < nOutLen;
  let layerVol = 0;
  if (dropLayer) for (let i = nOutLen; i < parts.length; i++) layerVol += Math.abs(parts[i].vol);
  const merge = sgn => {
    const idx = cl.side.map((v, i) => (v === sgn && keepBlk(i) ? i : -1)).filter(i => i >= 0);
    if (!idx.length) return null;
    const seen = new Set(), groups = [];
    for (const i of idx) {
      if (seen.has(i)) continue;
      const g = [], st = [i];
      seen.add(i);
      while (st.length) {
        const x = st.pop();
        g.push(parts[x].m);
        for (const y of cl.contact[x].keys()) if (cl.side[y] === sgn && keepBlk(y) && !seen.has(y)) { seen.add(y); st.push(y); }
      }
      groups.push(g.length > 1 ? clean(T(Manifold.union(g))) : g[0]);
    }
    return groups.length > 1 ? T(Manifold.compose(groups)) : groups[0];
  };
  let upper = merge(1);
  lap('unionA');
  let lower = merge(-1);
  lap('unionB');
  if (!upper || !lower || upper.isEmpty() || lower.isEmpty()) return notSeparating();
  lap('regroup');

  /* 截面岛（挑销的位置、报告截面）：薄片层里有真切口的块投影到 (u, v) */
  const cutParts = parts.filter((p, i) => i >= outs.length && p.top + p.bot > 0).map(p => p.m);
  let islands = [];
  if (cutParts.length) islands = T(T(Manifold.compose(cutParts)).project()).decompose().map(T);
  let star = 0, iou = 0, area = 0, starRings = null;
  if (islands.length) {
    const pick = pickStar(MF, islands, loopUV, T, warn);
    if (!pick.err) { star = pick.star; iou = pick.ious[star]; }
    area = islands[star].area();
    starRings = ringsOf(islands[star]);
  }
  const thin = Math.min(upper.volume(), lower.volume()) / Math.max(area, 1e-9);
  if (area > 0 && thin < MIN_PIECE) {
    return { err: fail('SLIVER', `这一刀会切下一层只有约 ${thin.toFixed(2)} mm 厚的薄片。请把线画得离端面远一点（至少 ${MIN_PIECE} mm）`) };
  }
  lap('islands');

  let pin = null;
  if (spec && starRings) {
    const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
    const C = prismOf(MF, mem, diag * 1.5 + 5);
    if (C) {
      T(C);
      const { theta } = principalAngle(outerOf(starRings));
      const r = placePinCurved(MF, { upper, lower, C, sheet: { heightAt: look }, rings: starRings, theta, spec, frame: fr }, T);
      if (r.warn) warn.push(r.warn);
      if (r.pin) { upper = r.upper; lower = r.lower; pin = r.pin; }
    } else warn.push('切面建不出插销用的切刀，已只切不加销');
  }
  lap('pin');

  const devMax = dz.dev.length ? Math.max(...dz.dev) : 0;
  const devMean = dz.dev.length ? dz.dev.reduce((s, x) => s + x, 0) / dz.dev.length : 0;
  return {
    upper, lower, pin, islands: islands.length, picked: star, iou, area, merged: cl.flipped, comps: null,
    sheet: {
      mode: 'strip', tris: mem.T.length, points: L.length,
      /* 切缝：points = 切缝点数，orphans = 核心线里删掉、仍留在切缝上的画线点，coreOnly = 只在核心线上的点（解结的交点等），
         runs / runsBad = 补上底板 / 补不出底板（退回老做法）的孤点段数，whisker = 只剩零宽度毛刺的段数，blunt = 原路折回处拉开的尖，
         patchOut = 底板重心在材料外的三角形数，fold = 底板与膜在共用边上的最小法线点积，
         floating = 有悬空点、沿用核心线的段数，peeled = 整圈剥掉的毛刺点数，skipped = 上一次拧不开、这次退回老做法的段数（trimmed 同），
         exact = 这一刀用的是精确切缝，fellBack = 精确切缝切不开、整圈退回老做法 */
      seam: {
        points: plan.S.length, peeled: plan.peeled, orphans: plan.orphans, coreOnly: plan.coreOnly, runs: plan.runs, runsBad: plan.runsBad,
        badWhy: plan.badWhy, whisker: plan.whisker, floating: plan.floating, skipped: plan.skipped, trimmed, blunt: plan.blunt, patchOut: plan.patchOut, fold: plan.fold,
        exact: plan.exact, fellBack,
      },
      depth: { min: Math.min(...st.b), max: Math.max(...st.b) },
      /* 膜露出表面、被压回材料里的点数（pushed，其中 split 个是劈边 / 劈三角形新加的），压不回的（left），用了几轮；
         reverted = 压过的膜切不开、换回了没压过的膜 */
      inside,
      err: { max: devMax, mean: devMean },
      parts: { out: outs.length, layer: ins.length, debris: cl.flipped, slivers, gap, layerVol: +layerVol.toFixed(3) },
      fix: { rounds: fixRounds, inserted, dropped, left: badLeft, normal: PA.mode.reduce((x, y) => x + y, 0), folds, stuck: geo.stuck.length, smooth: smoothFix, half: crossFix, thin: st.thinN },
    },
  };
}







