/* ================================================================
   支撑塔（格架塔）
   参考：e-Stage 7.0 官方用户手册（Grid / Top connection / Foundation 参数语义）
        + 公开产品资料与透明树脂实拍（2026-10-04 起按此复刻）
   格架拓扑（2026-10-14 规避改造后为「三角格」）：
   - 正交竖直墙（俯视正方形网格，墙距 = 格宽 w）；每面墙 = 竖杆 + 单向斜边在竖杆处折返（之字，
     每 q 个竖直半格换向）——孔为三角形。改造前是两组斜边交叉的菱形孔；改三角格是为与
     Materialise 的菱形格架专利（US8903533B2 / EP2198405B1 权 11 的 rhombus pattern）在结构图案上
     拉开距离，墙 / 竖杆 / 尺寸 / 斜边仰角 / 生成流程不变；两向墙在交线处各出一片竖板 →「+」截面柱
   - 半格序号 a/b（水平，步长 w/2）、n（竖向，步长 hs = h/2，h = w·tan(斜边角)）；周期 q 半格：
     墙在 a≡0 / b≡0 (mod q)；上行斜边记 fwd = (n mod 2q) < q——
       fwd（右行）：a−n ≡ 0 (mod q) 出 (a+1, n+1)；否则（左行）：a+n ≡ 0 (mod q) 出 (a−1, n+1)
     （x 固定墙换 b 同理；细格 q=2 的路径搜索版本见 downs2，与 upEdges 互为逆）；
     壳层缩减 = q 逐级翻倍（2→4→8→16），粗格是细格的子集
   - 支撑网格 = 格架 − 外扩「离模净距」的模型（节点点距 / 杆件胶囊体，BVH 判定）
   - 节点平滑过渡（几何实体化见 manifoldKit.js，在后台线程里算：manifold-3d / Clipper2）：每面墙在面内二维坐标里把杆件条带 + 节点圆盘并成一个区域，
     再做闭运算——凹角自动成半径 r 的圆角、凸侧是半径 边宽/2 的圆形接头，整面墙是一张连续穿孔板；只有一根杆的端头不放圆盘（端面平直）。
     旧版手写节点板轮廓、逐根修剪杆端，接缝靠凑：「<」顶点出锯齿缺口、针脚露台阶（用户截图），已整体废弃
   结构生成：
   1. 柱化路径：每个支撑点取针最省（针长 + 水平偏移罚）、可落地的接入节点，
      沿竖杆 / 斜边搜索到平台的路径（竖直优先，被模型挡住时沿斜边绕行）
   2. 支撑区域：路径节点所在的那一格（墙到墙），每下降一个柱高（柱高宽比 × 格宽）向四周展宽一格
      ——相邻支撑点的区域并成连续塔块（实拍：模型下方是一整块格架，不是一丛独立柱）
   3. 自平台逐层向上：节点只有在至少一根下行杆连到已保留节点时才保留（无打印孤岛），两端都保留的杆件全部收录
      （孔格闭合）；规划路径上的杆件强制收录，保证每个接入节点都连到平台
   4. 接入节点后，只保留自各接入节点沿下行杆的闭包——顶部收成尖顶、往下铺满成块，多余格架不生成
   接触（手册 Top connection）：十字截面直针自格架节点到接触点——连接宽 → 过渡段渐缩 → 接触宽
   （接触边距段）→ 沿针轴扎入渗透长度；针身胶囊体 + 过渡段锥台做净空判定。
   - 格架同向针（优先）：针轴竖直（与「+」柱同轴）或落在节点所在墙面内，与格架杆件同宽同厚，
     针根足迹并入墙面区域、与相邻杆之间同样出圆角；接触点重定义为针轴延长线与模型的首个交点（偏移受限）
   - 自由直针（兜底）：接触点不动；错切十字柱，针脚截面与「+」柱顶一致
   基础带（手册 Foundation）：底层节点按墙线连成段，墙下沿实心带，相邻竖杆之间的底边开三角缺口
   连不上格架的支撑点：就近接格架 → 分叉（一主干两头）→ 十字短杆（接到下方表面或平台）；
   短杆与分叉头的上下两端都按接触面法线判断要不要折（杆身与法线差 12°～50° 才折）；
   落到平台的平头不折；
   仍接不上的标红、不生成结构（由用户加点 / 删点处理）。
================================================================ */
import * as THREE from 'three';
import { pointDist, capsuleClear, coneClear, ldiInside, raycast } from './collide.js';
import { mergeParts, dirCandidates, tipCone, bridgeToSurface, bridgeSpan } from './supportKit.js';
import { solidifyAsync } from './geomClient.js';
import { columnHeight, joinPlateHeight, joinShoulder } from './joinPlate.js';

/* ---------- 三角形缓冲：板条/针/基础带直接写顶点，避免成千上万个 three 几何对象 ---------- */
/* runs 记录「一个构件 = 哪几段连续三角形」。导出前的布尔并要靠它把这一大坨还原成
   一个个闭合壳：只按顶点位置焊接会把位置重合的不同构件粘成一坨非流形大壳（实测
   导出里有 2.5 万个完全重合的三角形），manifold 会直接拒收。 */
class TriBuf {
  constructor() { this.a = new Float32Array(1 << 18); this.n = 0; this.runs = []; this._rs = -1; this._rt = ''; this.nDropped = 0; }
  ensure(k) {
    if (this.n + k <= this.a.length) return;
    let m = this.a.length * 2; while (m < this.n + k) m *= 2;
    const b = new Float32Array(m); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  beginRun(tag) { if (this._rs < 0) { this._rs = this.n / 9; this._rt = tag || ''; } }
  endRun() {
    if (this._rs < 0) return;
    if (this.n / 9 > this._rs) {
      this.orientRun(this._rs, this.n / 9);
      this.runs.push([this._rs, this.n / 9, this._rt]);
    }
    this._rs = -1; this._rt = '';
  }
  /* 朝向修复：一个构件内按共享边 BFS 统一三角形绕序（相邻面共享边须反向），
     再按有向体积统一朝外。节点板扇形三角化与斜切六面体曾出现部分面翻面，
     布尔并会以「Not manifold」拒收整个构件（实测 92 面节点板 8 条同向共享边）。 */
  orientRun(a, b) {
    const cnt = b - a;
    if (cnt < 4) return;
    const arr = this.a, Q = 1e4;
    const vk = (i, k) => {
      const o = (a + i) * 9 + k * 3;
      return `${Math.round(arr[o] * Q)},${Math.round(arr[o + 1] * Q)},${Math.round(arr[o + 2] * Q)}`;
    };
    const keys = [];
    for (let i = 0; i < cnt; i++) keys.push([vk(i, 0), vk(i, 1), vk(i, 2)]);
    const em = new Map();
    for (let i = 0; i < cnt; i++) {
      for (let k = 0; k < 3; k++) {
        const u = keys[i][k], v = keys[i][(k + 1) % 3];
        const key = u < v ? u + '|' + v : v + '|' + u;
        let e = em.get(key); if (!e) em.set(key, e = []);
        e.push(i);
      }
    }
    const flip = new Int8Array(cnt).fill(-1);
    for (let s = 0; s < cnt; s++) {
      if (flip[s] !== -1) continue;
      flip[s] = 0;
      const st = [s];
      while (st.length) {
        const i = st.pop();
        for (let k = 0; k < 3; k++) {
          const u = keys[i][k], v = keys[i][(k + 1) % 3];
          const key = u < v ? u + '|' + v : v + '|' + u;
          for (const j of em.get(key)) {
            if (j === i || flip[j] !== -1) continue;
            const d1 = flip[i] ? -1 : 1;
            const kj = keys[j];
            const s2 = (u === kj[0] && v === kj[1]) || (u === kj[1] && v === kj[2]) || (u === kj[2] && v === kj[0]) ? 1 : -1;
            flip[j] = d1 === s2 ? 1 : 0;
            st.push(j);
          }
        }
      }
    }
    let vol = 0;
    for (let i = 0; i < cnt; i++) {
      const o = (a + i) * 9;
      const ax = arr[o], ay = arr[o + 1], az = arr[o + 2];
      const p1 = o + 3 + (flip[i] ? 3 : 0), p2 = o + 6 - (flip[i] ? 3 : 0);
      const bx = arr[p1], by = arr[p1 + 1], bz = arr[p1 + 2];
      const cx = arr[p2], cy = arr[p2 + 1], cz = arr[p2 + 2];
      vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    if (Math.abs(vol) < 1e-12) return;
    const all = vol < 0 ? 1 : 0;
    for (let i = 0; i < cnt; i++) {
      if (!(flip[i] ^ all)) continue;
      const o = (a + i) * 9;
      for (let k = 0; k < 3; k++) { const t = arr[o + 3 + k]; arr[o + 3 + k] = arr[o + 6 + k]; arr[o + 6 + k] = t; }
    }
  }
  tri(p, q, r) {
    this.ensure(9); const a = this.a; let n = this.n;
    a[n++] = p[0]; a[n++] = p[1]; a[n++] = p[2]; a[n++] = q[0]; a[n++] = q[1]; a[n++] = q[2]; a[n++] = r[0]; a[n++] = r[1]; a[n++] = r[2];
    this.n = n;
  }
  /* 四边形（按外法线 out 自检绕序）；任一三角形塌缩（面积≈0）时跳过，不产出退化面 */
  quad(q0, q1, q2, q3, out) {
    const ux = q1[0] - q0[0], uy = q1[1] - q0[1], uz = q1[2] - q0[2], vx = q2[0] - q0[0], vy = q2[1] - q0[1], vz = q2[2] - q0[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const ar = Math.hypot(nx, ny, nz);
    if (ar < 1e-9) {                                        // 四点共线/重合的塌缩面：丢弃（焊接顶点后会造成非流形边）
      this.nDropped++;
      if (typeof window !== 'undefined' && (window.__degen || (window.__degen = [])).length < 400)
        window.__degen.push({ tag: this._rt, q: q0.map(v => +v.toFixed(3)) });
      return;
    }
    if (nx * out[0] + ny * out[1] + nz * out[2] < 0) { this.tri(q0, q2, q1); this.tri(q0, q3, q2); }
    else { this.tri(q0, q1, q2); this.tri(q0, q2, q3); }
  }
  /* 六面体：c[s*4 + i*2 + j]（s 沿轴两端，i/j 截面两向）—— 本身就是一个闭合构件。
     面的绕序按「面重心 − 体心」初判；个别面的翻面由 endRun 的 orientRun 统一修正。
     加 tag 便于导出时定位孤立 / 拒收构件的来源（union.js 的拒收明细会带上） */
  hexa(c, tag) {
    this.beginRun(tag);
    let cx = 0, cy = 0, cz = 0; for (const p of c) { cx += p[0]; cy += p[1]; cz += p[2]; } cx /= 8; cy /= 8; cz /= 8;
    for (const f of [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]]) {
      const q = f.map(k => c[k]);
      const fx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, fy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4, fz = (q[0][2] + q[1][2] + q[2][2] + q[3][2]) / 4;
      this.quad(q[0], q[1], q[2], q[3], [fx - cx, fy - cy, fz - cz]);
    }
    this.endRun();
  }
  geometry() {
    if (!this.n) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.a.slice(0, this.n), 3));
    g.computeVertexNormals();
    g.userData.runs = this.runs;
    return g;
  }
}

/* 变截面板：A→B；两端截面（宽 w 沿 e、厚 t 沿 m）沿杆轴投影到过端点、法线 nA / nB 的端面上
   （法线取杆轴 = 垂直切；取 Y = 水平切，用于杆端齐平在节点高度）。
   o0 / o1：两端截面中心沿 e 的侧移（板宽不对称时用：一侧按边宽、另一侧切齐到相邻墙面） */
function bar(buf, A, B, e, m, w0, t0, w1, t1, nA, nB, o0 = 0, o1 = 0, tag = '') {
  const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], l = Math.hypot(u[0], u[1], u[2]) || 1;
  u[0] /= l; u[1] /= l; u[2] /= l;
  const c = [];
  for (const [P, w, th, np, o] of [[A, w0, t0, nA, o0], [B, w1, t1, nB, o1]]) {
    const un = u[0] * np[0] + u[1] * np[1] + u[2] * np[2];
    for (const i of [-1, 1]) for (const j of [-1, 1]) {
      const ei = o + i * w / 2;
      const X = [P[0] + e[0] * ei + m[0] * j * th / 2, P[1] + e[1] * ei + m[1] * j * th / 2, P[2] + e[2] * ei + m[2] * j * th / 2];
      const k = ((P[0] - X[0]) * np[0] + (P[1] - X[1]) * np[1] + (P[2] - X[2]) * np[2]) / un;
      c.push([X[0] + u[0] * k, X[1] + u[1] * k, X[2] + u[2] * k]);
    }
  }
  buf.hexa(c, tag);
}
/* 小点集凸包，写进同一个构件。短杆针尖折向时，杆端截面和沿法线的接触面不平行，
   凸包把折角填实。
   同一张平面上的点（杆端方截面、颈圈方截面）只能三角化一次。逐个三点都收下的话，
   一个四边形会叠出四张三角形，边被用了三次以上；后面的朝向修复分不清正反，
   一半面翻到里面，正面剔除后这截杆就像缺了面。 */
