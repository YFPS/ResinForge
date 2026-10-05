/* ================================================================
   支撑塔（e-Stage 模式）—— Materialise e-Stage 菱形格架支撑塔的复刻
   依据：e-Stage 核心专利 US8903533B2（Materialise，Eggers & Renap，2007 优先权；同族 US10343389B2 / US11104119B2）
        + e-Stage 7.0 官方用户手册（Grid / Top connection / Foundation 参数语义）
        + Materialise 官方 e-Stage for Resin 产品说明与透明树脂实拍
   格架拓扑（专利 FIG.7 / FIG.12）：
   - 初始网格 = 正交竖直墙（俯视正方形网格，墙距 = 菱形宽 w）；每面墙 = 两组斜边交叉成的菱形（宽 w、高 w·tan(菱形角)）
     + 菱形竖直对角线（竖杆）；两向墙在交线处各出一片竖板 →「+」截面柱
   - 半格序号 a/b（水平，步长 w/2）、n（竖向，步长 h/2）；周期 q 半格：墙在 a≡0 / b≡0 (mod q)，
     上行斜边 a−n≡0、a+n≡0 (mod q) 两组分开判定；壳层缩减 = q 逐级翻倍（2→4→8→16），粗格是细格的子集
   - 支撑网格 = 初始网格 − 外扩「离模净距」的模型（节点点距 / 杆件胶囊体，BVH 判定）
   - 节点平滑过渡：杆件修剪到节点，每面墙内有 ≥2 根杆的节点放一块圆角节点板（相邻杆的凹角做圆弧圆角、凸侧半径 边宽/2 圆弧收头），
     杆件端面恰为节点板的边；只有一根杆的端头不放节点板、在节点高度水平切齐——节点处没有板条外伸的台阶和凸片
   结构生成：
   1. 柱化路径（专利 FIG.10）：每个支撑点取针最省（针长 + 水平偏移罚）、可落地的接入节点，
      沿竖杆 / 菱形斜边搜索到平台的路径（竖直优先，被模型挡住时沿斜边绕行）
   2. 支撑区域：路径节点所在的那一格（墙到墙），每下降一个柱高（柱高宽比 × 菱形宽）向四周展宽一格
      ——相邻支撑点的区域并成连续塔块（官方实拍：模型下方是一整块格架，不是一丛独立柱）
   3. 自平台逐层向上：节点只有在至少一根下行杆连到已保留节点时才保留（无打印孤岛），两端都保留的杆件全部收录
      （菱形闭合）；规划路径上的杆件强制收录，保证每个接入节点都连到平台
   4. 接入节点后，只保留自各接入节点沿下行杆的闭包——顶部收成尖顶、往下铺满成块，多余格架不生成
   接触（专利 FIG.13/14 + 手册 Top connection）：十字截面针自格架节点直通接触点——连接宽 → 过渡段渐缩 → 接触宽
   （接触边距段）→ 沿针轴扎入渗透长度；十字板对齐格架墙向，针脚在节点高度切齐；针身胶囊体 + 过渡段锥台做净空判定
   基础带（手册 Foundation）：底层节点按墙线连成段，墙下沿实心带，相邻竖杆之间的底边开三角缺口
   连不上格架的支撑点：专利做法为连回模型自身——此处交给树状支撑（锚定模型 / 绕行落地）兜底，不留悬空点
================================================================ */
import * as THREE from 'three';
import { pointDist, capsuleClear, coneClear, ldiInside } from './collide.js';
import { buildBranchingTree } from './supportTree.js';
import { mergeParts } from './supportKit.js';

/* ---------- 三角形缓冲：板条/针/基础带直接写顶点，避免成千上万个 three 几何对象 ---------- */
class TriBuf {
  constructor() { this.a = new Float32Array(1 << 18); this.n = 0; }
  ensure(k) {
    if (this.n + k <= this.a.length) return;
    let m = this.a.length * 2; while (m < this.n + k) m *= 2;
    const b = new Float32Array(m); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  tri(p, q, r) {
    this.ensure(9); const a = this.a; let n = this.n;
    a[n++] = p[0]; a[n++] = p[1]; a[n++] = p[2]; a[n++] = q[0]; a[n++] = q[1]; a[n++] = q[2]; a[n++] = r[0]; a[n++] = r[1]; a[n++] = r[2];
    this.n = n;
  }
  /* 四边形（按外法线 out 自检绕序） */
  quad(q0, q1, q2, q3, out) {
    const ux = q1[0] - q0[0], uy = q1[1] - q0[1], uz = q1[2] - q0[2], vx = q2[0] - q0[0], vy = q2[1] - q0[1], vz = q2[2] - q0[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * out[0] + ny * out[1] + nz * out[2] < 0) { this.tri(q0, q2, q1); this.tri(q0, q3, q2); }
    else { this.tri(q0, q1, q2); this.tri(q0, q2, q3); }
  }
  /* 六面体：c[s*4 + i*2 + j]（s 沿轴两端，i/j 截面两向） */
  hexa(c) {
    let cx = 0, cy = 0, cz = 0; for (const p of c) { cx += p[0]; cy += p[1]; cz += p[2]; } cx /= 8; cy /= 8; cz /= 8;
    for (const f of [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]]) {
      const q = f.map(k => c[k]);
      const fx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, fy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4, fz = (q[0][2] + q[1][2] + q[2][2] + q[3][2]) / 4;
      this.quad(q[0], q[1], q[2], q[3], [fx - cx, fy - cy, fz - cz]);
    }
  }
  geometry() {
    if (!this.n) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.a.slice(0, this.n), 3));
    g.computeVertexNormals();
    return g;
  }
}

