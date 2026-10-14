/* ================================================================
   支撑构件库（支撑塔）
   - 方向：接触端方向候选——法线钳制进接触锥（保留方位、倾角饱和到锥面）
   - 桥接：支撑塔连不上格架的点用的短连接（十字短杆 / 分叉头）：bridgeSpan 沿方向找落点、
     bridgeToSurface 竖直优先再多方向试放；净空一律按胶囊体判定（collide.js）
   - 合并：mergeParts 把构件几何拼成单一 BufferGeometry（保留 runs 边界供导出布尔并）
================================================================ */
import * as THREE from 'three';
import { raycast, capsuleClear } from './collide.js';

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

/* ---------- 桥接 ---------- */
/* 沿给定方向落到朝上的表面，给出桥接两端。dir 默认竖直向下。
   sinkTop 为真时上端也收成细尖并扎入；否则上端用 rFrom，接在已经生成的结构上。
   返回 { upper, lower, rFrom, rTip, thick, thickRoot, ground }，放不下时返回 null。 */
export function bridgeSpan(bvh, faces, from, opts = {}) {
  const rTip = Math.max(0.12, opts.rTip || 0.2);
  const maxLen = opts.maxLen || 12;
  const raw = opts.dir || [0, -1, 0];
  const dl = Math.hypot(raw[0], raw[1], raw[2]) || 1;
  const dx = raw[0] / dl, dy = raw[1] / dl, dz = raw[2] / dl;
  if (dy > -0.2) return null;
  if (opts.tiltMax != null && Math.acos(Math.min(1, -dy)) > opts.tiltMax + 1e-3) return null;
  const hit = raycast(bvh, from.x, from.y, from.z, dx, dy, dz, 0.05, maxLen);
  let land = null;
  if (hit) {
    // 先碰到的是朝上的模型面才落上去；碰到朝下的面（别的零件的底面）说明被挡住
    if (faces.nrm[hit.f * 3 + 1] < 0.5) return null;
    land = { x: from.x + dx * hit.t, y: from.y + dy * hit.t, z: from.z + dz * hit.t };
  } else if (opts.groundY != null) {
    // 下方没有模型面：可竖直落到平台面（groundY，连接底板时为板顶）
    const tg = (from.y - opts.groundY) / -dy;
    if (tg > 0.05 && tg <= maxLen) land = { x: from.x + dx * tg, y: opts.groundY, z: from.z + dz * tg };
  }
  if (!land) return null;
  if (opts.protNear && opts.protNear(land)) return null;
  const sink = Math.min(opts.pen ?? 0.2, 0.2);
  const back = rTip - sink;
  // 落在平台上时下端正好贴住平台面：退让量是给「收细 + 扎入模型」的接触端用的，平台端不收细、不扎入，退了就悬空 0.05
  const backL = hit ? back : 0;
  const lower = { x: land.x - dx * backL, y: land.y - dy * backL, z: land.z - dz * backL };
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
  // ground：落在平台面（groundY）而不是模型面——落点端不该收细、不该扎进平台，由调用方决定端头形状
  return { upper, lower, rFrom, rTip, thick, thickRoot, ground: !hit };
}

/* 竖直优先，再在接触锥里试几个斜向。命中的第一个方案即可。 */
export function bridgeToSurface(bvh, faces, from, opts = {}) {
  const tilt = opts.tiltMax ?? Math.PI / 4;
  const dirs = opts.dirs || downFan(tilt, [0.33, 0.66], 8);
  for (const d of dirs) {
    const s = bridgeSpan(bvh, faces, from, { ...opts, dir: d, tiltMax: tilt });
    if (s) return s;
  }
  return null;
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

/* 合并几何零件（非索引化 + 拼接），返回单一 BufferGeometry——零件间重叠由下游切片器并集（同 PrusaSlicer its_merge）。
   同时保留构件边界 userData.runs：导出前的布尔并要靠它把这堆三角形还原成一个个闭合壳 */
export function mergeParts(geoms) {
  const list = geoms.filter(Boolean).map(g => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of list) total += g.attributes.position.array.length;
  const arr = new Float32Array(total);
  let off = 0;
  const runs = [];
  for (const g of list) {
    const a = g.attributes.position.array;
    arr.set(a, off);
    const t0 = off / 9;
    const sub = g.userData && g.userData.runs;
    if (sub && sub.length) for (const [s, e] of sub) runs.push([t0 + s, t0 + e]);
    else runs.push([t0, t0 + a.length / 9]);
    off += a.length; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  out.computeVertexNormals();
  out.userData.runs = runs;
  return out;
}
