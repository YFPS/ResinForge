/* ================================================================
   树状支撑（普通模式）—— PrusaSlicer branching tree 的 JS 移植
   出处：PrusaSlicer src/libslic3r/BranchingTree/BranchingTree.cpp（build_tree / find_merge_pt）、
        SLA/SupportTreeBranching.cpp（BranchingTreeBuilder：add_merger / add_bridge / add_ground_bridge /
        add_mesh_bridge / suggest_avoidance / get_radius）、SLA/SupportTreeMesher.cpp（Head / DiffBridge / Pedestal 网格）
   流程：
   1. 支撑头：按被托面法线放置 PrusaSlicer 支撑头（前端球 r_pin 扎入 pen → 切线锥 → 后端球 r_back），
      方向钳制进临界锥，碰撞则锥内换向；全部方向碰撞且下方空间狭窄 → 微型短柱，否则记为「头部无法放置」
   2. 建树：后端球心作为叶节点，按高度从高到低出队，候选依次尝试（碰撞检测通过即连接）：
      ① 合并：两节点各向对方发出不陡于临界角的下行射线，交点即合并点 → 新结点重新入队；
         合并点恰为下方节点时直接桥接（该节点尚有空槽）
      ② 落模型：竖直下方被模型挡住且允许短小支撑、分支负载 ≤ 模型最大负载 → 倒置支撑头锚入可承载表面
      ③ 落地：距底座 > 最大分支长 → 先下行一段（suggest_avoidance，竖直优先、碰撞则锥内斜行）生成新结点再参与合并；
              否则地面柱（竖直优先，碰撞则「斜段 + 竖直」两段式避让）+ 底座锥台
      ④ 竖直方向通畅却落地失败时，再试锥内斜向的模型锚点
   3. 剪枝：未能落地/落模型的子树整体丢弃（PrusaSlicer discard_subtree），不留悬空几何
   分支半径随负载（自叶节点累计的最长路径长）加粗：r = clamp(r_min, r_max, 0.05·加宽系数·负载)（get_radius）
   与 PrusaSlicer 的差异：竖直落地路径通畅时优先落地，不因下方斜向有模型面就锚到模型上（少在模型表面留疤）
================================================================ */
import { raycast, capsuleClear } from './collide.js';
import { pill, frustum, prusaHead, placeTip, tipCone, downFan, groundRoute, microPost, mergeParts } from './supportKit.js';

const LEAF = 0, JUNC = 1;
const GROUND = -2, MESH = -3;
const WIDENING_SCALE = 0.05;              // PrusaSlicer BranchingTreeBuilder::WIDENING_SCALE
const DEAD = 8 * Math.PI / 180;           // 接触端方向死区（近水平面不倾斜）
const MAX_MERGE_CANDS = 24;               // 每节点最多尝试的合并候选（PrusaSlicer 为 K 近邻逐步加倍）

/* 最大堆（按 key 降序出队），出队时惰性跳过已失效节点 */
class MaxHeap {
  constructor(key) { this.a = []; this.key = key; }
  get size() { return this.a.length; }
  push(v) {
    const a = this.a; a.push(v);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.key(a[p]) >= this.key(a[i])) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && this.key(a[l]) > this.key(a[m])) m = l;
        if (r < a.length && this.key(a[r]) > this.key(a[m])) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/* PrusaSlicer find_merge_pt：A、B 各向对方（水平投影方向）发出下行射线，射线与水平面夹角至少为临界角 crit，
   两射线在 AB 所在竖直平面内的交点即合并点；交点不在 A 的前方（t<0）时返回 null。
   B 位于 A 的支撑锥内时交点恰为 B（调用方据此改走直接桥接）。 */