/* 变截面板：A→B；两端截面（宽 w 沿 e、厚 t 沿 m）沿杆轴投影到过端点、法线 nA / nB 的端面上
   （法线取杆轴 = 垂直切；取 Y = 水平切，用于杆端齐平在节点高度） */
function bar(buf, A, B, e, m, w0, t0, w1, t1, nA, nB) {
  const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], l = Math.hypot(u[0], u[1], u[2]) || 1;
  u[0] /= l; u[1] /= l; u[2] /= l;
  const c = [];
  for (const [P, w, th, np] of [[A, w0, t0, nA], [B, w1, t1, nB]]) {
    const un = u[0] * np[0] + u[1] * np[1] + u[2] * np[2];
    for (const i of [-1, 1]) for (const j of [-1, 1]) {
      const X = [P[0] + e[0] * i * w / 2 + m[0] * j * th / 2, P[1] + e[1] * i * w / 2 + m[1] * j * th / 2, P[2] + e[2] * i * w / 2 + m[2] * j * th / 2];
      const k = ((P[0] - X[0]) * np[0] + (P[1] - X[1]) * np[1] + (P[2] - X[2]) * np[2]) / un;
      c.push([X[0] + u[0] * k, X[1] + u[1] * k, X[2] + u[2] * k]);
    }
  }
  buf.hexa(c);
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
export function buildEStageTowers(ctx, points, P) {
  const { bvh, ld, groundY } = ctx;
  const w = Math.max(1, P.esCell);                                      // 菱形宽 = 墙距（俯视正方形网格边长）
  const crit = Math.max(10, Math.min(80, P.selfAngle)) * Math.PI / 180;
  const ang = Math.max(crit, Math.max(20, Math.min(85, P.esDiamAngle)) * Math.PI / 180);   // 菱形角（不低于临界角，斜边自支撑）
  const h = w * Math.tan(ang);                                          // 菱形高
  const ws = w / 2, hs = h / 2;                                         // 节点间距：水平半格 / 竖直半格
  const b = Math.max(0.15, P.esBarW), t = Math.max(0.15, P.esBarT);     // 边宽（板条面内宽）/ 边厚（墙厚）
  const gap = Math.max(0, P.esGap);
  const R = Math.hypot(b / 2, t / 2) + gap;                             // 杆件离模判定半径（板条外接圆 + 离模净距）
  const foundH = Math.max(0, P.esFoundH);
  const baseTop = groundY + foundH;                                     // 格架底层 = 基础带顶面
  const tiltMax = Math.PI / 2 - crit, tanT = Math.tan(tiltMax);
  // 十字针（e-Stage Top connection，自格架节点直通接触点）：连接宽 → 过渡段渐缩 → 接触宽（接触边距段）→ 沿针轴扎入渗透长度
  const connW = Math.max(0.1, P.esConnW), needleT = Math.max(0.1, P.esNeedleT);   // 连接宽 / 针板厚
  const tipW = Math.max(0.05, Math.min(connW, P.esTipW)), tipT = Math.min(needleT, tipW);   // 接触宽（接触段板厚不超过接触宽）
  const taper = Math.max(0.2, P.esTaper), cMargin = Math.max(0, P.esContactMargin);   // 过渡段长 / 接触边距
  const pen = Math.max(0, P.pen);                                       // 渗透长度
  const rCross = Math.hypot(connW / 2, needleT / 2);                    // 十字截面外接圆半径（净空判定）
  const Lmax = Math.max(1, P.esNeedleMax);                              // 针最大长（格架节点 → 接触点）
  const Dcol = Math.max(1, P.esColRatio) * w;                           // 柱高 = 柱高宽比 × 菱形宽（展宽 / 壳层缩减的深度步长）
  const maxWid = Math.max(0, Math.round(P.esTowerMaxR));                // 最大展宽（每侧格数）
  const hullRed = Math.max(0, Math.min(3, Math.round(P.esHullRed || 0)));   // 壳层缩减级数（0 = 关闭）
  const mid = P.esMidBars !== false;
  const st = { points: points.length, needles: 0, nodes: 0, bars: 0, towers: 0, foundRuns: 0, fallback: 0, ground: 0, anchors: 0, micro: 0, noHead: 0, unroutable: 0, capped: false };
  const pointState = new Array(points.length).fill('');
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
  const downs2 = (a, bb, n) => {                   // 下行杆：竖杆 + 墙内菱形斜边
    const out = [];
    if (n <= 0) return out;
    if (vert2(a, bb)) out.push([a, bb, n - 1, false]);
    if ((bb & 1) === 0 && ((a + n) & 1) === 0) out.push([a + 1, bb, n - 1, true], [a - 1, bb, n - 1, true]);
    if ((a & 1) === 0 && ((bb + n) & 1) === 0) out.push([a, bb + 1, n - 1, true], [a, bb - 1, n - 1, true]);
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
  /* 柱化路径（专利 FIG.10）：逐层束搜索，竖直优先，被挡住时沿菱形斜边绕行；返回自起点到底层的节点序列或 null */
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
  // 接入候选：接触点下方、针不陡于临界锥、长度 ≤ 针最大长；代价 = 针长 + 0.6 × 水平偏移（优先更竖直的针）
  const needleCost = (p, N) => {
    const dy = p.y - N[1], dh = Math.hypot(p.x - N[0], p.z - N[2]);
    if (dy < 0.3 || dh > dy * tanT + 1e-6) return -1;
    const L = Math.hypot(dh, dy);
    return L <= Lmax ? L + 0.6 * dh : -1;
  };
  // 针轴曲线：二次贝塞尔——自格架节点竖直起步（与下面的竖杆相切，针脚处无折角），平滑转向接触点；
  // 控制点竖直抬高 k，切向倾角沿曲线单调增大，末端（接触方向）不超过临界锥
  const needleCurve = (p, N) => {
    const P2 = [p.x, p.y, p.z], dy = p.y - N[1], dh = Math.hypot(p.x - N[0], p.z - N[2]);
    const k = Math.max(0, Math.min(0.2 * dy, dy - dh / tanT - 0.05));   // k 小：只在根部收一个小圆弧，针身大体笔直，针尖不打弯
    const P1 = [N[0], N[1] + k, N[2]];
    const m = k > 0.05 && dh > 0.02 ? 8 : 1;
    const pts = [], acc = [0];
    for (let i = 0; i <= m; i++) {
      const s = i / m, c0 = (1 - s) * (1 - s), c1 = 2 * (1 - s) * s, c2 = s * s;
      pts.push([c0 * N[0] + c1 * P1[0] + c2 * P2[0], c0 * N[1] + c1 * P1[1] + c2 * P2[1], c0 * N[2] + c1 * P1[2] + c2 * P2[2]]);
      if (i) acc.push(acc[i - 1] + len(sub(pts[i], pts[i - 1])));
    }
    const L = acc[m], tEnd = nrm(sub(P2, m > 1 ? P1 : N));
    const posAt = s => {                             // 弧长 s 处的点；s > L 沿末端切向外推（渗透段）
      if (s >= L) return [P2[0] + tEnd[0] * (s - L), P2[1] + tEnd[1] * (s - L), P2[2] + tEnd[2] * (s - L)];
      let i = 1; while (i < m && acc[i] < s) i++;
      const f = (s - acc[i - 1]) / ((acc[i] - acc[i - 1]) || 1), A = pts[i - 1], B = pts[i];
      return [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f];
    };
    return { pts, acc, L, posAt };
  };
  // 针净空：针身（节点 → 过渡段起点）沿曲线折线逐段按十字截面外接圆 + 0.1 做胶囊体判定；
  // 过渡段按锥台（接触端 tipW/2 → 起点 rCross，+0.1），自接触点起豁免「接触边距 + 0.2」（接触段本就贴住 / 扎入表面）
  const needleClear = (p, N) => {
    const cv = needleCurve(p, N), s1 = Math.max(0, cv.L - taper - cMargin);
    let prev = cv.pts[0];
    for (let i = 1; i < cv.pts.length && cv.acc[i - 1] < s1; i++) {
      const B = cv.acc[i] <= s1 ? cv.pts[i] : cv.posAt(s1);
      if (len(sub(B, prev)) > 0.02 && !capsuleClear(bvh, prev[0], prev[1], prev[2], B[0], B[1], B[2], rCross + 0.1)) return false;
      prev = B;
    }
    const S1 = cv.posAt(s1);
    return coneClear(bvh, p.x, p.y, p.z, tipW / 2 + 0.1, S1[0], S1[1], S1[2], rCross + 0.1, cMargin + 0.2);
  };

  /* ---------- 1. 每个支撑点：针最省、可落地的接入节点 + 柱化路径 ---------- */
  const plan = new Array(points.length).fill(null);
  const ar = Math.ceil(Lmax * tanT / ws) + 1;
  for (let pi = 0; pi < points.length; pi++) {
    const p = points[pi];
    const nHi = Math.floor((p.y - 0.3 - baseTop) / hs), nLo = Math.max(0, Math.ceil((p.y - Lmax - baseTop) / hs));
    if (nHi < 0) continue;
    const ca = Math.round(p.x / ws), cb = Math.round(p.z / ws);
    const cand = [];
    for (let n = nHi; n >= nLo; n--) for (let a = ca - ar; a <= ca + ar; a++) for (let bb = cb - ar; bb <= cb + ar; bb++) {
      if (!exists2(a, bb, n)) continue;
      const N = pos(a, bb, n), cost = needleCost(p, N);
      if (cost >= 0) cand.push({ a, b: bb, n, cost, N });
    }
    cand.sort((x, y) => x.cost - y.cost);
    let tries = 0;
    for (const c of cand) {
      if (tries >= 16) break;
      if (!nodeOK(c.a, c.b, c.n)) continue;
      tries++;
      if (!needleClear(p, c.N)) continue;
      const path = findPath(c.a, c.b, c.n);
      if (path) { plan[pi] = { top: c, path }; break; }
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
  const regHas = (a, bb, n) => regGet(a, bb, n) !== undefined;
  /* 节点所在级的菱形周期 q（半格）：壳层缩减每下降一个柱高翻倍一次——只放大内部结构（手册 Inner hull），
     区域边界上的外墙保持最小菱形（外壳缩减 0 级），塔块轮廓不随粗格跳变 */
  const qAt = (a, bb, n) => {
    const d = regGet(a, bb, n);
    if (d === undefined) return 0;
    const k = Math.min(hullRed, Math.floor(d / Dcol));
    if (!k) return 2;
    if ((a & 1) === 0 && !(regHas(a - 2, bb, n) && regHas(a + 2, bb, n))) return 2;
    if ((bb & 1) === 0 && !(regHas(a, bb - 2, n) && regHas(a, bb + 2, n))) return 2;
    return 2 << k;
  };
  /* 上行杆（自下层节点 (a,b,n)，存在性取下层节点所在级的周期 q）：[a2, b2, 类型, 在 x 固定墙, 在 z 固定墙] */
  const upEdges = (a, bb, n) => {
    const q = qAt(a, bb, n);
    if (!q) return [];
    const wx = md(a, q) === 0, wz = md(bb, q) === 0;   // x 固定墙（沿 z 走向）/ z 固定墙（沿 x 走向）
    const out = [];
    if (!wx && !wz) return out;
    const vs = mid ? q >> 1 : q;
    const vx = wx && md(bb, vs) === 0, vz = wz && md(a, vs) === 0;
    if (vx || vz) out.push([a, bb, 'v', vx, vz]);
    if (wz) { if (md(a - n, q) === 0) out.push([a + 1, bb, 'x']); if (md(a + n, q) === 0) out.push([a - 1, bb, 'x']); }
    if (wx) { if (md(bb - n, q) === 0) out.push([a, bb + 1, 'z']); if (md(bb + n, q) === 0) out.push([a, bb - 1, 'z']); }
    return out;
  };

  /* ---------- 3. 自平台逐层向上：有下行杆连到已保留节点才保留（无孤岛）；两端都保留的杆件全部收录（菱形闭合） ---------- */
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
    const next = new Map();
    const take = (a, bb, a2, b2, kind, vx, vz) => {
      if (regGet(a2, b2, n) === undefined || !edgeOK(a, bb, n - 1, a2, b2, n)) return;
      edges.push({ a1: a, b1: bb, n1: n - 1, a2, b2, n2: n, kind, vx, vz });
      const k = k2(a2, b2);
      if (!next.has(k)) { next.set(k, [a2, b2]); G.add(k3(a2, b2, n)); }
    };
    for (const [a, bb] of cur) {
      const ups = upEdges(a, bb, n - 1);
      for (const [a2, b2, kind, vx, vz] of ups) take(a, bb, a2, b2, kind, vx, vz);
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
  for (let pi = 0; pi < points.length; pi++) {
    const p = points[pi], g = plan[pi];
    let hook = null;
    if (g && G.has(k3(g.top.a, g.top.b, g.top.n))) hook = g.top;
    if (!hook) {
      const ci = Math.floor(p.x / hc), cj = Math.floor(p.y / hc), ck = Math.floor(p.z / hc);
      const cand = [];
      for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (let dc = -1; dc <= 1; dc++) {
        const arr = gHash.get((ci + da) + ',' + (cj + db) + ',' + (ck + dc));
        if (!arr) continue;
        for (const [a, bb, n, x, y, z] of arr) {
          const N = [x, y, z], cost = needleCost(p, N);
          if (cost >= 0) cand.push({ a, b: bb, n, cost, N });
        }
      }
      cand.sort((x, y) => x.cost - y.cost);
      for (let i = 0; i < cand.length && i < 24; i++) if (needleClear(p, cand[i].N)) { hook = cand[i]; break; }
    }
    if (hook) needles.push({ pi, a: hook.a, b: hook.b, n: hook.n, N: hook.N });
    else fallbackIdx.push(pi);
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
  st.nodes = keep.size; st.bars = used.length;
  // 自检：n>0 的保留节点都必须有下行杆（否则就是打印时的孤岛起点）
  { const hasDown = new Set(used.map(e => k3(e.a2, e.b2, e.n2))); st.minima = 0; for (const k of keep) if (k >= LAYER && !hasDown.has(k)) st.minima++; }

  /* ---------- 6. 几何 ---------- */
  const buf = new TriBuf();
  const X = [1, 0, 0], Z = [0, 0, 1];
  // 杆件所在墙面：0 = z 固定墙（法线 Z，面内坐标 (x, y)），1 = x 固定墙（法线 X，面内坐标 (z, y)）；
  // 竖杆在墙交线处两向墙各一片 →「+」截面柱
  const planesOf = e => (e.kind === 'x' ? [0] : e.kind === 'z' ? [1] : [e.vz ? 0 : -1, e.vx ? 1 : -1].filter(v => v >= 0));
  // 节点处各墙面内的入射杆：面内单位方向 + 杆长（修剪距离不超过杆长）
  const incid = new Map();                           // 键 = 节点键 × 2 + 墙面 → [[ds, dy, L], ...]
  const addInc = (k, pl, ds, dy, L) => { const kk = k * 2 + pl; let arr = incid.get(kk); if (!arr) incid.set(kk, arr = []); arr.push([ds, dy, L]); };
  for (const e of used) {
    const A = pos(e.a1, e.b1, e.n1), B = pos(e.a2, e.b2, e.n2), kA = k3(e.a1, e.b1, e.n1), kB = k3(e.a2, e.b2, e.n2);
    for (const pl of planesOf(e)) {
      const ds = pl === 0 ? B[0] - A[0] : B[2] - A[2], dy = B[1] - A[1], l = Math.hypot(ds, dy);
      addInc(kA, pl, ds / l, dy / l, l); addInc(kB, pl, -ds / l, -dy / l, l);
    }
  }
  // 接针节点：针自节点竖直起步，在已有格架杆的墙面内当作一根向上的杆参与节点圆角（针与格架圆滑相接）
  const needleNode = new Set(needles.map(nd => k3(nd.a, nd.b, nd.n)));
  for (const kN of needleNode) for (const pl of [0, 1]) {
    const arr = incid.get(kN * 2 + pl);
    if (arr && arr.length && !arr.some(d => d[1] > 0.999)) arr.push([0, 1, 0.8]);
  }
  // 圆角节点板（同一墙面内 ≥2 根杆的节点）：入射杆按极角排序，相邻两杆夹角 Δ < π 的一侧（凹角）做半径 r 的圆角，
  // 切点距节点 a = (b/2 + r)/tan(Δ/2)；Δ > π 的一侧（凸侧）以节点为心、半径 b/2 的圆弧收头；共线直通的两杆不需要节点板。
  // 每根杆修剪到两侧切点中较远者（e），杆端面恰为节点板的一条边——墙面成为孔角倒圆的连续穿孔板，节点处无直棱、无外伸。
  // 圆角半径取边宽一半，并按最小孔（菱形被竖直对角线分成的三角孔，或整个菱形）的内切圆限制，免得相邻圆角在孔里相交
  const holeIn = mid ? ws * hs / (hs + Math.hypot(ws, hs)) : ws * hs / Math.hypot(ws, hs);
  const rFil = Math.max(0, Math.min(b / 2, 0.6 * (holeIn - b / 2)));
  const ARC = 3;                                     // 圆角圆弧分段数
  const plates = new Map();                          // kk → [{ s, y, L, th, e }]（按极角排序）
  for (const [kk, dirs] of incid) {
    if (dirs.length < 2) continue;
    const ds = dirs.map(([s, y, L]) => ({ s, y, L, th: Math.atan2(y, s), e: 0 })).sort((p, q) => p.th - q.th);
    const k = ds.length;
    const gapOf = i => ds[(i + 1) % k].th - ds[i].th + (i === k - 1 ? 2 * Math.PI : 0);
    if (k === 2 && Math.abs(gapOf(0) - Math.PI) < 1e-3) continue;
    for (let i = 0; i < k; i++) {
      const D = gapOf(i);
      if (D >= Math.PI - 1e-3) continue;
      const a = (b / 2 + rFil) / Math.tan(D / 2);
      ds[i].e = Math.max(ds[i].e, a); ds[(i + 1) % k].e = Math.max(ds[(i + 1) % k].e, a);
    }
    for (const d of ds) d.e = Math.min(Math.max(d.e, b / 2), 0.95 * d.L);
    plates.set(kk, ds);
  }
  const trimAt = (k, pl, s, y) => {                  // 自节点沿面内方向 (s, y) 的杆端修剪距离；无节点板 → 0
    const ds = plates.get(k * 2 + pl);
    if (ds) for (const d of ds) if (d.s * s + d.y * y > 0.999) return d.e;
    return 0;
  };
  const Y = [0, 1, 0];
  const termAt = (k, pl) => (incid.get(k * 2 + pl) || []).length === 1;   // 该墙面内只有这一根杆到此为止
  const wallAt = (k, pl) => (incid.get(k * 2 + pl) || []).length >= 2;    // 该墙面在此节点有连续的杆（节点板或直通）
  // 杆件：扁平板条修剪到两端节点板边缘；单杆端头水平切齐到节点。单杆端头若是「+」柱的一臂在此终止、另一面墙在此连续：
  // 臂宽（b，比墙厚 t 宽）在这一段内收到墙厚，端面整个收进另一面墙里——否则两侧各露出 (b−t)/2 的小平台
  for (const e of used) {
    const A = pos(e.a1, e.b1, e.n1), B = pos(e.a2, e.b2, e.n2), L = len(sub(B, A)), u = nrm(sub(B, A));
    const kA = k3(e.a1, e.b1, e.n1), kB = k3(e.a2, e.b2, e.n2);
    for (const pl of planesOf(e)) {
      const us = pl === 0 ? u[0] : u[2];
      const eA = trimAt(kA, pl, us, u[1]), eB = trimAt(kB, pl, -us, -u[1]);
      if (eA + eB >= L - 1e-3) continue;               // 杆被两端节点板覆盖
      const wn = pl === 0 ? Z : X;
      const wA = termAt(kA, pl) && wallAt(kA, 1 - pl) ? Math.min(b, t) : b;
      const wB = termAt(kB, pl) && wallAt(kB, 1 - pl) ? Math.min(b, t) : b;
      bar(buf, [A[0] + u[0] * eA, A[1] + u[1] * eA, A[2] + u[2] * eA], [B[0] - u[0] * eB, B[1] - u[1] * eB, B[2] - u[2] * eB],
        nrm(cross(wn, u)), wn, wA, t, wB, t, eA > 0 ? u : Y, eB > 0 ? u : Y);
    }
  }
  // 节点板几何：轮廓（面内坐标，绕节点逆时针、对节点星形）→ 以节点为中心扇形三角化 → 沿墙法线挤出 ±t/2
  for (const [kk, ds] of plates) {
    const pl = kk % 2, kN = (kk - pl) / 2, [a, bb, n] = unk(kN), N = pos(a, bb, n);
    const k = ds.length, raw = [];
    for (let i = 0; i < k; i++) {
      const D1 = ds[i], D2 = ds[(i + 1) % k];
      const gap = D2.th - D1.th + (i === k - 1 ? 2 * Math.PI : 0);
      const n1 = [-D1.y, D1.s], n2 = [-D2.y, D2.s];  // 左法向
      raw.push([D1.s * D1.e - n1[0] * b / 2, D1.y * D1.e - n1[1] * b / 2], [D1.s * D1.e + n1[0] * b / 2, D1.y * D1.e + n1[1] * b / 2]);
      if (gap < Math.PI - 1e-3) {
        // 凹角圆角：杆 1 左边线与杆 2 右边线的公切圆（半径受两杆修剪距离限制）
        const tg = Math.tan(gap / 2);
        const r = Math.max(0, Math.min(rFil, Math.min(D1.e, D2.e) * tg - b / 2));
        const aT = (b / 2 + r) / tg;
        const T1 = [D1.s * aT + n1[0] * b / 2, D1.y * aT + n1[1] * b / 2];
        if (r < 1e-3) { raw.push(T1); continue; }
        const T2 = [D2.s * aT - n2[0] * b / 2, D2.y * aT - n2[1] * b / 2];
        const bis = [D1.s + D2.s, D1.y + D2.y], bl = Math.hypot(bis[0], bis[1]);
        bis[0] /= bl; bis[1] /= bl;
        const dO = (b / 2 + r) / Math.sin(gap / 2), O = [bis[0] * dO, bis[1] * dO];
        // 圆弧自 T1 绕 O 到 T2，经过靠近节点的一侧（−bis 方向）
        const a1 = Math.atan2(T1[1] - O[1], T1[0] - O[0]), a2 = Math.atan2(T2[1] - O[1], T2[0] - O[0]), am = Math.atan2(-bis[1], -bis[0]);
        const wrap = x => { while (x > Math.PI) x -= 2 * Math.PI; while (x <= -Math.PI) x += 2 * Math.PI; return x; };
        let sw = wrap(a2 - a1);
        const dm = wrap(am - a1);
        if (sw >= 0 ? (dm < 0 || dm > sw) : (dm > 0 || dm < sw)) sw = sw > 0 ? sw - 2 * Math.PI : sw + 2 * Math.PI;
        for (let j = 0; j <= ARC; j++) { const ang = a1 + sw * j / ARC; raw.push([O[0] + r * Math.cos(ang), O[1] + r * Math.sin(ang)]); }
      } else {
        // 凸侧：节点为心、半径 b/2 的圆弧，自杆 1 左边（节点处）转到杆 2 右边（节点处），跨度 Δ − π
        const b1 = Math.atan2(n1[1], n1[0]), extra = gap - Math.PI;
        const nseg = extra > 1e-3 ? Math.max(1, Math.ceil(ARC * extra / (Math.PI / 2))) : 0;
        for (let j = 0; j <= nseg; j++) { const ang = b1 + (nseg ? extra * j / nseg : 0); raw.push([b / 2 * Math.cos(ang), b / 2 * Math.sin(ang)]); }
      }
    }
    const poly = [];
    for (const q of raw) { const p0 = poly[poly.length - 1]; if (!p0 || Math.hypot(q[0] - p0[0], q[1] - p0[1]) > 1e-6) poly.push(q); }
    while (poly.length > 1 && Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) <= 1e-6) poly.pop();
    const m = poly.length;
    if (m < 3) continue;
    const W = (s, y, o) => (pl === 0 ? [N[0] + s, N[1] + y, N[2] + o] : [N[0] + o, N[1] + y, N[2] + s]);
    const wn = pl === 0 ? Z : X;
    for (const o of [t / 2, -t / 2]) {
      const out = o > 0 ? wn : [-wn[0], -wn[1], -wn[2]], C = W(0, 0, o);
      for (let i = 0; i < m; i++) {
        const P1 = W(poly[i][0], poly[i][1], o), P2 = W(poly[(i + 1) % m][0], poly[(i + 1) % m][1], o);
        const nn = cross(sub(P1, C), sub(P2, C));
        if (nn[0] * out[0] + nn[1] * out[1] + nn[2] * out[2] < 0) buf.tri(C, P2, P1); else buf.tri(C, P1, P2);
      }
    }
    for (let i = 0; i < m; i++) {
      const q = poly[i], q2 = poly[(i + 1) % m], ds2 = q2[0] - q[0], dy2 = q2[1] - q[1];
      // 逆时针多边形的边外法线 (dy, −ds)，映射回三维
      buf.quad(W(q[0], q[1], t / 2), W(q2[0], q2[1], t / 2), W(q2[0], q2[1], -t / 2), W(q[0], q[1], -t / 2), pl === 0 ? [dy2, -ds2, 0] : [0, -ds2, dy2]);
    }
  }
  // 十字针（e-Stage Top connection）：自格架节点直通接触点——针身（连接宽）→ 过渡段（渐缩到接触宽）→
  // 接触段（接触宽，长 = 接触边距）→ 沿针轴扎入渗透长度。
  // 错切十字柱：每层水平截面都是对齐墙向的「+」（板 Z：宽沿 X、厚沿 Z；板 X：宽沿 Z、厚沿 X），沿针轴曲线平移——
  // 针脚截面与格架竖杆 / 节点板顶边完全一致、起步方向竖直，斜向的接触点也无缝、无折角接上（逐层打印时本就是这个形状）。
  // 节点在某墙面内没有格架时，该向的针板自墙厚起步、在 fadeLen 内放宽到连接宽，针脚不露小平台
  const fadeLen = 0.6;
  const latticeIn = (k, pl, a, bb, n) => (incid.get(k * 2 + pl) || []).length > 0
    || (n === 0 && (pl === 0 ? md(bb, qAt(a, bb, 0) || 2) === 0 : md(a, qAt(a, bb, 0) || 2) === 0));
  for (const nd of needles) {
    const p = points[nd.pi], N = nd.N, kN = k3(nd.a, nd.b, nd.n);
    const cv = needleCurve(p, N), L = cv.L, at = cv.posAt;
    const s1 = Math.max(0, L - taper - cMargin), s2 = Math.max(s1, L - cMargin), s3 = L + pen;
    // 沿针轴的截面（宽、厚）：针身 → 过渡段线性渐缩 → 接触段
    const prof = s => {
      if (s <= s1) return [connW, needleT];
      if (s >= s2) return [tipW, tipT];
      const f = (s - s1) / (s2 - s1);
      return [connW + (tipW - connW) * f, needleT + (tipT - needleT) * f];
    };
    for (const pl of [0, 1]) {
      const eW = pl === 0 ? X : Z, eT = pl === 0 ? Z : X;
      const fade = latticeIn(kN, pl, nd.a, nd.b, nd.n) ? 0 : Math.min(fadeLen, s3 * 0.5);
      const ss = [...new Set([...cv.acc, fade, s1, s2, s3].filter(s => s >= 0 && s <= s3))].sort((x, y) => x - y);
      const wAt = s => { const [w, th] = prof(s); return [fade > 0 && s < fade ? Math.min(w, t + (w - t) * (s / fade)) : w, th]; };
      for (let i = 0; i + 1 < ss.length; i++) {
        if (ss[i + 1] - ss[i] < 1e-3) continue;
        const [w0, t0] = wAt(ss[i]), [w1, t1] = wAt(ss[i + 1]);
        bar(buf, at(ss[i]), at(ss[i + 1]), eW, eT, w0, t0, w1, t1, Y, Y);
      }
    }
    st.needles++; pointState[nd.pi] = 'ground';
  }
  // 基础带：底层节点按所在墙线连段（间隔 ≤ 本级周期即相连），墙下沿实心带，相邻竖杆之间开三角缺口
  if (foundH > 0) {
    const lines = new Map();                         // 'x' + b（z 固定墙，沿 x）/ 'z' + a（x 固定墙，沿 z）→ [{ s, q }]
    for (const k of keep) {
      const [a, bb, n] = unk(k);
      if (n !== 0) continue;
      const q = qAt(a, bb, 0) || 2;
      const onZ = md(bb, q) === 0, onX = md(a, q) === 0;
      if (onZ) { const lk = 'x' + bb; (lines.get(lk) || lines.set(lk, []).get(lk)).push({ s: a, q }); }
      if (onX) { const lk = 'z' + a; (lines.get(lk) || lines.set(lk, []).get(lk)).push({ s: bb, q }); }
      if (!onZ && !onX) { const lk = ((bb & 1) === 0 ? 'x' + bb : 'z' + a); (lines.get(lk) || lines.set(lk, []).get(lk)).push({ s: (bb & 1) === 0 ? a : bb, q }); }
    }
    const runs = [];
    for (const [lk, arr] of lines) {
      arr.sort((x, y) => x.s - y.s);
      const dir = lk[0], line = +lk.slice(1);
      let s0 = arr[0].s, prev = arr[0], q0 = arr[0].q;
      const flush = () => runs.push(prev.s > s0 ? { dir, line, s0, s1: prev.s, q: q0 } : { dir, line, s0: s0 - 0.5, s1: s0 + 0.5, q: q0 });
      for (let i = 1; i < arr.length; i++) {
        const c = arr[i];
        if (c.s - prev.s <= Math.max(c.q, prev.q)) { prev = c; q0 = Math.min(q0, c.q); continue; }
        flush(); s0 = c.s; prev = c; q0 = c.q;
      }
      flush();
    }
    const nh = Math.max(0, Math.min(P.esNotchH, foundH - 0.3));
    for (const r of runs) {
      // 轮廓（墙面坐标 s 向右、y 向上，逆时针）：底边在相邻竖杆之间开三角缺口
      const x0 = r.s0 * ws - t / 2, x1 = r.s1 * ws + t / 2;
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
      const toW = (s, y, o) => (r.dir === 'x' ? [s, groundY + y, r.line * ws + o] : [r.line * ws + o, groundY + y, s]);
      const tris = THREE.ShapeUtils.triangulateShape(poly.map(([s, y]) => new THREE.Vector2(s, y)), []);
      const wn = r.dir === 'x' ? Z : X;
      for (const [i, j, k] of tris) {
        for (const o of [t / 2, -t / 2]) {
          const P1 = toW(...poly[i], o), P2 = toW(...poly[j], o), P3 = toW(...poly[k], o);
          const out = o > 0 ? wn : [-wn[0], -wn[1], -wn[2]];
          const nn = cross(sub(P2, P1), sub(P3, P1));
          if (nn[0] * out[0] + nn[1] * out[1] + nn[2] * out[2] < 0) buf.tri(P1, P3, P2); else buf.tri(P1, P2, P3);
        }
      }
      const area = poly.reduce((acc, p1, k) => { const p2 = poly[(k + 1) % poly.length]; return acc + p1[0] * p2[1] - p2[0] * p1[1]; }, 0);
      const sgn = area > 0 ? 1 : -1;
      for (let i = 0; i < poly.length; i++) {
        const q = poly[i], q2 = poly[(i + 1) % poly.length];
        const a1 = toW(...q, t / 2), a2 = toW(...q2, t / 2), a3 = toW(...q2, -t / 2), a4 = toW(...q, -t / 2);
        // 侧面外法线：轮廓边在墙面内的外法线（逆时针轮廓 → 右手外侧）
        const o2 = [(q2[1] - q[1]) * sgn, -(q2[0] - q[0]) * sgn];
        buf.quad(a1, a2, a3, a4, r.dir === 'x' ? [o2[0], o2[1], 0] : [0, o2[1], o2[0]]);
      }
      st.foundRuns++;
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

  /* ---------- 7. 兜底：连不上格架的点交给树状支撑（锚定模型 / 绕行落地） ---------- */
  let geomTreeG = null, geomTreeA = null;
  if (fallbackIdx.length) {
    const tr = buildBranchingTree(ctx, fallbackIdx.map(i => points[i]), P);
    geomTreeG = tr.geomGround; geomTreeA = tr.geomAnchor;
    fallbackIdx.forEach((pi, k) => { pointState[pi] = tr.pointState[k]; });
    st.fallback = fallbackIdx.length;
    for (const k of ['ground', 'anchors', 'micro', 'noHead', 'unroutable']) st[k] = tr.stats[k] || 0;
  }
  const towerG = buf.geometry();
  const groundParts = [towerG, geomTreeG].filter(Boolean);
  return {
    geomGround: groundParts.length > 1 ? mergeParts(groundParts) : groundParts[0] || null,
    geomAnchor: geomTreeA,
    stats: st, pointState,
  };
}
