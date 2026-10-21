/* ================================================================
   大模型导入：二进制 STL 直读。减面只在文件达到 1GB 且用户同意时发生，
   按 Blueprint Studio 的比例保留三角形（1～2GB 留 50%，2～3GB 留 40%，更大留 30%）。
   减面后的法线按共用顶点平均，避免平面着色把表面糊成一块。
   不依赖 three / React。
================================================================ */

/* Blueprint Studio：文件不到 1GB 不减面。超过才询问，并按大小保留一定比例的三角形。 */
export const SIMPLIFY_MIN_BYTES = 1024 * 1024 * 1024;

export function blueprintRatio(bytes) {
  if (bytes > 3 * SIMPLIFY_MIN_BYTES) return 0.3;
  if (bytes > 2 * SIMPLIFY_MIN_BYTES) return 0.4;
  if (bytes >= SIMPLIFY_MIN_BYTES) return 0.5;
  return 1;
}

/* 文件长度对得上「84 + 面数×50」就按二进制读。不少二进制 STL 的头也以 solid 开头。 */
export function isBinarySTL(buf) {
  if (!buf || buf.byteLength < 84) return false;
  const n = new DataView(buf).getUint32(80, true);
  if (!Number.isFinite(n) || n <= 0) return false;
  const expect = 84 + n * 50;
  return expect === buf.byteLength || (expect < buf.byteLength && buf.byteLength - expect < 128);
}

/* 二进制 STL → Y-up 三角形坐标（载入时 rotateX(-90°)：(x,y,z) → (x,z,-y)）。忽略法线。 */
export function parseBinarySTL(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  const pos = new Float32Array(n * 9);
  let o = 84;
  let w = 0;
  for (let f = 0; f < n; f++) {
    o += 12;   // 跳过法线
    for (let v = 0; v < 3; v++) {
      const x = dv.getFloat32(o, true);
      const y = dv.getFloat32(o + 4, true);
      const z = dv.getFloat32(o + 8, true);
      o += 12;
      pos[w++] = x;
      pos[w++] = z;
      pos[w++] = -y;
    }
    o += 2;
  }
  return pos;
}

function bboxOf(pos) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/* 把顶点收进格子。返回新的三角形坐标，或只返回面数（emit=false 用来试格子大小）。 */
function cluster(pos, minX, minY, minZ, cell, emit) {
  const S = 4096;
  const inv = 1 / cell;
  const groups = new Map();
  const corner = (x, y, z) => {
    let ix = (x - minX) * inv, iy = (y - minY) * inv, iz = (z - minZ) * inv;
    ix = ix < 0 ? 0 : (ix >= S ? S - 1 : ix | 0);
    iy = iy < 0 ? 0 : (iy >= S ? S - 1 : iy | 0);
    iz = iz < 0 ? 0 : (iz >= S ? S - 1 : iz | 0);
    const k = ix + iy * S + iz * S * S;
    let g = groups.get(k);
    if (!g) groups.set(k, g = [0, 0, 0, 0]);
    g[0] += x; g[1] += y; g[2] += z; g[3]++;
    return k;
  };
  const nTri = pos.length / 9;
  const keys = new Float64Array(nTri * 3);
  for (let t = 0, k = 0; t < nTri; t++) {
    const i = t * 9;
    keys[k++] = corner(pos[i], pos[i + 1], pos[i + 2]);
    keys[k++] = corner(pos[i + 3], pos[i + 4], pos[i + 5]);
    keys[k++] = corner(pos[i + 6], pos[i + 7], pos[i + 8]);
  }
  let id = 0;
  for (const g of groups.values()) g[4] = id++;
  let faces = 0;
  let out = null;
  let w = 0;
  if (emit) {
    out = {
      pos: new Float32Array(nTri * 9),
      ids: new Uint32Array(nTri * 3),
      acc: new Float32Array(id * 3),
    };
  }
  for (let t = 0; t < nTri; t++) {
    const ka = keys[t * 3], kb = keys[t * 3 + 1], kc = keys[t * 3 + 2];
    if (ka === kb || kb === kc || kc === ka) continue;
    const a = groups.get(ka), b = groups.get(kb), c = groups.get(kc);
    const ax = a[0] / a[3], ay = a[1] / a[3], az = a[2] / a[3];
    const bx = b[0] / b[3], by = b[1] / b[3], bz = b[2] / b[3];
    const cx = c[0] / c[3], cy = c[1] / c[3], cz = c[2] / c[3];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    if ((uy * vz - uz * vy) ** 2 + (uz * vx - ux * vz) ** 2 + (ux * vy - uy * vx) ** 2 < 1e-16) continue;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    faces++;
    if (out) {
      out.pos[w] = ax; out.pos[w + 1] = ay; out.pos[w + 2] = az;
      out.pos[w + 3] = bx; out.pos[w + 4] = by; out.pos[w + 5] = bz;
      out.pos[w + 6] = cx; out.pos[w + 7] = cy; out.pos[w + 8] = cz;
      const ia = a[4], ib = b[4], ic = c[4];
      out.acc[ia * 3] += nx; out.acc[ia * 3 + 1] += ny; out.acc[ia * 3 + 2] += nz;
      out.acc[ib * 3] += nx; out.acc[ib * 3 + 1] += ny; out.acc[ib * 3 + 2] += nz;
      out.acc[ic * 3] += nx; out.acc[ic * 3 + 1] += ny; out.acc[ic * 3 + 2] += nz;
      out.ids[w / 3] = ia; out.ids[w / 3 + 1] = ib; out.ids[w / 3 + 2] = ic;
      w += 9;
    }
  }
  if (!out) return faces;
  const positions = faces === nTri ? out.pos : out.pos.slice(0, faces * 9);
  const normals = new Float32Array(positions.length);
  const ids = faces === nTri ? out.ids : out.ids.subarray(0, faces * 3);
  for (let v = 0; v < ids.length; v++) {
    const o = ids[v] * 3;
    let x = out.acc[o], y = out.acc[o + 1], z = out.acc[o + 2];
    const len = Math.hypot(x, y, z) || 1;
    normals[v * 3] = x / len;
    normals[v * 3 + 1] = y / len;
    normals[v * 3 + 2] = z / len;
  }
  return { positions, normals, faces };
}

