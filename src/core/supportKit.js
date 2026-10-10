/* ================================================================
   支撑构件库（树状支撑 / e-Stage 支撑塔共用）
   - 几何：轴对称旋转体统一构造（每个构件都是单一封闭流形）
       · 药丸 pill：两端球 + 外公切锥（PrusaSlicer DiffBridge / Head 的 robe 构造），分支、立柱共用
       · 支撑头 prusaHead：后端球 r_back + 切线锥 + 前端球 r_pin（SupportTreeMesher get_mesh(Head)）
       · 锥台 frustum：底座 Pedestal
   - 方向：接触端方向候选——法线钳制进临界锥（PrusaSlicer 将 polar 饱和到锥面，而非超角即放弃倾斜）
   - 避让：接触端放置 placeTip / 落地路径 groundRoute，一律按胶囊体净空判定（collide.js）
================================================================ */
import * as THREE from 'three';
import { raycast, capsuleClear, coneClear, pointDist } from './collide.js';

const UP = new THREE.Vector3(0, 1, 0);

/* ---------- 几何 ---------- */
/* 旋转体：profile = [[r, z], ...] 自下而上、首尾 r=0 封口；局部 +Y 对齐 dir，z=0 端平移到 p0 */
export function lathe(profile, seg, p0, dir) {
  const pts = profile.map(([r, z]) => new THREE.Vector2(Math.max(r, 0), z));
  const g = new THREE.LatheGeometry(pts, seg);
  if (dir) g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir));
  g.translate(p0.x, p0.y, p0.z);
  return g;
}

/* 药丸轮廓：球1（心 z=0，半径 R1）+ 球2（心 z=L，半径 R2）+ 外公切锥。
   切点角 φ：sinφ = (R1−R2)/L（PrusaSlicer get_mesh(Head) 的 phi 同一关系）；一球包含另一球时退化为大球 */
export function pillProfile(R1, R2, L, n = 6) {
  const out = [];
  if (L <= Math.abs(R1 - R2) + 1e-6) {
    const R = Math.max(R1, R2), zc = R1 >= R2 ? 0 : L;
    for (let k = 0; k <= 2 * n; k++) { const t = -Math.PI / 2 + Math.PI * k / (2 * n); out.push([R * Math.cos(t), zc + R * Math.sin(t)]); }
    return out;
  }
  const phi = Math.asin((R1 - R2) / L);
  const n1 = Math.max(2, Math.round(n * (phi + Math.PI / 2) / (Math.PI / 2)));
  for (let k = 0; k <= n1; k++) { const t = -Math.PI / 2 + (phi + Math.PI / 2) * k / n1; out.push([R1 * Math.cos(t), R1 * Math.sin(t)]); }
  const n2 = Math.max(2, Math.round(n * (Math.PI / 2 - phi) / (Math.PI / 2)));
  for (let k = 0; k <= n2; k++) { const t = phi + (Math.PI / 2 - phi) * k / n2; out.push([R2 * Math.cos(t), L + R2 * Math.sin(t)]); }
  return out;
}

const vec = (a, b) => new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z);

/* 药丸构件：a 端半径 ra → b 端半径 rb（分支 / 立柱 / 格架管） */
export function pill(a, b, ra, rb, seg = 16) {
  const d = vec(a, b), L = d.length();
  if (L < 1e-6) return sphere(a, Math.max(ra, rb), seg);
  return lathe(pillProfile(ra, rb, L), seg, a, d.normalize());
}
export function sphere(c, r, seg = 16) {
  const g = new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1));
  g.translate(c.x, c.y, c.z);
  return g;
}
/* 锥台（两端平面封口）：a 端半径 ra → b 端半径 rb */
export function frustum(a, b, ra, rb, seg = 16) {
  const d = vec(a, b), L = d.length();
  if (L < 1e-6) return null;
  return lathe([[0, 0], [ra, 0], [rb, L], [0, L]], seg, a, d.normalize());
}
/* PrusaSlicer 支撑头：后端球（心 = junction，半径 rBack）沿 -dir 经切线锥到前端球（半径 rPin，球心距 cc）。
   dir = 接触点指向外的方向（头部从模型伸出的方向） */
