/* ================================================================
   模型简化：二次误差边折叠（Garland & Heckbert 1997 的公开方法）。
   两种停止条件，对应切片软件里的「按保真度」和「按三角形比例」：
   - 保真度 1～10，越高允许的几何误差越小，表面越接近原件
   - 比例 0.01～0.99，留下这么多比例的三角形
   输入输出都是非索引三角形坐标。不依赖 three。
================================================================ */

function weld(pos) {
  const nCorner = pos.length / 3;
  const bits = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
  const map = new Map();
  const ids = new Int32Array(nCorner);
  const xyz = [];
  let n = 0;
  for (let v = 0; v < nCorner; v++) {
    const i = v * 3;
    const key = bits[i] + ':' + bits[i + 1] + ':' + bits[i + 2];
    let id = map.get(key);
    if (id === undefined) {
      id = n++;
      map.set(key, id);
      xyz.push(pos[i], pos[i + 1], pos[i + 2]);
    }
    ids[v] = id;
  }
  const faces = [];
  for (let t = 0; t < nCorner; t += 3) {
    const a = ids[t], b = ids[t + 1], c = ids[t + 2];
    if (a !== b && b !== c && c !== a) faces.push(a, b, c);
  }
  return { xyz: Float64Array.from(xyz), faces: Int32Array.from(faces), n };
}

function addPlane(q, nx, ny, nz, d, w) {
  q[0] += w * nx * nx; q[1] += w * nx * ny; q[2] += w * nx * nz; q[3] += w * nx * d;
  q[4] += w * ny * ny; q[5] += w * ny * nz; q[6] += w * ny * d;
  q[7] += w * nz * nz; q[8] += w * nz * d;
  q[9] += w * d * d;
}

function qErr(q, x, y, z) {
  return q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x
    + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y
    + q[7] * z * z + 2 * q[8] * z
    + q[9];
}

function addQ(dst, src) {
  for (let i = 0; i < 10; i++) dst[i] += src[i];
}

/* 解对称 3×3。失败时返回 null，调用方改在端点和中点里挑。 */
function solvePoint(q) {
  const a = q[0], b = q[1], c = q[2], d = q[4], e = q[5], f = q[7];
  const rx = -q[3], ry = -q[6], rz = -q[8];
  const det = a * (d * f - e * e) - b * (b * f - e * c) + c * (b * e - d * c);
  if (Math.abs(det) < 1e-18) return null;
  const inv = 1 / det;
  const x = inv * (rx * (d * f - e * e) - b * (ry * f - e * rz) + c * (ry * e - d * rz));
  const y = inv * (a * (ry * f - e * rz) - rx * (b * f - c * e) + c * (b * rz - c * ry));
  const z = inv * (a * (d * rz - e * ry) - b * (b * rz - c * ry) + rx * (b * e - d * c));
  if (!Number.isFinite(x + y + z)) return null;
  return [x, y, z];
}

function heapPush(h, item) {
  h.push(item);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p].err <= h[i].err) break;
    const s = h[p]; h[p] = h[i]; h[i] = s;
    i = p;
  }
}
function heapPop(h) {
  const top = h[0];
  const last = h.pop();
  if (!h.length || !top) return top;
  h[0] = last;
  let i = 0;
  for (;;) {
    const l = i * 2 + 1, r = l + 1;
    let s = i;
    if (l < h.length && h[l].err < h[s].err) s = l;
    if (r < h.length && h[r].err < h[s].err) s = r;
    if (s === i) break;
    const t = h[i]; h[i] = h[s]; h[s] = t;
    i = s;
  }
  return top;
}

function edgeKey(a, b, n) {
  return a < b ? a * n + b : b * n + a;
}

/**
 * @param {Float32Array} pos 非索引三角形
 * @param {{mode?: 'ratio'|'fidelity', ratio?: number, fidelity?: number, onProgress?: (t:number)=>void}} opts
 */
