/* ================================================================
   贴着切面的梯形销（沿画线的曲面切用）
   ----------------------------------------------------------------
   纯计算：不碰 DOM / store / three。切面由调用方给：
   · sheet.heightAt(u, v)：切面高度（局部系 (u,v)）；
   · C：切面之上（朝 +w）的那块实体，用来修剪公榫 / 母孔；
   · upper / lower：切出来的两件。
   公榫长在下件、母孔开在上件；销轴沿 frame.n（拟合平面法线），
   底面随切面起伏，放不下就按比例缩小，缩到下限还不行只切不加销。
================================================================ */
import {
  poleOf, signedDist, FIT_FRAC, PIN_TRIES, PIN_SHRINK, PIN_MIN, SOCKET_OVER, RING_SIMP, pinWallFor,
} from './cutGeom.js';

/** 销的棱台：轴 +w，长边沿 theta，中心 (x, y)。zRef 处宽 / 厚是 size / size·aspect，往上按锥度收窄，往下保持等截面；g 为向外多出的间隙 */
function pinPrism(MF, s, zRef, zLo, zHi, g, T) {
  const { Manifold } = MF;
  const w = s.size / 2, h = s.size * s.aspect / 2;
  const k = Math.max(0.35, 1 - 2 * s.depth * Math.tan(s.taper * Math.PI / 180) / s.size);
  const f = z => (z <= zRef ? 1 : Math.max(0.2, 1 - (1 - k) * (z - zRef) / s.depth));
  const c = Math.cos(s.theta), sn = Math.sin(s.theta);
  const ring = z => {
    const a = w * f(z) + g, b = h * f(z) + g;
    return [[-a, -b], [a, -b], [a, b], [-a, b]].map(([p, q]) => [s.x + p * c - q * sn, s.y + p * sn + q * c, z]);
  };
  return T(Manifold.hull([...ring(zLo), ...ring(zRef), ...ring(zHi)]));
}

/** 切面在 (x, y) 为中心、半径 R 的圆里的高度起伏（最高 − 最低）与最低、最高 */
function heightSpan(sheet, x, y, R) {
  let lo = Infinity, hi = -Infinity;
  const put = (a, b) => { const h = sheet.heightAt(a, b); if (!Number.isFinite(h)) return; if (h < lo) lo = h; if (h > hi) hi = h; };
  put(x, y);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    put(x + R * Math.cos(a), y + R * Math.sin(a));
    if (k % 2 === 0) put(x + 0.5 * R * Math.cos(a), y + 0.5 * R * Math.sin(a));
  }
  if (!(lo <= hi)) { const h0 = sheet.heightAt(x, y); const h1 = Number.isFinite(h0) ? h0 : 0; return { lo: h1, hi: h1, range: 0 }; }
  return { lo, hi, range: hi - lo };
}

/**
 * 在切面里放销：先取最大内切圆圆心；切面在销的范围内起伏超过销高的三成就在截面里另找一处净宽够、起伏最小的位置。
 * 公榫 = 销棱台 ∩ 切刀下移 embed（底面随切面起伏，埋进下件一小截），母孔 = 外扩 clear 的棱台 ∩ 切刀上移 SOCKET_OVER。
 * 放不下（材料太薄 / 太陡）就按比例缩小重试，缩到下限还不行就不加销。
 */