export function findMergePt(A, B, crit) {
  const dx = B.x - A.x, dz = B.z - A.z;
  const hxy = Math.hypot(dx, dz);
  if (hxy < 1e-6) return B.y <= A.y ? { x: B.x, y: B.y, z: B.z } : { x: A.x, y: A.y, z: A.z };
  const bx = hxy, by = B.y - A.y;
  const bsq = bx * bx + by * by;
  let sa = bsq > 1e-12 ? (by * Math.abs(by)) / bsq : 0;   // 带符号的 sin²（A→B）
  let sb = -sa;                                             // B→A
  const sc = Math.sin(crit), s2c = -sc * sc;
  sa = Math.min(sa, s2c); sb = Math.min(sb, s2c);           // 饱和：至少向下 crit
  const s2a = Math.abs(sa), s2b = Math.abs(sb);
  const Da0 = Math.sqrt(1 - s2a), Da1 = -Math.sqrt(s2a);
  const Db0 = -Math.sqrt(1 - s2b), Db1 = -Math.sqrt(s2b);
  const den = Da0 * Db1 - Da1 * Db0;
  if (Math.abs(den) < 1e-12) return null;
  const t1 = (Db1 * bx - by * Db0) / den;
  if (t1 < 0) return null;
  const mx = t1 * Da0, my = t1 * Da1;
  return { x: A.x + dx / hxy * mx, y: A.y + my, z: A.z + dz / hxy * mx };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/* ctx：{ bvh, groundY, faces, protNear(pt) }；points：支撑点 [{x,y,z,n}]；P：参数快照
   返回 { geomGround, geomAnchor, stats, pointState } */
export function buildBranchingTree(ctx, points, P) {
  const { bvh, groundY, faces, protNear } = ctx;
  const rPin = Math.max(0.05, P.tipD / 2);
  const rMin = Math.max(rPin * 1.2, P.midD / 2);
  const rMax = Math.max(rMin, P.maxBranchD / 2);
  const pen = Math.min(Math.max(0, P.pen), rPin * 2);
  const cc = Math.max(rMin - rPin + 0.05, P.headLen);        // 前后球心距（PrusaSlicer r_pin + width + r_back）
  const crit = Math.max(10, Math.min(80, P.selfAngle)) * Math.PI / 180;   // 临界角（从水平测量，PrusaSlicer bridge_slope）
  const tiltMax = Math.PI / 2 - crit;                          // 杆件最大倾斜（从竖直）
  const tc = tipCone(P);                                       // 支撑头朝向（接触朝向 / 接触最大倾角）
  const baseR = Math.max(rMax, P.baseD / 2);
  const baseTop = groundY + Math.max(0, P.baseH);
  const gap = 0.1;
  const SEG = 16;
  const headLen = rPin - pen + cc;                             // 接触点 → 后端球心
  const headSpec = { tipR: rPin, backR: rMin, len: headLen, skip: 2.2 * rPin + 0.2, gap };
  const rOf = nd => Math.max(nd.Rmin, Math.min(rMax, WIDENING_SCALE * P.widening * nd.w));
  const clearSeg = (a, b, r) => capsuleClear(bvh, a.x, a.y, a.z, b.x, b.y, b.z, r + gap);
  // 底座锥台 footprint 净空：自板面向上射线（中心查满高，0.5/0.9 倍底半径圆周查对应锥台高度）在底座高度内不碰模型。
  // 不用球形采样：顶面处的采样球会凸出顶面一个半径，模型底面贴近底座时（如抬高 1.2mm）必误判
  const padRing = [[0, 0, 1]];
  for (const f of [0.5, 0.9]) for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; padRing.push([Math.cos(a) * f, Math.sin(a) * f, Math.max(0.05, (1 - f) / (1 - Math.min(0.99, rMin / baseR)))]); }
  const footOK = g => {
    if (P.baseH <= 0) return true;
    for (const [cx, cz, hf] of padRing) {
      if (raycast(bvh, g.x + cx * baseR, groundY + 0.01, g.z + cz * baseR, 0, 1, 0, 0, Math.min(1, hf) * (baseTop - groundY) - 0.02)) return false;
    }
    return true;
  };

  const st = { points: points.length, heads: 0, ground: 0, anchors: 0, heavy: 0, micro: 0, noHead: 0, unroutable: 0, merges: 0, bridges: 0, avoid: 0 };
  const pointState = new Array(points.length).fill('');
  const ground = [], anchorG = [];

  /* ---------- 1. 支撑头 ---------- */
  const nodes = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    // 窄间隙（放不下支撑头 + 后端球）优先微型短柱（PrusaSlicer 的 small pillar 情形）；
    // 微型短柱下端扎在模型上，属于「落模型」——关闭短小支撑时禁用
    const mp = P.shortSup && microPost(bvh, faces, p, rMin, headLen + rMin + 0.3, protNear, SEG);
    if (mp) { anchorG.push(mp); st.micro++; pointState[i] = 'micro'; continue; }
    // 低点：接触点离底座顶面容不下「支撑头 + 后端球」（模型抬高过小）→ 底座直连短柱：竖直药丸自底座顶面升到接触点
    // （前端扎入 pen），下接底座锥台——对应 PrusaSlicer 支撑头直接落在 pad 上的情形；否则支撑头会扎穿底座
    if (p.y - baseTop < headLen + rMin) {
      const top = p.y + pen - rPin;
      // 底座紧贴模型下方（相当于 pad），只要求底座本体不与模型相交；短柱就在接触点正下方，不做净距检测
      if (top - baseTop > 0.05 && footOK({ x: p.x, y: baseTop, z: p.z })) {
        ground.push(pill({ x: p.x, y: baseTop, z: p.z }, { x: p.x, y: top, z: p.z }, rMin, rPin, SEG));
        if (P.baseH > 0) ground.push(frustum({ x: p.x, y: groundY, z: p.z }, { x: p.x, y: baseTop, z: p.z }, baseR, rMin, 24));
        st.ground++; pointState[i] = 'ground';
        continue;
      }
    }
    const h = placeTip(bvh, p, p.n, -1, tc.tilt, DEAD, headSpec, tc.fixed);
    if (h) {
      nodes.push({ x: h.back.x, y: h.back.y, z: h.back.z, Rmin: rMin, w: 0, type: LEAF, alive: true, parent: -1, kids: 0, pt: i, head: h });
      st.heads++;
      continue;
    }
    // 锥内全部方向碰撞：放宽间隙再试一次微型短柱
    const mp2 = P.shortSup && microPost(bvh, faces, p, rMin, headLen + rMin + 1.5, protNear, SEG);
    if (mp2) { anchorG.push(mp2); st.micro++; pointState[i] = 'micro'; continue; }
    st.noHead++; pointState[i] = 'nohead';
  }

  /* ---------- 2. 建树 ---------- */
  const heap = new MaxHeap(i => nodes[i].y);
  for (let i = 0; i < nodes.length; i++) heap.push(i);
  const edges = [];   // { a, b, ra, rb }：节点 a → 下游节点 b

  // 模型锚点候选：沿下行方向扇射线，命中可承载面（法线 y ≥ 0.5）且远离保护面
  const meshCands = (nd, fan) => {
    const out = [];
    for (const d of fan) {
      const hit = raycast(bvh, nd.x, nd.y, nd.z, d[0], d[1], d[2], 0.05, 80);
      if (!hit) continue;
      const f = hit.f, n = [faces.nrm[f * 3], faces.nrm[f * 3 + 1], faces.nrm[f * 3 + 2]];
      if (n[1] < 0.5) continue;
      const pt = { x: nd.x + d[0] * hit.t, y: nd.y + d[1] * hit.t, z: nd.z + d[2] * hit.t };
      if (protNear && protNear(pt)) continue;
      out.push({ pt, n, d: hit.t });
    }
    return out.sort((a, b) => a.d - b.d);
  };
  const tryMesh = (nd, rN, c) => {
    const a = placeTip(bvh, c.pt, c.n, +1, tiltMax, DEAD, { tipR: rPin, backR: Math.max(rMin, rN), len: rPin - pen + cc, skip: headSpec.skip, gap });
    if (!a) return false;
    const dy = a.back.y - nd.y;
    if (dy > -0.3) return false;                                                    // 锚头后端须在节点下方
    if (Math.hypot(a.back.x - nd.x, a.back.z - nd.z) > -dy * Math.tan(tiltMax) + 1e-6) return false;   // 分支不陡于临界角
    const rA = Math.max(rN, rOf({ Rmin: nd.Rmin, w: nd.w + dist(nd, a.back) }));
    if (!clearSeg(nd, a.back, rA)) return false;
    nd.parent = MESH; nd.anchor = { a, rA, rN };
    return true;
  };
  // suggest_avoidance：下行一段，优先选「段净空且其后竖直落地也净空」的方向，其次只要段净空；
  // 被挡住时依次缩短段长（L、L/2、L/4）再搜
  const descend = (nd, r, L0) => {
    for (const f of [1, 0.5, 0.25]) {
      const L = Math.min(L0 * f, nd.y - baseTop - 2 * r);
      if (L < 0.5) break;
      let fallback = null;
      for (const d of downFan(tiltMax)) {
        const q = { x: nd.x + d[0] * L, y: nd.y + d[1] * L, z: nd.z + d[2] * L };
        if (q.y < baseTop + 2 * r || !clearSeg(nd, q, r)) continue;
        if (clearSeg(q, { x: q.x, y: baseTop, z: q.z }, r)) return q;
        if (!fallback) fallback = q;
      }
      if (fallback) return fallback;
    }
    return null;
  };

  while (heap.size) {
    const id = heap.pop();
    const nd = nodes[id];
    if (!nd.alive) continue;
    nd.alive = false;                     // mark_unreachable
    const rN = rOf(nd);
    const dBed = nd.y - baseTop;
    let routed = false;

    // ① 合并 / 桥接候选（分支距离 < 落地距离，升序）
    const cands = [];
    const span = P.maxBranchLen * 1.5;
    for (let j = 0; j < nodes.length; j++) {
      const o = nodes[j];
      if (!o.alive || j === id) continue;
      if (Math.abs(o.x - nd.x) > span || Math.abs(o.z - nd.z) > span || o.y > nd.y + P.maxBranchLen) continue;
      const mp = findMergePt(nd, o, crit);
      if (!mp || mp.y < baseTop + 2 * Math.max(nd.Rmin, o.Rmin)) continue;
      const dn = dist(nd, mp), dO = dist(o, mp);
      if (dn > P.maxBranchLen || dO > P.maxBranchLen || dn >= dBed) continue;
      cands.push({ j, mp, dn, dO });
    }
    cands.sort((a, b) => a.dn - b.dn);
    for (let k = 0; k < cands.length && k < MAX_MERGE_CANDS && !routed; k++) {
      const c = cands[k], o = nodes[c.j];
      if (c.dO > 1e-4 && c.dn > 1e-4) {
        const m = { x: c.mp.x, y: c.mp.y, z: c.mp.z, Rmin: Math.max(nd.Rmin, o.Rmin), w: Math.max(nd.w, o.w) + Math.max(c.dn, c.dO), type: JUNC, alive: true, parent: -1, kids: 2 };
        const rM = rOf(m), rO = rOf(o);
        if (!clearSeg(nd, m, Math.max(rN, rM)) || !clearSeg(o, m, Math.max(rO, rM))) continue;
        const mi = nodes.push(m) - 1;
        edges.push({ a: id, b: mi, ra: rN, rb: rM }, { a: c.j, b: mi, ra: rO, rb: rM });
        nd.parent = mi; o.parent = mi; o.alive = false;
        heap.push(mi); st.merges++; routed = true;
      } else if (o.y < nd.y && o.kids < 2) {
        if (!clearSeg(nd, o, Math.max(rN, rOf(o)))) continue;
        o.w = Math.max(o.w, nd.w + c.dn);
        edges.push({ a: id, b: c.j, ra: rN, rb: rOf(o) });
        nd.parent = c.j; o.kids++; st.bridges++; routed = true;
      }
    }
    if (routed) continue;

    // ② 竖直下方被模型挡住 → 优先锚入模型（短小支撑）；下方表面近到放不下锚头时改用短锚（竖直短粗杆直接扎入）——
    //    合并点/下行点可能恰好落在下方表面上方 1mm 内（实测环面结 0.84mm），不兜底会让汇入的整棵子树被剪掉
    const allowMesh = P.shortSup && nd.w <= P.maxWeightOnModel;
    const vHit = raycast(bvh, nd.x, nd.y, nd.z, 0, -1, 0, 0.05, dBed);
    const anchorVertical = () => {
      for (const c of meshCands(nd, downFan(tiltMax, [0.33], 8))) if (tryMesh(nd, rN, c)) return true;
      if (vHit.t <= headLen + rMin + 0.6 && faces.nrm[vHit.f * 3 + 1] >= 0.3) {
        const pt = { x: nd.x, y: nd.y - vHit.t, z: nd.z };
        if (!protNear || !protNear(pt)) {
          const rE = Math.max(0.15, Math.min(rN, (vHit.t + 0.1) * 0.5));
          nd.parent = MESH; nd.shortAnchor = { y: Math.min(nd.y, pt.y - 0.1 + rE), rE, rN };
          return true;
        }
      }
      return false;
    };
    if (vHit && allowMesh && anchorVertical()) { st.anchors++; continue; }

    // ③ 落地：高处先下行一段生成新结点（树逐级汇聚），近地直接建地面柱
    if (dBed > P.maxBranchLen) {
      const q = descend(nd, rN, P.maxBranchLen);
      if (q) {
        const m = { x: q.x, y: q.y, z: q.z, Rmin: nd.Rmin, w: nd.w + dist(nd, q), type: JUNC, alive: true, parent: -1, kids: 1 };
        const mi = nodes.push(m) - 1;
        edges.push({ a: id, b: mi, ra: rN, rb: rOf(m) });
        nd.parent = mi; heap.push(mi); st.avoid++; routed = true;
      }
    } else {
      const rG = rOf({ Rmin: nd.Rmin, w: nd.w + dBed });
      const route = groundRoute(bvh, nd, Math.max(rN, rG), baseTop, tiltMax, P.maxBridgeLen, gap, footOK);
      if (route) { nd.parent = GROUND; nd.route = route; nd.rG = rG; st.ground++; routed = true; }
    }
    if (routed) continue;

    // ④ 仍未路由：锥内斜向模型锚点
    if (allowMesh) {
      for (const c of meshCands(nd, downFan(tiltMax, [0.5, 1], 8))) if ((routed = tryMesh(nd, rN, c))) break;
      if (routed) { st.anchors++; continue; }
    }
    // ⑤ 兜底：负载已超「模型最大负载」却无路落地 → 放宽负载限制锚入模型。
    //    PrusaSlicer 此时直接丢弃（max_weight_on_model_support），但被剪掉的是汇入的整棵子树（实测构造用例 15 个点悬空），
    //    锚一根粗些的支撑在模型上代价远小于悬空
    if (P.shortSup && !allowMesh) {
      routed = (vHit && anchorVertical());
      if (!routed) for (const c of meshCands(nd, downFan(tiltMax, [0.5, 1], 8))) if ((routed = tryMesh(nd, rN, c))) break;
      if (routed) { st.anchors++; st.heavy++; continue; }
    }
    nd.dead = true;
    nd.why = { leaf: nd.type === LEAF, y: +nd.y.toFixed(2), w: +nd.w.toFixed(1), dBed: +dBed.toFixed(1), vHit: vHit ? +vHit.t.toFixed(2) : null, allowMesh, mergeCands: cands.length };
  }

  /* ---------- 3. 剪枝：沿 parent 链能到达地面/模型的节点才有效 ---------- */
  const valid = new Int8Array(nodes.length);   // 0 未知 / 1 有效 / -1 无效
  const isValid = i => {
    const chain = [];
    let v = i;
    while (v >= 0 && valid[v] === 0) { chain.push(v); v = nodes[v].parent; }
    const ok = v >= 0 ? valid[v] === 1 : (v === GROUND || v === MESH);
    for (const c of chain) valid[c] = ok ? 1 : -1;
    return ok;
  };

  /* ---------- 4. 几何（按整棵树的落点分组着色：落地 = 绿 / 落模型 = 琥珀） ---------- */
  const rootOf = new Int32Array(nodes.length).fill(0);   // 0 未知 / GROUND / MESH
  const rootType = i => {
    if (rootOf[i]) return rootOf[i];
    let v = i; while (nodes[v].parent >= 0) v = nodes[v].parent;
    return (rootOf[i] = nodes[v].parent);
  };
  const bucket = i => (rootType(i) === MESH ? anchorG : ground);
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (nd.type !== LEAF) continue;
    if (!isValid(i)) { st.unroutable++; pointState[nd.pt] = 'unroutable'; continue; }
    bucket(i).push(prusaHead(nd.head.back, nd.head.dir, rMin, rPin, cc, SEG));
    pointState[nd.pt] = rootType(i) === MESH ? 'mesh' : 'ground';
  }
  for (const e of edges) {
    if (!isValid(e.a)) continue;
    bucket(e.a).push(pill(nodes[e.a], nodes[e.b], e.ra, e.rb, SEG));
  }
  for (let i = 0; i < nodes.length; i++) {
    const nd = nodes[i];
    if (!isValid(i)) continue;
    if (nd.parent === GROUND) {
      const rt = nd.route, rN = rOf(nd);
      for (let s = 0; s + 1 < rt.length; s++) ground.push(pill(rt[s], rt[s + 1], s === 0 ? rN : nd.rG, nd.rG, SEG));
      const g = rt[rt.length - 1];
      if (P.baseH > 0) ground.push(frustum({ x: g.x, y: groundY, z: g.z }, { x: g.x, y: baseTop, z: g.z }, baseR, nd.rG, 24));
    } else if (nd.parent === MESH && nd.shortAnchor) {
      const { y, rE, rN } = nd.shortAnchor;   // 短锚：节点竖直扎入正下方表面 0.1
      anchorG.push(pill({ x: nd.x, y, z: nd.z }, nd, rE, rN, SEG));
    } else if (nd.parent === MESH) {
      const { a, rA, rN } = nd.anchor;
      anchorG.push(pill(nd, a.back, rN, rA, SEG));
      anchorG.push(prusaHead(a.back, a.dir, rA, rPin, cc, SEG));
    }
  }
  return {
    geomGround: ground.length ? mergeParts(ground) : null,
    geomAnchor: anchorG.length ? mergeParts(anchorG) : null,
    stats: st, pointState,
    dead: nodes.filter(n => n.dead).map(n => n.why),   // 无法路由的节点诊断（层检查器 / 调试用）
  };
}