/**
 * 按保留比例收面。targetFaces 不低于原面数时不改。
 * 返回 { positions, normals }。normals 只在真正减面时有，按共用顶点平均，避免一块一块的平面着色。
 */
export function clusterSimplify(pos, targetFaces) {
  const n = pos.length / 9;
  if (!targetFaces || n <= targetFaces) return { positions: pos, normals: null };
  const box = bboxOf(pos);
  const ex = Math.max(box.maxX - box.minX, 1e-6);
  const ey = Math.max(box.maxY - box.minY, 1e-6);
  const ez = Math.max(box.maxZ - box.minZ, 1e-6);
  const area = ex * ey + ey * ez + ez * ex;
  let cell = Math.max(Math.sqrt(area / Math.max(1, targetFaces)), Math.max(ex, ey, ez) / 2048);
  let bestCell = cell;
  let bestFaces = n;
  for (let iter = 0; iter < 6; iter++) {
    const faces = cluster(pos, box.minX, box.minY, box.minZ, cell, false);
    if (faces > 0 && faces < bestFaces) { bestFaces = faces; bestCell = cell; }
    if (faces <= targetFaces * 1.08 && faces >= targetFaces * 0.72) break;
    if (faces === 0) cell *= 0.5;
    else cell *= Math.sqrt(Math.max(faces, 1) / targetFaces);
  }
  const out = cluster(pos, box.minX, box.minY, box.minZ, bestCell, true);
  if (!out || out.faces >= n) return { positions: pos, normals: null };
  return { positions: out.positions, normals: out.normals };
}

/* 底面落到 y=0，XZ 居中。frameOf 与 applyFrame 分开，是为了让简化网格和原始网格用同一组平移。 */
export function frameOf(pos) {
  const box = bboxOf(pos);
  return { cx: (box.minX + box.maxX) / 2, minY: box.minY, cz: (box.minZ + box.maxZ) / 2 };
}
export function applyFrame(pos, frame) {
  const { cx, minY, cz } = frame;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] -= cx;
    pos[i + 1] -= minY;
    pos[i + 2] -= cz;
  }
}

/* 非索引三角汤上，把位置相同、朝向接近的顶点法线平均。
   夹角大于约 50° 的折痕（眼睑、嘴唇、耳廓）不参与平均，避免减面后被涂成一块。 */
export function smoothSoupNormals(pos) {
  const CREASE = 0.64;
  const nV = pos.length / 3;
  const bits = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
  const map = new Map();
  const ids = new Int32Array(nV);
  let uniq = 0;
  for (let v = 0; v < nV; v++) {
    const i = v * 3;
    const key = bits[i] + ':' + bits[i + 1] + ':' + bits[i + 2];
    let id = map.get(key);
    if (id === undefined) { id = uniq++; map.set(key, id); }
    ids[v] = id;
  }
  const buckets = Array.from({ length: uniq }, () => []);
  const faceN = new Float32Array(nV * 3);
  for (let t = 0; t < pos.length; t += 9) {
    const ax = pos[t], ay = pos[t + 1], az = pos[t + 2];
    const bx = pos[t + 3], by = pos[t + 4], bz = pos[t + 5];
    const cx = pos[t + 6], cy = pos[t + 7], cz = pos[t + 8];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const w = len * 0.5;
    const base = t / 3;
    for (let k = 0; k < 3; k++) {
      faceN[(base + k) * 3] = nx;
      faceN[(base + k) * 3 + 1] = ny;
      faceN[(base + k) * 3 + 2] = nz;
      buckets[ids[base + k]].push(nx, ny, nz, w);
    }
  }
  const normals = new Float32Array(pos.length);
  for (let v = 0; v < nV; v++) {
    const nx = faceN[v * 3], ny = faceN[v * 3 + 1], nz = faceN[v * 3 + 2];
    const bag = buckets[ids[v]];
    let ax = 0, ay = 0, az = 0;
    for (let i = 0; i < bag.length; i += 4) {
      if (bag[i] * nx + bag[i + 1] * ny + bag[i + 2] * nz < CREASE) continue;
      const w = bag[i + 3];
      ax += bag[i] * w; ay += bag[i + 1] * w; az += bag[i + 2] * w;
    }
    const len = Math.hypot(ax, ay, az) || 1;
    normals[v * 3] = ax / len;
    normals[v * 3 + 1] = ay / len;
    normals[v * 3 + 2] = az / len;
  }
  return normals;
}

/* 与 bakePartRotation 同一套变换，作用在导出用的原始顶点上。 */
export function bakeSource(arr, q, cy, cx, minY, cz) {
  if (!arr || !q) return;
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  for (let i = 0; i < arr.length; i += 3) {
    const vx = arr[i];
    const vy = arr[i + 1] - cy;
    const vz = arr[i + 2];
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    const rx = vx + qw * tx + (qy * tz - qz * ty);
    const ry = vy + qw * ty + (qz * tx - qx * tz);
    const rz = vz + qw * tz + (qx * ty - qy * tx);
    arr[i] = rx - cx;
    arr[i + 1] = ry + cy - minY;
    arr[i + 2] = rz - cz;
  }
}