export function decimate(pos, opts = {}) {
  const mode = opts.mode === 'fidelity' ? 'fidelity' : 'ratio';
  const ratio = Math.min(0.9999, Math.max(0.01, opts.ratio == null ? 0.5 : opts.ratio));
  const fidelity = Math.min(10, Math.max(1, opts.fidelity == null ? 5 : opts.fidelity));
  const welded = weld(pos);
  const xyz = welded.xyz;
  const faces = welded.faces;
  const V = welded.n;
  const F = faces.length / 3;
  if (F < 8) return { positions: pos, normals: null, nfIn: pos.length / 9, nfOut: pos.length / 9 };

  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < xyz.length; i += 3) {
    const x = xyz[i], y = xyz[i + 1], z = xyz[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  // 允许偏离 = 包围盒对角线 × 10^(-保真度)。滑块越大，偏离越小。
  // 1 大约是对角线的一成（简化多）；5 是十万分之一，凑近仍是原表面，只去掉测不到的碎面。
  const tau = diag * Math.pow(10, -fidelity);
  const errLimit = tau * tau;
  const target = mode === 'ratio' ? Math.max(4, Math.round(F * ratio)) : 4;

  const Q = new Float64Array(V * 10);
  const area = new Float64Array(V);
  const aliveF = new Uint8Array(F);
  aliveF.fill(1);
  const vf = Array.from({ length: V }, () => []);
  for (let f = 0; f < F; f++) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    vf[a].push(f); vf[b].push(f); vf[c].push(f);
    const ax = xyz[a * 3], ay = xyz[a * 3 + 1], az = xyz[a * 3 + 2];
    const bx = xyz[b * 3], by = xyz[b * 3 + 1], bz = xyz[b * 3 + 2];
    const cx = xyz[c * 3], cy = xyz[c * 3 + 1], cz = xyz[c * 3 + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-20) { aliveF[f] = 0; continue; }
    nx /= len; ny /= len; nz /= len;
    const d = -(nx * ax + ny * ay + nz * az);
    const faceArea = len * 0.5;
    area[a] += faceArea; area[b] += faceArea; area[c] += faceArea;
    addPlane(Q.subarray(a * 10, a * 10 + 10), nx, ny, nz, d, faceArea);
    addPlane(Q.subarray(b * 10, b * 10 + 10), nx, ny, nz, d, faceArea);
    addPlane(Q.subarray(c * 10, c * 10 + 10), nx, ny, nz, d, faceArea);
  }

  const edgeFaces = new Map();
  const touch = (a, b, f) => {
    const k = edgeKey(a, b, V);
    let e = edgeFaces.get(k);
    if (!e) edgeFaces.set(k, e = []);
    e.push(f);
  };
  for (let f = 0; f < F; f++) {
    if (!aliveF[f]) continue;
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    touch(a, b, f); touch(b, c, f); touch(c, a, f);
  }
  // 边界边加一道垂直于面的惩罚，避免开口被拉走
  for (const [k, fl] of edgeFaces) {
    if (fl.length !== 1 || !aliveF[fl[0]]) continue;
    const a = k % V, b = (k - a) / V;
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const f = fl[0];
    const ia = faces[f * 3], ib = faces[f * 3 + 1], ic = faces[f * 3 + 2];
    const ax = xyz[ia * 3], ay = xyz[ia * 3 + 1], az = xyz[ia * 3 + 2];
    const bx = xyz[ib * 3], by = xyz[ib * 3 + 1], bz = xyz[ib * 3 + 2];
    const cx = xyz[ic * 3], cy = xyz[ic * 3 + 1], cz = xyz[ic * 3 + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const ex = xyz[hi * 3] - xyz[lo * 3], ey = xyz[hi * 3 + 1] - xyz[lo * 3 + 1], ez = xyz[hi * 3 + 2] - xyz[lo * 3 + 2];
    let px = ey * nz - ez * ny, py = ez * nx - ex * nz, pz = ex * ny - ey * nx;
    const pl = Math.hypot(px, py, pz);
    if (pl < 1e-20) continue;
    px /= pl; py /= pl; pz /= pl;
    const d = -(px * xyz[lo * 3] + py * xyz[lo * 3 + 1] + pz * xyz[lo * 3 + 2]);
    const w = Math.hypot(ex, ey, ez);
    addPlane(Q.subarray(lo * 10, lo * 10 + 10), px, py, pz, d, w);
    addPlane(Q.subarray(hi * 10, hi * 10 + 10), px, py, pz, d, w);
  }

  const ver = new Map();
  const heap = [];
  const edgeUses = (a, b) => {
    let n = 0;
    const list = vf[a];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!aliveF[f]) continue;
      const t0 = faces[f * 3], t1 = faces[f * 3 + 1], t2 = faces[f * 3 + 2];
      if ((t0 === a || t1 === a || t2 === a) && (t0 === b || t1 === b || t2 === b)) n++;
    }
    return n;
  };
  const consider = (a, b) => {
    if (a === b) return;
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const uses = edgeUses(lo, hi);
    if (uses < 1 || uses > 2) return;
    const q = new Float64Array(10);
    addQ(q, Q.subarray(lo * 10, lo * 10 + 10));
    addQ(q, Q.subarray(hi * 10, hi * 10 + 10));
    const ax = xyz[lo * 3], ay = xyz[lo * 3 + 1], az = xyz[lo * 3 + 2];
    const bx = xyz[hi * 3], by = xyz[hi * 3 + 1], bz = xyz[hi * 3 + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const ab2 = abx * abx + aby * aby + abz * abz;
    // 折痕（眼睑、嘴唇、耳廓）不允许新点离开这条边，否则最优解会顺着平面滑出去，表面被抹平。
    let sharp = false;
    if (uses === 2) {
      const ns = [];
      const list = vf[lo];
      for (let i = 0; i < list.length && ns.length < 2; i++) {
        const f = list[i];
        if (!aliveF[f]) continue;
        const t0 = faces[f * 3], t1 = faces[f * 3 + 1], t2 = faces[f * 3 + 2];
        if (!((t0 === lo || t1 === lo || t2 === lo) && (t0 === hi || t1 === hi || t2 === hi))) continue;
        const p0x = xyz[t0 * 3], p0y = xyz[t0 * 3 + 1], p0z = xyz[t0 * 3 + 2];
        const p1x = xyz[t1 * 3], p1y = xyz[t1 * 3 + 1], p1z = xyz[t1 * 3 + 2];
        const p2x = xyz[t2 * 3], p2y = xyz[t2 * 3 + 1], p2z = xyz[t2 * 3 + 2];
        let nx = (p1y - p0y) * (p2z - p0z) - (p1z - p0z) * (p2y - p0y);
        let ny = (p1z - p0z) * (p2x - p0x) - (p1x - p0x) * (p2z - p0z);
        let nz = (p1x - p0x) * (p2y - p0y) - (p1y - p0y) * (p2x - p0x);
        const nl = Math.hypot(nx, ny, nz) || 1;
        ns.push([nx / nl, ny / nl, nz / nl]);
      }
      if (ns.length === 2 && ns[0][0] * ns[1][0] + ns[0][1] * ns[1][1] + ns[0][2] * ns[1][2] < 0.64) sharp = true;
    }
    const stay = sharp ? ab2 * 0.0004 : ab2;
    const near = (c) => {
      if (!c || !Number.isFinite(c[0] + c[1] + c[2])) return false;
      let t = ab2 < 1e-20 ? 0 : ((c[0] - ax) * abx + (c[1] - ay) * aby + (c[2] - az) * abz) / ab2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const dx = c[0] - (ax + abx * t), dy = c[1] - (ay + aby * t), dz = c[2] - (az + abz * t);
      return dx * dx + dy * dy + dz * dz <= stay + 1e-12;
    };
    const mid = [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2];
    const cands = [solvePoint(q), [ax, ay, az], [bx, by, bz], mid];
    let raw = Infinity, pick = mid;
    for (const c of cands) {
      if (!near(c)) continue;
      let e = qErr(q, c[0], c[1], c[2]);
      if (!Number.isFinite(e)) continue;
      if (e < 0) e = 0;
      if (e < raw) { raw = e; pick = c; }
    }
    if (!Number.isFinite(raw)) raw = 0;
    const denom = area[lo] + area[hi];
    const err = denom > 1e-20 ? raw / denom : raw;
    const key = edgeKey(lo, hi, V);
    const version = (ver.get(key) || 0) + 1;
    ver.set(key, version);
    heapPush(heap, { lo, hi, err, x: pick[0], y: pick[1], z: pick[2], version });
  };

  for (const [k, fl] of edgeFaces) {
    if (!fl.length || fl.length > 2) continue;
    const a = k % V, b = (k - a) / V;
    consider(a < b ? a : b, a < b ? b : a);
  }

  let left = 0;
  for (let f = 0; f < F; f++) if (aliveF[f]) left++;
  const onProgress = opts.onProgress;
  let collapsed = 0;

  const faceOk = (f, keep, drop, nx, ny, nz) => {
    let a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    if (a === drop) a = keep; else if (b === drop) b = keep; else if (c === drop) c = keep;
    if (a === b || b === c || c === a) return true;
    const ax = a === keep ? nx : xyz[a * 3], ay = a === keep ? ny : xyz[a * 3 + 1], az = a === keep ? nz : xyz[a * 3 + 2];
    const bx = b === keep ? nx : xyz[b * 3], by = b === keep ? ny : xyz[b * 3 + 1], bz = b === keep ? nz : xyz[b * 3 + 2];
    const cx = c === keep ? nx : xyz[c * 3], cy = c === keep ? ny : xyz[c * 3 + 1], cz = c === keep ? nz : xyz[c * 3 + 2];
    const ox = xyz[faces[f * 3] * 3], oy = xyz[faces[f * 3] * 3 + 1], oz = xyz[faces[f * 3] * 3 + 2];
    const px = xyz[faces[f * 3 + 1] * 3], py = xyz[faces[f * 3 + 1] * 3 + 1], pz = xyz[faces[f * 3 + 1] * 3 + 2];
    const qx = xyz[faces[f * 3 + 2] * 3], qy = xyz[faces[f * 3 + 2] * 3 + 1], qz = xyz[faces[f * 3 + 2] * 3 + 2];
    const onx = (py - oy) * (qz - oz) - (pz - oz) * (qy - oy);
    const ony = (pz - oz) * (qx - ox) - (px - ox) * (qz - oz);
    const onz = (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
    const nnx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const nny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nnz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    return onx * nnx + ony * nny + onz * nnz > 0;
  };

  while (heap.length && left > target) {
    const e = heapPop(heap);
    if (!e) break;
    const key = edgeKey(e.lo, e.hi, V);
    if (ver.get(key) !== e.version) continue;
    if (mode === 'fidelity' && e.err > errLimit) break;
    // 边的邻接在折叠后会变，不能用最初的边表
    const uses = edgeUses(e.lo, e.hi);
    if (uses < 1 || uses > 2) continue;
    const incident = [];
    for (const f of vf[e.lo]) if (aliveF[f]) incident.push(f);
    for (const f of vf[e.hi]) if (aliveF[f] && !incident.includes(f)) incident.push(f);
    let safe = true;
    for (const f of incident) {
      const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
      const uses = (a === e.lo || a === e.hi) + (b === e.lo || b === e.hi) + (c === e.lo || c === e.hi);
      if (uses >= 2) continue;
      if (!faceOk(f, e.lo, e.hi, e.x, e.y, e.z)) { safe = false; break; }
    }
    if (!safe) continue;

    xyz[e.lo * 3] = e.x; xyz[e.lo * 3 + 1] = e.y; xyz[e.lo * 3 + 2] = e.z;
    addQ(Q.subarray(e.lo * 10, e.lo * 10 + 10), Q.subarray(e.hi * 10, e.hi * 10 + 10));
    area[e.lo] += area[e.hi];

    for (const f of incident) {
      let a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
      if (a === e.hi) a = e.lo;
      if (b === e.hi) b = e.lo;
      if (c === e.hi) c = e.lo;
      faces[f * 3] = a; faces[f * 3 + 1] = b; faces[f * 3 + 2] = c;
      if (a === b || b === c || c === a) {
        if (aliveF[f]) { aliveF[f] = 0; left--; }
      }
    }
    vf[e.lo] = incident.filter(f => aliveF[f]);
    vf[e.hi] = [];
    const seen = new Set();
    for (const f of vf[e.lo]) {
      const tri = [faces[f * 3], faces[f * 3 + 1], faces[f * 3 + 2]];
      for (let i = 0; i < 3; i++) {
        const u = tri[i], v = tri[(i + 1) % 3];
        if (u !== e.lo && v !== e.lo) continue;
        const other = u === e.lo ? v : u;
        if (seen.has(other)) continue;
        seen.add(other);
        consider(e.lo, other);
      }
    }
    collapsed++;
    if (onProgress && collapsed % 2000 === 0) onProgress(Math.min(0.95, collapsed / Math.max(1, F - target)));
  }

  const out = [];
  for (let f = 0; f < F; f++) {
    if (!aliveF[f]) continue;
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    out.push(
      xyz[a * 3], xyz[a * 3 + 1], xyz[a * 3 + 2],
      xyz[b * 3], xyz[b * 3 + 1], xyz[b * 3 + 2],
      xyz[c * 3], xyz[c * 3 + 1], xyz[c * 3 + 2],
    );
  }
  const positions = Float32Array.from(out);
  return { positions, nfIn: pos.length / 9, nfOut: positions.length / 9 };
}