function emitHull(buf, pts, tag) {
  const uniq = [];
  for (const p of pts) {
    if (uniq.some(q => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-6)) continue;
    uniq.push(p);
  }
  const n = uniq.length;
  if (n < 4) return;
  let cx = 0, cy = 0, cz = 0;
  for (const p of uniq) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx /= n; cy /= n; cz /= n;
  const planes = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const a = uniq[i], b = uniq[j], c = uniq[k];
        let nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
        let ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
        let nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        const nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-12) continue;
        nx /= nl; ny /= nl; nz /= nl;
        const mx = (a[0] + b[0] + c[0]) / 3, my = (a[1] + b[1] + c[1]) / 3, mz = (a[2] + b[2] + c[2]) / 3;
        if (nx * (mx - cx) + ny * (my - cy) + nz * (mz - cz) < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const d = nx * a[0] + ny * a[1] + nz * a[2];
        let outside = false;
        for (let t = 0; t < n; t++) {
          if (t === i || t === j || t === k) continue;
          if (nx * uniq[t][0] + ny * uniq[t][1] + nz * uniq[t][2] - d > 1e-5) { outside = true; break; }
        }
        if (outside) continue;
        let pl = null;
        for (const p of planes) {
          if (p.nx * nx + p.ny * ny + p.nz * nz > 0.9999 && Math.abs(p.d - d) < 1e-4) { pl = p; break; }
        }
        if (!pl) { pl = { nx, ny, nz, d, ids: [] }; planes.push(pl); }
        for (const id of [i, j, k]) if (!pl.ids.includes(id)) pl.ids.push(id);
      }
    }
  }
  buf.beginRun(tag);
  for (const pl of planes) {
    for (let t = 0; t < n; t++) {
      if (pl.ids.includes(t)) continue;
      if (Math.abs(pl.nx * uniq[t][0] + pl.ny * uniq[t][1] + pl.nz * uniq[t][2] - pl.d) <= 1e-5) pl.ids.push(t);
    }
    if (pl.ids.length < 3) continue;
    const ref = Math.abs(pl.ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let ex = ref[1] * pl.nz - ref[2] * pl.ny, ey = ref[2] * pl.nx - ref[0] * pl.nz, ez = ref[0] * pl.ny - ref[1] * pl.nx;
    const el = Math.hypot(ex, ey, ez) || 1;
    ex /= el; ey /= el; ez /= el;
    const mx = pl.ny * ez - pl.nz * ey, my = pl.nz * ex - pl.nx * ez, mz = pl.nx * ey - pl.ny * ex;
    const uv = pl.ids.map(id => {
      const p = uniq[id];
      return { id, u: p[0] * ex + p[1] * ey + p[2] * ez, v: p[0] * mx + p[1] * my + p[2] * mz };
    });
    uv.sort((a, b) => a.u - b.u || a.v - b.v);
    const cross2 = (o, a, b) => (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);
    const chain = (list) => {
      const h = [];
      for (const p of list) {
        while (h.length >= 2 && cross2(h[h.length - 2], h[h.length - 1], p) <= 1e-12) h.pop();
        h.push(p);
      }
      return h;
    };
    const lower = chain(uv), upper = chain(uv.slice().reverse());
    upper.pop(); lower.pop();
    const hull = lower.concat(upper);
    if (hull.length < 3) continue;
    const p0 = uniq[hull[0].id], p1 = uniq[hull[1].id], p2 = uniq[hull[2].id];
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const flip = (uy * vz - uz * vy) * pl.nx + (uz * vx - ux * vz) * pl.ny + (ux * vy - uy * vx) * pl.nz < 0;
    for (let i = 1; i < hull.length - 1; i++) {
      const A = uniq[hull[0].id], B = uniq[hull[i].id], C = uniq[hull[i + 1].id];
      if (flip) buf.tri(A, C, B); else buf.tri(A, B, C);
    }
  }
  buf.endRun();
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const nrm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const md = (x, m) => ((x % m) + m) % m;                                  // 负数取模（a/b 可为负）

/* 数值键：a/b ∈ [−2048, 2047] 半格，n 为层号（远小于 2^20），整体 < 2^53 */
const OFF = 2048, SPAN = 4096, LAYER = SPAN * SPAN;
const k2 = (a, b) => (a + OFF) * SPAN + (b + OFF);
const k3 = (a, b, n) => n * LAYER + k2(a, b);
const unk = k => { const n = Math.floor(k / LAYER), r = k - n * LAYER, a = Math.floor(r / SPAN); return [a - OFF, r - a * SPAN - OFF, n]; };

const MAX_NODES = 200000;    // 格架节点上限（防御性；正常模型远低于此）
const MAX_BARS = 600000;     // 杆件上限
const BEAM = 24;             // 柱化路径束搜索宽度

/* ctx：{ bvh, ld, groundY, faces, protNear, topY }；points：支撑点 [{x,y,z,n}]；P：参数快照
   返回 { geomGround, geomAnchor, stats, pointState } */
export async function buildEStageTowers(ctx, points, P) {
  // 长循环里定期让出主线程（ctx.yieldUI 由调用方给：每 ~24ms 让一次，界面照常响应）；几何实体化放在后台线程
  const tick = ctx.yieldUI || null;
  const { bvh, ld, groundY } = ctx;
  const w = Math.max(1, P.esCell);                                      // 格宽 = 墙距（俯视正方形网格边长）
  const crit = Math.max(10, Math.min(80, P.selfAngle)) * Math.PI / 180;
  const ang = Math.max(crit, Math.max(20, Math.min(85, P.esDiamAngle)) * Math.PI / 180);   // 斜边角（不低于临界角，斜边自支撑）
  const h = w * Math.tan(ang);                                          // 孔格竖高（由斜边角定）
  const ws = w / 2, hs = h / 2;                                         // 节点间距：水平半格 / 竖直半格
  const b = Math.max(0.15, P.esBarW), t = Math.max(0.15, P.esBarT);     // 边宽（板条面内宽）/ 边厚（墙厚）
  const gap = Math.max(0, P.esGap);
  const R = Math.hypot(b / 2, t / 2) + gap;                             // 杆件离模判定半径（板条外接圆 + 离模净距）
  const foundH = Math.max(0, P.esFoundH);
  const join = !!P.baseJoin;
  // 连接底板是垫在整套支撑下面的立板，板高 plateH（joinPlate.js）。开孔只在立板里，到不了板顶。
  // 板顶之上的实心肩 = 基础带高（joinShoulder），格架从肩顶才开孔。
  // 开孔上沿离板顶 max(0.4, 杆宽)，粗杆圆形接头不会贴进孔里。2026-10-16 曾把肩加到两倍杆宽来躲开孔沿，
  // 肩算在模型抬高之内，粗档格架起步离模型只剩约 1 mm。
  // 模型只抬板高 plateH；实心肩与基础带都在板顶之上，算在最短 4 mm 之内，最低的单杆正好从板顶落下、长 4 mm。
  // 自动底板：groundY 已是底板顶面，plateH 为 0，格架从「板顶 + 基础带」起步，不加这截肩。
  const plateH = join ? joinPlateHeight(P) : 0;
  const floorY = groundY + plateH;                                       // 支撑落地高度：连接底板顶 / 自动底板顶 / 平台
  const shoulder = join && plateH > 0 ? joinShoulder(P) : foundH;        // 板顶到格架起步的实心高度（= 基础带高）
  const baseTop = floorY + shoulder;                                     // 格架起步
  const tiltMax = Math.PI / 2 - crit, tanT = Math.tan(tiltMax);
  // 十字针（e-Stage Top connection，自格架节点直通接触点）：连接宽 → 过渡段渐缩 → 接触宽（接触边距段）→ 沿针轴扎入渗透长度
  const connW = Math.max(0.1, P.esConnW), needleT = Math.max(0.1, P.esNeedleT);   // 连接宽 / 针板厚（十字针针身 = 主干直径）
  const tipW = Math.max(0.05, Math.min(connW, P.esTipW)), tipT = Math.min(needleT, tipW);   // 接触宽（接触段板厚不超过接触宽）
  // 顶端这段锥的两头单独可调：上端靠近模型，底部靠近主干。缺省时上端=接触直径、底部=主干（连接宽）
  const topD = Math.max(0.05, Number.isFinite(+P.esTopD) ? +P.esTopD : tipW);
  const botD = Math.max(0.05, Number.isFinite(+P.esBotD) ? +P.esBotD : connW);
  // 短小支撑（十字短杆 / 分叉 / 贴面短连接）整根等比缩放：中段宽 = 主干直径（连接宽）× 小支撑缩放比例，
  // 端部接触宽也同比例（否则比例调小后中段被钳到未缩的接触宽，两端渐缩坍缩成等宽光杆——2026-10-14 用户截图）
  const sScale = Math.max(0.1, P.smallScale !== undefined ? P.smallScale : 0.8);
  const shortW = Math.max(0.05, connW * sScale);
  const shortTW = Math.max(0.03, tipW * sScale), shortTT = Math.max(0.03, tipT * sScale);
  const taper = Math.max(0.2, P.esTaper), cMargin = Math.max(0, P.esContactMargin);   // 过渡段长 / 接触边距
  const pen = Math.max(0, P.pen);                                       // 渗透长度
  // 开球头时：接触直径就是球的直径，接触深度就是球扎进模型的深度。
  // 球下面那段锥仍由上端直径、底部直径、顶端长度来定，但锥停在球的外侧，不再穿球扎进模型。
  // 否则接触段是一根和球一样粗的方杆，方杆的角（半对角线）比球还宽，把露在模型外面的球帽整个包住。
  const ball = P.tipBall !== false;
  const headD = Math.max(0.05, Number.isFinite(+P.esTipW) ? +P.esTipW : tipW);
  const headR = headD / 2;
  const headBury = Math.max(0, Math.min(pen, headD));
  const neckInset = 0.42 * headR;                                    // 从外极点沿扎入方向收进球里，端头埋在球里才连得上
  const distFromCenter = headR - neckInset;
  const neckCs = Math.sqrt(Math.max(1e-8, headR * headR - distFromCenter * distFromCenter));
  // 端头是方截面，角在对角线上。半对角线要落在该处球截面里面，球才鼓得出来
  const neckD = Math.min(topD, neckCs * 1.25);
  const neckOff = headBury - headR - distFromCenter;                 // 颈圈相对接触点，沿扎入方向。负 = 在模型外面
  const headFrame = into => {
    const n = nrm(into);
    const ref = Math.abs(n[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
    const e = nrm(cross(ref, n)), m = nrm(cross(n, e));
    return { n, e, m };
  };
  const headCenter = (origin, n) => [
    origin[0] + n[0] * (headBury - headR),
    origin[1] + n[1] * (headBury - headR),
    origin[2] + n[2] * (headBury - headR),
  ];
  /* 球头：纬线 8 圈、每圈 16 段。再少就看成一颗多面宝石。格架针走凸包，短杆直接出三角形。 */
  const putBall = (buf, origin, into) => {
    const { n, e, m } = headFrame(into);
    const [c0, c1, c2] = headCenter(origin, n);
    const rings = 8, segs = 16;
    const at = (i, j) => {
      const phi = Math.PI * (i / rings);
      const th = (2 * Math.PI * j) / segs;
      const sp = Math.sin(phi), cp = Math.cos(phi), rr = sp * headR;
      const ct = Math.cos(th), stt = Math.sin(th);
      return [
        c0 + n[0] * cp * headR + e[0] * rr * ct + m[0] * rr * stt,
        c1 + n[1] * cp * headR + e[1] * rr * ct + m[1] * rr * stt,
        c2 + n[2] * cp * headR + e[2] * rr * ct + m[2] * rr * stt,
      ];
    };
    if (!buf) {
      const pts = [at(0, 0), at(rings, 0)];
      for (let i = 1; i < rings; i++) for (let j = 0; j < segs; j++) pts.push(at(i, j));
      spec.hulls.push(pts);
    } else {
      buf.beginRun('ball');
      for (let j = 0; j < segs; j++) {
        const j2 = (j + 1) % segs;
        buf.tri(at(0, 0), at(1, j2), at(1, j));
        buf.tri(at(rings, 0), at(rings - 1, j), at(rings - 1, j2));
      }
      for (let i = 1; i < rings - 1; i++) {
        for (let j = 0; j < segs; j++) {
          const j2 = (j + 1) % segs;
          const a = at(i, j), b = at(i, j2), c = at(i + 1, j), d = at(i + 1, j2);
          buf.tri(a, b, d);
          buf.tri(a, d, c);
        }
      }
      buf.endRun();
    }
    st.balls++;
  };
  const putHead = (buf, origin, into) => { if (ball) putBall(buf, origin, into); };
  const rCross = Math.hypot(connW / 2, needleT / 2);                    // 十字截面外接圆半径（净空判定）
  const Lmax = Math.max(1, P.esNeedleMax);                              // 针最大长（格架节点 → 接触点）
  const Dcol = columnHeight(P);                           // 柱高 = 柱高宽比 × 格宽（展宽 / 壳层缩减的深度步长）
  const maxWid = Math.max(0, Math.round(P.esTowerMaxR));                // 最大展宽（每侧格数）
  const hullRed = Math.max(0, Math.min(3, Math.round(P.esHullRed || 0)));   // 壳层缩减级数（0 = 关闭）
  const mid = P.esMidBars !== false;
  const st = { points: points.length, needles: 0, nodes: 0, bars: 0, towers: 0, foundRuns: 0, fallback: 0, ground: 0, anchors: 0, shortAnchors: 0, micro: 0, plates: 0, noHead: 0, unroutable: 0, unconnected: 0, diagFall: 0, diagPatch: 0, cubes: 0, balls: 0, capped: false };
  const pointState = new Array(points.length).fill('');
  if (join) { st.bandH = +plateH.toFixed(2); st.stripH = +(plateH + shoulder).toFixed(2); }   // 板高 / 平台到格架起步（实心肩在板顶之上）
  const pos = (a, bb, n) => [a * ws, baseTop + n * hs, bb * ws];

  /* ---------- 离模判定（缓存） ---------- */
  const dCap = 2 * Math.hypot(ws, hs) + R + 1;
  const nodeD = new Map();
  const nodeDist = (a, bb, n) => {                 // 到模型的距离（LDI 实体内部 = −1；上限 dCap）
    const k = k3(a, bb, n);
    let d = nodeD.get(k);
    if (d === undefined) {
      const p = pos(a, bb, n);
      d = ld && ldiInside(ld, p[0], p[1], p[2]) ? -1 : pointDist(bvh, p[0], p[1], p[2], dCap);
      nodeD.set(k, d);
    }
    return d;
  };
  const nodeOK = (a, bb, n) => nodeDist(a, bb, n) >= R;
  const edgeC = new Map();
  const edgeOK = (a1, b1, n1, a2, b2, n2) => {     // 相邻层杆件（任意端序）
    if (n1 > n2) { let x = a1; a1 = a2; a2 = x; x = b1; b1 = b2; b2 = x; x = n1; n1 = n2; n2 = x; }
    const k = k3(a1, b1, n1) * 9 + (a2 - a1 + 1) * 3 + (b2 - b1 + 1);
    let v = edgeC.get(k);
    if (v === undefined) {
      v = nodeOK(a1, b1, n1) && nodeOK(a2, b2, n2);
      if (v) {
        const A = pos(a1, b1, n1), B = pos(a2, b2, n2), L = len(sub(A, B));
        // 捷径：端点离模距离 − 半杆长 ≥ R → 整根杆必在净空内（点距 1-Lipschitz），免做胶囊体精确判定
        const dm = Math.min(nodeDist(a1, b1, n1), nodeDist(a2, b2, n2));
        if (dm - L / 2 < R) v = capsuleClear(bvh, A[0], A[1], A[2], B[0], B[1], B[2], R);
      }
      edgeC.set(k, v);
    }
    return v;
  };

  /* ---------- 细格拓扑（q = 2，柱化路径搜索用） ---------- */
  const vert2 = (a, bb) => (mid ? ((a & 1) === 0 || (bb & 1) === 0) : ((a & 1) === 0 && (bb & 1) === 0));
  const exists2 = (a, bb, n) => n >= 0 && ((a & 1) === 0 || (bb & 1) === 0)
    && (vert2(a, bb) || ((bb & 1) === 0 && ((a + n) & 1) === 0) || ((a & 1) === 0 && ((bb + n) & 1) === 0));
  const downs2 = (a, bb, n) => {                   // 下行杆：竖杆 + 墙内斜边（三角格：单向，与 upEdges 互为逆）
    const out = [];
    if (n <= 0) return out;
    if (vert2(a, bb)) out.push([a, bb, n - 1, false]);
    const m = n - 1, fwdM = md(m, 4) < 2, d = fwdM ? -1 : 1;   // 上行向右（fwd）⇔ 下行向左
    if ((bb & 1) === 0 && md(fwdM ? a - 1 - m : a + 1 + m, 2) === 0) out.push([a + d, bb, n - 1, true]);
    if ((a & 1) === 0 && md(fwdM ? bb - 1 - m : bb + 1 + m, 2) === 0) out.push([a, bb + d, n - 1, true]);
    return out;
  };
  // 竖直下行到底是否通畅：每个平面点缓存「自底向上连续净空的最高层」（胶囊体二分）
  const nTopAll = Math.max(1, Math.ceil(((ctx.topY ?? baseTop + 100) - baseTop) / hs) + 2);
  const colTop = new Map();
  const clearTop = (a, bb) => {
    const k = k2(a, bb);
    let v = colTop.get(k);
    if (v !== undefined) return v;
    v = -1;
    if (vert2(a, bb) && nodeOK(a, bb, 0)) {
      const P0 = pos(a, bb, 0);
      const ok = n => { const Q = pos(a, bb, n); return capsuleClear(bvh, P0[0], P0[1], P0[2], Q[0], Q[1], Q[2], R); };
      let lo = 0, hi = nTopAll;
      if (ok(hi)) lo = hi;
      else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ok(m)) lo = m; else hi = m; }
      v = lo;
    }
    colTop.set(k, v);
    return v;
  };
  /* 柱化路径（专利 FIG.10）：逐层束搜索，竖直优先，被挡住时沿斜边绕行；返回自起点到底层的节点序列或 null */
  const lenV = hs, lenD = Math.hypot(ws, hs);
  const findPath = (a0, b0, n0) => {
    if (n0 <= clearTop(a0, b0)) { const path = []; for (let n = n0; n >= 0; n--) path.push([a0, b0, n]); return path; }
    let front = [{ a: a0, b: b0, n: n0, cost: 0, prev: null }];
    let best = null;
    for (let n = n0; n > 0 && front.length; n--) {
      const next = new Map();
      for (const f of front) {
        if (best && f.cost >= best.cost) continue;
        if (n <= clearTop(f.a, f.b)) {   // 此处已可竖直落到底
          const c = f.cost + n * lenV;
          if (!best || c < best.cost) best = { ...f, cost: c, tail: true };
          continue;
        }
        for (const [a, bb, nn, diag] of downs2(f.a, f.b, n)) {
          if (!edgeOK(f.a, f.b, n, a, bb, nn)) continue;
          const c = f.cost + (diag ? lenD * 1.15 : lenV);
          const k = k2(a, bb), o = next.get(k);
          if (!o || c < o.cost) next.set(k, { a, b: bb, n: nn, cost: c, prev: f });
        }
      }
      front = [...next.values()].sort((x, y) => x.cost - y.cost).slice(0, BEAM);
      for (const f of front) if (f.n === 0 && (!best || f.cost < best.cost)) best = f;
    }
    if (!best) return null;
    const rev = [];
    for (let v = best; v; v = v.prev) rev.push([v.a, v.b, v.n]);
    const path = rev.reverse();
    if (best.tail) { const [a, bb, n] = path[path.length - 1]; for (let k = n - 1; k >= 0; k--) path.push([a, bb, k]); }
    return path;
  };
  // 接触方向（自接触点指向外，朝下）：被托面外法线钳进 45° 接触锥（tipCone，逐面计算）。替补：竖直
  const tc = tipCone();
  const tipDirs = p => {
    const d0 = dirCandidates(p.n, -1, tc.tilt, 8 * Math.PI / 180)[0];
    return d0[1] < -0.999 ? [d0] : [d0, [0, -1, 0]];
  };
  const clamp1 = x => Math.max(-1, Math.min(1, x));
  /* ---- 格架同向针（专利 FIG.13b + 正文「connection is made along one of the directions of the mesh edges」）----
     针轴只取格架自身的方向：① 竖直，与「+」柱 / 墙内竖杆同轴；② 墙面内斜向（针轴落在节点所在的墙面里，倾角 ≤ 接触最大倾角 ∩ 临界锥）。
     十字截面与格架对齐（专利 FIG.13c 截面 A-A′）：一片板就在墙面内、与墙内杆件同宽同厚，经节点圆角板无缝相接；另一片板垂直墙面。
     接触点按专利做法重定义：针轴延长线与模型的首个交点（「structure 125 is virtually prolonged until it intersects with the object」），
     偏移 ≤ 接触宽（至少 0.15 mm）；孤岛种子不得上移 > 0.1——最低点先打印。
     偏移原先允许到 min(1.2, 0.4·格宽)：支撑点挪到接触点后被吸到格架墙线附近，边缘环 / 内部六角格的均匀分布被打乱
     （用户 2026-10-12 截图指出；环面结 206 点里 143 点被挪动，中位 0.53、最大 1.2 mm）。现在接不进这个范围的点改用自由直针，直接接到支撑点本身。
     旧实现让直针朝法线任意方位斜出：十字板离开墙面、针脚水平切口外露，节点处出现小方块 / 台阶（用户截图红框指出）。 */
  const thMax = Math.min(tc.tilt, tiltMax);              // 墙面内斜针最大倾角
  // 接触点偏移上限：不超过接触宽、也不超过 0.3mm（针尖落在支撑点标记球里）。粗档接触直径 1.0mm，原先按接触宽放行，
  // 格架同向针把支撑点挪到 0.95～0.99mm（≈ 0.25 × 间距），布点的均匀被打乱（2026-10-17 实测）
  const shiftTol = Math.min(0.3, Math.max(0.15, tipW));
  const shiftOf = () => shiftTol;
  const arP = Math.ceil(Lmax * Math.tan(thMax) / ws) + 1;
  const triNrm = f => {                                  // 三角形外法线（世界系，与 computeFaceDataFull 同绕序）
    const T = bvh.tri, i = f * 9;
    return nrm(cross([T[i + 3] - T[i], T[i + 4] - T[i + 1], T[i + 5] - T[i + 2]], [T[i + 6] - T[i], T[i + 7] - T[i + 1], T[i + 8] - T[i + 2]]));
  };
  // 候选（按代价升序）：nodeAt(a, b, n) 判定节点可用（规划阶段 = 细格存在；接入阶段 = 已保留格架）。
  // 针轴偏离期望方向 ≤ 25°（同自由直针上限）——超出时宁可用方向精确的自由直针：曾因角度权重过低，
  // 平面上选出 40° 斜针、斜面上选出朝侧面 / 反方向倾斜的针（方位差 50°~166°）。
  // 代价 = 针长 + 8 × 针轴偏离期望方向（弧度）+ 2 × 接触点偏移估计（mm）
  const DEV_AL = 25 * Math.PI / 180;
  const alignedCands = (p, pi, nodeAt) => {
    const out = [], n = p.n || [0, -1, 0], sMax = shiftOf(p);
    const d0 = dirsOf[pi][0], uw = [-d0[0], -d0[1], -d0[2]];   // 期望针轴（自节点指向接触点）
    // ① 竖直针：接触点附近的竖杆柱；接触高度按切平面估计
    for (let a = Math.ceil((p.x - sMax) / ws); a <= Math.floor((p.x + sMax) / ws); a++)
      for (let bb = Math.ceil((p.z - sMax) / ws); bb <= Math.floor((p.z + sMax) / ws); bb++) {
        if (!vert2(a, bb)) continue;
        const dx = a * ws - p.x, dz = bb * ws - p.z;
        const yt = Math.abs(n[1]) > 0.3 ? p.y - (n[0] * dx + n[2] * dz) / n[1] : p.y;
        const sh = Math.hypot(dx, yt - p.y, dz);
        if (sh > sMax) continue;
        const dev = Math.acos(clamp1(uw[1]));
        if (dev > DEV_AL) continue;
        for (let nn = Math.floor((yt - 0.3 - baseTop) / hs), k = 0; nn >= 0 && k < 3; nn--) {
          if (!nodeAt(a, bb, nn)) continue;
          const N = pos(a, bb, nn), L = yt - N[1];
          if (L > Lmax) break;
          out.push({ kind: 'v', a, b: bb, n: nn, N, u: [0, 1, 0], L, cost: L + 8 * dev + 2 * sh });
          k++;
        }
      }
    // ② 墙面内斜针：pl 0 = z 固定墙（z = 偶数半格，针沿 x 倾斜）/ 1 = x 固定墙（针沿 z 倾斜）
    if (thMax > 0.02) for (const pl of [0, 1]) {
      const c0 = pl === 0 ? p.z : p.x, ni = pl === 0 ? n[0] : n[2], nw = pl === 0 ? n[2] : n[0];
      const den = ni * ni + n[1] * n[1];
      if (den < 0.05) continue;                          // 被托面正对墙法向：移到墙面内要沿表面爬太远
      // 墙面内表面切向（面内坐标 (s, y)）：目标点可沿它再挪 ±0.6——孤岛周界点垂直墙面挪进来时可能落到边缘外，切向挪一点就能打中
      const tl = Math.hypot(n[1], ni) || 1, ts = n[1] / tl, ty = -ni / tl;
      for (let wi = Math.ceil((c0 - sMax) / w); wi <= Math.floor((c0 + sMax) / w); wi++) {
        // 切平面上离支撑点最近、且落在该墙面内的点
        const dc = wi * w - c0, ds0 = -nw * dc * ni / den, dy0 = -nw * dc * n[1] / den, iw = 2 * wi;
        for (const dl of [0, 0.6, -0.6]) {
          const ds = ds0 + ts * dl, dy = dy0 + ty * dl, sh = Math.hypot(ds, dy, dc);
          if (sh > sMax) continue;
          const sT = (pl === 0 ? p.x : p.z) + ds, yT = p.y + dy;
          const ci = Math.round(sT / ws);
          const nHi = Math.floor((yT - 0.3 - baseTop) / hs), nLo = Math.max(0, Math.ceil((yT - Lmax - baseTop) / hs));
          for (let nn = nHi; nn >= nLo; nn--) for (let i = ci - arP; i <= ci + arP; i++) {
            const a = pl === 0 ? i : iw, bb = pl === 0 ? iw : i;
            const hsft = sT - i * ws, vy = yT - (baseTop + nn * hs);
            if (vy < 0.3 || Math.abs(hsft) < 1e-3 || Math.abs(hsft) > vy * Math.tan(thMax) + 1e-6) continue;   // 正上方 = 竖直针，由 ① 覆盖
            const L = Math.hypot(hsft, vy);
            if (L > Lmax || !nodeAt(a, bb, nn)) continue;
            const u = pl === 0 ? [hsft / L, vy / L, 0] : [0, vy / L, hsft / L];
            const dev = Math.acos(clamp1(u[0] * uw[0] + u[1] * uw[1] + u[2] * uw[2]));
            if (dev > DEV_AL) continue;
            out.push({ kind: 'p', pl, a, b: bb, n: nn, N: pos(a, bb, nn), u, L, cost: L + 8 * dev + 2 * sh });
          }
        }
      }
    }
    return out.sort((x, y) => x.cost - y.cost);
  };
  // 候选核验：自节点沿针轴求首个命中 = 重定义后的接触点；偏移 / 孤岛种子不上移 / 掠射 / 保护面 / 针净空
  const why = st.alignWhy = { hit: 0, shift: 0, rise: 0, graze: 0, prot: 0, clear: 0, path: 0, none: 0 };   // 同向针未采用的原因（自检）
  const verifyAligned = (p, c) => {
    const N = c.N, u = c.u;
    const hit = raycast(bvh, N[0], N[1], N[2], u[0], u[1], u[2], 0.05, c.L + 1.5);
    if (!hit || hit.t < 0.3) { why.hit++; return null; }
    const C = [N[0] + u[0] * hit.t, N[1] + u[1] * hit.t, N[2] + u[2] * hit.t];
    const shift = Math.hypot(C[0] - p.x, C[1] - p.y, C[2] - p.z);
    if (shift > shiftOf(p)) { why.shift++; return null; }
    if (p.island !== null && p.island !== undefined && C[1] > p.y + 0.1) { why.rise++; return null; }
    let fn = triNrm(hit.f);
    if (fn[0] * u[0] + fn[1] * u[1] + fn[2] * u[2] > 0) fn = [-fn[0], -fn[1], -fn[2]];   // 绕序反了的 STL
    if (-(fn[0] * u[0] + fn[1] * u[1] + fn[2] * u[2]) < 0.3) { why.graze++; return null; }   // 掠射：针轴与表面夹角 < 17.5°
    if (ctx.protNear && ctx.protNear({ x: C[0], y: C[1], z: C[2] })) { why.prot++; return null; }
    if (!needleClear(C, N)) { why.clear++; return null; }
    return { ...c, C, L: hit.t, shift, fn };
  };
  // 挪支撑点到接触点 C：与其它支撑点的净距不得低于布点的最小距离（0.8 × 间距，与布点的 DMIN 同口径；原只守「支撑杆直径 + 0.4」，
  // 挪过去的点会和布点挤成一对）；挪不动返回 false
  const clearMove = Math.max(0.3, (P.esBarW || 0.6) + 0.4, 0.8 * (P.spacing || 2.5));
  const moveTo = (p, C) => {
    for (const q of points) if (q !== p && Math.hypot(q.x - C[0], q.y - C[1], q.z - C[2]) < clearMove) { st.moveBlocked = (st.moveBlocked || 0) + 1; return false; }
    p.x = C[0]; p.y = C[1]; p.z = C[2];
    return true;
  };
  /* ---- 自由直针（兜底：格架同向针在偏移限度内接不上时，接触点不动，节点 → 支撑点直连）---- */
  const DEV_MAX = 25 * Math.PI / 180;
  const needleCost = (p, N, d) => {
    const dy = p.y - N[1], hx = N[0] - p.x, hz = N[2] - p.z, dh = Math.hypot(hx, hz);
    if (dy < 0.3 || dh > dy * tanT + 1e-6) return -1;
    const L = Math.hypot(dh, dy);
    if (L > Lmax) return -1;
    const dev = Math.acos(clamp1((hx * d[0] - dy * d[1] + hz * d[2]) / L));
    if (dev > DEV_MAX) return -1;
    // 斜向偏移（X、Z 同时偏）惩罚：针身尽量留在一面墙里，根部截面才对得上柱顶。
    // 接触段的方向另算（见下方 aimOf）：这里只决定针身接到哪一个节点，不决定针尖朝哪。
    return L + 0.6 * dh + 6 * dev + 0.8 * Math.min(Math.abs(hx), Math.abs(hz));
  };
  // 自由直针针轴：节点 → 接触点的直线（错切十字直杆 + 过渡段 + 接触段），渗透段沿针轴扎入
  const needleCurve = (p, N) => {
    const P4 = [p.x, p.y, p.z];
    const pts = [N, P4], acc = [0, len(sub(P4, N))];
    const m = 1, L = acc[1], tEnd = nrm(sub(P4, N));
    const posAt = s => {                             // 弧长 s 处的点；s > L 沿接触方向外推（渗透段，扎入模型）
      if (s >= L) return [P4[0] + tEnd[0] * (s - L), P4[1] + tEnd[1] * (s - L), P4[2] + tEnd[2] * (s - L)];
      let i = 1; while (i < m && acc[i] < s) i++;
      const f = (s - acc[i - 1]) / ((acc[i] - acc[i - 1]) || 1), A = pts[i - 1], B = pts[i];
      return [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f];
    };
    return { pts, acc, L, posAt };
  };
  // 针净空（直针，接触点 C、节点 N）：针身（节点 → 过渡段起点）按十字截面外接圆 + 0.1 做胶囊体判定；
  // 过渡段按锥台（接触端 tipW/2 → 起点 rCross，+0.1），自接触点起豁免「顶端长度（过渡段 + 接触边距）+ 0.2」
  // （针头本就贴住 / 扎入表面；接触边距为 0 时只豁免过渡段，否则过渡段贴近模型的那一截会被整根误判为穿模）
  const needleClear = (C, N) => {
    const L = len(sub(C, N)), u = nrm(sub(C, N)), s1 = Math.max(0, L - taper - cMargin);
    const S1 = [N[0] + u[0] * s1, N[1] + u[1] * s1, N[2] + u[2] * s1];
    if (s1 > 0.02 && !capsuleClear(bvh, N[0], N[1], N[2], S1[0], S1[1], S1[2], rCross + 0.1)) return false;
    return coneClear(bvh, C[0], C[1], C[2], tipW / 2 + 0.1, S1[0], S1[1], S1[2], rCross + 0.1, taper + cMargin + 0.2);
  };

  /* ---------- 1. 每个支撑点：针最省、可落地的接入节点 + 柱化路径 ---------- */
  const plan = new Array(points.length).fill(null);
  const ar = Math.ceil(Lmax * tanT / ws) + 1;
  const dirsOf = points.map(tipDirs);                // 每点的接触方向（主方向 + 竖直替补）
  for (let pi = 0; pi < points.length; pi++) {
    if (tick) await tick();
    const p = points[pi];
    // 优先：格架同向针（竖直 / 墙面内斜向，接触点重定义）
    let tries = 0;
    const ac = alignedCands(p, pi, exists2);
    if (!ac.length) why.none++;
    for (const c of ac) {
      if (tries >= 24) break;
      if (!nodeOK(c.a, c.b, c.n)) continue;
      tries++;
      const v = verifyAligned(p, c);
      if (!v) continue;
      const path = findPath(c.a, c.b, c.n);
      if (path) { plan[pi] = { top: v, path }; break; }
      why.path++;
    }
    if (plan[pi]) continue;
    // 兜底：自由直针（接触点不动）
    const C = [p.x, p.y, p.z];
    for (const d of dirsOf[pi]) {
      const nHi = Math.floor((p.y - 0.3 - baseTop) / hs), nLo = Math.max(0, Math.ceil((p.y - Lmax - baseTop) / hs));
      if (nHi < 0) continue;
      const ca = Math.round(p.x / ws), cb = Math.round(p.z / ws);
      const cand = [];
      for (let n = nHi; n >= nLo; n--) for (let a = ca - ar; a <= ca + ar; a++) for (let bb = cb - ar; bb <= cb + ar; bb++) {
        if (!exists2(a, bb, n)) continue;
        const N = pos(a, bb, n), cost = needleCost(p, N, d);
        if (cost >= 0) cand.push({ kind: 'free', a, b: bb, n, cost, N, C });
      }
      cand.sort((x, y) => x.cost - y.cost);
      tries = 0;
      for (const c of cand) {
        if (tries >= 16) break;
        if (!nodeOK(c.a, c.b, c.n)) continue;
        tries++;
        if (!needleClear(C, c.N)) continue;
        const path = findPath(c.a, c.b, c.n);
        if (path) { plan[pi] = { top: c, path }; break; }
      }
      if (plan[pi]) break;
    }
  }

  /* ---------- 2. 支撑区域：路径所在格（墙到墙），每下降一个柱高向四周展宽一格 ---------- */
  const regL = [];                                   // regL[n]：Map(k2 → 最浅深度 d)
  const forced = new Map();                          // 规划路径上的杆件（下层节点键 → 上层 [a,b,n]）
  let nMax = 0;
  const span = (c, xp) => ((c & 1) ? [c - 1, c + 1] : (c * ws <= xp ? [c, c + 2] : [c - 2, c]));   // 节点所在格；在墙上时取偏向支撑点一侧
  for (let pi = 0; pi < points.length; pi++) {
    const g = plan[pi];
    if (!g) continue;
    const p = points[pi];
    for (let i = 0; i < g.path.length; i++) {
      const [pa, pb, pn] = g.path[i];
      const d = Math.max(0, p.y - (baseTop + pn * hs));
      const wid = Math.min(maxWid, Math.floor(d / Dcol));
      let [aLo, aHi] = span(pa, p.x), [bLo, bHi] = span(pb, p.z);
      aLo -= 2 * wid; aHi += 2 * wid; bLo -= 2 * wid; bHi += 2 * wid;
      // 区域最小宽度（半格）：比 4 半格还窄的路径条（单根柱化落柱/细支腿）两侧长不出格架，
      // 那一段就成了「独立主干」（用户 2026-10-14 截图）。对称扩到至少 4 半格，让邻列自然长出、
      // 斜边链可接；宽区域不受影响。
      while (aHi - aLo < 3) { aLo--; aHi++; }
      while (bHi - bLo < 3) { bLo--; bHi++; }
      const m = regL[pn] || (regL[pn] = new Map());
      for (let a = aLo; a <= aHi; a++) for (let bb = bLo; bb <= bHi; bb++) {
        if ((a & 1) && (bb & 1)) continue;          // 两向都是奇数 = 格子内部，不在任何墙上
        const k = k2(a, bb), o = m.get(k);
        if (o === undefined || d < o) m.set(k, d);
      }
      if (i > 0) {
        const [ua, ub, un] = g.path[i - 1];
        const kl = k3(pa, pb, pn);
        let arr = forced.get(kl); if (!arr) forced.set(kl, arr = []);
        if (!arr.some(e => e[0] === ua && e[1] === ub)) arr.push([ua, ub, un]);
      }
      if (pn > nMax) nMax = pn;
    }
  }
  const regGet = (a, bb, n) => { const m = regL[n]; return m ? m.get(k2(a, bb)) : undefined; };
  // 调试：区域表底部前几层 dump（[a, b, 最浅深度]），供「独立主干」分析（只挂 window，不进 stats）
  if (typeof window !== 'undefined') window.__regDump = regL.slice(0, 5).map(m => m ? [...m].map(([kk, d]) => { const a = Math.floor(kk / SPAN) - OFF, bb = kk - (a + OFF) * SPAN - OFF; return [a, bb, d]; }) : []);
  const regHas = (a, bb, n) => regGet(a, bb, n) !== undefined;
  /* 节点所在级的格周期 q（半格）：壳层缩减每下降一个柱高翻倍一次——只放大内部结构（手册 Inner hull），
     区域边界上的外墙保持最小孔格（外壳缩减 0 级），塔块轮廓不随粗格跳变 */
  const qAt = (a, bb, n) => {
    const d = regGet(a, bb, n);
    if (d === undefined) return 0;
    const k = Math.min(hullRed, Math.floor(d / Dcol));
    if (!k) return 2;
    if ((a & 1) === 0 && !(regHas(a - 2, bb, n) && regHas(a + 2, bb, n))) return 2;
    if ((bb & 1) === 0 && !(regHas(a, bb - 2, n) && regHas(a, bb + 2, n))) return 2;
    return 2 << k;
  };
  /* 上行杆（自下层节点 (a,b,n)，存在性取下层节点所在级的周期 q）：[a2, b2, 类型, 在 x 固定墙, 在 z 固定墙]
     三角格（2026-10-14 规避改造）：两组斜边不再同时向上（那是菱形孔），改为按竖直位置每 q 个半格折返、只出一根——
     孔从菱形变三角形；墙、竖杆（vx / vz）、尺寸、自支撑角全部不变。 */
  const upEdges = (a, bb, n) => {
    const q = qAt(a, bb, n);
    if (!q) return [];
    const wx = md(a, q) === 0, wz = md(bb, q) === 0;   // x 固定墙（沿 z 走向）/ z 固定墙（沿 x 走向）
    const out = [];
    if (!wx && !wz) return out;
    const vs = mid ? q >> 1 : q;
    const vx = wx && md(bb, vs) === 0, vz = wz && md(a, vs) === 0;
    if (vx || vz) out.push([a, bb, 'v', vx, vz]);
    const fwd = md(n, 2 * q) < q;                      // 本周期前半段斜边朝 + 一侧，后半段反向（在竖杆处折返）
    // 斜边链的相位间距 qs（半格）：不随壳层缩减整级翻倍——跟着 q 翻倍时，粗格（q≥4）每两格才有一条链，
    // 主干上长段没有斜边接点（用户 2026-10-14 截图：中粗 / 粗档的一根竖杆整段无加强，晃动隐患）。
    // 最小保持细格的 2 半格（q=2 行为不变）；q≥4 时取 q/2，链的密度与细格一致，孔仍随折返周期放大。
    const qs = Math.max(2, q >> 1);
    // 主方向在前、反向备选在后（消费端「主向被区域拒收时才用备选」——链在区域边界折返）；
    // 没有备选时，q 混合区的边界列（qAt 退回 2 的细格列）整列没有斜边，从底板起就是一根独立主干。
    if (wz) {
      const d = fwd ? 1 : -1;
      if (md(a - d * n, qs) === 0) out.push([a + d, bb, 'x']);
      if (md(a + d * n, qs) === 0) out.push([a - d, bb, 'x']);
    }
    if (wx) {
      const d = fwd ? 1 : -1;
      if (md(bb - d * n, qs) === 0) out.push([a, bb + d, 'z']);
      if (md(bb + d * n, qs) === 0) out.push([a, bb - d, 'z']);
    }
    return out;
  };

  /* ---------- 3. 自平台逐层向上：有下行杆连到已保留节点才保留（无孤岛）；两端都保留的杆件全部收录（孔格闭合） ---------- */
  const G = new Set();
  const edges = [];                                  // { a1,b1,n1, a2,b2,n2, kind, vx, vz }
  let cur = [];
  if (regL[0]) {
    for (const k of regL[0].keys()) {
      const [a, bb] = unk(k);
      const ups = upEdges(a, bb, 0);
      if (!ups.length && !forced.has(k3(a, bb, 0))) continue;
      if (!nodeOK(a, bb, 0)) continue;
      G.add(k3(a, bb, 0)); cur.push([a, bb]);
    }
  }
  for (let n = 1; n <= nMax && cur.length; n++) {
    if (tick) await tick();
    const next = new Map();
    const take = (a, bb, a2, b2, kind, vx, vz) => {
      // 目标格不在区域时，允许「紧邻区域半格」的目标：区域按路径节点的墙格逐层构造，边界可能漏半格宽的空带——
      // 斜边链跨到空带的第一步被拒，整列主干就没了加强（2026-10-14 独立主干修复）；放宽半步让链贴到区域边上，
      // 净空仍由 edgeOK 严格把关。放宽目标只影响斜边：竖杆目标与源同格、直接命中区域。
      if (regGet(a2, b2, n) === undefined
        && regGet(a2 + 1, b2, n) === undefined && regGet(a2 - 1, b2, n) === undefined
        && regGet(a2, b2 + 1, n) === undefined && regGet(a2, b2 - 1, n) === undefined) {
        st.rejReg = (st.rejReg || 0) + 1; return false;
      }
      if (!edgeOK(a, bb, n - 1, a2, b2, n)) { st.rejOK = (st.rejOK || 0) + 1; return false; }
      edges.push({ a1: a, b1: bb, n1: n - 1, a2, b2, n2: n, kind, vx, vz });
      const k = k2(a2, b2);
      if (!next.has(k)) { next.set(k, [a2, b2]); G.add(k3(a2, b2, n)); }
      return true;
    };
    for (const [a, bb] of cur) {
      const ups = upEdges(a, bb, n - 1);
      const diagDone = { x: false, z: false };
      for (const [a2, b2, kind, vx, vz] of ups) {
        if (kind === 'v') { take(a, bb, a2, b2, kind, vx, vz); continue; }
        // 朝每个方向（x 向 / z 向）每层至多一根斜边：主方向在前；被区域拒收时用反向后备折返
        //（否则 q 混合区的边界列整列无斜边）。「+」柱节点两向各一根，互不占位。
        if (diagDone[kind]) continue;
        const ok = take(a, bb, a2, b2, kind, vx, vz);
        if (!ok) st.diagFall = (st.diagFall || 0) + 1;   // 主向被拒（触发折返尝试）
        diagDone[kind] = ok;
      }
      const fz = forced.get(k3(a, bb, n - 1));
      if (fz) for (const [a2, b2] of fz) {
        if (ups.some(e => e[0] === a2 && e[1] === b2)) continue;
        const kind = a2 === a && b2 === bb ? 'v' : (b2 === bb ? 'x' : 'z');
        take(a, bb, a2, b2, kind, (a & 1) === 0, (bb & 1) === 0);
      }
    }
    cur = [...next.values()];
    if (G.size > MAX_NODES || edges.length > MAX_BARS) { st.capped = true; break; }
  }

  /* ---------- 4. 接入：优先接规划路径的起点；否则接接触点下方最省的已保留节点（长度 / 倾角 / 针净空） ---------- */
  const gHash = new Map(), hc = Lmax;
  for (const k of G) {
    const [a, bb, n] = unk(k), [x, y, z] = pos(a, bb, n);
    const hk = `${Math.floor(x / hc)},${Math.floor(y / hc)},${Math.floor(z / hc)}`;
    let arr = gHash.get(hk); if (!arr) gHash.set(hk, arr = []); arr.push([a, bb, n, x, y, z]);
  }
  const needles = [];
  const fallbackIdx = [];
  const lowIdx = [];                                 // 低空间点：格架立不起来，改成单杆直落到底板（不参与分叉）
  const lowSpans = new Map();                        // 低空间单杆的落地方案（这里判定、步骤 7 出几何，同一份结果）
  // 十字短杆 / 低空间单杆的落地：竖直优先、再在接触锥里斜着试，落到下方朝上的模型面或底座顶（floorY）；接触端半径 0.2
  const shortSpan = (p, maxLen) => bridgeToSurface(bvh, ctx.faces, p, {
    rTip: 0.2, maxLen, pen: P.pen, protNear: ctx.protNear, sinkTop: true, tiltMax, groundY: floorY,
  });
  for (let pi = 0; pi < points.length; pi++) {
    if (tick) await tick();
    const p = points[pi], g = plan[pi];
    // 最短 4 mm（2026-10-16 用户定）：接触点离格架起步面不足一个柱高时，格架压成扁块，改用单杆直落到底板 / 平台 /
    // 自动底板顶面——最短的单杆 = 模型抬高（默认 4 mm），不再两两配成分叉。与「短小支撑」开关无关（关了也照生成）。
    // 限长按该点到底座的高度给足：低空间判的是「离格架起步面不足一个柱高」，粗档柱高 17.4 mm，离底座可到 20 mm；
    // 原先沿用十字短杆的 12 mm，判成单杆却落不下去（环面结粗档 21 点标红、1 处孤岛悬空）。
    // 仍落不下去（正下方被模型挡住等）就回到下面的常规接入（格架针 → 就近接格架 → 分叉 → 十字短杆），不直接标红
    if (p.y - baseTop < Dcol) {
      const s = shortSpan(p, Math.max(12, (p.y - floorY) / Math.cos(tiltMax) + 1));
      if (s) { lowIdx.push(pi); lowSpans.set(pi, s); fallbackIdx.push(pi); continue; }
      st.lowBack = (st.lowBack || 0) + 1;
    }
    let hook = null;
    if (g && G.has(k3(g.top.a, g.top.b, g.top.n)) && (g.top.kind === 'free' || moveTo(p, g.top.C))) hook = g.top;   // 挪不动（与其它点挤在一起）就改走下面的兜底
    if (!hook) {                                     // 格架同向针接已保留节点
      let tries = 0;
      for (const c of alignedCands(p, pi, (a, bb, n) => G.has(k3(a, bb, n)))) {
        if (tries++ >= 24) break;
        const v = verifyAligned(p, c);
        if (v && moveTo(p, v.C)) { hook = v; break; }
      }
    }
    if (!hook) {                                     // 自由直针接已保留节点
      const C = [p.x, p.y, p.z];
      const ci = Math.floor(p.x / hc), cj = Math.floor(p.y / hc), ck = Math.floor(p.z / hc);
      const cand = [];
      for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (let dc = -1; dc <= 1; dc++) {
        const arr = gHash.get((ci + da) + ',' + (cj + db) + ',' + (ck + dc));
        if (!arr) continue;
        for (const [a, bb, n, x, y, z] of arr) for (const d of dirsOf[pi]) {
          const N = [x, y, z], cost = needleCost(p, N, d);
          if (cost >= 0) cand.push({ kind: 'free', a, b: bb, n, cost, N, C });
        }
      }
      cand.sort((x, y) => x.cost - y.cost);
      for (let i = 0; i < cand.length && i < 24; i++) if (needleClear(C, cand[i].N)) { hook = cand[i]; break; }
    }
    if (!hook) {                                     // 就近接格架（2026-10-12 用户：「这种就直接算法就近连接啊」——别让短杆孤零零立在格架旁边）
      // 常规两种针都接不上时：在 2 倍针最大长内找最近的已保留节点直连；针身仍须在临界锥内（自支撑），
      // 接触方向放宽到接触锥（45°，常规自由直针限 25°），但按偏离期望方向加价，贴着法线的节点优先。接不上的才交给分叉 / 十字短杆 / 标红
      const C = [p.x, p.y, p.z], reach = 2 * Lmax, rr = Math.ceil(reach / hc);
      const dWant = dirsOf[pi][0];                       // 期望方向（法线钳进接触锥），谁更贴着它谁优先，不再「锥里谁短用谁」
      const ci = Math.floor(p.x / hc), cj = Math.floor(p.y / hc), ck = Math.floor(p.z / hc);
      const cand = [];
      for (let da = -rr; da <= rr; da++) for (let db = -rr; db <= 0; db++) for (let dc = -rr; dc <= rr; dc++) {
        const arr = gHash.get((ci + da) + ',' + (cj + db) + ',' + (ck + dc));
        if (!arr) continue;
        for (const [a, bb, n, x, y, z] of arr) {
          const dy = p.y - y, hx = x - p.x, hz = z - p.z, dh = Math.hypot(hx, hz);
          if (dy < 0.3 || dh > dy * tanT + 1e-6) continue;
          const L = Math.hypot(dh, dy);
          if (L > reach) continue;
          const dev = Math.acos(clamp1((hx * dWant[0] - dy * dWant[1] + hz * dWant[2]) / L));
          if (dev > tc.tilt + 1e-3) continue;            // 针身仍须落在接触锥里；针尖再由 aimOf 折向法线
          cand.push({ kind: 'free', a, b: bb, n, cost: L + 8 * dev, N: [x, y, z], C, near: true });
        }
      }
      cand.sort((x, y) => x.cost - y.cost);
      for (let i = 0; i < cand.length && i < 24; i++) if (needleClear(C, cand[i].N)) { hook = cand[i]; st.needlesNear = (st.needlesNear || 0) + 1; break; }
    }
    if (hook) {
      const u = hook.u || nrm(sub(hook.C, hook.N)), L = hook.kind === 'free' ? len(sub(hook.C, hook.N)) : hook.L;
      // 同向针的支撑点已在 moveTo 里挪到接触点 C（显示 / 选点 / 删点与结构同位）；自由直针的 C 即支撑点本身
      needles.push({ pi, kind: hook.kind, pl: hook.pl, a: hook.a, b: hook.b, n: hook.n, N: hook.N, C: hook.C, u, L, fn: hook.fn, shift: hook.shift || 0 });
    } else fallbackIdx.push(pi);
  }

  /* ---------- 5. 只保留自各接入节点沿下行杆的闭包（顶部收成尖顶，多余格架不生成） ---------- */
  const down = new Map();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i], k = k3(e.a2, e.b2, e.n2);
    let arr = down.get(k); if (!arr) down.set(k, arr = []); arr.push(k3(e.a1, e.b1, e.n1));
  }
  const keep = new Set(), stack = [];
  for (const nd of needles) { const k = k3(nd.a, nd.b, nd.n); if (!keep.has(k)) { keep.add(k); stack.push(k); } }
  while (stack.length) { const k = stack.pop(); for (const k1 of down.get(k) || []) if (!keep.has(k1)) { keep.add(k1); stack.push(k1); } }
  const used = edges.filter(e => keep.has(k3(e.a1, e.b1, e.n1)) && keep.has(k3(e.a2, e.b2, e.n2)));
  /* 兜底加强（2026-10-14，用户截图：中粗 / 粗档有的主干整段无加强、晃动隐患）：
     q 混合区 / 区域边界的斜边链可能在跨区处断裂，留下「独立竖杆」段。这里对最终杆件做实扫：
     ≥3 个竖直半格没有斜边相接的竖杆段，每 3 半格补一根同规格斜杆（±1 水平 + 1 竖直，连到邻近
     已保留节点、胶囊体净空通过才补）——细档本就没有断链，此步不产生新杆。 */
  {
    const nodeSet = new Set();
    const diag = new Set();                              // 有斜边相接的节点
    const vAdj = new Map();                              // 竖杆链：k2(a,b) → Map<下层 n, 上层 n+1>
    for (const e of used) {
      nodeSet.add(k3(e.a1, e.b1, e.n1)); nodeSet.add(k3(e.a2, e.b2, e.n2));
      if (e.kind !== 'v') { diag.add(k3(e.a1, e.b1, e.n1)); diag.add(k3(e.a2, e.b2, e.n2)); }
      else {
        const ck = k2(e.a1, e.b1);
        let m = vAdj.get(ck); if (!m) vAdj.set(ck, m = new Map());
        m.set(Math.min(e.n1, e.n2), Math.max(e.n1, e.n2));
      }
    }
    const extra = [];
    for (const [ck, m] of vAdj) {
      const a = Math.floor(ck / SPAN) - OFF, bb = ck - (a + OFF) * SPAN - OFF;
      let since = 0;
      for (const n of [...m.keys()].sort((x, y) => x - y)) {
        if (diag.has(k3(a, bb, n)) || diag.has(k3(a, bb, n + 1))) { since = 0; continue; }
        since++;
        if (since < 3) continue;
        for (const [da, dbb] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const t = k3(a + da, bb + dbb, n + 1);
          if (!nodeSet.has(t) || !edgeOK(a, bb, n, a + da, bb + dbb, n + 1)) continue;
          extra.push({ a1: a, b1: bb, n1: n, a2: a + da, b2: bb + dbb, n2: n + 1, kind: da !== 0 ? 'x' : 'z', vx: false, vz: false });
          diag.add(k3(a, bb, n)); diag.add(t);
          since = 0;
          break;
        }
      }
    }
    if (extra.length) { used.push(...extra); st.diagPatch = extra.length; }
  }
  st.nodes = keep.size; st.bars = used.length;
  st.edgeList = used.map(e => [e.a1, e.b1, e.n1, e.a2, e.b2, e.n2, e.kind]);   // 诊断：保留杆件 [a1,b1,n1,a2,b2,n2,kind]，供「独立主干」（无斜边相接的竖杆段）分析
  // 自检：n>0 的保留节点都必须有下行杆（否则就是打印时的孤岛起点）
  { const hasDown = new Set(used.map(e => k3(e.a2, e.b2, e.n2))); st.minima = 0; for (const k of keep) if (k >= LAYER && !hasDown.has(k)) st.minima++; }

  /* ---------- 6. 几何：规格 → 实体（manifoldKit.solidifySpec，后台线程） ----------
     旧实现在这里手写几千个六面体 + 扇形节点板 + 分段针，各自闭合、只是贴着摆放，接缝靠端面切法与节点板轮廓凑齐——
     「<」顶点（节点板被切齐削平、两根斜杆的端角伸出平面）与自由直针针脚（端面垂直针轴、柱顶一角外露）两类裂口 / 台阶都出在这里。
     现在这一步只描述「每面墙由哪些条带 / 圆盘组成、每根针由哪些截面组成」，并集、圆角、闭合交给 manifold-3d（内含 Clipper2）。 */
  const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
  // 杆件所在墙面：0 = z 固定墙（法线 Z，面内坐标 (x, y)），1 = x 固定墙（法线 X，面内坐标 (z, y)）；
  // 竖杆在墙交线处两向墙各一片 →「+」截面柱
  const planesOf = e => (e.kind === 'x' ? [0] : e.kind === 'z' ? [1] : [e.vz ? 0 : -1, e.vx ? 1 : -1].filter(v => v >= 0));
  // 节点处各墙面内的入射杆：面内单位方向 + 杆长（圆形接头、侧边切齐判定用）
  const incid = new Map();                           // 键 = 节点键 × 2 + 墙面 → [[ds, dy, L], ...]
  const addInc = (k, pl, ds, dy, L) => { const kk = k * 2 + pl; let arr = incid.get(kk); if (!arr) incid.set(kk, arr = []); arr.push([ds, dy, L]); };
  const vbar = new Set();                            // 节点处该墙面有竖杆（「+」柱的一片）：键同上
  for (const e of used) {
    const A = pos(e.a1, e.b1, e.n1), B = pos(e.a2, e.b2, e.n2), kA = k3(e.a1, e.b1, e.n1), kB = k3(e.a2, e.b2, e.n2);
    for (const pl of planesOf(e)) {
      const ds = pl === 0 ? B[0] - A[0] : B[2] - A[2], dy = B[1] - A[1], l = Math.hypot(ds, dy);
      addInc(kA, pl, ds / l, dy / l, l); addInc(kB, pl, -ds / l, -dy / l, l);
      if (e.kind === 'v') { vbar.add(kA * 2 + pl); vbar.add(kB * 2 + pl); }
    }
  }
  // 格架自身在各墙面的入射数（不含针）：针脚是否需要自墙厚放宽的判定用
  const latCnt = new Map();
  for (const [kk, arr] of incid) latCnt.set(kk, arr.length);
  const addNeedleInc = (kN, pl, s, y, L) => {
    const kk = kN * 2 + pl;
    let arr = incid.get(kk); if (!arr) incid.set(kk, arr = []);
    if (!arr.some(d => d[0] * s + d[1] * y > 0.999)) arr.push([s, y, L]);   // 同节点同向多根针只记一次
  };
  // 格架同向针的针轴就在墙面内：当作该墙面的一根杆（节点出圆形接头、与相邻杆之间出圆角）；
  // 竖直针在柱所在的每面墙里都是一根向上的竖杆。自由直针斜出墙面，不登记
  for (const nd of needles) {
    const kN = k3(nd.a, nd.b, nd.n);
    if (nd.kind === 'p') addNeedleInc(kN, nd.pl, nd.pl === 0 ? nd.u[0] : nd.u[2], nd.u[1], nd.L);
    else if (nd.kind === 'v') {
      if ((nd.b & 1) === 0) addNeedleInc(kN, 0, 0, 1, nd.L);
      if ((nd.a & 1) === 0) addNeedleInc(kN, 1, 0, 1, nd.L);
    }
  }
  // 凹角圆角半径：取边宽一半，并按最小孔（折返斜边与竖杆围成的三角孔）的内切圆限制——
  // 闭运算半径大于孔的内切圆会把孔填死
  const holeIn = mid ? ws * hs / (hs + Math.hypot(ws, hs)) : ws * hs / Math.hypot(ws, hs);
  const rFil = Math.max(0, Math.min(b / 2, 0.6 * (holeIn - b / 2)));
  const termAt = (k, pl) => (incid.get(k * 2 + pl) || []).length === 1;   // 该墙面内只有这一根杆到此为止
  const wallAt = (k, pl) => (incid.get(k * 2 + pl) || []).length >= 2;    // 该墙面在此节点有连续的杆
  // 侧边切齐：墙面 pl 在节点处没有朝 s·sg > 0 一侧的杆（本墙到此为止，例如塔块外墙上与之正交的墙），而另一面墙在此确实向一侧延伸——
  // 该侧的柱（竖杆 + 节点圆盘）切齐到另一面墙的墙面（s = sg·t/2）。否则边宽（0.45）比墙厚（0.35）宽：外墙上整根「+」柱凸出 0.05 成一条棱、
  // 节点圆形接头凸出 0.05 成小盖子（用户截图：「立柱是共用一根还是多根重复」「节点合并不够完美」）。两面墙都不延伸 = 独立「+」柱，不切
  const armDir = (k, pl, sg, ys) => (incid.get(k * 2 + pl) || []).some(d => d[0] * sg > 0.1 && (!ys || d[1] * ys > 0.1));
  // 「墙面 pl 在柱子 sg 一侧有孔格」：本节点有朝 sg 的杆，或下方 q/2 个节点内有朝 sg 上行的斜边、上方 q/2 内有朝 sg 下行的斜边
  // （柱即墙内竖杆，斜边只每隔 q/2 个节点才接到柱上，中间节点只有竖杆直通；按方向判定——塔块下宽上窄，
  //  下方孔格朝 sg 下行的斜边不代表上面这段旁边也有格）
  const sideWall = (k, pl, sg) => {
    if (armDir(k, pl, sg, 0)) return true;
    const [a, bb, n] = unk(k), h = Math.max(1, (qAt(a, bb, n) || 2) >> 1);
    for (let d = 1; d <= h; d++) {
      if (n - d >= 0 && armDir(k3(a, bb, n - d), pl, sg, 1)) return true;
      if (armDir(k3(a, bb, n + d), pl, sg, -1)) return true;
    }
    return false;
  };
  const clipMemo = new Map();
  // 实际执行的切齐：另一面墙在这个节点确实有杆（它的板在这里，切面才与它的墙面齐平）；否则切出来的是一块孤零零的平面
  const clipAt = (k, pl, sg) => (incid.get(k * 2 + 1 - pl) || []).length > 0 && clipSide(k, pl, sg);
  const clipSide = (k, pl, sg) => {
    const key = k * 4 + pl * 2 + (sg > 0 ? 1 : 0);
    let v = clipMemo.get(key);
    if (v === undefined) { v = !sideWall(k, pl, sg) && (sideWall(k, 1 - pl, 1) || sideWall(k, 1 - pl, -1)); clipMemo.set(key, v); }
    return v;
  };
  // 连接底板的立板（基础带）范围
  const half = join ? Math.max(b, t) / 2 : t / 2;
  const wallRuns = [];
  const baseLines = new Map();                       // 墙线 → 线上的格架底层节点（连接底板最后要核一遍每个节点都被立板托住）
  {
    const lines = baseLines;
    for (const k of keep) {
      const [a, bb, n] = unk(k);
      if (n !== 0) continue;
      const q = qAt(a, bb, 0) || 2;
      const onZ = md(bb, q) === 0, onX = md(a, q) === 0;
      if (onZ) { const lk = 'x' + bb; (lines.get(lk) || lines.set(lk, []).get(lk)).push({ s: a, q }); }
      if (onX) { const lk = 'z' + a; (lines.get(lk) || lines.set(lk, []).get(lk)).push({ s: bb, q }); }
      if (!onZ && !onX) { const lk = ((bb & 1) === 0 ? 'x' + bb : 'z' + a); (lines.get(lk) || lines.set(lk, []).get(lk)).push({ s: (bb & 1) === 0 ? a : bb, q }); }
    }
    for (const [lk, arr] of lines) {
      arr.sort((x, y) => x.s - y.s);
      const dir = lk[0], line = +lk.slice(1);
      let s0 = arr[0].s, prev = arr[0], q0 = arr[0].q;
      // nLo / nHi：段上格架底层节点的范围（「去掉外伸」不得收过它们，否则节点上的柱 / 斜杆悬空）
      const flush = () => wallRuns.push(prev.s > s0 ? { dir, line, s0, s1: prev.s, q: q0, nLo: s0, nHi: prev.s } : { dir, line, s0: s0 - 0.5, s1: s0 + 0.5, q: q0, nLo: s0, nHi: s0 });
      for (let i = 1; i < arr.length; i++) {
        const c = arr[i];
        if (c.s - prev.s <= Math.max(c.q, prev.q)) { prev = c; q0 = Math.min(q0, c.q); continue; }
        flush(); s0 = c.s; prev = c; q0 = c.q;
      }
      flush();
    }
  }
  // 连接底板：同一条墙上相距约两个格宽以内、中间没有模型的段并成一条，避免底边断开或留下单独的小块
  if (join && wallRuns.length > 1) {
    wallRuns.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : a.line - b.line || a.s0 - b.s0));
    // 这条模型上断开的底板，空档大约 10～25mm。中间没有模型就补上
    const maxIdx = Math.max(8 * w, 28) / ws;
    const bridgeOk = (a, c) => {
      if (a.dir !== c.dir || a.line !== c.line) return false;
      const gap = c.s0 - a.s1;
      if (gap <= 0) return true;
      if (gap > maxIdx) return false;
      const y = groundY + Math.min(plateH * 0.5, 1.2);
      const steps = Math.max(2, Math.ceil(gap * ws / 0.7));
      for (let i = 0; i <= steps; i++) {
        const s = (a.s1 + (c.s0 - a.s1) * i / steps) * ws;
        const p = a.dir === 'x' ? [s, y, a.line * ws] : [a.line * ws, y, s];
        if (ld && ldiInside(ld, p[0], p[1], p[2])) return false;
        if (pointDist(bvh, p[0], p[1], p[2], half + 0.6) < half + 0.2) return false;
      }
      return true;
    };
    const merged = [];
    let cur = wallRuns[0];
    for (let i = 1; i < wallRuns.length; i++) {
      const n = wallRuns[i];
      if (bridgeOk(cur, n)) cur = { ...cur, s1: Math.max(cur.s1, n.s1), q: Math.min(cur.q, n.q), nLo: Math.min(cur.nLo, n.nLo), nHi: Math.max(cur.nHi, n.nHi) };
      else { merged.push(cur); cur = n; }
    }
    merged.push(cur);
    wallRuns.length = 0;
    for (const r of merged) wallRuns.push(r);
  }
  // 去掉外伸：每条底板只留到最外一层交叉墙，不再从外墙侧面吐出一截——但不收过段上的格架底层节点。
  // 只在这一条墙线上的节点（不在交叉墙上）也立着柱 / 斜杆，收掉它下面的立板，杆端就悬在平台上方「板高 − 0.25」处
  // （用户 2026-10-12 截图：粗模板塔块外沿的竖杆底端悬空；环面结 / 蘑菇 / 悬臂雕像都有）。无交叉的短段同理收到节点本身，不再整段删掉。
  // 交叉判定一律用收之前的段（旧实现边收边判，结果与段的先后顺序有关）
  if (join && P.baseFlush && wallRuns.length) {
    const crossAt = (r, s) => wallRuns.some(o => o.dir !== r.dir && o.line === s && o.s0 <= r.line && r.line <= o.s1);
    const kept = [];
    for (const r of wallRuns) {
      let lo = Infinity, hi = -Infinity;
      for (const o of wallRuns) {
        if (o.dir === r.dir) continue;
        // 差一格也算交上，否则外伸的小段会停在外墙外面，判不成交叉
        if (o.line < r.s0 - 1 || o.line > r.s1 + 1) continue;
        if (r.line < o.s0 - 1 || r.line > o.s1 + 1) continue;
        lo = Math.min(lo, o.line);
        hi = Math.max(hi, o.line);
      }
      let s0 = r.s0, s1 = r.s1;
      if (lo <= hi) { s0 = Math.max(s0, lo); s1 = Math.min(s1, hi); }
      else if (s1 - s0 < 2) { s0 = r.nLo; s1 = r.nHi; }
      if (s1 < s0) { s0 = r.nLo; s1 = r.nHi; }
      s0 = Math.min(s0, r.nLo); s1 = Math.max(s1, r.nHi);
      // 只剩一个节点、交叉立板正好从它上面过：节点已由那块立板托住，这一小块不再单出
      if (s1 - s0 < 0.2 && crossAt(r, s0)) continue;
      kept.push({ ...r, s0, s1 });
    }
    wallRuns.length = 0;
    for (const r of kept) wallRuns.push(r);
  }
  // 连接底板的立板不得顶进模型：立板只到板顶，板顶在模型底面以下一个「模型抬高」。模型抬高调得很低、
  // 或模型有部分伸到板高以内时，节点之间补上的那截、跨空档并起来的立板会从模型下面穿过去。
  // 沿立板中线在板底 / 半高 / 板顶三个高度采样，离模不足「立板半厚 + 0.2」（与跨空档合并同一口径）的地方断开
  if (join && plateH > 0 && wallRuns.length) {
    const ys = [Math.min(0.3, plateH * 0.5), plateH * 0.5, Math.max(plateH * 0.5, plateH - 0.05)].map(v => groundY + v);
    const need = half + 0.2;
    const clearAt = (r, x) => {
      for (const y of ys) {
        const p = r.dir === 'x' ? [x, y, r.line * ws] : [r.line * ws, y, x];
        if (ld && ldiInside(ld, p[0], p[1], p[2])) return false;
        if (pointDist(bvh, p[0], p[1], p[2], need + 0.1) < need) return false;
      }
      return true;
    };
    const parts = [];
    for (const r of wallRuns) {
      // 采样位置是立板中线上的 x（立板轮廓 = s0·ws − 半厚 … s1·ws + 半厚）；连续净空的一截换回 s0 / s1，太短（不足一个板厚）的丢掉，节点由下面补
      const xa = r.s0 * ws - half, xb = r.s1 * ws + half, n = Math.max(1, Math.ceil((xb - xa) / 0.4)), dx = (xb - xa) / n;
      let a = null, last = null;
      const cut = () => {
        if (a !== null && last - a >= 2 * half) parts.push({ ...r, s0: (a + half) / ws, s1: (last - half) / ws });
        a = null;
      };
      for (let i = 0; i <= n; i++) {
        const x = xa + dx * i;
        if (clearAt(r, x)) { if (a === null) a = x; last = x; } else { if (a !== null) st.slabCuts = (st.slabCuts || 0) + 1; cut(); }
      }
      cut();
    }
    wallRuns.length = 0;
    for (const r of parts) wallRuns.push(r);
  }
  // 每个格架底层节点都要落在立板上（去掉外伸、净空断开之后再核一遍）：节点上立着柱 / 斜杆，下面没有立板就悬在平台上方
  if (join && plateH > 0) {
    for (const [lk, arr] of baseLines) {
      const dir = lk[0], line = +lk.slice(1);
      for (const { s, q } of arr) {
        if (wallRuns.some(r => r.dir === dir && r.line === line && r.s0 - 1e-6 <= s && s <= r.s1 + 1e-6)) continue;
        if (wallRuns.some(o => o.dir !== dir && Math.abs(o.line - s) < 1e-6 && o.s0 - 1e-6 <= line && line <= o.s1 + 1e-6)) continue;
        wallRuns.push({ dir, line, s0: s, s1: s, q, nLo: s, nHi: s });
        st.slabForced = (st.slabForced || 0) + 1;
      }
    }
  }
  // 和后面打孔用同一套位置，孔再外扩一个杆件半径，杆头才不会露在孔里
  // 孔心对齐格架节距：落在「两根竖杆之间」的半格交点（墙面内坐标为奇数半格），与节点（对穿槽所在）恒错开一个半格；
  // 孔间竖条正对节点 /「+」柱——力线自竖杆直落板底，段与段之间相位一致（不再按段长均布）。孔只打在立板上，不打进基础带。
  const skirtHoles = r => {
    if (!join || !P.baseHole || r.pad) return [];
    const x0 = r.s0 * ws - half, x1 = r.s1 * ws + half;
    const chH = 0.6;
    const chamfer = P.baseChamfer ? Math.min(chH * ws / Math.max(hs, 0.2), Math.max(0, (x1 - x0 - 0.8) / 2)) : 0;
    // 上沿离板顶至少一个杆宽：肩只有基础带高，粗杆圆头靠孔让位，不再把肩加到两倍杆宽
    const yLo = 0.45, yHi = plateH - Math.max(0.4, b);
    const hh = (yHi - yLo) / 2, cy = groundY + (yLo + yHi) / 2;
    const hw = Math.min(w * 0.42, Math.max(0.35, hh * 1.05));
    const out = [];
    if (hh <= 0.35 || hw <= 0.28) return out;
    // 段端可能不在整半格上（立板在模型下方断开）：从 s0 之后第一个奇数半格起
    let s1st = Math.floor(r.s0) + 1;
    if (md(s1st, 2) === 0) s1st++;
    for (let s = s1st; s <= r.s1 - 1; s += 2) {
      const cx = s * ws;                                  // 奇数半格：两侧各一根竖杆的中点
      if (cx - hw < x0 + chamfer + 0.4 || cx + hw > x1 - chamfer - 0.4) continue;
      out.push({ dir: r.dir, line: r.line, cx, cy, hw, hh });
    }
    return out;
  };
  const baseHoles = [];
  if (join && P.baseHole) for (const r of wallRuns) for (const h of skirtHoles(r)) baseHoles.push(h);

  /* ---- 6a. 墙：每面墙的面内区域 = 柱部分（竖杆 + 节点圆盘，可切齐）∪ 其余（斜边、针根足迹、基础带）；圆角由闭运算统一给出 ---- */
  const SEG = 24;                                    // 整圆分段（节点圆盘、圆角）：16 段时 90° 圆角只有 4 段，最低点看得出一截直边
  const spec = { t, rFil, seg: SEG, walls: [], slabs: [], hulls: [], knuckles: [], cuts: [] };
  const wallMap = new Map();
  const wallOf = (pl, line) => {
    const k = pl * SPAN + line + OFF;
    let wv = wallMap.get(k);
    if (!wv) { wv = { pl, c: line * ws, col: [], web: [], clip: [], sub: [] }; wallMap.set(k, wv); spec.walls.push(wv); }
    return wv;
  };
  const lineOf = (pl, a, bb) => (pl === 0 ? bb : a);          // 墙线（半格序号）
  const sOf = (pl, a, bb) => (pl === 0 ? a : bb) * ws;        // 面内水平坐标
  // 面内条带 A → B：两端半宽 hA / hB（左右对称）
  const strip2 = (A, B, hA, hB) => {
    const dx = B[0] - A[0], dy = B[1] - A[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
    return [[A[0] - nx * hA, A[1] - ny * hA], [B[0] - nx * hB, B[1] - ny * hB], [B[0] + nx * hB, B[1] + ny * hB], [A[0] + nx * hA, A[1] + ny * hA]];
  };
  // 圆盘多边形转半格：顶点不落在 0° / 90° / 180° / 270°——否则圆盘最外点恰好压在杆端、基础带顶面、立板端面这些轴向面上，
  // 三维布尔并在这种「点贴面」处会留零体积碎片
  const disc2 = (cx, cy, rr) => { const o = []; for (let i = 0; i < SEG; i++) { const q = 2 * Math.PI * (i + 0.5) / SEG; o.push([cx + rr * Math.cos(q), cy + rr * Math.sin(q)]); } return o; };
  // 与另一面墙的墙面相贴的轮廓（切齐、单臂收窄）一律收进墙面内 EPS：轮廓经 Clipper 量化（1e-8），
  // 与对面墙的挤出面「几乎共面」时三维布尔会切出碎片；收进 1µm 肉眼与打印都无差别
  const EPS = 1e-3;
  const narrow = Math.min(b / 2, t / 2 - EPS);       // 单臂收窄后的半宽
  // 杆件：端点到端点的等宽条带（端面垂直杆轴）。「+」柱的一臂在此终止、另一面墙在此连续：这一端收到墙厚，端面整个收进另一面墙
  for (const e of used) {
    const kA = k3(e.a1, e.b1, e.n1), kB = k3(e.a2, e.b2, e.n2);
    for (const pl of planesOf(e)) {
      const A = [sOf(pl, e.a1, e.b1), baseTop + e.n1 * hs], B = [sOf(pl, e.a2, e.b2), baseTop + e.n2 * hs];
      const hA = termAt(kA, pl) && wallAt(kA, 1 - pl) ? narrow : b / 2;
      const hB = termAt(kB, pl) && wallAt(kB, 1 - pl) ? narrow : b / 2;
      const wv = wallOf(pl, lineOf(pl, e.a1, e.b1));
      (e.kind === 'v' ? wv.col : wv.web).push(strip2(A, B, hA, hB));
    }
  }
  // 圆形接头：墙面内有 ≥2 根杆（含格架同向针）的节点放半径 边宽/2 的圆盘——与条带边线相切，凸侧自然成圆弧，
  // 凹角由闭运算倒圆。只有一根杆的端头不放（端面保持平直）
  const CLIP_OUT = b / 2 + 0.3;                      // 切齐条带外沿：盖过圆盘（半径 b/2）
  const clipPoly = (sc, sg, d0, y0, d1, y1) => [[sc + sg * d0, y0], [sc + sg * CLIP_OUT, y0], [sc + sg * CLIP_OUT, y1], [sc + sg * d1, y1]];
  for (const [kk, arr] of incid) {
    if (arr.length < 2) continue;
    const pl = kk % 2, kN = (kk - pl) / 2, [a, bb, n] = unk(kN);
    const sc = sOf(pl, a, bb), y = baseTop + n * hs, wv = wallOf(pl, lineOf(pl, a, bb));
    wv.col.push(disc2(sc, y, b / 2));
    // 切齐侧：节点上下各盖住一个圆盘半径
    for (const sg of [1, -1]) if (clipAt(kN, pl, sg)) wv.clip.push(clipPoly(sc, sg, t / 2 - EPS, y - b / 2 - 0.05, t / 2 - EPS, y + b / 2 + 0.05));
    // 顶 / 底帽：本墙面在节点上方（下方）没有杆（「^」尖顶 /「v」底角），而另一面墙的竖杆从这里穿过——
    // 圆盘的上（下）半圆比那根竖杆宽（边宽 > 墙厚），两侧各凸出一片半月形小盖子（实测截图）；把这半截切齐到那面墙的墙面
    const oth = incid.get(kN * 2 + 1 - pl) || [], hc = t / 2 - EPS, yy = b / 2 + 0.05;
    if (!arr.some(d => d[1] > 0.3) && oth.some(d => d[1] > 0.999)) for (const sg of [1, -1]) wv.clip.push(clipPoly(sc, sg, hc, y, hc, y + yy));
    if (!arr.some(d => d[1] < -0.3) && oth.some(d => d[1] < -0.999)) for (const sg of [1, -1]) wv.clip.push(clipPoly(sc, sg, hc, y - yy, hc, y));
  }
  // 自由直针压在「该墙面只剩一根斜边到此为止」的节点上：斜边端面垂直杆轴、斜着露在针根外面（针根是水平截面），
  // 端角还会挑出一片薄刃（实测截图）。这里补一个圆盘，斜边端头成圆头，再由针根盖住。竖杆的单端不补——平顶正好是针根的截面
  for (const nd of needles) {
    if (nd.kind !== 'free') continue;
    const kN = k3(nd.a, nd.b, nd.n);
    for (const pl of [0, 1]) {
      const arr = incid.get(kN * 2 + pl);
      if (!arr || arr.length !== 1 || Math.abs(arr[0][0]) < 0.1) continue;
      wallOf(pl, lineOf(pl, nd.a, nd.b)).col.push(disc2(sOf(pl, nd.a, nd.b), baseTop + nd.n * hs, b / 2));
    }
  }
  /* ---- 跨墙转折节点：凸包转接块 ----
     每面墙在自己的平面里由闭运算出圆角，但传力路径在节点处从一面墙「拐」到正交墙时，两面墙之间没有任何过渡：
     ① 拐角（每面墙在此各只剩一根斜杆：一根自本墙上来，下一根沿正交墙继续往上）——两个端面垂直杆轴的平头只在角上碰一下，留 V 形缺口（用户截图）；
     ② 本墙在节点上方（下方）没有杆、正交墙却沿斜杆继续往上（往下）——本墙的圆形接头半圆单独立在那里，正交墙的斜杆从它背后伸出，像贴了半个月牙。
     这里在该半边取「正交墙继续走的斜杆截面（节点处 + 沿杆 KD 处）」与「本墙在节点处的材料（圆盘半边 / 单杆端面）」再加节点核心，
     取一个凸包当转接块：缺口与月牙都被包进一块连续的实体里。只在这种转折处加，「+」柱照常交叉的节点不加（否则每个节点都鼓一个疙瘩）。 */
  const KD = Math.max(0.4, b);                       // 转接块沿继续走的斜杆延伸的长度
  const bk = b / 2 - EPS;                            // 截面半宽（内缩 EPS：不与墙面轮廓几乎共面）
  const dir3 = (pl, d) => (pl === 0 ? [d[0], d[1], 0] : [0, d[1], d[0]]);      // 面内方向 → 世界系
  const perp3 = (pl, d) => (pl === 0 ? [-d[1], d[0], 0] : [0, d[0], -d[1]]);   // 面内垂直方向 → 世界系
  const secPts = (N, pl, d, dist) => {               // 杆件在距节点 dist 处的截面四角（宽 = 边宽、厚 = 墙厚）
    const u3 = dir3(pl, d), p3 = perp3(pl, d), m3 = pl === 0 ? Z : X, out = [];
    for (const we of [bk, -bk]) for (const wm of [t / 2, -t / 2]) {
      out.push([N[0] + u3[0] * dist + p3[0] * we + m3[0] * wm, N[1] + u3[1] * dist + p3[1] * we + m3[1] * wm, N[2] + u3[2] * dist + p3[2] * we + m3[2] * wm]);
    }
    return out;
  };
  const capOff = (kN, pl, h) => {                    // 去掉圆盘的 h 半边：由转接块接管，免得半圆弧在转接块上留一道月牙折线
    const [a, bb, n] = unk(kN), sc = sOf(pl, a, bb), y = baseTop + n * hs, R = b / 2 + 0.1;
    wallOf(pl, lineOf(pl, a, bb)).clip.push(h > 0 ? [[sc - R, y], [sc + R, y], [sc + R, y + R], [sc - R, y + R]] : [[sc - R, y - R], [sc + R, y - R], [sc + R, y], [sc - R, y]]);
  };
  const endPts = (N, pl, arr) => arr.flatMap(d => secPts(N, pl, d, 0));   // 该墙面所有杆（含格架同向针）在节点处的端面截面
  const corePts = N => { const c = t / 2 - EPS, out = []; for (const ex of [c, -c]) for (const ez of [c, -c]) out.push([N[0] + ex, N[1], N[2] + ez]); return out; };
  st.knuckles = 0;
  for (const [kk, arr0] of incid) {
    if (kk % 2 !== 0) continue;                      // 每个节点只看一次（墙面 0 的键）
    const kN = kk / 2, arr1 = incid.get(kN * 2 + 1);
    if (!arr1 || !arr0.length || !arr1.length) continue;
    const arrs = [arr0, arr1], N = pos(...unk(kN)), pts = [];
    for (const h of [1, -1]) {
      const has = arrs.map(arr => arr.filter(d => d[1] * h > 0.3));
      for (const Xp of [0, 1]) {
        const Yp = 1 - Xp;
        if (!has[Xp].length || has[Xp].some(d => Math.abs(d[0]) < 0.1) || has[Yp].length) continue;
        // 墙 Xp 沿斜杆往这半边继续、墙 Yp 在这半边没有杆：Yp 在节点处的材料要接到 Xp 的斜杆上
        for (const d of has[Xp]) pts.push(...secPts(N, Xp, d, 0), ...secPts(N, Xp, d, KD));
        // 墙 Yp 在这半边的圆盘半圆去掉，改由它各杆的端面截面进凸包：转接块顶面是从 Yp 的杆端直通 Xp 斜杆的平面，没有圆弧折线
        if (arrs[Yp].length >= 2) capOff(kN, Yp, h);
        pts.push(...endPts(N, Yp, arrs[Yp]));
      }
    }
    if (pts.length) { pts.push(...corePts(N)); spec.knuckles.push(pts); st.knuckles++; }   // 转接块属格架节点件（视口归格架组）
  }
  // 验收：塔块侧边界上的「<」/「>」顶点（墙面内恰两根斜杆、同朝一侧、一上一下）——旧版裂口最常出现的位置
  st.vertexList = [];
  for (const [kk, arr] of incid) {
    if (arr.length !== 2 || !arr.every(d => Math.abs(d[0]) > 0.3) || Math.sign(arr[0][0]) !== Math.sign(arr[1][0]) || arr[0][1] * arr[1][1] >= 0) continue;
    const pl = kk % 2, kN = (kk - pl) / 2, sg = -Math.sign(arr[0][0]);
    if (st.vertexList.length < 400) st.vertexList.push({ N: pos(...unk(kN)), pl, open: sg, clip: clipSide(kN, pl, sg) });
  }
  // 格架自基础带顶起步。底层节点只有一根杆、不放圆盘时，端面正好停在基础带顶上（几乎共面）——
  // 每个底层节点向基础带里多伸 0.25（重叠而非贴面）
  if (join) {
    for (const [kk] of incid) {
      const pl = kk % 2, kN = (kk - pl) / 2, [a, bb, n] = unk(kN);
      if (n !== 0) continue;
      const sc = sOf(pl, a, bb), y = baseTop, hw = b / 2 * 0.8;
      wallOf(pl, lineOf(pl, a, bb)).web.push([[sc - hw, y - 0.25], [sc + hw, y - 0.25], [sc + hw, y + 0.05], [sc - hw, y + 0.05]]);
    }
  }
  // 竖杆的切齐：两端都切齐 = 整段收到墙面；只一端切齐 = 自墙厚线性过渡回边宽（旧版竖杆的不对称截面）。
  // 只作用在柱部分，斜边与针根足迹不受影响——旧版只削节点板、不削斜杆，「<」顶点因此成锯齿
  for (const e of used) {
    if (e.kind !== 'v' || planesOf(e).length < 2) continue;   // 只有「+」柱（两面墙共用这根竖杆）才有凸出另一面墙的问题
    const kA = k3(e.a1, e.b1, e.n1), kB = k3(e.a2, e.b2, e.n2);
    for (const pl of planesOf(e)) {
      const sc = sOf(pl, e.a1, e.b1), yA = baseTop + e.n1 * hs, yB = baseTop + e.n2 * hs;
      for (const sg of [1, -1]) {
        const cA = clipAt(kA, pl, sg), cB = clipAt(kB, pl, sg);
        if (cA || cB) wallOf(pl, lineOf(pl, e.a1, e.b1)).clip.push(clipPoly(sc, sg, cA ? t / 2 - EPS : b / 2, yA, cB ? t / 2 - EPS : b / 2, yB));
      }
    }
  }

  /* ---- 6b. 十字针（e-Stage Top connection，专利 FIG.13/14）：自格架节点沿直线到接触点——
     针身（连接宽 × 针板厚）沿格架方向，根部截面就是柱顶截面（水平的向柱内多包 0.05，免得斜针把柱顶平台露出来）。
     针尖另沿被托面法线：过渡段起点改向，接触面垂直于法线。夹角不到 12° 不折，超过 50° 折不动就保持直针。
     旧版整根针轴锁在墙面上，曲面一侧的尖是歪的。 ---- */
  /* 针尖折向：期望方向（法线钳进 45° 锥，指向模型内）从过渡段起点出发，接触点不挪（布点位置即接触点，挪动会打乱布点的均匀间距）。
     接触点沿期望方向必须正好在表面上（短射线校验），变成掠射、孤岛种子被抬高、或过渡段够不到接触点，都放弃，保持原针轴。 */
  const TIP_BEND_MIN = 12 * Math.PI / 180, TIP_BEND_MAX = 50 * Math.PI / 180;
  const aimWhy = st.aimWhy = { short: 0, flat: 0, small: 0, big: 0, hit: 0, shift: 0, rise: 0, graze: 0, clear: 0, crowd: 0 };
  const aimOf = (nd, p, u, s1) => {
    if (s1 < 0.2) { aimWhy.short++; return null; }
    const d0 = dirsOf[nd.pi] && dirsOf[nd.pi][0];
    if (!d0) { aimWhy.flat++; return null; }
    const uDes = [-d0[0], -d0[1], -d0[2]];
    if (uDes[1] < 0.3) { aimWhy.flat++; return null; }
    const ang = Math.acos(clamp1(u[0] * uDes[0] + u[1] * uDes[1] + u[2] * uDes[2]));
    if (ang < TIP_BEND_MIN) { aimWhy.small++; return null; }   // 针身已经贴着法线，不必再折
    if (ang > TIP_BEND_MAX) { aimWhy.big++; return null; }     // 差得太多，短短一段过渡折不过去
    const N0 = nd.N;
    const K = [N0[0] + u[0] * s1, N0[1] + u[1] * s1, N0[2] + u[2] * s1];
    const reach = taper + cMargin + 1.2;
    // 接触点不挪：布点位置就是接触点（布点时已按间距排匀，挪动会把均匀打乱）。旧版从过渡段起点沿 uDes 重新打到表面，
    // 落点离布点最多 1.1mm，坡面上的支撑点被挪得一团一团（用户：「均匀的位置出现一坨不均匀」）。
    // 现在：布点位置 C0 沿 uDes 必须正好在表面上（短射线校验），针尖面垂直 uDes 落在 C0 处。
    const C0 = nd.C || [p.x, p.y, p.z];
    const probe = 0.3;
    const hit = raycast(bvh, C0[0] - uDes[0] * probe, C0[1] - uDes[1] * probe, C0[2] - uDes[2] * probe, uDes[0], uDes[1], uDes[2], 0.05, probe + 0.5);
    if (!hit || Math.abs(hit.t - probe) > 0.15) { aimWhy.hit++; return null; }
    const H = C0, shift = 0;
    if (p.island !== null && p.island !== undefined && H[1] > p.y + 0.1) { aimWhy.rise++; return null; }
    const hitT = (H[0] - K[0]) * uDes[0] + (H[1] - K[1]) * uDes[1] + (H[2] - K[2]) * uDes[2];   // 过渡段起点沿 uDes 到接触点的距离
    if (hitT < 0.3 || hitT > reach) { aimWhy.hit++; return null; }
    let fn = triNrm(hit.f);
    if (fn[0] * uDes[0] + fn[1] * uDes[1] + fn[2] * uDes[2] > 0) fn = [-fn[0], -fn[1], -fn[2]];
    if (-(fn[0] * uDes[0] + fn[1] * uDes[1] + fn[2] * uDes[2]) < 0.5) { aimWhy.graze++; return null; }   // 与表面夹角 < 30°，折完还是擦着走
    // 只查前半段：针尖后半段本来就要贴上表面，整段胶囊会把自己要扎的那一面判成穿模
    const stop = hitT * 0.5;
    if (stop > 0.2 && !capsuleClear(bvh, K[0], K[1], K[2], K[0] + uDes[0] * stop, K[1] + uDes[1] * stop, K[2] + uDes[2] * stop, Math.min(0.15, tipW / 2 + 0.04))) { aimWhy.clear++; return null; }
    return { H, uDes, fn, shift, hitT };
  };
  const fadeLen = 0.6;                               // 根部过渡长：格架截面 → 连接宽 × 针板厚
  const DROP = 0.05;                                 // 针脚凸包向柱内多包的深度：与柱体重叠而非恰好贴面，布尔并稳健
  const latticeIn = (k, pl, a, bb, n) => (latCnt.get(k * 2 + pl) || 0) > 0
    || (n === 0 && (pl === 0 ? md(bb, qAt(a, bb, 0) || 2) === 0 : md(a, qAt(a, bb, 0) || 2) === 0));
  // 节点处 pl 墙面的柱顶截面（沿面内 ±s 的半宽，与墙面轮廓同一口径：切齐侧 / 单臂收窄 = 墙厚/2 − EPS）；该墙面在此没有竖杆 → null
  const footSec = (kN, pl) => {
    if (!vbar.has(kN * 2 + pl)) return null;
    const h0 = termAt(kN, pl) && wallAt(kN, 1 - pl) ? narrow : b / 2;
    const plus = vbar.has(kN * 2 + 1 - pl);         // 「+」柱：竖杆段的切齐只在这里发生
    const cP = clipAt(kN, pl, 1) && plus, cM = clipAt(kN, pl, -1) && plus;
    return { p: cP ? Math.min(h0, t / 2 - EPS) : h0, m: cM ? Math.min(h0, t / 2 - EPS) : h0 };
  };
  st.needlesV = 0; st.needlesP = 0; st.needlesFree = 0; st.shiftSum = 0; st.shiftMax = 0; st.tipBent = 0;
  const emitted = new Set();                         // 同节点同向的格架同向针几何相同（孤岛周界种子可能密于间距、选中同一根竖杆），只出一份
  for (const nd of needles) {
    if (tick) await tick();
    const p = points[nd.pi], N = nd.N, kN = k3(nd.a, nd.b, nd.n), u = nd.u, L = nd.L;
    const s1 = Math.max(0, L - taper - cMargin), s2 = Math.max(s1, L - cMargin), s3 = L + pen;
    const aim = aimOf(nd, p, u, s1);                 // 针尖改沿法线；失败则整根保持原针轴
    const intoDir = (aim && aim.uDes) ? aim.uDes : (p.n ? [-p.n[0], -p.n[1], -p.n[2]] : u);
    const intoN = nrm(intoDir);
    // 球头：锥收到球外侧的颈圈，不收到模型表面。颈圈在接触点之外（neckOff 为负）时停在表面前
    let sNeck = s2;
    if (ball && !aim) {
      const C0 = nd.C || [p.x, p.y, p.z];
      const Mx = C0[0] + intoN[0] * neckOff, My = C0[1] + intoN[1] * neckOff, Mz = C0[2] + intoN[2] * neckOff;
      const dot = u[0] * intoN[0] + u[1] * intoN[1] + u[2] * intoN[2];
      sNeck = dot > 0.3
        ? ((Mx - N[0]) * intoN[0] + (My - N[1]) * intoN[1] + (Mz - N[2]) * intoN[2]) / dot
        : L + neckOff;
      sNeck = Math.max(Math.min(s1 + 0.05, L * 0.5), Math.min(L - 0.01, sNeck));
    }
    const sEnd = aim ? s1 : (ball ? sNeck : s2);     // 折向时针身停在过渡段起点，尖另沿法线出
    const dupKey = nd.kind === 'free' ? null : `${kN}|${u.map(v => Math.round(v * 200)).join(',')}`;
    if (dupKey && emitted.has(dupKey)) { pointState[nd.pi] = 'ground'; continue; }
    if (dupKey) emitted.add(dupKey);
    // 板片：{ e 板宽方向, m 板厚方向, rP / rM 根部朝 ±e 的半宽, tR 根部板厚, inPl 落在哪面墙内（出面内足迹，−1 = 不出）}
    // 根部与格架截面一致，在 fadeLen 内过渡到 连接宽 × 针板厚——针脚与柱 / 墙等宽等厚，接缝由布尔并消去
    const sheets = [];
    if (nd.kind === 'free' || nd.kind === 'v') {
      // 竖直针与自由直针：两片板分别平行于两向墙（自由直针为错切十字柱，每层水平截面都对齐墙向，专利 FIG.13c 截面 A-A′）
      for (const pl of [0, 1]) {
        const eW = pl === 0 ? X : Z, eT = pl === 0 ? Z : X;
        const fs = footSec(kN, pl), onWall = latticeIn(kN, pl, nd.a, nd.b, nd.n);
        const inPl = nd.kind === 'v' && onWall ? pl : -1;
        if (fs) sheets.push({ e: eW, m: eT, rP: fs.p, rM: fs.m, tR: t, inPl });
        else if (onWall) sheets.push({ e: eW, m: eT, rP: b / 2, rM: b / 2, tR: t, inPl });
        else sheets.push({ e: eW, m: eT, rP: t / 2, rM: t / 2, tR: Math.min(needleT, b), inPl: -1 });   // 横穿另一面墙：自墙厚起步
      }
    } else {
      // 墙面内斜针：一片板在墙面内（截面垂直针轴，与墙内杆件同宽同厚）；另一片板垂直墙面，截面取水平（错切）——
      // 根部截面就是正交墙在此的柱顶截面，与自由直针一样只在节点处折一下。曾用「柱顶截面 ∪ 斜截面」的凸包过渡，
      // 不露台阶但成片三角小面（实测截图），不如直接错切干净
      const wn = nd.pl === 0 ? Z : X, nip = nrm(cross(wn, u)), mh = nd.pl === 0 ? X : Z;
      sheets.push({ e: nip, m: wn, rP: b / 2, rM: b / 2, tR: t, inPl: nd.pl });
      const fs = footSec(kN, 1 - nd.pl);
      sheets.push({ e: wn, m: mh, rP: fs ? fs.p : t / 2, rM: fs ? fs.m : t / 2, tR: fs ? t : Math.min(needleT, b), inPl: -1 });
    }
    const fA = Math.min(fadeLen, Math.max(0.05, s3 * 0.5));
    const at = s => [N[0] + u[0] * s, N[1] + u[1] * s, N[2] + u[2] * s];
    const sq = Math.abs(tipW - tipT) < 1e-6;         // 接触段截面为正方形：两片板在此完全重合，只出一份
    const tipBase = aim ? [] : null;                 // 折向时收集针身末端截面，和沿法线的接触面取一个凸包
    // 自由直针压在柱顶（两面墙在节点上方都没有格架杆）：节点圆盘的上半圆比针根宽，针一斜就在针根旁边露出半个月牙——
    // 把有圆盘的墙面的上半圆与针根截面（两片板）取一个凸包，月牙并进针根
    let topCaps = null;
    if (nd.kind === 'free' && ![0, 1].some(q => (incid.get(kN * 2 + q) || []).some(d => d[1] > 0.3))) {
      for (const q of [0, 1]) {
        const arr = incid.get(kN * 2 + q) || [];
        if (arr.length >= 2 || (arr.length === 1 && Math.abs(arr[0][0]) >= 0.1)) {
          capOff(kN, q, 1);                            // 圆盘上半圆去掉，杆端面进凸包（同跨墙转折节点）
          (topCaps || (topCaps = [])).push(...endPts(N, q, arr));
        }
      }
    }
    sheets.forEach((sh, si) => {
      const prof = s => {                            // → [朝 +e 半宽, 朝 −e 半宽, 板厚]
        const f = Math.max(0, Math.min(1, s / fA));
        let eP = sh.rP + (connW / 2 - sh.rP) * f, eM = sh.rM + (connW / 2 - sh.rM) * f, th = sh.tR + (needleT - sh.tR) * f;
        if (s > s1) {                                // 顶端锥：从底部直径收到上端。开球头时收到颈圈，停在球外侧
          const sTip = ball && !aim ? sNeck : s2;
          const dTip = ball && !aim ? neckD : topD;
          const g = s >= sTip || sTip <= s1 ? 1 : (s - s1) / (sTip - s1);
          const d = botD + (dTip - botD) * g;
          eP = d / 2; eM = d / 2; th = d;
        }
        return [eP, eM, th];
      };
      // 截面矩形：中心 c，沿 ±e 半宽 eP / eM，沿 m 厚 th。竖直针与自由直针的 e、m 都是水平轴 → 每层截面水平（自由直针即错切十字柱）；
      // 墙面内斜针的截面垂直针轴
      const rect = (c, eP, eM, th) => {
        const out = [];
        for (const we of [eP, -eM]) for (const wm of [th / 2, -th / 2]) {
          out.push([c[0] + sh.e[0] * we + sh.m[0] * wm, c[1] + sh.e[1] * we + sh.m[1] * wm, c[2] + sh.e[2] * we + sh.m[2] * wm]);
        }
        return out;
      };
      const ring = (s, insW = 0, insT = 0) => { const [eP, eM, th] = prof(s); return rect(at(s), eP - insW, eM - insW, th - 2 * insT); };
      const horiz = Math.abs(sh.e[1]) < 1e-9 && Math.abs(sh.m[1]) < 1e-9;
      // 主体：根部 → 过渡段末端，一个凸包（截面尺寸沿针轴先增后平再减 = 凹函数，凸包即真形；相邻分段共用一圈斜截面时
      // 浮点下那四点并不严格共面，两个凸包各按不同对角线三角化，布尔并会留下四面体空隙——实测 80 个）
      const root = [];
      if (horiz) {
        // 根部截面就是节点处的柱顶截面（水平、在节点高度），再向柱内多包 DROP：柱顶整个被针脚盖住，不再外露。
        // 宽度内缩 EPS（不与柱的轮廓面几乎共面）；板厚与墙面同一平面（坐标精确相等，内核可稳健处理）
        const [eP0, eM0, th0] = prof(0);
        root.push(...rect([N[0], N[1] - DROP, N[2]], eP0 - EPS, eM0 - EPS, th0), ...rect(N, eP0 - EPS, eM0 - EPS, th0));
      } else {
        // 墙面内斜针：根部截面垂直针轴。宽度内缩 EPS——根部半宽 = 边宽/2 = 节点圆盘半径，针轴恰是 22.5° 的倍数时
        // 截面角点正落在圆盘多边形的顶点上，布尔并会沿墙厚留一条零体积空腔（实测 2 处）；板厚保持与墙面精确共面
        root.push(...ring(0, EPS, 0));
      }
      const st2 = [];
      for (const s of [fA, s1, sEnd]) if (s > 1e-4 && s <= sEnd + 1e-9 && !st2.some(v => Math.abs(v - s) < 1e-4)) st2.push(s);
      if (sh.rP <= connW / 2 + 1e-9 && sh.rM <= connW / 2 + 1e-9 && sh.tR <= needleT + 1e-9) {
        spec.hulls.push([...root, ...st2.flatMap(s => ring(s))]);
      } else {
        // 根部比针身宽 / 厚（边宽 > 连接宽或墙厚 > 针板厚）：截面先减后平，不再是凸的，根部过渡与针身分开取凸包
        const sF = Math.min(fA, sEnd);
        spec.hulls.push([...root, ...ring(sF)]);
        const rest = [sF, ...st2.filter(s => s > sF + 1e-4)];
        if (rest.length > 1) spec.hulls.push(rest.flatMap(s => ring(s)));
      }
      // 接触段 + 渗透：另一个凸包，向过渡段里多包一截（重叠而非贴面）。折向法线时这段改由下面的尖凸包出。
      // 开球头时不另出这根方杆：它和球一样粗，角比球宽，会把露在外面的球帽包住。扎进模型的是球本身
      if (!ball && !aim && !(sq && si > 0) && s3 > s2 + 1e-4) {
        const sA = Math.max(0, s2 - Math.min(0.05, (s2 - s1) * 0.5));
        spec.hulls.push([...rect(at(sA), topD / 2, topD / 2, topD), ...rect(at(s3), topD / 2, topD / 2, topD)]);
      }
      if (tipBase) {
        const sB = Math.max(0, s1 - 0.05);
        const pushRing = s => { const [eP, eM, th] = prof(s); tipBase.push(...rect(at(s), eP, eM, th)); };
        if (s1 - sB > 1e-4) pushRing(sB);
        pushRing(s1);
      }
      if (topCaps) {                                 // 柱顶圆盘上半圆与针根截面接成一块（见下）
        topCaps.push(...ring(Math.min(fA, s2) * 0.6, EPS, EPS));
      }
      // 面内足迹：针根在所在墙面里的一小段，与相邻杆件之间由闭运算出圆角（同杆件互接）；比针身窄 EPS，免得轮廓面与针板侧面几乎共面。
      // 墙面挤出厚度是墙厚：针板厚小于墙厚时足迹只留很短一截，免得比针身厚出一圈
      if (sh.inPl >= 0) {
        const dF = needleT >= t - 1e-6 ? Math.min(fA, s3 * 0.45) : Math.min(0.15, s3 * 0.3);
        const ix = sh.inPl === 0 ? 0 : 2, E = [sh.e[ix], sh.e[1]];
        const c0 = at(0), c1 = at(dF), [p0, m0] = prof(0), [p1, m1] = prof(dF);
        const P2 = (c, wv) => [c[ix] + E[0] * wv, c[1] + E[1] * wv];
        wallOf(sh.inPl, lineOf(sh.inPl, nd.a, nd.b)).web.push([P2(c0, -(m0 - EPS)), P2(c0, p0 - EPS), P2(c1, p1 - EPS), P2(c1, -(m1 - EPS))]);
      }
    });
    if (topCaps) { topCaps.push(...corePts(N)); spec.knuckles.push(topCaps); st.knuckles++; }   // 柱顶针脚盖属格架节点件（视口归格架组）
    // 针尖：针身末端的十字截面 → 沿法线的接触面（垂直于法线）→ 再沿法线扎入。一个凸包把折角填实，不是弯杆
    let uTip = u;
    if (aim && tipBase && tipBase.length >= 4) {
      const uDes = aim.uDes, H = aim.H;
      const ref = Math.abs(uDes[1]) < 0.92 ? Y : X;
      const e = nrm(cross(ref, uDes)), m = nrm(cross(uDes, e));
      const face = (c, hw, ht) => {
        const out = [];
        for (const we of [hw, -hw]) for (const wm of [ht / 2, -ht / 2]) {
          out.push([c[0] + e[0] * we + m[0] * wm, c[1] + e[1] * we + m[1] * wm, c[2] + e[2] * we + m[2] * wm]);
        }
        return out;
      };
      if (ball) {
        const neck = [H[0] + uDes[0] * neckOff, H[1] + uDes[1] * neckOff, H[2] + uDes[2] * neckOff];
        spec.hulls.push([...tipBase, ...face(neck, neckD / 2, neckD)]);
      } else {
        const margin = Math.min(cMargin, Math.max(0, aim.hitT - 0.15));
        const Cm = [H[0] - uDes[0] * margin, H[1] - uDes[1] * margin, H[2] - uDes[2] * margin];
        const Hp = [H[0] + uDes[0] * pen, H[1] + uDes[1] * pen, H[2] + uDes[2] * pen];
        spec.hulls.push([...tipBase, ...face(Cm, topD / 2, topD)]);
        if (margin + pen > 1e-4) {
          const back = Math.min(0.05, Math.max(0.02, aim.hitT * 0.2));
          const Cb = [Cm[0] - uDes[0] * back, Cm[1] - uDes[1] * back, Cm[2] - uDes[2] * back];
          spec.hulls.push([...face(Cb, topD / 2, topD), ...face(Hp, topD / 2, topD)]);
        }
      }
      if (aim.shift > 0.02) moveTo(p, H);
      nd.C = H; nd.fn = aim.fn; uTip = uDes;
      st.tipBent++;
    }
    {
      const C = nd.C || [p.x, p.y, p.z];
      const src = (aim && aim.uDes) ? aim.uDes : (p.n ? [-p.n[0], -p.n[1], -p.n[2]] : u);
      putHead(null, C, src);
    }
    if (nd.kind === 'free') st.needlesFree++;
    else {
      if (nd.kind === 'v') st.needlesV++; else st.needlesP++;
      st.shiftSum += nd.shift; st.shiftMax = Math.max(st.shiftMax, nd.shift);
    }
    st.needles++; pointState[nd.pi] = 'ground';
    // 调试 / 验收：针型 / 两端点 / 接触面法线 / 针尖方向 / 柱顶（节点上方两面墙都没有格架杆 = 针脚直接压在柱顶上）
    const top = ![0, 1].some(q => (incid.get(kN * 2 + q) || []).some((d, i) => i < (latCnt.get(kN * 2 + q) || 0) && d[1] > 0.3));
    (st.needleList || (st.needleList = [])).push({ kind: nd.kind, pl: nd.pl, N, C: nd.C, pi: nd.pi, fn: nd.fn, u: uTip, top });
    // 自检：针尖方向与被托面外法线的夹角（°）。用法线（布点时那一面），不用量到的邻接三角面——细分面会把夹角放大
    const pn = p.n || nd.fn || [0, -1, 0], ln = Math.hypot(pn[0], pn[1], pn[2]) || 1;
    const dev = Math.acos(clamp1(-(uTip[0] * pn[0] + uTip[1] * pn[1] + uTip[2] * pn[2]) / ln)) * 180 / Math.PI;
    (st.tipDev || (st.tipDev = [])).push(dev);
    st.needleList[st.needleList.length - 1].bent = !!aim;
    st.needleList[st.needleList.length - 1].dev = dev;
  }

  /* ---- 6c. 连接底板 + 基础带。
     开连接底板：立板只到板顶（从平台挤出，开孔只打在这段里），基础带是板上的支撑，并进墙面、从板顶往上接到格架。
     不开：基础带直接并进墙面，从落地高度（平台或自动底板顶）往上 foundH。三角缺口只在这档开。 ---- */
  if (join && plateH > 0) {
    for (const r of wallRuns) {
      const pl = r.dir === 'x' ? 0 : 1;
      // 立板两端收进 EPS：「去掉外伸」后端面恰与交叉立板的板面齐平，几乎共面会切出碎片
      const x0 = r.s0 * ws - (half - EPS), x1 = r.s1 * ws + (half - EPS);
      const chH = 0.6;
      const chamfer = !r.pad && P.baseChamfer ? Math.min(chH * ws / Math.max(hs, 0.2), Math.max(0, (x1 - x0 - 0.8) / 2)) : 0;
      let poly;
      if (chamfer > 0.15 && chH < plateH - 0.2) {
        poly = [[x0 + chamfer, 0], [x1 - chamfer, 0], [x1, chH], [x1, plateH], [x0, plateH], [x0, chH]];
      } else poly = [[x0, 0], [x1, 0], [x1, plateH], [x0, plateH]];
      spec.slabs.push({ pl, c: r.line * ws, half, polys: [poly.map(([s, y]) => [s, groundY + y])] });
      // 板内的墙面杆件减掉，开孔才不露杆。减到板顶下 0.05：基础带从这里接上去，重叠而不是贴面
      wallOf(pl, r.line).sub.push([[x0 + 0.05, groundY - 0.1], [x1 - 0.05, groundY - 0.1], [x1 - 0.05, floorY - 0.05], [x0 + 0.05, floorY - 0.05]]);
      // 墙线上的基础带加到肩顶。短杆脚下的垫块不在这条墙线上，顶面在后面的 padTop 段与这里齐平；杆仍从板顶长起。
      // 肩向板里只叠 0.05：视口不做三维并，贴齐会闪一条缝；再深就会进到开孔上沿（孔顶离板顶 max(0.4, 杆宽)）。
      if (!r.pad && shoulder > 0.05) {
        wallOf(pl, r.line).web.push([[x0, floorY - 0.05], [x1, floorY - 0.05], [x1, baseTop], [x0, baseTop]]);
        st.foundRuns++;
      }
    }
    for (const h of baseHoles) {
      spec.cuts.push({ pl: h.dir === 'x' ? 0 : 1, c: h.line * ws, half: half + 0.05,
        poly: [[h.cx, h.cy + h.hh], [h.cx + h.hw, h.cy], [h.cx, h.cy - h.hh], [h.cx - h.hw, h.cy]] });
    }
  } else if (foundH > 0.05) {
    // 三角缺口只在不接底板的档开。连接底板、自动底板都是平底贴住板面（2026-10-14）
    const nh = P.autoPlateOn ? 0 : Math.max(0, Math.min(P.esNotchH, foundH - 0.3));
    const hb = Math.max(b, t) / 2;
    for (const r of wallRuns) {
      const pl = r.dir === 'x' ? 0 : 1;
      const x0 = r.s0 * ws - (hb + EPS), x1 = r.s1 * ws + (hb + EPS);
      const poly = [[x0, 0]];
      const vs = mid ? r.q >> 1 : r.q, vsw = vs * ws;
      const nw = Math.min(0.6 * vsw, vsw - t - 0.3);
      if (nh > 0.1 && nw > 0.3) {
        for (let s = Math.ceil(r.s0 / vs) * vs; s + vs <= r.s1 + 1e-9; s += vs) {
          const c = (s + vs / 2) * ws;
          if (c - nw / 2 <= x0 + 0.1 || c + nw / 2 >= x1 - 0.1) continue;
          poly.push([c - nw / 2, 0], [c, nh], [c + nw / 2, 0]);
        }
      }
      poly.push([x1, 0], [x1, foundH], [x0, foundH]);
      wallOf(pl, r.line).web.push(poly.map(([s, y]) => [s, groundY + y]));
      st.foundRuns++;
    }
  }

  /* ---- 6d. 实体化：在几何后台线程里算（geomClient → geom.worker → manifoldKit.solidifySpec：Clipper2 并集 + 闭运算 → 挤出；凸包），
     主线程只等结果。被更新的请求取代时这里抛 aborted，由调用方安静退出 ---- */
  let towerG = null, needleG = null;
  if (spec.walls.length || spec.hulls.length || spec.slabs.length) {
    if (ctx.progress) ctx.progress(0.9, '几何实体化（后台线程）…');
    const tW = performance.now();
    const solid = await (ctx.solidify || solidifyAsync)(spec);
    if (solid) {
      // 视口按「格架塔 / 连接体（针）」两块几何分别建 mesh（2026-10-14）：「连接体」显示模式只亮出针。
      // 两块都从全量 pos/nrm（非索引，按 solid.parts 顺序拼接）按各自部件的三角形区间切片。
      const mk = parts => {
        const want = new Set(parts);
        let nt = 0;
        for (const p of parts) nt += p.tri.length / 3;
        const pos = new Float32Array(nt * 9), nrm = new Float32Array(nt * 9);
        let o = 0, acc = 0;
        for (const p of solid.parts) {
          const n0 = p.tri.length / 3;
          if (want.has(p)) {
            pos.set(solid.pos.subarray(acc * 9, (acc + n0) * 9), o);
            nrm.set(solid.nrm.subarray(acc * 9, (acc + n0) * 9), o);
            o += n0 * 9;
          }
          acc += n0;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        // 导出：每份都是闭合流形，原样交给内核做三维布尔并（不拆、不焊）
        g.userData.solids = parts;
        let a2 = 0;
        g.userData.runs = parts.map(pt => { const a0 = a2; a2 += pt.tri.length / 3; return [a0, a2]; });
        return g;
      };
      const hullParts = solid.parts.filter(p => p.kind === 'hull');
      const towerParts = solid.parts.filter(p => p.kind !== 'hull');
      if (towerParts.length) towerG = mk(towerParts);
      if (hullParts.length) needleG = mk(hullParts);
      const ss = solid.stats;
      st.solid = { walls: ss.walls, hulls: ss.hulls, parts: ss.parts, tris: ss.tris, ms: ss.ms, wait: Math.round(performance.now() - tW), knuckles: st.knuckles };
    }
  }
  // 塔块数：保留格架的连通分量（孤立的底层接入节点 = 基础带上直接立针，也算一座）
  {
    const adj = new Map();
    for (const e of used) {
      const ka = k3(e.a1, e.b1, e.n1), kb = k3(e.a2, e.b2, e.n2);
      (adj.get(ka) || adj.set(ka, []).get(ka)).push(kb); (adj.get(kb) || adj.set(kb, []).get(kb)).push(ka);
    }
    const seen = new Set();
    for (const k of keep) {
      if (seen.has(k)) continue;
      st.towers++; const q = [k]; seen.add(k);
      while (q.length) { const x = q.pop(); for (const y of adj.get(x) || []) if (!seen.has(y)) { seen.add(y); q.push(y); } }
    }
  }

  /* ---------- 7. 兜底：连不上格架的点 ----------
     相邻两点先试「分叉」（一主干两头，见 forkSolve）；其余正下方有朝上表面的点用「十字贴面短连接」（gusset）直接连过去；
     形态参考 e-Stage 手册的 close-to-part 连接（§5.2.6 / FIG.13 的直连接），几何为本项目自研：
     十字截面（连接宽 × 针板厚，水平截面恒为「+」）+ 两端渐缩到接触宽 + 渗透扎入——
     不做专利图中的「根部喇叭锥」，接触点保持细，省树脂、好折断。
     放不下的点仍可绕到平台；仍接不上的标红、不生成结构。 */
  /* 十字针截面的杆：A→B，截面沿轴渐变；thinA / thinB 决定该端是否收到接触宽（默认两端都细 = 十字贴面短连接）。
     分叉的主干 / 头：分叉点 F 端保持连接宽（粗），落点 / 接触端收细。 */
  // penA / penB：两端沿杆轴扎入的长度（默认渗透长度）；落到平台的一端为 0——平头立在平台上，不扎到平台下面
  // flatA：A 端落在平台上，端面水平平切（正好贴住平台）。端面垂直杆轴时斜杆一歪就有一角低于平台
  // （实测环面结中细模板 + 连接底板：4 根斜向短杆扎到平台下 0.093 mm，导出最低点不再是 z = 0）
  // tipP：B 端（顶部，被托的那一面）的支撑点。footN：A 端落到模型上时，那一面的外法线（朝上）。
  // 两端各自判断要不要沿法线折，口径与格架针 aimOf 相同；差不到 12° 不折，超过 50° 折不动。落到平台的平头不折。
  const emitMember = (gBuf, A, B, thinA = true, thinB = true, penA = pen, penB = pen, flatA = false, tipP = null, footN = null) => {
    // 连接底板：落点在板顶（floorY）。杆只向板里叠 0.05，导出时和立板熔在一起。
    // 粗杆再往下扎 0.2，杆身有一截会露在开孔里（杆宽 1.5 时尤其明显）。
    if (flatA && join && A.y <= floorY + 0.05) {
      A = { x: A.x, y: Math.max(groundY, floorY - 0.05), z: A.z };
    }
    const ax = [A.x, A.y, A.z], bx = [B.x, B.y, B.z];
    const d = sub(bx, ax), L = len(d);
    if (L < 0.35) return false;                                // 更短的间隙放不下短杆，不生成
    const u = [d[0] / L, d[1] / L, d[2] / L];
    const cm = Math.min(cMargin, L * 0.24);                    // 接触段（表面外的细直段）
    let tp = Math.min(taper, Math.max(0.06, L * 0.22));        // 过渡段（接触宽 → 连接宽）
    if (cm + tp > L * 0.46) tp = Math.max(0, L * 0.46 - cm);
    const at = s => [ax[0] + u[0] * s, ax[1] + u[1] * s, ax[2] + u[2] * s];
    // 开球头时接触端停在球外侧的颈圈，不再用接触宽的方杆穿球扎进模型（方杆的角比球宽，会把露出来的球帽包住）
    const sLo = (ball && thinA && !flatA) ? -neckOff : (flatA ? 0 : -penA);
    const sHi = (ball && thinB) ? (L + neckOff) : (L + penB);
    if (!(sHi > sLo + 0.05)) return false;
    const endW = ball ? Math.min(shortTW, neckD) : shortTW;
    const endT = ball ? Math.min(shortTT, neckD) : shortTT;
    // axis：从杆身指向该端接触面的方向。outN：该面外法线。anchor：顶部支撑点（底部没有可挪的点）
    const tryAim = (axis, outN, anchor, sRing, foot) => {
      if (!outN || !bvh) return null;
      const sgn = foot ? 1 : -1;                               // 底部外法线朝上，顶部外法线朝下
      const d0 = dirCandidates(outN, sgn, tc.tilt, 8 * Math.PI / 180)[0];
      if (!d0) return null;
      const uDes = [-d0[0], -d0[1], -d0[2]];                   // 扎进模型的方向
      if (foot ? uDes[1] > -0.3 : uDes[1] < 0.3) return null;
      const ang = Math.acos(clamp1(axis[0] * uDes[0] + axis[1] * uDes[1] + axis[2] * uDes[2]));
      if (ang < TIP_BEND_MIN || ang > TIP_BEND_MAX) return null;
      const K = at(sRing);
      const reach = taper + cMargin + 1.2;
      // 顶部（有支撑点）：接触点不挪，就是布点位置；要求它沿 uDes 正好在表面上（同针的折向，见上面 aimOf）。
      // 底部没有可挪的点，仍从过渡段沿 uDes 打到表面
      let H, hitT, hitF;
      if (anchor) {
        const C0 = [anchor.x, anchor.y, anchor.z], probe = 0.3;
        const hp = raycast(bvh, C0[0] - uDes[0] * probe, C0[1] - uDes[1] * probe, C0[2] - uDes[2] * probe, uDes[0], uDes[1], uDes[2], 0.05, probe + 0.5);
        if (!hp || Math.abs(hp.t - probe) > 0.15) return null;
        H = C0; hitF = hp.f;
        hitT = (C0[0] - K[0]) * uDes[0] + (C0[1] - K[1]) * uDes[1] + (C0[2] - K[2]) * uDes[2];
        if (hitT < 0.3 || hitT > reach) return null;
      } else {
        const hit = raycast(bvh, K[0], K[1], K[2], uDes[0], uDes[1], uDes[2], 0.05, Math.max(reach, 2));
        if (!hit || hit.t < 0.3 || hit.t > reach) return null;
        H = [K[0] + uDes[0] * hit.t, K[1] + uDes[1] * hit.t, K[2] + uDes[2] * hit.t];
        hitF = hit.f; hitT = hit.t;
      }
      const ox = anchor ? anchor.x : ax[0], oy = anchor ? anchor.y : ax[1], oz = anchor ? anchor.z : ax[2];
      const shift = Math.hypot(H[0] - ox, H[1] - oy, H[2] - oz);     // 顶部恒为 0（接触点就是布点位置）
      let fn = triNrm(hitF);
      if (fn[0] * uDes[0] + fn[1] * uDes[1] + fn[2] * uDes[2] > 0) fn = [-fn[0], -fn[1], -fn[2]];
      const stop = hitT * 0.5;
      const rad = Math.min(0.15, shortTW / 2 + 0.04);
      const clear = !(stop > 0.2) || capsuleClear(bvh, K[0], K[1], K[2], K[0] + uDes[0] * stop, K[1] + uDes[1] * stop, K[2] + uDes[2] * stop, rad);
      const riseOk = !anchor || anchor.island == null || H[1] <= anchor.y + 0.1;
      if (shift > 1.6 || !riseOk || !clear || -(fn[0] * uDes[0] + fn[1] * uDes[1] + fn[2] * uDes[2]) < 0.5) return null;
      return { H, uDes, shift, hitT, s1: sRing, ang, foot };
    };
    const sBend = Math.max(0, L - cm - tp);                   // 顶部：过渡段起点
    const sFoot = cm + tp;                                    // 底部：过渡段结束、杆身变粗的地方
    let aim = (thinB && tipP && tipP.n && sBend >= 0.2 && sBend > sLo + 0.05) ? tryAim(u, tipP.n, tipP, sBend, false) : null;
    let footAim = (thinA && !flatA && footN && sFoot > 0.15 && sFoot < L - 0.2) ? tryAim([-u[0], -u[1], -u[2]], footN, null, sFoot, true) : null;
    // 杆太短，两头的过渡段叠在一起：留下偏得更多的那一头
    if (aim && footAim && aim.s1 < footAim.s1 + 0.25) {
      if (footAim.ang > aim.ang) aim = null; else footAim = null;
    }
    const sStart = footAim ? footAim.s1 : sLo;
    const sEnd = aim ? aim.s1 : sHi;
    if (!(sEnd > sStart + 0.05)) return false;
    const thinTip = aim ? false : thinB;                       // 折向时这一端的收尖改由尖凸包出
    const thinRoot = footAim ? false : thinA;
    const prof = s => {                                        // 细端 g=0（球头时收到颈圈宽，否则接触宽 × 比例）、粗端 / 中段 g=1
      const gA = thinRoot ? Math.min(1, Math.max(0, (s - cm) / (tp || 1e-9))) : 1;
      const gB = thinTip ? Math.min(1, Math.max(0, (L - cm - s) / (tp || 1e-9))) : 1;
      const g = Math.min(gA, gB);
      return [endW + (shortW - endW) * g, endT + (shortW - endT) * g];
    };
    const KS = [];
    for (const s of [sLo, sStart, 0, cm, cm + tp, L - cm - tp, L - cm, L, sHi, sEnd]) {
      if (s < sStart - 1e-9 || s > sEnd + 1e-9) continue;
      if (!KS.length || s > KS[KS.length - 1] + 1e-9) KS.push(s);
    }
    const emit = (e, m, s0, s1) => {
      const list = [s0, ...KS.filter(s => s > s0 + 1e-9 && s < s1 - 1e-9), s1];
      for (let i = 0; i + 1 < list.length; i++) {
        const [w0, t0] = prof(list[i]), [w1, t1] = prof(list[i + 1]);
        // 端面：中间段界水平（错切连续），最外两端垂直轴——斜杆上水平切端面会被剪切投影成塌缩细针
        const nA = Math.abs(list[i] - sStart) < 1e-6 ? (flatA && !footAim ? Y : u) : Y;
        const nB = Math.abs(list[i + 1] - sEnd) < 1e-6 ? u : Y;
        bar(gBuf, at(list[i]), at(list[i + 1]), e, m, w0, t0, w1, t1, nA, nB, 0, 0, 'gusset');
      }
    };
    emit(X, Z, sStart, sEnd);                                  // 第一片：折向的那一端收到过渡段起点
    // 宽和厚一样时第二片占的体积和第一片相同。叠上去两层壳抢深度，看起来像杆身缺面。
    // 只有某一段宽厚不同，第二片才是十字的另一臂。
    {
      let need2 = false;
      for (const s of [sStart, (sStart + sEnd) / 2, sEnd]) {
        const [w, t] = prof(s);
        if (Math.abs(w - t) > 1e-4) { need2 = true; break; }
      }
      if (need2) emit(Z, X, sStart, sEnd);
    }
    if (!aim && !footAim) return true;
    // 杆端方截面接到沿法线的接触面，一个凸包填上折角。向杆身里多包 0.05，贴面布尔并会留缝
    const ringOf = (P, dir, e, m, w, th) => {
      const out = [], un = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2] || 1;
      for (const i of [-1, 1]) for (const j of [-1, 1]) {
        const X0 = P[0] + e[0] * i * w / 2 + m[0] * j * th / 2;
        const X1 = P[1] + e[1] * i * w / 2 + m[1] * j * th / 2;
        const X2 = P[2] + e[2] * i * w / 2 + m[2] * j * th / 2;
        const k = ((P[0] - X0) * dir[0] + (P[1] - X1) * dir[1] + (P[2] - X2) * dir[2]) / un;
        out.push([X0 + dir[0] * k, X1 + dir[1] * k, X2 + dir[2] * k]);
      }
      return out;
    };
    const faceOf = (c, dir, hw) => {
      const ref = Math.abs(dir[1]) < 0.92 ? Y : X;
      const e = nrm(cross(ref, dir)), m = nrm(cross(dir, e)), out = [];
      for (const we of [hw, -hw]) for (const wm of [hw, -hw])
        out.push([c[0] + e[0] * we + m[0] * wm, c[1] + e[1] * we + m[1] * wm, c[2] + e[2] * we + m[2] * wm]);
      return out;
    };
    const emitBend = (one, penLen) => {
      const sRing = one.s1;
      const [wE, tE] = prof(sRing);
      const pts = ringOf(at(sRing), u, X, Z, wE, tE);
      if (Math.abs(wE - tE) > 1e-6) pts.push(...ringOf(at(sRing), u, Z, X, wE, tE));
      const sBack = one.foot ? Math.min(sEnd - 0.02, sRing + 0.05) : Math.max(sStart + 0.02, sRing - 0.05);
      if ((one.foot ? sBack > sRing : sBack < sRing) && Math.abs(sBack - sRing) > 1e-4) {
        const [wB, tB] = prof(sBack);
        pts.push(...ringOf(at(sBack), u, X, Z, wB, tB));
        if (Math.abs(wB - tB) > 1e-6) pts.push(...ringOf(at(sBack), u, Z, X, wB, tB));
      }
      const du = one.uDes, Hh = one.H;
      if (ball) {
        pts.push(...faceOf([Hh[0] + du[0] * neckOff, Hh[1] + du[1] * neckOff, Hh[2] + du[2] * neckOff], du, neckD / 2));
      } else {
        const margin = Math.min(cMargin, Math.max(0, one.hitT - 0.15));
        const Cm = [Hh[0] - du[0] * margin, Hh[1] - du[1] * margin, Hh[2] - du[2] * margin];
        pts.push(...faceOf(Cm, du, shortTW / 2));
        if (margin + penLen > 1e-4) {
          const back = Math.min(0.05, Math.max(0.02, one.hitT * 0.2));
          const Cb = [Cm[0] - du[0] * back, Cm[1] - du[1] * back, Cm[2] - du[2] * back];
          const Hp = [Hh[0] + du[0] * penLen, Hh[1] + du[1] * penLen, Hh[2] + du[2] * penLen];
          const ref = Math.abs(du[1]) < 0.92 ? Y : X;
          const e = nrm(cross(ref, du)), m = nrm(cross(du, e));
          bar(gBuf, Cb, Hp, e, m, shortTW, shortTW, shortTW, shortTW, du, du, 0, 0, 'gusset-tip');
        }
      }
      emitHull(gBuf, pts, 'gusset-tip');
      st.shortBent = (st.shortBent || 0) + 1;
      if (one.foot) st.shortBentFoot = (st.shortBentFoot || 0) + 1;
    };
    if (aim) {
      emitBend(aim, penB);
      if (aim.shift > 0.02) moveTo(tipP, aim.H);
    }
    if (footAim) emitBend(footAim, penA);
    return { H: aim && aim.H, uDes: aim && aim.uDes, footH: footAim && footAim.H, footDir: footAim && footAim.uDes };
  };
  let geomTreeG = null, geomTreeA = null;
  // 兜底件落到支撑地面 floorY：自动底板是板顶，连接底板是立板顶面，没有底板就是平台。
  // 连接底板下、正下方原来没有立板的落点，上面已补了一小块立板，杆从板顶起步，不再穿过底板落到平台。
  const lowSet = lowIdx.length ? new Set(lowIdx) : null;
  if (fallbackIdx.length && (P.shortSup || lowIdx.length)) {
    const plates = [];
    const rest = [];
    const gBuf = new TriBuf();
    const gBufG = new TriBuf();   // 落到平台的短杆 / 分叉：属落板支撑，归入黑灰那一组（落到模型上的才是红色的短小支撑）
    /* ---- 分叉短杆（一主干两头，2026-10-12 用户提议）：相邻的两个兜底点共用一根主干，在 F 处分叉成两个接触头 ----
       主干：自 F 竖直落到模型面 / 平台（F 端粗、落点端细）；头：F → 接触点（F 端粗、接触端细）。
       F 取两点水平中点的上方，高度从接触点下方 0.5 mm 起逐级下探，取第一个同时满足：头长 ∈ [0.55, 针最大长]、
       头与接触点法线的夹角 ≤ 接触锥（45°）、头离模净空、F 在模型外且离表面 ≥ 0.45（连接宽截面外接圆）、主干能落地且长 ≥ 0.35。 */
    const cosTilt = Math.cos(tc.tilt);
    const forkSolve = (a, b) => {
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2, yTop = Math.min(a.y, b.y);
      for (let k = 0; k < 36; k++) {
        const F = { x: mx, y: yTop - 0.5 - 0.15 * k, z: mz };
        if (ld && ldiInside(ld, F.x, F.y, F.z)) continue;
        if (pointDist(bvh, F.x, F.y, F.z, 0.6) < 0.45) continue;
        let ok = true;
        for (const q of [a, b]) {
          const dv = [q.x - F.x, q.y - F.y, q.z - F.z], L = len(dv);
          if (L < 0.55 || L > Lmax) { ok = false; break; }
          const u = [dv[0] / L, dv[1] / L, dv[2] / L];
          const nq = q.n || [0, -1, 0];
          // 头的方向（自接触点指向 F）与被托面法线的夹角须在接触锥内
          if (-(u[0] * nq[0] + u[1] * nq[1] + u[2] * nq[2]) < cosTilt) { ok = false; break; }
          // 头离模净空：停在接触点前 0.33 mm，胶囊半径 0.25（与十字短杆的包络半径同口径）
          const sx = q.x - u[0] * 0.33, sy = q.y - u[1] * 0.33, sz = q.z - u[2] * 0.33;
          if (Math.hypot(sx - F.x, sy - F.y, sz - F.z) > 0.12 && !capsuleClear(bvh, F.x, F.y, F.z, sx, sy, sz, 0.25)) { ok = false; break; }
        }
        if (!ok) continue;
        // 主干：自 F 竖直落到朝上的模型面或平台（与十字短杆同一套落地判定，中途不碰模型）
        const tr = bridgeSpan(bvh, ctx.faces, F, { dir: [0, -1, 0], maxLen: 12, pen: P.pen, protNear: ctx.protNear, sinkTop: false, rFrom: 0.3, groundY: floorY });
        if (!tr || Math.hypot(tr.lower.x - F.x, tr.lower.y - F.y, tr.lower.z - F.z) < 0.35) continue;
        return { F, trunk: tr.lower, ground: tr.ground, landN: tr.landN };
      }
      return null;
    };
    // 配对：水平距离 ≤ 1.6 × 支撑间距、高度相近的兜底点，依距离由近到远试 3 个；配不上的点照旧单独用十字短杆
    const paired = new Set();
    const dPair = 1.6 * P.spacing;
    for (const pi of fallbackIdx) {
      if (paired.has(pi) || (lowSet && lowSet.has(pi))) continue;
      const a = points[pi];
      const cands = [];
      for (const pj of fallbackIdx) {
        if (pj === pi || paired.has(pj) || (lowSet && lowSet.has(pj))) continue;
        const b = points[pj];
        const dh = Math.hypot(b.x - a.x, b.z - a.z);
        if (dh <= dPair && Math.abs(b.y - a.y) <= 2) cands.push({ pj, dh });
      }
      cands.sort((x, y) => x.dh - y.dh);
      for (const c of cands.slice(0, 3)) {
        const b = points[c.pj];
        const fk = forkSolve(a, b);
        if (!fk) continue;
        const buf = fk.ground ? gBufG : gBuf, ps = fk.ground ? 'ground' : 'mesh';
        const et = emitMember(buf, fk.trunk, fk.F, !fk.ground, false, fk.ground ? 0 : pen, pen, fk.ground, null, fk.ground ? null : fk.landN);   // 主干：落在模型上那端可折向落面，落在平台上平头
        const ea = emitMember(buf, fk.F, a, false, true, pen, pen, false, a);   // 头：F 端粗、接触端细，针尖可折向法线
        const eb = emitMember(buf, fk.F, b, false, true, pen, pen, false, b);
        putHead(buf, (ea && ea.H) || [a.x, a.y, a.z], (ea && ea.uDes) || [a.x - fk.F.x, a.y - fk.F.y, a.z - fk.F.z]);
        putHead(buf, (eb && eb.H) || [b.x, b.y, b.z], (eb && eb.uDes) || [b.x - fk.F.x, b.y - fk.F.y, b.z - fk.F.z]);
        if (!fk.ground) putHead(buf, (et && et.footH) || [fk.trunk.x, fk.trunk.y, fk.trunk.z], (et && et.footDir) || [fk.trunk.x - fk.F.x, fk.trunk.y - fk.F.y, fk.trunk.z - fk.F.z]);
        paired.add(pi); paired.add(c.pj);
        pointState[pi] = ps; pointState[c.pj] = ps;
        if (fk.ground) st.ground += 2; else st.anchors += 2;
        st.plates += 2; st.forks = (st.forks || 0) + 1;
        (st.forkList || (st.forkList = [])).push({ F: fk.F, L: fk.trunk, p: [a, b] });
        break;
      }
    }
    for (const pi of fallbackIdx) {
      if (paired.has(pi)) continue;
      // 「短小支撑」关闭时普通兜底点不生成（标红）；低空间单杆仍照生成（它是格架在矮空间里的替代形态，不是可选兜底件）
      if (!P.shortSup && !(lowSet && lowSet.has(pi))) { rest.push(pi); continue; }
      // 低空间单杆用步骤 4 判定时的落地方案（限长按到底座的高度）；普通兜底点按十字短杆的 12 mm 限长
      const s = lowSpans.get(pi) || shortSpan(points[pi], 12);
      const em = s && emitMember(s.ground ? gBufG : gBuf, s.lower, s.upper, !s.ground, true, s.ground ? 0 : pen, pen, s.ground, points[pi], s.ground ? null : s.landN);
      if (em) {
        pointState[pi] = s.ground ? 'ground' : 'mesh';
        if (s.ground) st.ground++; else st.anchors++;
        st.plates++;
        (st.gussetList || (st.gussetList = [])).push({ A: s.lower, B: s.upper, landN: s.landN || null });
        const up = [s.upper.x - s.lower.x, s.upper.y - s.lower.y, s.upper.z - s.lower.z];
        const buf = s.ground ? gBufG : gBuf;
        putHead(buf, em.H || [points[pi].x, points[pi].y, points[pi].z], em.uDes || up);
        if (!s.ground) {
          const down = [-up[0], -up[1], -up[2]];
          putHead(buf, em.footH || [s.lower.x, s.lower.y, s.lower.z], em.footDir || down);
        }
      } else rest.push(pi);
    }
    const gg = gBuf.geometry();
    if (gg) plates.push(gg);
    if (rest.length) {
      // 连不上格架、也贴不上面的点不生成支撑，标红，由用户加点 / 删点处理
      for (const pi of rest) pointState[pi] = 'unroutable';
      st.unconnected = rest.length;
    }
    const ggG = gBufG.geometry();
    if (ggG) geomTreeG = geomTreeG ? mergeParts([geomTreeG, ggG]) : ggG;
    geomTreeA = plates.length ? mergeParts(plates) : null;
    st.fallback = fallbackIdx.length;
    if (lowIdx.length) st.lowSpace = lowIdx.length;   // 低空间单杆的点数（日志 / 验收）
  } else if (fallbackIdx.length) {
    for (const pi of fallbackIdx) pointState[pi] = 'unroutable';
    st.unconnected = fallbackIdx.length;
    st.fallback = fallbackIdx.length;
  }
  // 短杆落在底座顶、正下方却没有底座时，补一块小垫块，再用细条接到墙线上的底座（连接底板 / 基础带）上。
  // 连接底板时垫块与细条顶提到板顶 + 实心肩，与墙线上的基础带顶齐平；杆仍从板顶长起，下段埋在垫块里，最短支撑仍按板顶算。
  // 不开底板时顶面仍是基础带顶。自动底板的杆落在自动底板上，它本身已覆盖杆脚，不补。
  // 只补真正落到底座顶的点，不给后来接到模型上的点空垫一块。
  const padTop = join && plateH > 0 ? floorY : (!P.autoPlateOn && foundH > 0.05 ? foundH : null);
  if (padTop !== null) {
    const floorY = padTop;   // 本段的落地高度（遮住外层的 floorY：不开底板时取基础带顶）。杆脚仍按这个高度认
    // 连接底板档顶面升到肩顶，和墙线基础带齐平；不开底板时 padTop 已是基础带顶，不再加高
    const slabTop = join && plateH > 0 ? padTop + shoulder : floorY;
    // 杆身半宽要整个落在立板顶面上。只按墙线外包框量，中心擦到板边也会判成有板，杆其实悬在外面。
    const onSlab = (x, z) => wallRuns.some(r => {
      const need = shortW / 2;
      const along = r.dir === 'x' ? x : z, across = r.dir === 'x' ? z : x;
      const x0 = r.s0 * ws - (half - EPS), x1 = r.s1 * ws + (half - EPS);
      if (Math.abs(across - r.line * ws) > half - need) return false;
      return along >= x0 + need && along <= x1 - need;
    });
    const lands = [];
    const addL = (x, z, y) => {
      if (!(y <= floorY + 0.15) || !Number.isFinite(x) || onSlab(x, z)) return;
      if (lands.some(p => Math.hypot(p.x - x, p.z - z) < 0.35)) return;
      const need = half + 0.15;
      // 垫块加到肩顶后，顶部那一截也要离模。墙线上的实心肩本来就在同一高度、不另做离模检查
      const ys = [groundY + 0.25, groundY + plateH * 0.5, floorY - 0.08];
      if (join && plateH > 0) ys.push(padTop + shoulder - 0.08);
      for (const yy of ys) {
        if (ld && ldiInside(ld, x, yy, z)) return;
        if (pointDist(bvh, x, yy, z, need + 0.2) < need) return;
      }
      lands.push({ x, z });
    };
    for (const g of st.gussetList || []) if (g.A) addL(g.A.x, g.A.z, g.A.y);
    for (const f of st.forkList || []) if (f.L) addL(f.L.x, f.L.z, f.L.y);
    if (lands.length || wallRuns.length > 1) {   // 垫块要补，或者多座墙线条之间要连通
      // 垫块与连接条的半宽：比墙线条略细（0.01 免得与墙面共面），仍整块盖住杆脚（半宽 shortW/2），不再比墙和杆粗
      const padHalf = Math.max(shortW / 2 + 0.05, half - 0.01);
      const pads = lands.map(p => {
        const x0 = p.x - padHalf, x1 = p.x + padHalf;
        return { pl: 0, c: p.z, half: padHalf, polys: [[[x0, groundY], [x1, groundY], [x1, slabTop], [x0, slabTop]]] };
      });
      // 连通（用户 2026-10-16：底部没连接）：墙线条（各座格架的基础带 / 连接底板条）与垫块要接成一块，不能各自悬着。
      // 按「两者最近距离」依次接入（Prim），接法为 L 形细条（先沿 x 再沿 z）。细条顶与垫块同一高度（连接底板时齐到墙线基础带顶）。
      const rectOf = r => (r.dir === 'x'
        ? { x0: r.s0 * ws, x1: r.s1 * ws, z0: r.line * ws, z1: r.line * ws }
        : { x0: r.line * ws, x1: r.line * ws, z0: r.s0 * ws, z1: r.s1 * ws });
      const els = [
        ...wallRuns.map(r => ({ rc: rectOf(r) })),
        ...lands.map(p => ({ rc: { x0: p.x, x1: p.x, z0: p.z, z1: p.z } })),
      ];
      for (const e of els) { e.cx = (e.rc.x0 + e.rc.x1) / 2; e.cz = (e.rc.z0 + e.rc.z1) / 2; }
      const rectDist = (a, b) => Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.z0 - b.z1, b.z0 - a.z1));
      const clampTo = (rc, x, z) => ({ x: Math.max(rc.x0, Math.min(rc.x1, x)), z: Math.max(rc.z0, Math.min(rc.z1, z)) });
      const legs = [];
      if (els.length > 1) {
        const linkedEls = [els[0]], rest = els.slice(1);
        while (rest.length) {
          let best = null;
          rest.forEach((r, i) => {
            for (const l of linkedEls) {
              const d = rectDist(r.rc, l.rc);
              if (!best || d < best.d) best = { i, d, r, l };
            }
          });
          rest.splice(best.i, 1);
          const { r, l } = best;
          // 两端各取离对方最近的点：先在 r 上取离 l 中心最近的点，再在 l 上取离它最近的点
          const p = clampTo(r.rc, l.cx, l.cz), q = clampTo(l.rc, p.x, p.z);
          if (Math.abs(p.x - q.x) > 1e-3) {   // x 向细条：沿 z = p.z，自 p 到 q 的 x 方向
            const xa = Math.min(p.x, q.x) - padHalf, xb = Math.max(p.x, q.x) + padHalf;
            legs.push({ pl: 0, c: p.z, half: padHalf, polys: [[[xa, groundY], [xb, groundY], [xb, slabTop], [xa, slabTop]]] });
          }
          if (Math.abs(p.z - q.z) > 1e-3) {   // z 向细条：沿 x = q.x，自 p 到 q 的 z 方向
            const za = Math.min(p.z, q.z) - padHalf, zb = Math.max(p.z, q.z) + padHalf;
            legs.push({ pl: 1, c: q.x, half: padHalf, polys: [[[za, groundY], [zb, groundY], [zb, slabTop], [za, slabTop]]] });
          }
          linkedEls.push(r);
        }
      }
      const slabs = pads.concat(legs);
      const padSolid = slabs.length ? await (ctx.solidify || solidifyAsync)({ t, rFil: 0, seg: 8, walls: [], slabs, hulls: [], knuckles: [], cuts: [] }) : null;
      const padParts = (padSolid && padSolid.parts || []).filter(p => p.kind === 'slab' && p.tri && p.tri.length);
      if (padParts.length) {
        const triN = p => {
          const { vert, tri } = p, pos = new Float32Array(tri.length * 3), nrm = new Float32Array(tri.length * 3);
          for (let i = 0, o = 0; i < tri.length; i += 3, o += 9) {
            const ia = tri[i] * 3, ib = tri[i + 1] * 3, ic = tri[i + 2] * 3;
            const ax = vert[ia], ay = vert[ia + 1], az = vert[ia + 2];
            const bx = vert[ib], by = vert[ib + 1], bz = vert[ib + 2];
            const cx = vert[ic], cy = vert[ic + 1], cz = vert[ic + 2];
            let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
            let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
            let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
            const ln = Math.hypot(nx, ny, nz) || 1;
            pos[o] = ax; pos[o + 1] = ay; pos[o + 2] = az;
            pos[o + 3] = bx; pos[o + 4] = by; pos[o + 5] = bz;
            pos[o + 6] = cx; pos[o + 7] = cy; pos[o + 8] = cz;
            nrm[o] = nrm[o + 3] = nrm[o + 6] = nx / ln;
            nrm[o + 1] = nrm[o + 4] = nrm[o + 7] = ny / ln;
            nrm[o + 2] = nrm[o + 5] = nrm[o + 8] = nz / ln;
          }
          return { pos, nrm };
        };
        let extraP = new Float32Array(0), extraN = new Float32Array(0);
        for (const p of padParts) {
          const m = triN(p);
          const np = new Float32Array(extraP.length + m.pos.length), nn = new Float32Array(extraN.length + m.nrm.length);
          np.set(extraP); np.set(m.pos, extraP.length); extraP = np;
          nn.set(extraN); nn.set(m.nrm, extraN.length); extraN = nn;
        }
        if (!towerG) {
          towerG = new THREE.BufferGeometry();
          towerG.userData.solids = [];
          towerG.userData.runs = [];
        }
        const op = towerG.attributes.position ? towerG.attributes.position.array : new Float32Array(0);
        const on = towerG.attributes.normal ? towerG.attributes.normal.array : new Float32Array(0);
        const pos = new Float32Array(op.length + extraP.length), nrm = new Float32Array(on.length + extraN.length);
        pos.set(op); pos.set(extraP, op.length); nrm.set(on); nrm.set(extraN, on.length);
        towerG.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        towerG.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
        const solids = towerG.userData.solids || (towerG.userData.solids = []);
        const runs = towerG.userData.runs || (towerG.userData.runs = []);
        let a2 = runs.length ? runs[runs.length - 1][1] : 0;
        for (const p of padParts) {
          solids.push(p);
          const a0 = a2; a2 += p.tri.length / 3;
          runs.push([a0, a2]);
        }
        st.pads = padParts.length;
      }
    }
  }
  // 格架塔（已是水密实体，导出直接复用。含格架节点件：转接块 / 柱顶盖）、连接体（十字针凸包）、兜底树分开返回：兜底件由各自闭合的构件堆成，导出时另做布尔并
  return {
    geomGround: towerG, geomNeedle: needleG, geomGround2: geomTreeG,
    geomAnchor: geomTreeA,
    stats: st, pointState,
  };
}