export function prusaHead(junction, dir, rBack, rPin, cc, seg = 16) {
  const d = new THREE.Vector3(-dir[0], -dir[1], -dir[2]);
  return lathe(pillProfile(rBack, rPin, cc, 8), seg, junction, d);
}
/* ---------- 方向 ---------- */
/* 接触端方向候选（单位向量，从接触点指向外）。n = 接触面外法线；sgn = −1 向下伸出（顶端）/ +1 向上伸出（锚定端）。
   主方向 = 法线钳制进「与 sgn·Y 夹角 ≤ tiltMax」的锥（超角时保留方位角、倾角饱和到锥面）；
   与轴夹角 < dead 视为水平面 → 取轴向（吸收细分法线噪声）。
   其后为锥内替补方向（多环倾角 × 12 方位），按与主方向夹角升序——避让时依次试放，越靠前越贴近理想朝向 */
export function dirCandidates(n, sgn, tiltMax, dead, fixed = false) {
  const ax = [0, sgn, 0];
  let main = ax;
  if (n) {
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    const c = n[1] * sgn / l;
    const h = Math.hypot(n[0], n[2]) / l;
    if (c < Math.cos(dead) && h > 1e-9) {
      // fixed：固定倾角模式——沿法线方位、倾角直接取 tiltMax
      const tilt = fixed ? tiltMax : Math.min(Math.acos(Math.max(-1, Math.min(1, c))), tiltMax);
      const s = Math.sin(tilt);
      main = [n[0] / l / h * s, sgn * Math.cos(tilt), n[2] / l / h * s];
    }
  }
  const out = [];
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const tilt = tiltMax * f, na = f === 0 ? 1 : 12;
    for (let k = 0; k < na; k++) {
      const az = k * 2 * Math.PI / na;
      out.push([Math.sin(tilt) * Math.cos(az), sgn * Math.cos(tilt), Math.sin(tilt) * Math.sin(az)]);
    }
  }
  const dot = v => v[0] * main[0] + v[1] * main[1] + v[2] * main[2];
  out.sort((a, b) => dot(b) - dot(a));
  return [main, ...out];
}

/* 接触朝向参数 → { tilt 接触端最大倾角（弧度，从竖直）, fixed 固定倾角 }。
   接触端很短（约 1mm），可比自支撑角更斜；针身 / 分支仍按 selfAngle 的临界锥约束 */
export function tipCone(P) {
  const mode = P.tipMode || 'normal';
  const tilt = mode === 'vertical' ? 0 : Math.max(0, Math.min(75, P.tipTilt ?? 45)) * Math.PI / 180;
  return { tilt, fixed: mode === 'fixed' };
}

/* ---------- 避让 ---------- */
/* 接触端放置（支撑头 / 接触杆 / 锚定头）：沿候选方向依次试放，首个净空者胜出。
   spec：{ tipR 接触端半径, backR 后端半径, len 接触点→后端中心距离, skip 接触端豁免长度, gap 安全净距 }
   接触端本就贴住/扎入表面，豁免 skip 段；其后锥体（半径线性插值）与后端球都须与模型保持 gap。
   返回 { dir, back, tilt } 或 null（锥内全部方向碰撞 → 该点不可支撑） */
export function placeTip(bvh, p, n, sgn, tiltMax, dead, spec, fixed = false) {
  for (const d of dirCandidates(n, sgn, tiltMax, dead, fixed)) {
    const bx = p.x + d[0] * spec.len, by = p.y + d[1] * spec.len, bz = p.z + d[2] * spec.len;
    if (!coneClear(bvh, p.x, p.y, p.z, spec.tipR + spec.gap, bx, by, bz, spec.backR + spec.gap, spec.skip)) continue;
    if (pointDist(bvh, bx, by, bz, spec.backR + spec.gap) < spec.backR + spec.gap) continue;
    return { dir: d, back: { x: bx, y: by, z: bz }, tilt: Math.acos(Math.min(1, Math.abs(d[1]))) };
  }
  return null;
}

