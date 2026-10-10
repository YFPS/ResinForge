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
   接触（专利 FIG.13/14 + 手册 Top connection）：十字截面直针自格架节点到接触点——连接宽 → 过渡段渐缩 → 接触宽
   （接触边距段）→ 沿针轴扎入渗透长度；针身胶囊体 + 过渡段锥台做净空判定。
   - 格架同向针（优先，专利「connection is made along one of the directions of the mesh edges」/ FIG.13b）：
     针轴竖直（与「+」柱同轴）或落在节点所在墙面内，与格架杆件同宽同厚、经节点圆角板无缝相接；
     接触点重定义为针轴延长线与模型的首个交点（偏移受限）
   - 自由直针（兜底，FIG.13a 斜向连接）：接触点不动；错切十字柱，针脚截面与「+」柱顶一致（FIG.13c 截面 A-A′）
   基础带（手册 Foundation）：底层节点按墙线连成段，墙下沿实心带，相邻竖杆之间的底边开三角缺口
   连不上格架的支撑点：能直接落到朝上表面时，按短小支撑样式处理（树状细尖，或单片竖板）。
   其余仍交给树状支撑绕行落地。竖板是单独的一块，不沿格架边接针，也不在两层之间再铺一套菱形格。
================================================================ */
import * as THREE from 'three';
import { pointDist, capsuleClear, coneClear, ldiInside, raycast } from './collide.js';
import { buildBranchingTree } from './supportTree.js';
import { mergeParts, dirCandidates, tipCone, bridgeToSurface } from './supportKit.js';

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

/* [DEBUG-j1] 关节审计采集（诊断用，验证后移除）：登记每个六面体构件的 8 角点与节点板轮廓。
   开关走 window.__capOn —— Vite HMR 后应用与诊断脚本可能各自持有一份模块实例，只有 window 是共享的 */
const AUDIT = { hexes: [], plates: [], meta: {} };
let CAPTAG = '', CAPINFO = null;                                       // [DEBUG-j1] 当前采集来源标签与端部上下文

/* 变截面板：A→B；两端截面（宽 w 沿 e、厚 t 沿 m）沿杆轴投影到过端点、法线 nA / nB 的端面上
   （法线取杆轴 = 垂直切；取 Y = 水平切，用于杆端齐平在节点高度）。
   o0 / o1：两端截面中心沿 e 的侧移（板宽不对称时用：一侧按边宽、另一侧切齐到相邻墙面） */
