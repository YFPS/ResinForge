/* ================================================================
   画线切割内核（manifold-3d：切面 + 梯形插销）
   ----------------------------------------------------------------
   纯计算：不碰 DOM / store / three，主线程、Web Worker、Node 通用。调度（后台线程、排队）见 geomClient.js。
   切面有两种：
   · 沿画线（默认）：画线各点离拟合平面都超过 FLAT_TOL 时，按画线切，见 cutCurve.js → cutSeam.js 的
     「窄带 + 膜」：切口落在画线上、切面整片在材料里，画线以外的地方不切；
   · 平面：画线很平（或 req.surface === 'plane'）时，切的是最佳拟合平面（线段长度加权的质心 + 面积加权 Newell 法线），
     偏差由 fitPlane 报出。下面 1~5 是平面这一路，曲面那一路的步骤相同，只是切面换成曲面。
   做法：
   1. 画线拟合出切面（平面路径）。
   2. 零件焊成水密网格（顶点先吸附到 1e-4 mm 再按位置焊接），变到「切面 = 局部 z 为 0」的坐标系里。
      不是水密（破洞 / 翻向 / 重复面 / 多面共边）时先自动修复再重试，见 meshRepair.js / buildManifoldAuto。
   3. 切面与零件的截面是若干个「岛」（带孔多边形）。画线投影到切面后，与哪个岛的交并比最高，就切哪个岛。
   4. splitByPlane 把零件分成上下两侧（+n 为上），各自是水密实体。有多个岛时只切被圈住的那一个：
      其余岛两侧的分量按连通关系并查集合并回去（共面接触，布尔并后接缝消失）；
      被圈住的岛两侧若仍经别处相连，说明这一刀切不开，报错而不是悄悄切成别的样子。
   5. 梯形插销：放在被圈住岛的最大内切圆圆心，公榫长在下件、母孔（加单边间隙）开在上件。
      销的尺寸 / 深度自适应：母孔体积必须几乎全落在上件材料内、公榫根部必须几乎全落在下件材料内，放不下就按比例缩小重试，
      缩到下限还放不下就不加销（只切），并在 warn 里说明。
   坐标系：输入输出同一坐标系（调用方给什么系就在什么系里切），n 指向「上件」。
   返回：{ ok: true, upper: { pos }, lower: { pos }, info } 或 { ok: false, code, reason }；pos 为非索引三角形（9 个数一个面）。
================================================================ */
import {
  dot, len3, unit, fail, flatPoints, fitPlane, frameOf, weldSoup, buildManifold, buildManifoldAuto, soupOf,
  poleOf, principalAngle, ringsOf, outerOf, inRings, pickStar,
  RING_SIMP, FIT_FRAC, PIN_TRIES, PIN_SHRINK, PIN_MIN, SOCKET_OVER, MIN_PIECE, PIN_WALL, pinWallFor,
} from './cutGeom.js';
import { REPAIR_MAX_FACES, repairIndexed, describeRepair, topoCheck } from './meshRepair.js';
import { cutCurved, FLAT_TOL } from './cutCurve.js';

/** 梯形销默认参数：size 根部宽、depth 插入深度、clear 单边间隙（mm）、taper 单边锥角（°）、aspect 厚 / 宽 */
export const PIN_DEFAULTS = { size: 6, depth: 6, clear: 0.1, taper: 10, aspect: 0.6 };

/* ---------- 梯形销（平面切） ---------- */

/**
 * 销的各个实体（凸包）。局部系：销轴 +z（插入方向，从下件伸进上件），根部中心在 (x, y, 0)，长边沿 theta 方向。
 * 宽、厚按同一比例沿轴收窄（z 处为 f(z)；z = 0 处正好是 size），端部不小于根部的 35%。
 * male 公榫（根部埋进下件一小截）；root 埋入段（校验是否落在下件材料内）；socketBody 母孔 z ≥ 0 的主体（校验是否落在上件材料内）；
 * socket 母孔（向切面外多开一小截，保证切透）。母孔 = 公榫外扩单边间隙 clear，轴向多深 clear；间隙在各高度保持一致。
 */