/* 桥板：两个表面之间的一整块竖板。轮廓是两端圆头的凸包，宽度沿外公切线直线变窄，
   厚度从根部收到尖端。尖端只留下细圆头，粗的部分停在模型外面。
   板是实心的一块：没有孔，没有重复的格子，也不沿某组边的方向另接一根针。 */
export function strap(a, b, ra, rb, thick = 0.35, seg = 10, thickRoot = 0) {
  const A = new THREE.Vector3(a.x, a.y, a.z);
  const B = new THREE.Vector3(b.x, b.y, b.z);
  const axis = new THREE.Vector3().subVectors(B, A);
  const L = axis.length();
  if (L < 0.2 || ra < 0.05 || rb < 0.05) return null;
  if (L + Math.min(ra, rb) <= Math.max(ra, rb) + 1e-3) return null;
  axis.multiplyScalar(1 / L);
  const wd = new THREE.Vector3().crossVectors(axis, UP);
  if (wd.lengthSq() < 1e-8) wd.crossVectors(axis, new THREE.Vector3(1, 0, 0));
  wd.normalize();
  const td = new THREE.Vector3().crossVectors(axis, wd).normalize();
  const N = Math.max(8, seg);
  const samples = [];
  const circ = (cx, r) => {
    for (let i = 0; i < N; i++) {
      const ang = i / N * Math.PI * 2;
      samples.push({ x: cx + Math.cos(ang) * r, y: Math.sin(ang) * r });
    }
  };
  circ(0, ra);
  circ(L, rb);
  samples.sort((p, q) => p.x - q.x || p.y - q.y);
  const cross2 = (o, p, q) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const chain = list => {
    const h = [];
    for (const p of list) {
      while (h.length >= 2 && cross2(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    return h;
  };
  const lower = chain(samples);
  const upperH = chain([...samples].reverse());
  lower.pop();
  upperH.pop();
  const hull = lower.concat(upperH);
  if (hull.length < 4) return null;
  const hTip = Math.max(0.14, thick) / 2;
  const hRoot = Math.max(hTip, (thickRoot || thick) / 2);
  const hAt = x => {
    const t = Math.min(1, Math.max(0, x / L));
    return hRoot + (hTip - hRoot) * t;
  };
  const to3 = (p, s) => A.clone().addScaledVector(axis, p.x).addScaledVector(wd, p.y).addScaledVector(td, s);
  const top = hull.map(p => to3(p, hAt(p.x)));
  const bot = hull.map(p => to3(p, -hAt(p.x)));
  let sx = 0, sy = 0;
  for (const p of hull) { sx += p.x; sy += p.y; }
  sx /= hull.length; sy /= hull.length;
  const midT = to3({ x: sx, y: sy }, hAt(sx));
  const midB = to3({ x: sx, y: sy }, -hAt(sx));
  const pos = [];
  const push = (p, q, r) => { pos.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z); };
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    push(midT, top[i], top[j]);
    push(midB, bot[j], bot[i]);
    push(top[i], bot[i], top[j]);
    push(top[j], bot[i], bot[j]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}

/* 沿给定方向落到朝上的表面，给出桥板两端。dir 默认竖直向下。
   sinkTop 为真时上端也收成细尖并扎入；否则上端用 rFrom，接在已经生成的分支上。
   返回 { upper, lower, rFrom, rTip, thick, thickRoot }，放不下时返回 null。 */
export function bridgeSpan(bvh, faces, from, opts = {}) {
  const rTip = Math.max(0.12, opts.rTip || 0.2);
  const maxLen = opts.maxLen || 12;
  const raw = opts.dir || [0, -1, 0];
  const dl = Math.hypot(raw[0], raw[1], raw[2]) || 1;
  const dx = raw[0] / dl, dy = raw[1] / dl, dz = raw[2] / dl;
  if (dy > -0.2) return null;
  if (opts.tiltMax != null && Math.acos(Math.min(1, -dy)) > opts.tiltMax + 1e-3) return null;
  const hit = raycast(bvh, from.x, from.y, from.z, dx, dy, dz, 0.05, maxLen);
  if (!hit || faces.nrm[hit.f * 3 + 1] < 0.5) return null;
  const land = { x: from.x + dx * hit.t, y: from.y + dy * hit.t, z: from.z + dz * hit.t };
  if (opts.protNear && opts.protNear(land)) return null;
  const sink = Math.min(opts.pen ?? 0.2, 0.2);
  const back = rTip - sink;
  const lower = { x: land.x - dx * back, y: land.y - dy * back, z: land.z - dz * back };
  const upper = opts.sinkTop
    ? { x: from.x - dx * back, y: from.y - dy * back, z: from.z - dz * back }
    : { x: from.x, y: from.y, z: from.z };
  if (Math.hypot(upper.x - lower.x, upper.y - lower.y, upper.z - lower.z) < 0.2) return null;
  const rFrom = opts.sinkTop ? rTip : Math.max(rTip, opts.rFrom || rTip);
  const thick = Math.max(0.28, opts.thick || rTip * 1.6);
  const thickRoot = opts.sinkTop ? thick : Math.max(thick, Math.min(1.05, rFrom * 1.7));
  if (bvh) {
    // 胶囊停在落点前一个包络半径处，尖端扎入段不参与净空，否则短间隙会被落点自己挡掉
    const env = Math.max(thick * 0.5 + 0.05, Math.min(opts.envR || 0.45, Math.max(rTip, thickRoot * 0.5)));
    // 出发端也要离「接触面」一个包络半径以上：起点若仍在面下 0.2（旧值），窄间隙里起点自己贴着面，
    // 净空必失败（雕像头顶 0.76 缝的兜底点实测如此）
    const sStart = opts.sinkTop ? Math.max(0.2, env + 0.06) : 0;
    const start = opts.sinkTop
      ? { x: from.x + dx * sStart, y: from.y + dy * sStart, z: from.z + dz * sStart }
      : upper;
    const stop = { x: land.x - dx * (env + 0.08), y: land.y - dy * (env + 0.08), z: land.z - dz * (env + 0.08) };
    const travel = Math.hypot(start.x - stop.x, start.y - stop.y, start.z - stop.z);
    if (travel > 0.12 && !capsuleClear(bvh, start.x, start.y, start.z, stop.x, stop.y, stop.z, env)) return null;
  }
  return { upper, lower, rFrom, rTip, thick, thickRoot };
}

/* 竖直优先，再在临界锥里试几个斜向。命中的第一块板即可。 */
export function bridgeToSurface(bvh, faces, from, opts = {}) {
  const tilt = opts.tiltMax ?? Math.PI / 4;
  const dirs = opts.dirs || downFan(tilt, [0.33, 0.66], 8);
  for (const d of dirs) {
    const s = bridgeSpan(bvh, faces, from, { ...opts, dir: d, tiltMax: tilt });
    if (s) return s;
  }
  return null;
}

/* 直接生成桥板几何。放不下时返回 null。 */
export function bridgeDown(bvh, faces, from, opts) {
  const s = (opts && opts.fan) ? bridgeToSurface(bvh, faces, from, opts) : bridgeSpan(bvh, faces, from, opts);
  return s ? strap(s.upper, s.lower, s.rFrom, s.rTip, s.thick, 10, s.thickRoot) : null;
}

/* 微型短柱（窄间隙）：接触点竖直下方 lim 内有可承载表面 → 竖直双端细尖直柱。
   两端都用接触尖半径，各扎入不超过 0.2。窄间隙里常规接触端会被迫斜置换向，把根部甩到间隙外反而落不了地。
   返回几何或 null */
export function microPost(bvh, faces, p, rTip, lim, protNear, seg = 16) {
  const hit = raycast(bvh, p.x, p.y - 0.05, p.z, 0, -1, 0, 0.1, lim);
  if (!hit || faces.nrm[hit.f * 3 + 1] < 0.3) return null;
  const yb = p.y - 0.05 - hit.t, span = p.y - yb;
  if (span < 0.25 || (protNear && protNear({ x: p.x, y: yb, z: p.z }))) return null;
  const r = Math.max(0.12, rTip);
  const sink = Math.min(0.2, r * 0.5);
  const y0 = yb - sink + r, y1 = p.y + sink - r;
  if (y1 - y0 < 0.05) return null;
  return pill({ x: p.x, y: y0, z: p.z }, { x: p.x, y: y1, z: p.z }, r, r, seg);
}

/* 向下的方向扇（竖直优先，再按倾角由小到大 × 12 方位），用于避让段 / 地面路径 / 模型锚定射线 */
export function downFan(tiltMax, rings = [0.33, 0.66, 1], na = 12) {
  const out = [[0, -1, 0]];
  for (const f of rings) {
    const t = tiltMax * f;
    for (let k = 0; k < na; k++) {
      const az = (k + (f === 0.66 ? 0.5 : 0)) * 2 * Math.PI / na;
      out.push([Math.sin(t) * Math.cos(az), -Math.cos(t), Math.sin(t) * Math.sin(az)]);
    }
  }
  return out;
}

/* 落地路径（PrusaSlicer deepsearch_ground_connection 的离散版）：从 p（杆半径 r）到底座顶面 yTop。
   先试竖直；碰撞则在临界锥内搜索「斜段 + 竖直」两段式避让，斜段长 ≤ maxBridge，按总长升序取首个净空方案。
   footOK(g) 额外校验落点（底座锥台净空等）。返回折线 [p, (q), g] 或 null */
export function groundRoute(bvh, p, r, yTop, tiltMax, maxBridge, gap, footOK) {
  const clear = (a, b) => capsuleClear(bvh, a.x, a.y, a.z, b.x, b.y, b.z, r + gap);
  const g0 = { x: p.x, y: yTop, z: p.z };
  if (p.y - yTop < 1e-3) return footOK && !footOK(g0) ? null : [p, g0];
  if (clear(p, g0) && (!footOK || footOK(g0))) return [p, g0];
  const cands = [];
  const lens = [1, 2, 3.5, maxBridge * 0.7, maxBridge].filter((v, i, a) => v > 0.3 && v <= maxBridge + 1e-9 && a.indexOf(v) === i);
  for (const d of downFan(tiltMax).slice(1)) {
    for (const L of lens) {
      const q = { x: p.x + d[0] * L, y: p.y + d[1] * L, z: p.z + d[2] * L };
      if (q.y < yTop + r) continue;
      cands.push({ q, cost: L + (q.y - yTop) });
    }
  }
  cands.sort((a, b) => a.cost - b.cost);
  for (const { q } of cands) {
    const g = { x: q.x, y: yTop, z: q.z };
    if (footOK && !footOK(g)) continue;
    if (clear(p, q) && clear(q, g)) return [p, q, g];
  }
  return null;
}

/* 合并几何零件（非索引化 + 拼接），返回单一 BufferGeometry——零件间重叠由下游切片器并集（同 PrusaSlicer its_merge） */
export function mergeParts(geoms) {
  const list = geoms.filter(Boolean).map(g => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of list) total += g.attributes.position.array.length;
  const arr = new Float32Array(total);
  let off = 0;
  for (const g of list) { arr.set(g.attributes.position.array, off); off += g.attributes.position.array.length; g.dispose(); }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  out.computeVertexNormals();
  return out;
}
