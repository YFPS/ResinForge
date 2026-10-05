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

/* 微型短柱（窄间隙）：接触点竖直下方 lim 内有可承载表面 → 竖直双端球头直柱，两端各扎入 0.1。
   优先于常规接触端：窄间隙里常规接触端会被迫斜置换向，把根部甩到间隙外反而落不了地（实测悬臂雕像球底 0.8mm 间隙）。
   返回几何或 null */
export function microPost(bvh, faces, p, rMax, lim, protNear, seg = 16) {
  const hit = raycast(bvh, p.x, p.y - 0.05, p.z, 0, -1, 0, 0.1, lim);
  if (!hit || faces.nrm[hit.f * 3 + 1] < 0.3) return null;
  const yb = p.y - 0.05 - hit.t, span = p.y - yb;
  if (span < 0.25 || (protNear && protNear({ x: p.x, y: yb, z: p.z }))) return null;
  const r = Math.min(rMax, Math.max(0.15, span * 0.45));
  const y0 = Math.min(yb - 0.1 + r, p.y + 0.1 - r), y1 = Math.max(yb - 0.1 + r, p.y + 0.1 - r);
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