function pinSolids(MF, s, T) {
  const { Manifold } = MF;
  const wall = s.wall || PIN_WALL;
  const w = s.size / 2, h = s.size * s.aspect / 2;
  const k = Math.max(0.35, 1 - 2 * s.depth * Math.tan(s.taper * Math.PI / 180) / s.size);
  const f = z => 1 - (1 - k) * z / s.depth;
  const embed = Math.max(s.size * 0.18, 0.3);
  const c = Math.cos(s.theta), sn = Math.sin(s.theta);
  const ring = (z, g) => {
    const a = w * f(z) + g, b = h * f(z) + g;
    return [[-a, -b], [a, -b], [a, b], [-a, b]].map(([p, q]) => [s.x + p * c - q * sn, s.y + p * sn + q * c, z]);
  };
  const solid = (z0, z1, g) => T(Manifold.hull([...ring(z0, g), ...ring(z1, g)]));
  return {
    male: solid(-embed, s.depth, 0),
    maleAbove: solid(0, s.depth, 0),
    root: solid(-embed, 0, 0),
    socket: solid(-SOCKET_OVER, s.depth + s.clear, s.clear),
    socketBody: solid(0, s.depth + s.clear, s.clear),
    wallUp: solid(0, s.depth + s.clear + wall, s.clear + wall),           // 母孔外扩壁厚：必须整个在上件里，孔才不会顶穿
    wallLo: solid(-embed - wall, 0, wall),                                // 公榫根部外扩壁厚：必须整个在下件里
    embed, k,
  };
}

/** 在被圈住岛的最大内切圆处放销：放不下就缩小重试。返回 { upper, lower, pin } 或 { warn } */
function placePin(MF, ctx, T) {
  const { Manifold } = MF;
  const { upper, lower, pole, theta, spec, frame } = ctx;
  const rho = Math.sqrt(1 + spec.aspect * spec.aspect) / 2;          // 销外接圆半径 / 销宽
  const room = (pole.r - spec.clear - 0.15 - 0.03) / rho * 1.08;      // 小销的孔壁按 0.15 起算；真正的判据是下面的体积校验
  let size = Math.min(spec.size, room);
  if (!(size >= PIN_MIN)) return { warn: `切面太小（最大内切圆半径 ${pole.r.toFixed(1)} mm），放不下梯形插销，已只切不加销` };
  const ratio = spec.depth / spec.size;
  const vUp = upper.volume(), vLo = lower.volume();
  for (let attempt = 0; attempt < PIN_TRIES && size >= PIN_MIN; attempt++, size *= PIN_SHRINK) {
    const wall = pinWallFor(size);
    const clear = Math.min(spec.clear, Math.max(0.04, 0.08 * size));
    const s = { ...spec, size, depth: Math.max(size * ratio, 0.5), x: pole.x, y: pole.y, theta, clear, wall };
    const sol = pinSolids(MF, s, T);
    const vBody = sol.socketBody.volume(), vRoot = sol.root.volume();
    const inUp = T(Manifold.intersection([sol.socketBody, upper])).volume() / vBody;
    const inLo = T(Manifold.intersection([sol.root, lower])).volume() / vRoot;
    if (inUp < FIT_FRAC || inLo < FIT_FRAC) continue;
    /* 体积比只能挡住大半截落在外面的情形：孔顶穿出一道缝只占体积的千分之几。外扩壁厚的孔、根部都必须整个在材料里 */
    const outUp = T(Manifold.difference([sol.wallUp, upper])).volume(), outLo = T(Manifold.difference([sol.wallLo, lower])).volume();
    if (outUp > 2e-3 * sol.wallUp.volume() || outLo > 2e-3 * sol.wallLo.volume()) continue;
    const lower2 = T(Manifold.union([lower, sol.male]));
    const upper2 = T(Manifold.difference([upper, sol.socket]));
    if (lower2.status() !== 'NoError' || upper2.status() !== 'NoError') continue;
    const gain = lower2.volume() - vLo, loss = vUp - upper2.volume();
    if (gain < 0.5 * sol.maleAbove.volume() || loss < 0.5 * vBody) continue;   // 布尔没有真正生效（孔口没切透、公榫没并上）
    const wd = [frame.u[0] * pole.x + frame.v[0] * pole.y + frame.c[0], frame.u[1] * pole.x + frame.v[1] * pole.y + frame.c[1], frame.u[2] * pole.x + frame.v[2] * pole.y + frame.c[2]];
    return {
      upper: upper2, lower: lower2,
      pin: {
        size, depth: s.depth, clear: s.clear, taper: spec.taper, aspect: spec.aspect, tip: sol.k, theta,
        world: wd, axis: frame.n.slice(), shrunk: attempt, fit: { socket: inUp, root: inLo },
        volMale: gain, volSocket: loss,
      },
      warn: attempt ? `梯形销放不下设定尺寸，已缩小到宽 ${size.toFixed(1)} × 深 ${s.depth.toFixed(1)} mm` : null,
    };
  }
  return { warn: '这一刀的切面里放不下梯形插销（材料太薄或形状太窄），已只切不加销' };
}