export function placePinCurved(MF, ctx, T) {
  const { Manifold } = MF;
  const { upper, lower, C, sheet, rings, theta, spec, frame } = ctx;
  const pole = poleOf(rings, RING_SIMP * 5);
  const rho = Math.sqrt(1 + spec.aspect * spec.aspect) / 2;
  let size = Math.min(spec.size, (pole.r - spec.clear - 0.15 - 0.03) / rho * 1.08);
  if (!(size >= PIN_MIN)) return { warn: `切面太小（最大内切圆半径 ${pole.r.toFixed(1)} mm），放不下梯形插销，已只切不加销` };
  const ratio = spec.depth / spec.size;
  const reach = s => rho * s + spec.clear + 0.3;
  let site = { x: pole.x, y: pole.y };
  if (heightSpan(sheet, site.x, site.y, reach(size)).range > 0.3 * size * ratio) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rings) for (const p of r) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    const step = Math.max(0.5, reach(size) / 3);
    let best = null;
    for (let x = minX; x <= maxX; x += step) {
      for (let y = minY; y <= maxY; y += step) {
        const sd = signedDist(rings, x, y);
        if (sd < reach(size)) continue;
        const range = heightSpan(sheet, x, y, reach(size)).range;
        const score = range - 0.02 * sd;
        if (!best || score < best.score) best = { x, y, score };
      }
    }
    if (best) site = { x: best.x, y: best.y };
  }
  const vUp = upper.volume(), vLo = lower.volume();
  for (let attempt = 0; attempt < PIN_TRIES && size >= PIN_MIN; attempt++, size *= PIN_SHRINK) {
    const wall = pinWallFor(size);
    const clear = Math.min(spec.clear, Math.max(0.04, 0.08 * size));
    const s = { ...spec, size, depth: Math.max(size * ratio, 0.5), x: site.x, y: site.y, theta, clear, wall };
    const sp = heightSpan(sheet, site.x, site.y, reach(size));
    if (sp.range > 0.5 * s.depth) continue;                 // 销的范围内切面起伏太大，缩小一点再试
    const zRef = sheet.heightAt(site.x, site.y);
    const embed = Math.max(size * 0.18, 0.3);
    const zLo = sp.lo - embed - 0.5;
    const maleP = pinPrism(MF, s, zRef, zLo, zRef + s.depth, 0, T);
    const sockP = pinPrism(MF, s, zRef, zLo, zRef + s.depth + s.clear, s.clear, T);
    const Cdown = T(C.translate([0, 0, -embed]));
    const Cover = T(C.translate([0, 0, -SOCKET_OVER]));
    const male = T(Manifold.intersection([maleP, Cdown]));
    const maleAbove = T(Manifold.intersection([maleP, C]));
    const root = T(Manifold.difference([male, C]));
    const socketBody = T(Manifold.intersection([sockP, C]));
    const socket = T(Manifold.intersection([sockP, Cover]));
    const vBody = socketBody.volume(), vRoot = root.volume();
    if (!(vBody > 1e-6) || !(vRoot > 1e-6)) continue;
    const inUp = T(Manifold.intersection([socketBody, upper])).volume() / vBody;
    const inLo = T(Manifold.intersection([root, lower])).volume() / vRoot;
    if (inUp < FIT_FRAC || inLo < FIT_FRAC) continue;
    /* 体积比只能挡住大半截落在外面的情形：孔顶穿出一道缝只占体积的千分之几。外扩 PIN_WALL 的孔、根部都必须整个在材料里 */
    const wallUp = T(Manifold.intersection([pinPrism(MF, s, zRef, zLo, zRef + s.depth + s.clear + wall, s.clear + wall, T), C]));
    const wallLo = T(Manifold.difference([T(Manifold.intersection([pinPrism(MF, s, zRef, zLo - wall, zRef, wall, T), T(C.translate([0, 0, -embed - wall]))])), C]));
    const outUp = T(Manifold.difference([wallUp, upper])).volume(), outLo = T(Manifold.difference([wallLo, lower])).volume();
    if (outUp > 2e-3 * wallUp.volume() || outLo > 2e-3 * Math.max(wallLo.volume(), 1e-9)) continue;
    const lower2 = T(Manifold.union([lower, male]));
    const upper2 = T(Manifold.difference([upper, socket]));
    if (lower2.status() !== 'NoError' || upper2.status() !== 'NoError') continue;
    const gain = lower2.volume() - vLo, loss = vUp - upper2.volume();
    if (gain < 0.5 * maleAbove.volume() || loss < 0.5 * vBody) continue;
    const { u: fu, v: fv, n: fn, c: fc } = frame;
    const wd = [0, 1, 2].map(k => fu[k] * site.x + fv[k] * site.y + fn[k] * zRef + fc[k]);
    const tip = Math.max(0.35, 1 - 2 * s.depth * Math.tan(s.taper * Math.PI / 180) / s.size);
    return {
      upper: upper2, lower: lower2,
      pin: {
        size, depth: s.depth, clear: s.clear, taper: spec.taper, aspect: spec.aspect, tip, theta,
        world: wd, axis: fn.slice(), shrunk: attempt, fit: { socket: inUp, root: inLo },
        volMale: gain, volSocket: loss, tilt: sp.range,
      },
      warn: attempt ? `梯形销放不下设定尺寸，已缩小到宽 ${size.toFixed(1)} × 深 ${s.depth.toFixed(1)} mm` : null,
    };
  }
  return { warn: '这一刀的切面里放不下梯形插销（材料太薄、形状太窄或切面起伏太大），已只切不加销' };
}
