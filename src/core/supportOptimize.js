/* ================================================================
   树状支撑的交叉两岸。
   只连接两根竖直落地柱：斜杆两端都落在底座上方的直柱中心线上，球头埋进柱身，
   不悬空、不插进锥形底座。两岸 = 这两根柱；左右各一根、方向相反，侧面是剪刀撑。
   斜柱、分支、相距过远或直柱太短的不加。
================================================================ */
import { capsuleClear } from './collide.js';
import { mergeParts, pill } from './supportKit.js';

const MIN_SPAN = 4;     // 底座已经挨上时不再打交叉
const MAX_SPAN = 16;    // 再远就不是邻柱加固

/* 直柱中心线上、高度 y 处的点（y 夹在这段直柱内） */
function onShaft(p, y) {
  const t = (y - p.y0) / (p.y1 - p.y0);
  return {
    x: p.x0 + (p.x1 - p.x0) * t,
    y,
    z: p.z0 + (p.z1 - p.z0) * t,
  };
}

/**
 * posts：{ x0,y0,z0, x1,y1,z1, r } 底座顶到第一个拐点的直柱。
 * 返回 { geom, ribs, gussets, isolated, skipped }。ribs = 交叉组数，gussets = 斜杆数。
 */
export function crossGroundPosts(ctx, posts, P) {
  const empty = { geom: null, ribs: 0, gussets: 0, isolated: 0, skipped: 0 };
  if (!posts || posts.length < 2) return empty;
  const yPad = posts[0].y0;   // 直柱下端就是底座顶面
  const minSpan = Math.max(MIN_SPAN, (P.baseD || 3) + 0.6);
  const bvh = ctx.bvh;
  const pairs = [];
  for (let i = 0; i < posts.length; i++) {
    for (let j = i + 1; j < posts.length; j++) {
      const d = Math.hypot(posts[i].x0 - posts[j].x0, posts[i].z0 - posts[j].z0);
      if (d >= minSpan && d <= MAX_SPAN) pairs.push({ i, j, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const deg = new Array(posts.length).fill(0);
  const geoms = [];
  let ribs = 0, gussets = 0, skipped = 0;
  for (const pair of pairs) {
    if (deg[pair.i] >= 2 || deg[pair.j] >= 2) continue;
    const A = posts[pair.i], B = posts[pair.j];
    const top = Math.min(A.y1, B.y1);
    const avail = top - yPad;
    if (avail < 3.6) { skipped++; continue; }
    const yLo = yPad + 0.55;
    let rise = Math.min(avail - 1.15, 5.2, Math.max(2.6, pair.d * 0.4));
    if (rise < 2.4) { skipped++; continue; }
    const rodR = Math.min(0.32, Math.max(0.22, Math.min(A.r, B.r) * 0.62));
    let bars = null;
    for (let attempt = 0; attempt < 3 && !bars; attempt++) {
      const yHi = yLo + rise;
      if (yHi > top - 0.3) { rise *= 0.72; continue; }
      const a0 = onShaft(A, yLo), b1 = onShaft(B, yHi);
      const a1 = onShaft(A, yHi), b0 = onShaft(B, yLo);
      const clear = (p, q) => !bvh || capsuleClear(bvh, p.x, p.y, p.z, q.x, q.y, q.z, rodR + 0.1);
      if (clear(a0, b1) && clear(a1, b0)) {
        bars = [pill(a0, b1, rodR, rodR, 8), pill(a1, b0, rodR, rodR, 8)];
      } else rise *= 0.72;
    }
    if (!bars) { skipped++; continue; }
    geoms.push(...bars);
    ribs++;
    gussets += 2;
    deg[pair.i]++;
    deg[pair.j]++;
  }
  let geom = null;
  if (geoms.length) {
    const flat = geoms.map(g => {
      if (!g.index) return g;
      const n = g.toNonIndexed();
      g.dispose();
      return n;
    });
    geom = mergeParts(flat);
  }
  const isolated = posts.filter((_, i) => deg[i] === 0 && posts.some((q, j) => j !== i && Math.hypot(posts[i].x0 - q.x0, posts[i].z0 - q.z0) <= MAX_SPAN)).length;
  return { geom, ribs, gussets, isolated, skipped };
}