/* ---------- 多个截面岛：只切被圈住的那一个（平面切） ---------- */

/**
 * 切开后上下两侧各有若干连通分量。除被圈住的岛以外，每个岛两侧的分量通过共面接触相连，要并回去。
 * 并查集：节点是上 / 下各分量，非选中岛连一条边。被圈住岛两侧的分量若仍连通，这一刀切不开。
 * 无法落在任何一组的孤立壳体（模型本来就有的游离壳）按所在半空间归属。
 */
function regroup(MF, up, dn, islands, star, diag, T) {
  const { Manifold } = MF;
  const Us = up.decompose().map(T), Ds = dn.decompose().map(T);
  const nu = Us.length, nd = Ds.length;
  const eps = Math.max(1e-3, diag * 1e-5);
  const polysOf = (list, h) => list.map(m => { const c = T(m.slice(h)); return c.isEmpty() ? null : c.toPolygons(); });
  const pu = polysOf(Us, eps), pd = polysOf(Ds, -eps);
  const where = (polys, x, y) => polys.findIndex(p => p && inRings(p, x, y));
  const parent = Array.from({ length: nu + nd }, (_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const link = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  let starU = -1, starD = -1, merged = 0;
  islands.forEach((isl, k) => {
    const pole = poleOf(ringsOf(isl), RING_SIMP * 5);
    const iu = where(pu, pole.x, pole.y), id = where(pd, pole.x, pole.y);
    if (k === star) { starU = iu; starD = id; return; }
    if (iu >= 0 && id >= 0) { link(iu, nu + id); merged++; }
  });
  if (starU < 0 || starD < 0) return { err: fail('LOCATE', '定位不到被圈住的切面两侧的实体，请换一个切面位置再试') };
  if (find(starU) === find(nu + starD)) {
    return { err: fail('NOT_SEPARATING', '这一刀没能把模型分开：圈住的切面两侧还通过别的部位连在一起（例如环形或拱形结构）。请换个位置，或沿另一个方向画线') };
  }
  const rootU = find(starU), rootD = find(nu + starD);
  const gu = [], gd = [];
  for (let i = 0; i < nu + nd; i++) {
    const r = find(i), m = i < nu ? Us[i] : Ds[i - nu];
    if (r === rootU) gu.push(m);
    else if (r === rootD) gd.push(m);
    else (i < nu ? gu : gd).push(m);
  }
  const join = g => (g.length === 1 ? g[0] : T(Manifold.union(g)));
  return { upper: join(gu), lower: join(gd), merged, comps: [nu, nd] };
}

/* ---------- 入口 ---------- */

/**
 * 网格不是水密时给用户看的话：说清自动修复后还剩什么问题。不再建议「简化」——它是保持拓扑的
 * 边折叠，不补洞，说了也没用。
 */
function notManifoldReason(faces, built) {
  if (built.skipped === 'TOO_BIG') {
    return `模型不是水密网格，面数 ${faces} 超过自动修复上限（${(REPAIR_MAX_FACES / 1e4).toFixed(0)} 万面），无法精确切割。请先用建模软件或切片软件修复后再导入`;
  }
  if (built.skipped === 'ZERO_VOLUME') {
    return '模型不是水密网格，自动修复后体积接近零（更像一张没有厚度的面片），无法切割。请先在建模软件里给它加上厚度';
  }
  const left = built.left || {};
  const parts = [];
  if (left.boundary) parts.push(`${left.boundary} 条开放边`);
  if (left.nonManifold) parts.push(`${left.nonManifold} 条多面共边`);
  if (left.sameDir) parts.push(`${left.sameDir} 条朝向冲突的边`);
  if (!parts.length) {
    /* 拓扑统计全为 0 却还是被 Manifold 拒收（例如只剩几张零厚度的面片）：至少把面数说出来 */
    const n = built.repair ? built.repair.facesOut : 0;
    return `模型不是水密网格，自动修复后仍有 ${n} 个面围不成封闭实体（${built.status || 'Not manifold'}），无法精确切割。请先用建模软件或切片软件的「修复模型」功能处理后再导入`;
  }
  return `模型不是水密网格，自动修复后仍有 ${parts.join('、')}没法处理，无法精确切割。请先用建模软件或切片软件的「修复模型」功能处理后再导入`;
}

/**
 * 沿切面切开零件，可选加梯形销。
 * req = {
 *   pos:     Float32Array 非索引三角形汤（与 plane / loop 同一坐标系）
 *   plane:   { c: [x,y,z], n: [x,y,z] }   拟合平面，过 c，+n 一侧是上件
 *   loop:    画线点（xyz 平铺数组）：选中被圈住的截面岛，曲面切时它就是切面要穿过的那条线
 *   pin:     null | { size, depth, clear, taper, aspect }   null = 只切不加销
 *   surface: 'line'（默认）| 'plane'。'line' 时画线不平（偏差 > FLAT_TOL）按画线的曲面切，'plane' 一律切拟合平面
 * }
 */
export function cutByPlane(MF, req) {
  const ctx = { repair: null };
  const res = cutByPlaneInner(MF, req, ctx);
  /* 失败时也把修复报告挂到结果上：调用方要据此写「已尝试自动修复…这次没切成」，界面不用自己判断是哪一步 */
  if (!res.ok && ctx.repair) res.repair = ctx.repair;
  return res;
}

function cutByPlaneInner(MF, req, ctx) {
  const t0 = performance.now();
  const gc = [];
  const T = o => { gc.push(o); return o; };
  const ms = {};
  const lap = (key, t) => { ms[key] = +(performance.now() - t).toFixed(1); return performance.now(); };
  const warn = [];
  try {
    const pos = req.pos;
    /* 至少两个三角形才让内核判断：没有厚度的面片要走到修复那一步才会给出「体积接近零」的提示 */
    if (!(pos instanceof Float32Array) || pos.length < 18 || pos.length % 9) return fail('BAD_INPUT', '没有可切的模型网格');
    const n0 = unit(req.plane.n);
    if (!(len3(req.plane.n) > 1e-9)) return fail('BAD_INPUT', '切面法线无效');
    const loop = flatPoints(req.loop || []);
    if (loop.length < 9) return fail('LINE_FLAT', '画线至少要有三个点');

    let t = performance.now();
    const built = buildManifoldAuto(MF, pos, gc);
    ctx.repair = built.repair || null;
    if (built.err === 'TOO_SMALL') return fail('TOO_SMALL', '模型面数太少，无法切割');
    if (built.err) {
      return fail('NOT_MANIFOLD', notManifoldReason(pos.length / 9, built), { status: built.status, left: built.left });
    }
    ms.weld = +(performance.now() - t).toFixed(1);
    if (built.repairMs != null) ms.repair = built.repairMs;   // ms.weld 是整个建网格步骤（含修复）
    if (built.repair) for (const w of built.repair.warn || []) warn.push(w);
    t = performance.now();

    const fr = frameOf(req.plane.c, n0);
    const src = built.M;
    const Mp = T(src.transform(fr.toLocal));
    const bb = Mp.boundingBox();
    const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
    let dev = 0;
    for (let i = 0; i < loop.length; i += 3) {
      dev = Math.max(dev, Math.abs((loop[i] - fr.c[0]) * n0[0] + (loop[i + 1] - fr.c[1]) * n0[1] + (loop[i + 2] - fr.c[2]) * n0[2]));
    }
    const curved = req.surface !== 'plane' && dev > FLAT_TOL;
    const spec = req.pin ? { ...PIN_DEFAULTS, ...req.pin } : null;
    const vSrc = src.volume();

    let upper, lower, pin = null, merged = 0, comps = null, islandsN = 0, star = 0, iou = 0, area = 0, sheet = null;
    if (curved) {
      /* 沿画线的曲面切 */
      const c = cutCurved(MF, { Mp, bb, fr, loop, spec, T, ms, warn, gap: req.gap, wall: req.wall });
      if (c.err) return c.err;
      ({ upper, lower, pin, merged, comps, sheet } = c);
      islandsN = c.islands; star = c.picked; iou = c.iou; area = c.area;
      t = performance.now();
    } else {
      /* 平面切 */
      if (!(bb.min[2] < -1e-6 * diag && bb.max[2] > 1e-6 * diag)) return fail('PLANE_MISS', '切面没有穿过模型，请把画线圈在模型的某一圈上');
      /* 切面贴着端面：切下来的是一层薄片，打印不出来也放不下销。线画在刚切过的切缝上再切一次就是这种情形 */
      const thin = Math.min(bb.max[2], -bb.min[2]);
      if (thin < MIN_PIECE) return fail('SLIVER', `这一刀离模型的端面只有 ${thin.toFixed(2)} mm，只会切下一层薄片。请把线画得离端面远一点（至少 ${MIN_PIECE} mm）`);
      const cs = T(Mp.slice(0));
      if (cs.isEmpty()) return fail('PLANE_MISS', '切面没有穿过模型，请把画线圈在模型的某一圈上');
      const islands = cs.decompose().map(T);
      t = lap('slice', t);

      /* 画线投影到切面，与哪个岛重合度（交并比）最高就切哪个岛 */
      const loop2 = [];
      for (let i = 0; i < loop.length; i += 3) {
        const d = [loop[i] - fr.c[0], loop[i + 1] - fr.c[1], loop[i + 2] - fr.c[2]];
        loop2.push([dot(d, fr.u), dot(d, fr.v)]);
      }
      const pick = pickStar(MF, islands, loop2, T, warn);
      if (pick.err) return pick.err;
      star = pick.star; iou = pick.ious[star]; islandsN = islands.length;
      const starRings = ringsOf(islands[star]);
      area = islands[star].area();
      t = lap('pick', t);

      /* 切开；多个岛时把别的岛合回去 */
      const [up, dn] = Mp.splitByPlane([0, 0, 1], 0).map(T);
      if (up.isEmpty() || dn.isEmpty()) return fail('EMPTY_PART', '这一刀没有把模型分成两块（切面只擦到了边缘）');
      t = lap('split', t);
      upper = up; lower = dn;
      if (islands.length > 1) {
        const g = regroup(MF, up, dn, islands, star, diag, T);
        if (g.err) return g.err;
        upper = g.upper; lower = g.lower; merged = g.merged; comps = g.comps;
      }
      t = lap('regroup', t);

      /* 梯形销：最大内切圆圆心，长边沿截面长轴 */
      if (spec) {
        const pole = poleOf(starRings, RING_SIMP * 5);
        const { theta } = principalAngle(outerOf(starRings));
        const r = placePin(MF, { upper, lower, pole, theta, spec, frame: fr }, T);
        if (r.warn) warn.push(r.warn);
        if (r.pin) { upper = r.upper; lower = r.lower; pin = r.pin; }
      }
      t = lap('pin', t);
    }

    /* 回到调用方的坐标系，输出非索引汤 */
    const outU = soupOf(T(upper.transform(fr.toWorld)));
    const outL = soupOf(T(lower.transform(fr.toWorld)));
    lap('out', t);
    ms.total = +(performance.now() - t0).toFixed(1);
    return {
      ok: true,
      upper: { pos: outU }, lower: { pos: outL },
      info: {
        surface: curved ? 'line' : 'plane', dev, sheet,
        tris: { src: pos.length / 9, welded: built.tris, upper: outU.length / 9, lower: outL.length / 9 },
        dropped: built.dropped,
        vol: { src: vSrc, upper: upper.volume(), lower: lower.volume() },
        islands: islandsN, picked: star, iou, area, merged, comps,
        pin, warn: warn.filter(Boolean), ms,
        repair: built.repair,   // 网格不是水密时自动修复的报告（没修过为 null）
      },
    };
  } catch (e) {
    return fail('KERNEL', `几何内核出错：${(e && e.message) || e}`);
  } finally {
    for (const o of gc) { try { o.delete(); } catch { /* 已释放 */ } }
  }
}

/* 画线模块与验收脚本用 */
export { fitPlane, soupOf, weldSoup, buildManifold, FLAT_TOL, buildManifoldAuto, repairIndexed, describeRepair, topoCheck };


