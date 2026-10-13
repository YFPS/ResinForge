/* ================================================================
   几何规格的紧凑编码（主线程 ↔ 几何后台线程）
   ----------------------------------------------------------------
   支撑塔规格里是几十万个 [x, y] 小数组（墙面多边形）和上千组凸包点。直接 postMessage 要在主线程做
   结构化克隆，逐个复制小数组；这里压成定长类型数组，postMessage 时整块转交（transfer，零拷贝）。
================================================================ */

/** 多边形 / 点组列表 → { xy: Float64Array, len: Int32Array, dim }；类型数组的 buffer 记入 transfer */
function encList(list, dim, transfer) {
  let n = 0;
  for (const p of list) n += p.length;
  const xy = new Float64Array(n * dim), len = new Int32Array(list.length);
  let o = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    len[i] = p.length;
    for (const v of p) for (let d = 0; d < dim; d++) xy[o++] = v[d];
  }
  transfer.push(xy.buffer, len.buffer);
  return { xy, len, dim };
}

function decList(e) {
  const out = [];
  let o = 0;
  for (let i = 0; i < e.len.length; i++) {
    const p = new Array(e.len[i]);
    for (let j = 0; j < e.len[i]; j++, o += e.dim) p[j] = e.dim === 2 ? [e.xy[o], e.xy[o + 1]] : [e.xy[o], e.xy[o + 1], e.xy[o + 2]];
    out.push(p);
  }
  return out;
}

/** 规格 → { data, transfer }：data 可直接 postMessage(data, transfer) */
export function encodeSpec(spec) {
  const transfer = [];
  const data = {
    t: spec.t, rFil: spec.rFil, seg: spec.seg,
    walls: spec.walls.map(w => ({ pl: w.pl, c: w.c, col: encList(w.col, 2, transfer), web: encList(w.web, 2, transfer), clip: encList(w.clip, 2, transfer), sub: encList(w.sub || [], 2, transfer) })),
    slabs: (spec.slabs || []).map(s => ({ pl: s.pl, c: s.c, half: s.half, polys: encList(s.polys, 2, transfer) })),
    hulls: encList(spec.hulls, 3, transfer),
    cuts: spec.cuts || [],
  };
  return { data, transfer };
}

/** encodeSpec 的逆过程（在后台线程里做，不占主线程） */
export function decodeSpec(data) {
  return {
    t: data.t, rFil: data.rFil, seg: data.seg,
    walls: data.walls.map(w => ({ pl: w.pl, c: w.c, col: decList(w.col), web: decList(w.web), clip: decList(w.clip), sub: w.sub ? decList(w.sub) : [] })),
    slabs: data.slabs.map(s => ({ pl: s.pl, c: s.c, half: s.half, polys: decList(s.polys) })),
    hulls: decList(data.hulls),
    cuts: data.cuts,
  };
}