function bar(buf, A, B, e, m, w0, t0, w1, t1, nA, nB, o0 = 0, o1 = 0) {
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
  if (window.__capOn) AUDIT.hexes.push({ c, tag: CAPTAG, info: CAPINFO });
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
  if (window.__capOn) { AUDIT.hexes.length = 0; AUDIT.plates.length = 0; AUDIT.meta = {}; delete AUDIT.plateKeys; delete AUDIT.plateSkip; window.__cap = AUDIT; }   // [DEBUG-j1]
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
  const join = !!P.baseJoin;
  // 连接底板（连接条）：格架自板顶起步——板内不留任何格架杆件 / 节点板，底板开孔不会暴露内部构件；
  // 否则格架从基础带顶起步（基础带只垫在下面）。
  const bandH = join ? Math.max(foundH + hs * 0.85, 1.5) : foundH;
  const baseTop = groundY + (join ? bandH : foundH);
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
  const st = { points: points.length, needles: 0, nodes: 0, bars: 0, towers: 0, foundRuns: 0, fallback: 0, ground: 0, anchors: 0, shortAnchors: 0, micro: 0, plates: 0, noHead: 0, unroutable: 0, capped: false };
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
  // 接触方向（自接触点指向外，朝下）：被托面外法线按「接触朝向 / 接触最大倾角」钳制（tipCone）。替补：竖直
  const tc = tipCone(P);
  const tipDirs = p => {
    const d0 = dirCandidates(p.n, -1, tc.tilt, 8 * Math.PI / 180, tc.fixed)[0];
    return d0[1] < -0.999 ? [d0] : [d0, [0, -1, 0]];
  };
  const clamp1 = x => Math.max(-1, Math.min(1, x));
  /* ---- 格架同向针（专利 FIG.13b + 正文「connection is made along one of the directions of the mesh edges」）----
     针轴只取格架自身的方向：① 竖直，与「+」柱 / 墙内竖杆同轴；② 墙面内斜向（针轴落在节点所在的墙面里，倾角 ≤ 接触最大倾角 ∩ 临界锥）。
     十字截面与格架对齐（专利 FIG.13c 截面 A-A′）：一片板就在墙面内、与墙内杆件同宽同厚，经节点圆角板无缝相接；另一片板垂直墙面。
     接触点按专利做法重定义：针轴延长线与模型的首个交点（「structure 125 is virtually prolonged until it intersects with the object」），
     偏移受限（普通点 ≤ min(1.2, 0.4·菱形宽)；手动点 ≤ 0.4；孤岛种子不得上移 > 0.1——最低点先打印）。
     旧实现让直针朝法线任意方位斜出：十字板离开墙面、针脚水平切口外露，节点处出现小方块 / 台阶（用户截图红框指出）。 */
  const thMax = Math.min(tc.tilt, tiltMax);              // 墙面内斜针最大倾角
  const shiftOf = p => (p.manual ? 0.4 : Math.min(1.2, 0.4 * w));
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
  /* ---- 自由直针（兜底：格架同向针在偏移限度内接不上时，接触点不动，节点 → 支撑点直连）---- */
  const DEV_MAX = 25 * Math.PI / 180;
  const needleCost = (p, N, d) => {
    const dy = p.y - N[1], hx = N[0] - p.x, hz = N[2] - p.z, dh = Math.hypot(hx, hz);
    if (dy < 0.3 || dh > dy * tanT + 1e-6) return -1;
    const L = Math.hypot(dh, dy);
    if (L > Lmax) return -1;
    const dev = Math.acos(clamp1((hx * d[0] - dy * d[1] + hz * d[2]) / L));
    if (dev > DEV_MAX) return -1;
    // + 斜向偏移（X、Z 同时偏）惩罚：只沿一个墙向倾斜时，十字针一片板始终留在墙面内、与格架共面
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
  // 过渡段按锥台（接触端 tipW/2 → 起点 rCross，+0.1），自接触点起豁免「接触边距 + 0.2」（接触段本就贴住 / 扎入表面）
  const needleClear = (C, N) => {
    const L = len(sub(C, N)), u = nrm(sub(C, N)), s1 = Math.max(0, L - taper - cMargin);
    const S1 = [N[0] + u[0] * s1, N[1] + u[1] * s1, N[2] + u[2] * s1];
    if (s1 > 0.02 && !capsuleClear(bvh, N[0], N[1], N[2], S1[0], S1[1], S1[2], rCross + 0.1)) return false;
    return coneClear(bvh, C[0], C[1], C[2], tipW / 2 + 0.1, S1[0], S1[1], S1[2], rCross + 0.1, cMargin + 0.2);
  };

  /* ---------- 1. 每个支撑点：针最省、可落地的接入节点 + 柱化路径 ---------- */
  const plan = new Array(points.length).fill(null);
  const ar = Math.ceil(Lmax * tanT / ws) + 1;
  const dirsOf = points.map(tipDirs);                // 每点的接触方向（主方向 + 竖直替补）
  for (let pi = 0; pi < points.length; pi++) {
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
    if (!hook) {                                     // 格架同向针接已保留节点
      let tries = 0;
      for (const c of alignedCands(p, pi, (a, bb, n) => G.has(k3(a, bb, n)))) {
        if (tries++ >= 24) break;
        const v = verifyAligned(p, c);
        if (v) { hook = v; break; }
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
    if (hook) {
      const u = hook.u || nrm(sub(hook.C, hook.N)), L = hook.kind === 'free' ? len(sub(hook.C, hook.N)) : hook.L;
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
  // 格架自身在各墙面的入射数（不含针）：针脚是否需要自墙厚放宽的判定用
  const latCnt = new Map();
  for (const [kk, arr] of incid) latCnt.set(kk, arr.length);
  const addNeedleInc = (kN, pl, s, y, L) => {
    const kk = kN * 2 + pl;
    let arr = incid.get(kk); if (!arr) incid.set(kk, arr = []);
    if (!arr.some(d => d[0] * s + d[1] * y > 0.999)) arr.push([s, y, L]);   // 同节点同向多根针只记一次
  };
  // 格架同向针：针轴就在墙面内，按真实方向当作该墙面的一根杆参与节点圆角（与格架杆件同宽同厚，节点处无缝）；
  // 竖直针在柱所在的每面墙里都是一根向上的竖杆
  for (const nd of needles) {
    const kN = k3(nd.a, nd.b, nd.n);
    if (nd.kind === 'p') addNeedleInc(kN, nd.pl, nd.pl === 0 ? nd.u[0] : nd.u[2], nd.u[1], nd.L);
    else if (nd.kind === 'v') {
      if ((nd.b & 1) === 0) addNeedleInc(kN, 0, 0, 1, nd.L);
      if ((nd.a & 1) === 0) addNeedleInc(kN, 1, 0, 1, nd.L);
    }
  }
  // 自由直针（兜底）不登记入射：它是错切十字柱，针脚水平截面与下面「+」柱顶完全相同，在节点处直接弯折接出即连续；
  // 若按针轴投影方向登记，节点板会沿投影方向伸出一截与针截面对不上的假杆头（小方块 / 台阶，用户截图红框指出）
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
  // 侧边切齐：墙面 pl 在节点处没有朝 s·sg > 0 一侧的杆（本墙到此为止，例如塔块外墙上与之正交的墙），而另一面墙在此确实向一侧延伸——
  // 该侧板宽切齐到另一面墙的墙面（s = sg·t/2）。否则边宽（0.45）比墙厚（0.35）宽：外墙上整根「+」柱凸出 0.05 成一条棱、
  // 节点板凸侧圆弧凸出 0.05 成小盖子（用户截图：「立柱是共用一根还是多根重复」「节点合并不够完美」）。两面墙都不延伸 = 独立「+」柱，不切
  const armDir = (k, pl, sg, ys) => (incid.get(k * 2 + pl) || []).some(d => d[0] * sg > 0.1 && (!ys || d[1] * ys > 0.1));
  // 「墙面 pl 在柱子 sg 一侧有菱形格」：本节点有朝 sg 的杆，或下方 q/2 个节点内有朝 sg 上行的斜边、上方 q/2 内有朝 sg 下行的斜边
  // （柱即菱形竖直对角线，斜边只每隔 q/2 个节点接到柱上，中间节点只有竖杆直通；按方向判定——塔块下宽上窄，
  //  下方菱形格朝 sg 下行的斜边不代表上面这段旁边也有格）
  const sideWall = (k, pl, sg) => {
    if (armDir(k, pl, sg, 0)) return true;
    const [a, bb, n] = unk(k), h = Math.max(1, (qAt(a, bb, n) || 2) >> 1);
    for (let d = 1; d <= h; d++) {
      if (n - d >= 0 && armDir(k3(a, bb, n - d), pl, sg, 1)) return true;
      if (armDir(k3(a, bb, n + d), pl, sg, -1)) return true;
    }
    return false;
  };
  const clipSide = (k, pl, sg) => !sideWall(k, pl, sg) && (sideWall(k, 1 - pl, 1) || sideWall(k, 1 - pl, -1));
  // 连接底板的立板范围要先算好：低于立板顶、又伸出立板侧面的斜杆会在侧面上留下一小块，生成杆件时切掉
  const half = join ? Math.max(b, t) / 2 : t / 2;
  const topY = groundY + bandH;
  if (window.__capOn) Object.assign(AUDIT.meta, { ws, hs, b, t, baseTop, topY, w, connW, tipW, needleT, groundY });   // [DEBUG-j1]
  const wallRuns = [];
  {
    const lines = new Map();
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
      const flush = () => wallRuns.push(prev.s > s0 ? { dir, line, s0, s1: prev.s, q: q0 } : { dir, line, s0: s0 - 0.5, s1: s0 + 0.5, q: q0 });
      for (let i = 1; i < arr.length; i++) {
        const c = arr[i];
        if (c.s - prev.s <= Math.max(c.q, prev.q)) { prev = c; q0 = Math.min(q0, c.q); continue; }
        flush(); s0 = c.s; prev = c; q0 = c.q;
      }
      flush();
    }
  }
  // 连接底板：同一条墙上相距约两个菱形宽以内、中间没有模型的段并成一条，避免底边断开或留下单独的小块
  if (join && wallRuns.length > 1) {
    wallRuns.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : a.line - b.line || a.s0 - b.s0));
    // 这条模型上断开的底板，空档大约 10～25mm。中间没有模型就补上
    const maxIdx = Math.max(8 * w, 28) / ws;
    const bridgeOk = (a, c) => {
      if (a.dir !== c.dir || a.line !== c.line) return false;
      const gap = c.s0 - a.s1;
      if (gap <= 0) return true;
      if (gap > maxIdx) return false;
      const y = groundY + Math.min(bandH * 0.5, 1.2);
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
      if (bridgeOk(cur, n)) cur = { ...cur, s1: Math.max(cur.s1, n.s1), q: Math.min(cur.q, n.q) };
      else { merged.push(cur); cur = n; }
    }
    merged.push(cur);
    wallRuns.length = 0;
    for (const r of merged) wallRuns.push(r);
  }
  // 去掉外伸：每条底板只留到最外一层交叉墙，不再从外墙侧面吐出一截
  if (join && P.baseFlush && wallRuns.length) {
    const snap = wallRuns.map(r => ({ dir: r.dir, line: r.line, s0: r.s0, s1: r.s1, q: r.q }));
    const kept = [];
    for (const r of snap) {
      let lo = Infinity, hi = -Infinity;
      for (const o of snap) {
        if (o.dir === r.dir) continue;
        // 差一格也算交上，否则外伸的小段会停在外墙外面，判不成交叉
        if (o.line < r.s0 - 1 || o.line > r.s1 + 1) continue;
        if (r.line < o.s0 - 1 || r.line > o.s1 + 1) continue;
        lo = Math.min(lo, o.line);
        hi = Math.max(hi, o.line);
      }
      if (lo <= hi) {
        r.s0 = Math.max(r.s0, lo);
        r.s1 = Math.min(r.s1, hi);
      } else if (r.s1 - r.s0 < 2) continue;
      if (r.s1 - r.s0 > 0.2) kept.push(r);
    }
    wallRuns.length = 0;
    for (const r of kept) wallRuns.push(r);
  }
  // 杆件截面会比中心线鼓出一圈，裁切边界往里收这一圈，端头才不会冒出立板侧面
  const lip = Math.hypot(b / 2, t / 2);
  // 和后面打孔用同一套位置，孔再外扩一个杆件半径，杆头才不会露在孔里
  // 孔心对齐格架节距：落在「两根竖杆之间」的半格交点（墙面内坐标为奇数半格），与节点（对穿槽所在）恒错开一个半格；
  // 孔间竖条正对节点 /「+」柱——力线自竖杆直落板底，段与段之间相位一致（不再按段长均布）。
  const skirtHoles = r => {
    if (!join || !P.baseHole) return [];
    const x0 = r.s0 * ws - half, x1 = r.s1 * ws + half;
    const chH = 0.6;
    const chamfer = P.baseChamfer ? Math.min(chH * ws / Math.max(hs, 0.2), Math.max(0, (x1 - x0 - 0.8) / 2)) : 0;
    const yLo = 0.45, yHi = bandH - 0.4;
    const hh = (yHi - yLo) / 2, cy = groundY + (yLo + yHi) / 2;
    const hw = Math.min(w * 0.42, Math.max(0.35, hh * 1.05));
    const out = [];
    if (hh <= 0.35 || hw <= 0.28) return out;
    for (let s = r.s0 + (md(r.s0, 2) === 0 ? 1 : 2); s <= r.s1 - 1; s += 2) {
      const cx = s * ws;                                  // 奇数半格：两侧各一根竖杆的中点
      if (cx - hw < x0 + chamfer + 0.4 || cx + hw > x1 - chamfer - 0.4) continue;
      out.push({ dir: r.dir, line: r.line, cx, cy, hw, hh });
    }
    return out;
  };
  const baseHoles = [];
  if (join && P.baseHole) for (const r of wallRuns) for (const h of skirtHoles(r)) baseHoles.push(h);
  // 斜杆的截面会比中心线更伸进孔里，墙面内按边宽外扩，孔里才不留杆头。
  // 竖向不能同样外扩：孔顶到立板顶只有 0.4mm，再外扩一个边宽会把立板顶上的立柱切掉，柱和格架之间空出一截。
  const holePad = b + t;
  const holeTop = groundY + bandH - 0.4;
  const holePadY = Math.min(holePad, Math.max(0, topY - holeTop - 0.08));
  const inHole = p => {
    for (const h of baseHoles) {
      const along = h.dir === 'x' ? p[0] : p[2], cross = h.dir === 'x' ? p[2] : p[0];
      if (Math.abs(cross - h.line * ws) > half + holePad) continue;
      if (Math.abs(along - h.cx) / (h.hw + holePad) + Math.abs(p[1] - h.cy) / (h.hh + holePadY) <= 1) return true;
    }
    return false;
  };
  const inSkirt = p => {
    if (p[1] >= topY - 1e-4) return true;
    const h = half - lip;
    for (const r of wallRuns) {
      const along = r.dir === 'x' ? p[0] : p[2], cross = r.dir === 'x' ? p[2] : p[0];
      if (along >= r.s0 * ws - h && along <= r.s1 * ws + h && Math.abs(cross - r.line * ws) <= Math.max(h, 0.02)) return true;
    }
    return false;
  };
  const clipJoin = (A, B) => {
    if (!join) return [[A, B, 0, 1]];
    const ts = [0, 1];
    const pushT = t => { if (t > 1e-4 && t < 1 - 1e-4) ts.push(t); };
    if (Math.abs(B[1] - A[1]) > 1e-8) pushT((topY - A[1]) / (B[1] - A[1]));
    const h = half - lip;
    for (const r of wallRuns) {
      const ax = r.dir === 'x';
      const cuts = [
        [ax ? A[0] : A[2], ax ? B[0] : B[2], r.s0 * ws - h],
        [ax ? A[0] : A[2], ax ? B[0] : B[2], r.s1 * ws + h],
        [ax ? A[2] : A[0], ax ? B[2] : B[0], r.line * ws - Math.max(h, 0)],
        [ax ? A[2] : A[0], ax ? B[2] : B[0], r.line * ws + Math.max(h, 0)],
      ];
      for (const [a0, a1, lim] of cuts) if (Math.abs(a1 - a0) > 1e-8) pushT((lim - a0) / (a1 - a0));
    }
    for (const h of baseHoles) {
      const ax = h.dir === 'x';
      const a0 = ax ? A[0] : A[2], da = (ax ? B[0] : B[2]) - a0, dy = B[1] - A[1];
      const c0 = ax ? A[2] : A[0], c1 = ax ? B[2] : B[0];
      if (Math.abs(c0 - h.line * ws) > half + holePad && Math.abs(c1 - h.line * ws) > half + holePad) continue;
      const hwE = h.hw + holePad, hhE = h.hh + holePadY;
      for (const sx of [1, -1]) for (const sy of [1, -1]) {
        const denom = sx * da / hwE + sy * dy / hhE;
        if (Math.abs(denom) < 1e-8) continue;
        const t = (1 - sx * (a0 - h.cx) / hwE - sy * (A[1] - h.cy) / hhE) / denom;
        if (t <= 1e-4 || t >= 1 - 1e-4) continue;
        const along = a0 + da * t, y = A[1] + dy * t;
        if (sx * (along - h.cx) >= -1e-3 && sy * (y - h.cy) >= -1e-3) pushT(t);
      }
    }
    ts.sort((a, c) => a - c);
    const lerp = t => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
    const out = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      const t0 = ts[i], t1 = ts[i + 1];
      if (t1 - t0 < 1e-4) continue;
      const mid = lerp((t0 + t1) / 2);
      if (inSkirt(mid) && !inHole(mid)) out.push([lerp(t0), lerp(t1), t0, t1]);
    }
    return out;
  };
  // 十字针不走上面的杆件裁切。针从立板内部的节点直着穿出时，会把一整截留在菱形孔里。
  // 孔在墙面内是菱形，沿墙法线贯穿板厚；针截面沿墙面再鼓出 ra，所以禁区是菱形上下削平的六边形
  const clipNeedle = (A, B, ext) => {
    if (!baseHoles.length) return [[A, B, 0, 1]];
    const ts = [0, 1];
    const pushT = t => { if (t > 1e-4 && t < 1 - 1e-4) ts.push(t); };
    const inside = p => {
      for (const h of baseHoles) {
        const ax = h.dir === 'x';
        const along = ax ? p[0] : p[2], cross = ax ? p[2] : p[0];
        const { ra, rc } = ext(h);
        if (Math.abs(cross - h.line * ws) > half + rc) continue;
        const dx = Math.abs(along - h.cx), dy = Math.abs(p[1] - h.cy);
        if (dy > h.hh + 1e-6) continue;
        const lim = dy >= h.hh ? ra : h.hw * (1 - dy / h.hh) + ra;
        if (dx <= lim + 1e-6) return true;
      }
      return false;
    };
    for (const h of baseHoles) {
      const ax = h.dir === 'x';
      const { ra, rc } = ext(h);
      const c0 = ax ? A[2] : A[0], c1 = ax ? B[2] : B[0];
      if (Math.abs(c0 - h.line * ws) > half + rc && Math.abs(c1 - h.line * ws) > half + rc) continue;
      const a0 = ax ? A[0] : A[2], da = (ax ? B[0] : B[2]) - a0, y0 = A[1], dy = B[1] - A[1];
      const c = h.cx, yT = h.cy + h.hh, yB = h.cy - h.hh, yM = h.cy;
      const hex = [[c + ra, yT], [c + h.hw + ra, yM], [c + ra, yB], [c - ra, yB], [c - h.hw - ra, yM], [c - ra, yT]];
      for (let i = 0; i < 6; i++) {
        const P = hex[i], Q = hex[(i + 1) % 6];
        const ex = Q[0] - P[0], ey = Q[1] - P[1];
        const den = da * ey - dy * ex;
        if (Math.abs(den) < 1e-10) continue;
        const t = ((P[0] - a0) * ey - (P[1] - y0) * ex) / den;
        const u = ((P[0] - a0) * dy - (P[1] - y0) * da) / den;
        if (t > 1e-4 && t < 1 - 1e-4 && u >= -1e-4 && u <= 1 + 1e-4) pushT(t);
      }
    }
    ts.sort((a, c) => a - c);
    const lerp = t => [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t];
    const out = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      const t0 = ts[i], t1 = ts[i + 1];
      if (t1 - t0 < 1e-4) continue;
      if (!inside(lerp((t0 + t1) / 2))) out.push([lerp(t0), lerp(t1), t0, t1]);
    }
    return out;
  };
  // 杆件：扁平板条修剪到两端节点板边缘；单杆端头水平切齐到节点。单杆端头若是「+」柱的一臂在此终止、另一面墙在此连续：
  // 臂宽（b，比墙厚 t 宽）在这一段内收到墙厚，端面整个收进另一面墙里——否则两侧各露出 (b−t)/2 的小平台
  for (const e of used) {
    const A = pos(e.a1, e.b1, e.n1), B = pos(e.a2, e.b2, e.n2), L = len(sub(B, A)), u = nrm(sub(B, A));
    const kA = k3(e.a1, e.b1, e.n1), kB = k3(e.a2, e.b2, e.n2);
    for (const pl of planesOf(e)) {
      const us = pl === 0 ? u[0] : u[2];
      const eA = trimAt(kA, pl, us, u[1]), eB = trimAt(kB, pl, -us, -u[1]);
      if (eA + eB >= L - 1e-3) continue;               // 杆被两端节点板覆盖
      const wn = pl === 0 ? Z : X, ex = nrm(cross(wn, u));
      const wA = termAt(kA, pl) && wallAt(kA, 1 - pl) ? Math.min(b, t) : b;
      const wB = termAt(kB, pl) && wallAt(kB, 1 - pl) ? Math.min(b, t) : b;
      // 竖杆两侧在两端的实际外缘（面内水平坐标 s）：该侧被切齐到相邻墙面时为 t/2
      let pA = wA / 2, mA = wA / 2, pB = wB / 2, mB = wB / 2;
      if (e.kind === 'v') {
        if (clipSide(kA, pl, 1)) pA = Math.min(pA, t / 2);
        if (clipSide(kA, pl, -1)) mA = Math.min(mA, t / 2);
        if (clipSide(kB, pl, 1)) pB = Math.min(pB, t / 2);
        if (clipSide(kB, pl, -1)) mB = Math.min(mB, t / 2);
        // 两侧都收到墙厚：整根落在另一面墙的竖杆里（「+」柱另一片板 b × t 已覆盖），不必再出
        if (e.vx && e.vz && pA <= t / 2 && mA <= t / 2 && pB <= t / 2 && mB <= t / 2) continue;
      }
      const es = (pl === 0 ? ex[0] : ex[2]) >= 0 ? 1 : -1;   // 板宽方向 e 与面内 +s 同向 / 反向
      const p0 = [A[0] + u[0] * eA, A[1] + u[1] * eA, A[2] + u[2] * eA];
      const p1 = [B[0] - u[0] * eB, B[1] - u[1] * eB, B[2] - u[2] * eB];
      for (const [P, Q, t0, t1] of clipJoin(p0, p1)) {
        const w0 = (pA + mA) + ((pB + mB) - (pA + mA)) * t0, w1 = (pA + mA) + ((pB + mB) - (pA + mA)) * t1;
        const o0 = es * (pA - mA) / 2, o1 = es * (pB - mB) / 2;
        // 端面一律垂直杆轴：斜杆的「水平切端面」会被剪切投影成塌缩细针（导出实体里的毛刺）；
        // 竖直杆的 u 本来就是竖直方向，塔块轮廓（平顶 / 平底）不受影响
        const n0 = u, n1 = u;
        if (len(sub(Q, P)) < 0.05) continue;
        CAPTAG = 'lattice';
        CAPINFO = { eA, eB, tA: termAt(kA, pl), tB: termAt(kB, pl), oA: wallAt(kA, 1 - pl), oB: wallAt(kB, 1 - pl), wA, wB, L, pl, kind: e.kind };
        bar(buf, P, Q, ex, wn, w0, t, w1, t, n0, n1, o0 + (o1 - o0) * t0, o0 + (o1 - o0) * t1);
      }
    }
  }
  // 底板开孔之后，孔里不该再留杆件。孔正上方的节点就在立板顶上沿，节点板顺着竖杆向下的那一截
  // 会伸进菱形孔，看起来像孔里留下一小段立柱。交叉墙的实心底板也会从侧面穿进对方的孔。
  // 下面这组裁切只在开孔时用：把节点板和交叉底板里落进孔的部分去掉。
  const left2 = (A, B, P) => (B[0] - A[0]) * (P[1] - A[1]) - (B[1] - A[1]) * (P[0] - A[0]);
  const area2 = p => {
    let a = 0;
    for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
    return a * 0.5;
  };
  const dedupe2 = p => {
    const o = [];
    for (const v of p) { const q = o[o.length - 1]; if (!q || Math.hypot(v[0] - q[0], v[1] - q[1]) > 1e-6) o.push(v); }
    if (o.length > 1 && Math.hypot(o[0][0] - o[o.length - 1][0], o[0][1] - o[o.length - 1][1]) <= 1e-6) o.pop();
    return o;
  };
  const splitByEdge = (poly, A, B) => {
    const inn = [], out = [];
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length];
      const sp = left2(A, B, P), sq = left2(A, B, Q);
      const pin = sp >= -1e-8, qin = sq >= -1e-8;
      if (pin) inn.push(P); else out.push(P);
      if (pin !== qin && Math.abs(sp - sq) > 1e-12) {
        const tt = sp / (sp - sq);
        out.push([P[0] + (Q[0] - P[0]) * tt, P[1] + (Q[1] - P[1]) * tt]);
        inn.push(out[out.length - 1]);
      }
    }
    return { inn, out };
  };
  // 凸多边形（逆时针，内部在边的左侧）把一个凸多边形裁掉，返回落在外侧的各块
  const clipOutsideConvex = (poly, convex) => {
    const rec = (p, i) => {
      p = dedupe2(p);
      if (p.length < 3 || Math.abs(area2(p)) < 1e-8) return [];
      if (i >= convex.length) return [];
      const A = convex[i], B = convex[(i + 1) % convex.length];
      const { inn, out } = splitByEdge(p, A, B);
      const res = [];
      const op = dedupe2(out);
      if (op.length >= 3 && Math.abs(area2(op)) > 1e-8) res.push(op);
      const ip = dedupe2(inn);
      if (ip.length >= 3 && Math.abs(area2(ip)) > 1e-8) res.push(...rec(ip, i + 1));
      return res;
    };
    return rec(poly, 0);
  };
  const insideConvex = (p, poly) => {
    for (let i = 0; i < poly.length; i++) if (left2(poly[i], poly[(i + 1) % poly.length], p) < -1e-6) return false;
    return true;
  };
  const segHit = (A, B, C, D) => {
    const d = (B[0] - A[0]) * (D[1] - C[1]) - (B[1] - A[1]) * (D[0] - C[0]);
    if (Math.abs(d) < 1e-12) return null;
    const tt = ((C[0] - A[0]) * (D[1] - C[1]) - (C[1] - A[1]) * (D[0] - C[0])) / d;
    const u = ((C[0] - A[0]) * (B[1] - A[1]) - (C[1] - A[1]) * (B[0] - A[0])) / d;
    if (tt < -1e-5 || tt > 1 + 1e-5 || u < -1e-5 || u > 1 + 1e-5) return null;
    return [A[0] + (B[0] - A[0]) * tt, A[1] + (B[1] - A[1]) * tt];
  };
  const paramOn = (A, B, P) => {
    const dx = B[0] - A[0], dy = B[1] - A[1];
    if (Math.abs(dx) >= Math.abs(dy)) return (P[0] - A[0]) / (dx || 1e-12);
    return (P[1] - A[1]) / (dy || 1e-12);
  };
  // 两个逆时针凸多边形的并。重叠处会凹进去，不能按交点极角排（交点重心落在边上时顺序会拧成自交，三角化把孔填上）
  const unionConvex = (A, B) => {
    const m = A.length, n = B.length;
    const ax = Array.from({ length: m }, () => []), bx = Array.from({ length: n }, () => []);
    for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
      const h = segHit(A[i], A[(i + 1) % m], B[j], B[(j + 1) % n]);
      if (!h) continue;
      const t = paramOn(A[i], A[(i + 1) % m], h), u = paramOn(B[j], B[(j + 1) % n], h);
      if (t <= 1e-5 || t >= 1 - 1e-5 || u <= 1e-5 || u >= 1 - 1e-5) continue;
      const rec = { p: h, i, j, t, u };
      ax[i].push(rec); bx[j].push(rec);
    }
    let nX = 0;
    for (const arr of ax) { arr.sort((p, q) => p.t - q.t); nX += arr.length; }
    for (const arr of bx) arr.sort((p, q) => p.u - q.u);
    if (nX < 2) {
      if (A.length && insideConvex(A[0], B)) return B.map(p => p.slice());
      if (B.length && insideConvex(B[0], A)) return A.map(p => p.slice());
      return null;
    }
    let s = A.findIndex(p => !insideConvex(p, B));
    if (s < 0) return B.map(p => p.slice());
    const used = new Set(), out = [A[s].slice()];
    let onA = true, edge = s, tCur = 0, guard = 0;
    while (guard++ < (m + n) * 4) {
      if (onA) {
        let next = null;
        for (const h of ax[edge]) if (h.t > tCur + 1e-5 && !used.has(h)) { next = h; break; }
        if (!next) {
          edge = (edge + 1) % m; tCur = 0;
          if (edge === s && out.length > 2) break;
          if (!insideConvex(A[edge], B)) out.push(A[edge].slice());
          continue;
        }
        used.add(next); out.push(next.p.slice());
        onA = false; edge = next.j; tCur = next.u;
      } else {
        let next = null;
        for (const h of bx[edge]) if (h.u > tCur + 1e-5 && !used.has(h)) { next = h; break; }
        if (!next) {
          edge = (edge + 1) % n; tCur = 0;
          if (!insideConvex(B[edge], A)) out.push(B[edge].slice());
          continue;
        }
        used.add(next); out.push(next.p.slice());
        onA = true; edge = next.i; tCur = next.t;
      }
    }
    const p = dedupe2(out);
    return p.length >= 3 ? p : null;
  };
  // 从逆时针外轮廓里去掉一个凸区域。完全落在内部就当孔；压到边上就从外轮廓咬掉，避免端头留下一截挡在孔里
  const polyMinusConvex = (poly, clip) => {
    const m = poly.length, n = clip.length;
    const insideC = p => insideConvex(p, clip);
    const insideP = p => {
      let w = 0;
      for (let i = 0; i < m; i++) {
        const A = poly[i], B = poly[(i + 1) % m];
        if (A[1] <= p[1]) { if (B[1] > p[1] && left2(A, B, p) > 0) w++; }
        else if (B[1] <= p[1] && left2(A, B, p) < 0) w--;
      }
      return w !== 0;
    };
    const subX = [], clipX = Array.from({ length: n }, () => []);
    let nX = 0;
    for (let i = 0; i < m; i++) {
      const A = poly[i], B = poly[(i + 1) % m];
      const hs = [];
      for (let j = 0; j < n; j++) {
        const h = segHit(A, B, clip[j], clip[(j + 1) % n]);
        if (!h) continue;
        const t = paramOn(A, B, h);
        if (t <= 1e-5 || t >= 1 - 1e-5) continue;
        hs.push({ t, u: paramOn(clip[j], clip[(j + 1) % n], h), p: h, j, i });
      }
      hs.sort((a, b) => a.t - b.t);
      let inside = insideC(A);
      const kept = [];
      for (const h of hs) {
        const q = kept[kept.length - 1];
        if (q && Math.hypot(q.p[0] - h.p[0], q.p[1] - h.p[1]) < 1e-5) continue;
        h.enter = !inside; inside = !inside;
        kept.push(h); clipX[h.j].push(h);
      }
      subX.push(kept); nX += kept.length;
    }
    for (const arr of clipX) arr.sort((a, b) => a.u - b.u);
    if (nX === 0) {
      if (clip.length && clip.every(p => insideP(p))) return { hole: clip.map(p => p.slice()) };
      return { outer: poly.map(p => p.slice()) };
    }
    const used = new Set(), result = [];
    let sEdge = 0;
    while (sEdge < m && insideC(poly[sEdge])) sEdge++;
    if (sEdge >= m) return { outer: [] };
    let edge = sEdge, cur = poly[edge].slice(), phase = 'sub', cj = 0, cu = 0, guard = 0;
    result.push(cur.slice());
    while (guard++ < (m + n) * 6) {
      if (phase === 'sub') {
        const A = poly[edge], B = poly[(edge + 1) % m];
        const tCur = paramOn(A, B, cur);
        let next = null;
        for (const h of subX[edge]) {
          if (used.has(h.i + ':' + h.t.toFixed(5))) continue;
          if (h.t > tCur + 1e-5) { next = h; break; }
        }
        if (!next) {
          edge = (edge + 1) % m;
          const v = poly[edge];
          if (Math.hypot(v[0] - result[0][0], v[1] - result[0][1]) < 1e-5 && result.length > 2) break;
          if (!insideC(v)) result.push(v.slice());
          cur = v.slice();
          continue;
        }
        used.add(next.i + ':' + next.t.toFixed(5));
        result.push(next.p.slice());
        cur = next.p.slice();
        if (!next.enter) continue;
        phase = 'clip'; cj = next.j; cu = next.u;
      } else {
        const arr = clipX[cj];
        let prev = null;
        for (let k = arr.length - 1; k >= 0; k--) if (arr[k].u < cu - 1e-5) { prev = arr[k]; break; }
        if (prev) {
          used.add(prev.i + ':' + prev.t.toFixed(5));
          result.push(prev.p.slice());
          cur = prev.p.slice();
          edge = prev.i; phase = 'sub';
        } else {
          result.push(clip[cj].slice());
          cur = clip[cj].slice();
          cj = (cj - 1 + n) % n; cu = 1;
        }
      }
    }
    return { outer: dedupe2(result) };
  };
  const asCCW = p => (area2(p) < 0 ? p.slice().reverse() : p.slice());
  const asCW = p => (area2(p) > 0 ? p.slice().reverse() : p.slice());
  // 这块节点板（墙面坐标，原点在节点）要让开的凸区域：本墙的菱形孔，以及垂直墙的孔穿过来的矩形槽
  const plateCuts = (N, pl, poly) => {
    if (!join || !P.baseHole || !baseHoles.length) return [];
    const eps = 0.06;
    let s0 = 0, s1 = 0, y0 = 0, y1 = 0;
    for (const p of poly) {
      s0 = Math.min(s0, p[0]); s1 = Math.max(s1, p[0]);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    }
    const nodeAlong = pl === 0 ? N[0] : N[2], nodeCross = pl === 0 ? N[2] : N[0];
    const cuts = [];
    for (const h of baseHoles) {
      const same = (pl === 0) === (h.dir === 'x');
      if (same) {
        if (Math.abs(nodeCross - h.line * ws) > half + 0.05) continue;
        const cs = h.cx - nodeAlong, cy = h.cy - N[1], Hw = h.hw + eps, Hh = h.hh + eps;
        if (cs + Hw < s0 || cs - Hw > s1 || cy + Hh < y0 || cy - Hh > y1) continue;
        cuts.push([[cs, cy - Hh], [cs + Hw, cy], [cs, cy + Hh], [cs - Hw, cy]]);
      } else {
        const c0 = nodeCross - t / 2, c1 = nodeCross + t / 2;
        if (c1 < h.cx - h.hw || c0 > h.cx + h.hw) continue;
        const xStar = Math.max(c0, Math.min(h.cx, c1));
        const reach = 1 - Math.abs(xStar - h.cx) / h.hw;
        if (reach <= 0.02) continue;
        const yHalf = h.hh * reach + eps;
        const sA = h.line * ws - half - eps - nodeAlong, sB = h.line * ws + half + eps - nodeAlong;
        const yA = h.cy - yHalf - N[1], yB = h.cy + yHalf - N[1];
        if (sB < s0 || sA > s1 || yB < y0 || yA > y1) continue;
        cuts.push([[sA, yA], [sB, yA], [sB, yB], [sA, yB]]);
      }
    }
    return cuts;
  };
  // 节点板几何：轮廓（面内坐标，绕节点逆时针、对节点星形）→ 以节点为中心扇形三角化 → 沿墙法线挤出 ±t/2
  for (const [kk, ds] of plates) {
    const pl = kk % 2, kN = (kk - pl) / 2, [a, bb, n] = unk(kN), N = pos(a, bb, n);
    if (window.__capOn) (AUDIT.plateKeys || (AUDIT.plateKeys = [])).push([pl, N]);   // [DEBUG-j1]
    if (join && N[1] < topY - 1e-4) { if (window.__capOn) (AUDIT.plateSkip || (AUDIT.plateSkip = [])).push(['join', kk, N]); continue; }   // 立板内部的节点板不再往侧面冒出
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
    let poly0 = raw;
    // 侧边切齐（见 clipSide）：轮廓按半平面 s·sg ≤ t/2 裁切（节点在半平面内，裁后仍对节点星形，扇形三角化照旧）
    for (const sg of [1, -1]) {
      if (!clipSide(kN, pl, sg) || window.__noPlateClip) continue;   // [DEBUG-j1] __noPlateClip 为 A/B 实验开关
      const out = [];
      for (let i = 0; i < poly0.length; i++) {
        const A = poly0[i], B = poly0[(i + 1) % poly0.length], da = A[0] * sg - t / 2, db = B[0] * sg - t / 2;
        if (da <= 0) out.push(A);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const f = da / (da - db); out.push([A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f]); }
      }
      poly0 = out;
    }
    const poly = [];
    for (const q of poly0) { const p0 = poly[poly.length - 1]; if (!p0 || Math.hypot(q[0] - p0[0], q[1] - p0[1]) > 1e-6) poly.push(q); }
    while (poly.length > 1 && Math.hypot(poly[0][0] - poly[poly.length - 1][0], poly[0][1] - poly[poly.length - 1][1]) <= 1e-6) poly.pop();
    const m = poly.length;
    if (m < 3) { if (window.__capOn) (AUDIT.plateSkip || (AUDIT.plateSkip = [])).push(['thin', kk, N, poly0.length, m]); continue; }
    const W = (s, y, o) => (pl === 0 ? [N[0] + s, N[1] + y, N[2] + o] : [N[0] + o, N[1] + y, N[2] + s]);
    const wn = pl === 0 ? Z : X;
    const cuts = plateCuts(N, pl, poly);
    // 没碰到孔：照旧以节点为心扇形挤出。碰到孔：逐个扇形三角形减掉孔，只留外侧，切口补上侧壁
    let pieces = null;
    if (cuts.length) {
      pieces = [];
      for (let i = 0; i < m; i++) {
        let tri = [[0, 0], poly[i], poly[(i + 1) % m]];
        if (Math.abs(area2(tri)) < 1e-8) continue;
        if (area2(tri) < 0) tri = tri.slice().reverse();
        let parts = [tri];
        for (const cut of cuts) {
          const next = [];
          for (const part of parts) next.push(...clipOutsideConvex(part, cut));
          parts = next;
        }
        for (const part of parts) pieces.push(part);
      }
    }
    if (window.__capOn) {
      const rings = pieces || [poly];
      const dirs = ds.map(d => [d.s, d.y, d.L, d.e]);
      for (const rg of rings) if (rg.length > 2) AUDIT.plates.push({ pl, N, t, poly: rg, dirs });
    }
    const emitFace = (ring, o) => {
      const mm = ring.length;
      if (mm < 3) return;
      const out = o > 0 ? wn : [-wn[0], -wn[1], -wn[2]], C = W(ring[0][0], ring[0][1], o);
      for (let i = 1; i + 1 < mm; i++) {
        const P1 = W(ring[i][0], ring[i][1], o), P2 = W(ring[i + 1][0], ring[i + 1][1], o);
        const nn = cross(sub(P1, C), sub(P2, C));
        if (Math.abs(nn[0]) + Math.abs(nn[1]) + Math.abs(nn[2]) < 1e-10) continue;
        if (nn[0] * out[0] + nn[1] * out[1] + nn[2] * out[2] < 0) buf.tri(C, P2, P1); else buf.tri(C, P1, P2);
      }
    };
    const emitRim = (q, q2) => {
      const ds2 = q2[0] - q[0], dy2 = q2[1] - q[1];
      if (ds2 * ds2 + dy2 * dy2 < 1e-10) return;
      // 逆时针多边形的边外法线 (dy, −ds)，映射回三维
      buf.quad(W(q[0], q[1], t / 2), W(q2[0], q2[1], t / 2), W(q2[0], q2[1], -t / 2), W(q[0], q[1], -t / 2), pl === 0 ? [dy2, -ds2, 0] : [0, -ds2, dy2]);
    };
    if (!pieces) {
      for (const o of [t / 2, -t / 2]) {
        const out = o > 0 ? wn : [-wn[0], -wn[1], -wn[2]], C = W(0, 0, o);
        for (let i = 0; i < m; i++) {
          const P1 = W(poly[i][0], poly[i][1], o), P2 = W(poly[(i + 1) % m][0], poly[(i + 1) % m][1], o);
          const nn = cross(sub(P1, C), sub(P2, C));
          if (nn[0] * out[0] + nn[1] * out[1] + nn[2] * out[2] < 0) buf.tri(C, P2, P1); else buf.tri(C, P1, P2);
        }
      }
      for (let i = 0; i < m; i++) emitRim(poly[i], poly[(i + 1) % m]);
    } else {
      for (const part of pieces) for (const o of [t / 2, -t / 2]) emitFace(part, o);
      // 只给出现一次的边做侧壁：扇形内部的辐条两边各一次，外轮廓和孔切口只出现一次
      const edges = new Map();
      const qk = v => Math.round(v * 1e5);
      for (const part of pieces) {
        for (let i = 0; i < part.length; i++) {
          const A = part[i], B = part[(i + 1) % part.length];
          const k1 = qk(A[0]) + ',' + qk(A[1]), k2 = qk(B[0]) + ',' + qk(B[1]);
          const key = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
          const e = edges.get(key);
          if (e) e.n++;
          else edges.set(key, { n: 1, A, B });
        }
      }
      for (const e of edges.values()) if (e.n === 1) emitRim(e.A, e.B);
    }
  }
  // 十字针（e-Stage Top connection，专利 FIG.13/14）：自格架节点沿直线到接触点——针身（连接宽）→ 过渡段（渐缩到接触宽）→
  // 接触段（接触宽，长 = 接触边距）→ 沿针轴扎入渗透长度。十字截面与格架对齐（FIG.13c 截面 A-A′）。
  // 节点在某墙面内没有格架时，该向的针板自墙厚起步、在 fadeLen 内放宽到连接宽，针脚不露小平台
  const fadeLen = 0.6;
  const latticeIn = (k, pl, a, bb, n) => (latCnt.get(k * 2 + pl) || 0) > 0
    || (n === 0 && (pl === 0 ? md(bb, qAt(a, bb, 0) || 2) === 0 : md(a, qAt(a, bb, 0) || 2) === 0));
  st.needlesV = 0; st.needlesP = 0; st.needlesFree = 0; st.shiftSum = 0; st.shiftMax = 0;
  const emitted = new Set();                         // 同节点同向的格架同向针几何相同（孤岛周界种子可能密于间距、选中同一根竖杆），只出一份
  for (const nd of needles) {
    const p = points[nd.pi], N = nd.N, kN = k3(nd.a, nd.b, nd.n), u = nd.u, L = nd.L;
    const s1 = Math.max(0, L - taper - cMargin), s2 = Math.max(s1, L - cMargin), s3 = L + pen;
    const dupKey = nd.kind === 'free' ? null : `${kN}|${u.map(v => Math.round(v * 200)).join(',')}`;
    if (dupKey && emitted.has(dupKey)) { pointState[nd.pi] = 'ground'; continue; }
    if (dupKey) emitted.add(dupKey);
    // 板片：{ e 板宽方向, m 板厚方向, s0 起点（沿针轴）, rP / rM 根部朝 +e / −e 的外缘, tR 根部板厚, fl 根部 → 针身的过渡长,
    //        sheared 错切（自由直针：每层水平截面对齐墙向，端面一律水平）}。根部外缘取与之相接的格架截面：
    //   节点板 / 竖杆处 = 边宽/2（被侧边切齐的一侧 = 墙厚/2），该墙面无格架或「+」臂已收到墙厚 = 墙厚/2；之后在 fl 内放宽到 连接宽/2
    const sheets = [];
    const clipR = (pl, sg, base) => (clipSide(kN, pl, sg) ? Math.min(base, t / 2) : base);
    if (nd.kind === 'free') {
      for (const pl of [0, 1]) {
        const eW = pl === 0 ? X : Z, eT = pl === 0 ? Z : X;   // eW 与该墙面 +s 同向
        // 该墙面没有格架，或这面墙只有一根到此为止、已收到墙厚的「+」臂（另一面墙在此连续）：针板自墙厚起步放宽
        const narrowed = latCnt.get(kN * 2 + pl) === 1 && (latCnt.get(kN * 2 + 1 - pl) || 0) >= 2;
        const base = latticeIn(kN, pl, nd.a, nd.b, nd.n) && !narrowed ? connW / 2 : t / 2;
        sheets.push({ e: eW, m: eT, s0: 0, rP: clipR(pl, 1, base), rM: clipR(pl, -1, base), tR: needleT, sheared: true });
      }
    } else if (nd.kind === 'v') {
      for (const pl of [0, 1]) {
        const eW = pl === 0 ? X : Z, eT = pl === 0 ? Z : X;
        const onWall = (pl === 0 ? (nd.b & 1) === 0 : (nd.a & 1) === 0) && latticeIn(kN, pl, nd.a, nd.b, nd.n);
        sheets.push(onWall ? { e: eW, m: eT, s0: trimAt(kN, pl, 0, 1), rP: clipR(pl, 1, b / 2), rM: clipR(pl, -1, b / 2), tR: t }
          : { e: eW, m: eT, s0: 0, rP: t / 2, rM: t / 2, tR: needleT });
      }
    } else {
      // 格架同向斜针：截面垂直针轴的「+」直杆。墙面内的那片板与墙内杆件同宽（边宽）同厚（墙厚），修剪到节点圆角板边缘、
      // 端面恰为节点板的一条边——与格架杆件的接法完全相同；另一片板（垂直墙面）自墙厚起步放宽
      const wn = nd.pl === 0 ? Z : X, nip = nrm(cross(wn, u));
      const inWall = latticeIn(kN, nd.pl, nd.a, nd.b, nd.n);
      sheets.push(inWall ? { e: nip, m: wn, s0: trimAt(kN, nd.pl, nd.pl === 0 ? u[0] : u[2], u[1]), rP: b / 2, rM: b / 2, tR: t }
        : { e: nip, m: wn, s0: 0, rP: t / 2, rM: t / 2, tR: needleT });
      sheets.push({ e: wn, m: nip, s0: 0, rP: t / 2, rM: t / 2, tR: needleT });
    }
    const cv = nd.kind === 'free' ? needleCurve(p, N) : null;
    const at = cv ? cv.posAt : s => [N[0] + u[0] * s, N[1] + u[1] * s, N[2] + u[2] * s];
    const sq = Math.abs(tipW - tipT) < 1e-6;           // 接触段截面为正方形：两片板在此完全重合，只出一份
    let sharedFrom = Infinity;
    sheets.forEach((sh, si) => {
      const ramp = Math.abs(sh.rP - connW / 2) > 1e-6 || Math.abs(sh.rM - connW / 2) > 1e-6 || Math.abs(sh.tR - needleT) > 1e-6;
      const fl = ramp ? Math.min(fadeLen, Math.max(0.05, (s3 - sh.s0) * 0.5)) : 0;
      const prof = s => {                              // → [宽, 厚, 截面中心沿 +e 的侧移]
        const f = fl > 0 ? Math.max(0, Math.min(1, (s - sh.s0) / fl)) : 1;
        let eP = sh.rP + (connW / 2 - sh.rP) * f, eM = sh.rM + (connW / 2 - sh.rM) * f, th = sh.tR + (needleT - sh.tR) * f;
        if (s > s1) {                                  // 过渡段 → 接触段（与根部过渡取窄者）
          const g = s >= s2 ? 1 : (s - s1) / (s2 - s1), hw = (connW + (tipW - connW) * g) / 2, tt = needleT + (tipT - needleT) * g;
          eP = Math.min(eP, hw); eM = Math.min(eM, hw); th = Math.min(th, tt);
        }
        return [eP + eM, th, (eP - eM) / 2];
      };
      const ss = [...new Set([sh.s0, sh.s0 + fl, s1, s2, L, s3, ...(cv ? cv.acc : [])].filter(s => s >= sh.s0 && s <= s3))].sort((x, y) => x - y);
      if (si === 0) sharedFrom = sq ? Math.max(s2, sh.s0 + fl) : Infinity;
      for (let i = 0; i + 1 < ss.length; i++) {
        if (ss[i + 1] - ss[i] < 1e-3) continue;
        if (si > 0 && ss[i] >= Math.max(sharedFrom, sh.s0 + fl) - 1e-9) break;   // 正方形接触段已由第一片板生成
        const [w0, th0, o0] = prof(ss[i]), [w1, th1, o1] = prof(ss[i + 1]);
        // 端面：中间段界保持水平（错切连续）；两个最外端（针脚端 / 接触端）一律垂直针轴——
        // 斜杆上的「水平切端面」会被剪切投影成塌缩细针（导出实体里的毛刺），针脚端的斜切面藏在「+」柱体内
        const nA = i === 0 && sh.s0 === 0 ? u : (sh.sheared ? Y : u),
              nB = sh.sheared && i + 2 < ss.length ? Y : u;
        const reach = (d, w, th) => Math.abs(sh.e[0] * d[0] + sh.e[1] * d[1] + sh.e[2] * d[2]) * w / 2
          + Math.abs(sh.m[0] * d[0] + sh.m[1] * d[1] + sh.m[2] * d[2]) * th / 2;
        const parts = clipNeedle(at(ss[i]), at(ss[i + 1]), h => {
          const dA = h.dir === 'x' ? X : Z, dC = h.dir === 'x' ? Z : X;
          return {
            ra: Math.max(reach(dA, w0, th0), reach(dA, w1, th1)),
            rc: Math.max(reach(dC, w0, th0), reach(dC, w1, th1)),
          };
        });
        for (const [C0, C1, ta, tb] of parts) {
          if (len(sub(C1, C0)) < 0.02) continue;
          const sa = ss[i] + (ss[i + 1] - ss[i]) * ta, sb = ss[i] + (ss[i + 1] - ss[i]) * tb;
          const [wa, tha, oa] = prof(sa), [wb, thb, ob] = prof(sb);
          CAPTAG = 'needle'; CAPINFO = null; bar(buf, C0, C1, sh.e, sh.m, wa, tha, wb, thb, ta < 1e-4 ? nA : u, tb > 1 - 1e-4 ? nB : u, oa, ob);
        }
      }
    });
    if (nd.kind === 'free') st.needlesFree++;
    else {
      if (nd.kind === 'v') st.needlesV++; else st.needlesP++;
      st.shiftSum += nd.shift; st.shiftMax = Math.max(st.shiftMax, nd.shift);
    }
    st.needles++; pointState[nd.pi] = 'ground';
    (st.needleList || (st.needleList = [])).push({ kind: nd.kind, pl: nd.pl, N, C: nd.C, pi: nd.pi, fn: nd.fn });   // 调试 / 验收：针型 / 两端点 / 接触面法线
    // 自检：针轴与接触处表面外法线的夹角（°）——格架同向针取重定义后接触点所在面的法线，自由直针取支撑点法线
    const pn = nd.fn || p.n || [0, -1, 0], ln = Math.hypot(pn[0], pn[1], pn[2]) || 1;
    (st.tipDev || (st.tipDev = [])).push(Math.acos(clamp1(-(u[0] * pn[0] + u[1] * pn[1] + u[2] * pn[2]) / ln)) * 180 / Math.PI);
  }
  // 基础带：底层节点按所在墙线连段。连接底板时不刻缺口，立板升到能盖住最下一排尖角。
  if (bandH > 0) {
    const runs = wallRuns;
    const nh = join ? 0 : Math.max(0, Math.min(P.esNotchH, bandH - 0.3));
    // 连接条用边宽：转角上另一面墙的杆比墙厚宽 (边宽−墙厚)/2，按墙厚做会在立板侧面露出一小块
    const half = join ? Math.max(b, t) / 2 : t / 2;
    for (const r of runs) {
      // 轮廓（墙面坐标 s 向右、y 向上，逆时针）。
      // 栅角：只在贴台面的底角斜切一小截，斜度与菱形格一致，上面仍是直边。
      const x0 = r.s0 * ws - half, x1 = r.s1 * ws + half;
      const chH = 0.6;
      const chamfer = join && P.baseChamfer
        ? Math.min(chH * ws / Math.max(hs, 0.2), Math.max(0, (x1 - x0 - 0.8) / 2))
        : 0;
      let poly;
      if (chamfer > 0.15 && chH < bandH - 0.2) {
        poly = [[x0 + chamfer, 0], [x1 - chamfer, 0], [x1, chH], [x1, bandH], [x0, bandH], [x0, chH]];
      } else {
        poly = [[x0, 0]];
        const vs = mid ? r.q >> 1 : r.q, vsw = vs * ws;
        const nw = Math.min(0.6 * vsw, vsw - t - 0.3);
        if (nh > 0.1 && nw > 0.3) {
          for (let s = Math.ceil(r.s0 / vs) * vs; s + vs <= r.s1 + 1e-9; s += vs) {
            const c = (s + vs / 2) * ws;
            if (c - nw / 2 <= x0 + 0.1 || c + nw / 2 >= x1 - 0.1) continue;
            poly.push([c - nw / 2, 0], [c, nh], [c + nw / 2, 0]);
          }
        }
        poly.push([x1, 0], [x1, bandH], [x0, bandH]);
      }
      // 底板开孔：本墙菱形，再加上垂直墙的孔从侧面穿过来的槽。
      // 槽若只收到外轮廓里面 0.08，底板端头会在孔里留下一截薄壁；压到边上的槽改从外轮廓咬掉。
      // 叠在一起的区域先并成一块，再决定当孔还是咬边，避免两套轮廓交叉把孔填实。
      let shapes = skirtHoles(r).map(h => {
        const cy = h.cy - groundY;
        return asCCW([[h.cx, cy + h.hh], [h.cx + h.hw, cy], [h.cx, cy - h.hh], [h.cx - h.hw, cy]]);
      });
      if (baseHoles.length) {
        const eps = 0.05;
        for (const h of baseHoles) {
          if (h.dir === r.dir) continue;
          const c0 = r.line * ws - half, c1 = r.line * ws + half;
          if (c1 < h.cx - h.hw || c0 > h.cx + h.hw) continue;
          const xStar = Math.max(c0, Math.min(h.cx, c1));
          const reach = 1 - Math.abs(xStar - h.cx) / h.hw;
          if (reach <= 0.2) continue;   // 与交点仅擦边（交叠 < 0.2 孔径）不挖：否则在板面留下无意义的扁缝
          const yHalf = h.hh * reach + eps;
          const s0 = h.line * ws - half - eps, s1 = h.line * ws + half + eps;
          const y0 = (h.cy - groundY) - yHalf, y1 = (h.cy - groundY) + yHalf;
          if (s1 - s0 < 0.12 || y1 - y0 < 0.12) continue;
          let acc = asCCW([[s0, y1], [s1, y1], [s1, y0], [s0, y0]]);
          const rest = [];
          for (const s of shapes) {
            const u = unionConvex(s, acc);
            if (u && u.length >= 3) acc = u;
            else rest.push(s);
          }
          rest.push(acc);
          shapes = rest;
        }
      }
      const holes = [];
      for (const s of shapes) {
        if (!s || s.length < 3 || Math.abs(area2(s)) < 1e-6) continue;
        const cut = polyMinusConvex(poly, asCCW(s));
        if (cut.hole) holes.push(asCW(cut.hole));
        else if (cut.outer && cut.outer.length >= 3) poly = cut.outer;
      }
      if (poly.length < 3) continue;
      if (area2(poly) < 0) poly.reverse();
      const verts = poly.slice();
      for (const h of holes) for (const p of h) verts.push(p);
      const toW = (s, y, o) => (r.dir === 'x' ? [s, groundY + y, r.line * ws + o] : [r.line * ws + o, groundY + y, s]);
      const tris = THREE.ShapeUtils.triangulateShape(
        poly.map(([s, y]) => new THREE.Vector2(s, y)),
        holes.map(h => h.map(([s, y]) => new THREE.Vector2(s, y))),
      );
      const wn = r.dir === 'x' ? Z : X;
      for (const [i, j, k] of tris) {
        for (const o of [half, -half]) {
          const P1 = toW(...verts[i], o), P2 = toW(...verts[j], o), P3 = toW(...verts[k], o);
          const out = o > 0 ? wn : [-wn[0], -wn[1], -wn[2]];
          const nn = cross(sub(P2, P1), sub(P3, P1));
          if (nn[0] * out[0] + nn[1] * out[1] + nn[2] * out[2] < 0) buf.tri(P1, P3, P2); else buf.tri(P1, P2, P3);
        }
      }
      const emitLoop = loop => {
        const area = loop.reduce((acc, p1, k) => { const p2 = loop[(k + 1) % loop.length]; return acc + p1[0] * p2[1] - p2[0] * p1[1]; }, 0);
        const sgn = area > 0 ? 1 : -1;
        for (let i = 0; i < loop.length; i++) {
          const q = loop[i], q2 = loop[(i + 1) % loop.length];
          const a1 = toW(...q, half), a2 = toW(...q2, half), a3 = toW(...q2, -half), a4 = toW(...q, -half);
          const o2 = [(q2[1] - q[1]) * sgn, -(q2[0] - q[0]) * sgn];
          buf.quad(a1, a2, a3, a4, r.dir === 'x' ? [o2[0], o2[1], 0] : [0, o2[1], o2[0]]);
        }
      };
      emitLoop(poly);
      for (const h of holes) emitLoop(h);
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

  /* ---------- 7. 兜底：连不上格架的点 ----------
     短小支撑样式为「支撑塔」时，正下方有朝上表面的点用「十字贴面短连接」（gusset）直接连过去；
     形态参考 e-Stage 手册的 close-to-part 连接（§5.2.6 / FIG.13 的直连接），几何为本项目自研：
     十字截面（连接宽 × 针板厚，水平截面恒为「+」）+ 两端渐缩到接触宽 + 渗透扎入——
     不做专利图中的「根部喇叭锥」，接触点保持细，省树脂、好折断。
     放不下的点仍可绕到平台，但不再往模型上种树状锚点。
     短小支撑样式为「树状细尖」时，整段仍交给树状支撑。 */
  const emitGusset = (gBuf, A, B) => {
    const ax = [A.x, A.y, A.z], bx = [B.x, B.y, B.z];
    const d = sub(bx, ax), L = len(d);
    if (L < 0.35) return false;                                // 更短的间隙交给树状侧微柱处理
    const u = [d[0] / L, d[1] / L, d[2] / L];
    const cm = Math.min(cMargin, L * 0.24);                    // 接触段（表面外的细直段）
    let tp = Math.min(taper, Math.max(0.06, L * 0.22));        // 过渡段（接触宽 → 连接宽）
    if (cm + tp > L * 0.46) tp = Math.max(0, L * 0.46 - cm);
    const at = s => [ax[0] + u[0] * s, ax[1] + u[1] * s, ax[2] + u[2] * s];
    const prof = s => {                                        // 两端 g=0（接触宽）、中段 g=1（连接宽）
      const g = Math.min(1, Math.max(0, (s - cm) / (tp || 1e-9)), Math.max(0, (L - cm - s) / (tp || 1e-9)));
      return [tipW + (connW - tipW) * g, tipT + (needleT - tipT) * g];
    };
    const KS = [];
    for (const s of [-pen, 0, cm, cm + tp, L - cm - tp, L - cm, L, L + pen]) if (!KS.length || s > KS[KS.length - 1] + 1e-9) KS.push(s);
    const emit = (e, m, s0, s1) => {
      const list = [s0, ...KS.filter(s => s > s0 + 1e-9 && s < s1 - 1e-9), s1];
      for (let i = 0; i + 1 < list.length; i++) {
        const [w0, t0] = prof(list[i]), [w1, t1] = prof(list[i + 1]);
        // 端面：中间段界水平（错切连续），最外两端垂直轴——斜杆上水平切端面会被剪切投影成塌缩细针
        const nA = Math.abs(list[i] + pen) < 1e-6 ? u : Y;
        const nB = Math.abs(list[i + 1] - (L + pen)) < 1e-6 ? u : Y;
        CAPTAG = 'gusset'; CAPINFO = null; bar(gBuf, at(list[i]), at(list[i + 1]), e, m, w0, t0, w1, t1, nA, nB);
      }
    };
    emit(X, Z, -pen, L + pen);                                 // 第一片：全段（含两端渗透）
    // 接触段截面为正方形时两片完全重合，第二片只补中段（少一份重合几何）；否则两片各自全段
    if (Math.abs(tipW - tipT) < 1e-6) emit(Z, X, cm, L - cm); else emit(Z, X, -pen, L + pen);
    return true;
  };
  let geomTreeG = null, geomTreeA = null;
  // 连接底板时兜底树状的地面是板顶面：落地柱与底座落在板上，不再穿过底板、柱顶从板面露头
  const treeCtx = join ? { ...ctx, groundY: topY } : ctx;
  if (fallbackIdx.length && P.shortSup && P.shortKind === 'tower') {
    const plates = [];
    const rest = [];
    const rTip = Math.max(0.12, (P.tipD || 0.4) / 2);
    const tiltMax = Math.PI / 2 - Math.max(10, Math.min(80, P.selfAngle)) * Math.PI / 180;
    const gBuf = new TriBuf();
    for (const pi of fallbackIdx) {
      const s = bridgeToSurface(ctx.bvh, ctx.faces, points[pi], {
        rTip, maxLen: 12, pen: P.pen, protNear: ctx.protNear, sinkTop: true, tiltMax,
      });
      if (s && emitGusset(gBuf, s.lower, s.upper)) {
        pointState[pi] = 'mesh'; st.anchors++; st.plates++;
        (st.gussetList || (st.gussetList = [])).push({ A: s.lower, B: s.upper });   // 调试 / 验收：落点与支撑点
      } else rest.push(pi);
    }
    const gg = gBuf.geometry();
    if (gg) plates.push(gg);
    if (rest.length) {
      const tr = buildBranchingTree(treeCtx, rest.map(i => points[i]), P);
      geomTreeG = tr.geomGround;
      if (tr.geomAnchor) plates.push(tr.geomAnchor);
      rest.forEach((pi, k) => { pointState[pi] = tr.pointState[k]; });
      for (const k of ['ground', 'anchors', 'shortAnchors', 'micro', 'plates', 'noHead', 'unroutable']) st[k] += tr.stats[k] || 0;
    }
    geomTreeA = plates.length ? mergeParts(plates) : null;
    st.fallback = fallbackIdx.length;
  } else if (fallbackIdx.length) {
    const tr = buildBranchingTree(treeCtx, fallbackIdx.map(i => points[i]), P);
    geomTreeG = tr.geomGround; geomTreeA = tr.geomAnchor;
    fallbackIdx.forEach((pi, k) => { pointState[pi] = tr.pointState[k]; });
    st.fallback = fallbackIdx.length;
    for (const k of ['ground', 'anchors', 'shortAnchors', 'micro', 'plates', 'noHead', 'unroutable']) st[k] = tr.stats[k] || 0;
  }
  const towerG = buf.geometry();
  const groundParts = [towerG, geomTreeG].filter(Boolean);
  return {
    geomGround: groundParts.length > 1 ? mergeParts(groundParts) : groundParts[0] || null,
    geomAnchor: geomTreeA,
    stats: st, pointState,
  };
}
