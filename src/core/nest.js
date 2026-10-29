/* 板面自动排版。
   外接矩形用最大矩形法（短边剩余 / 面积剩余 / 靠角，再配几种放入顺序）铺满板面。
   绕竖直轴的几个角度里，选当下最省地方的一个。
   轮廓没铺满外接矩形时（环、凹形），再用位图把小件塞进空档，间距仍按膨胀后的轮廓算。 */

const ANGLES = [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4];

function lowMask(n) {
  if (n >= 32) return 0xFFFFFFFF;
  return (0xFFFFFFFF >>> (32 - n)) >>> 0;
}

function Grid(w, h) {
  this.w = w;
  this.h = h;
  this.words = (w + 31) >> 5;
  this.bits = new Uint32Array(Math.max(1, h * this.words));
}

/* 两段不一定字对齐的位是否有交。n 是要比的位数。 */
function rangeOverlaps(src, srcBit, dst, dstBit, n) {
  while (n > 0) {
    const sOff = srcBit & 31;
    const dOff = dstBit & 31;
    const take = Math.min(n, 32 - sOff, 32 - dOff);
    const mask = lowMask(take);
    const a = (src[srcBit >> 5] >>> sOff) & mask;
    const b = (dst[dstBit >> 5] >>> dOff) & mask;
    if ((a & b) !== 0) return true;
    srcBit += take;
    dstBit += take;
    n -= take;
  }
  return false;
}

function rowHits(occ, py, ox, maskRow, maskBits) {
  let srcBit = 0;
  let dstBit = ox;
  if (dstBit < 0) {
    srcBit = -dstBit;
    dstBit = 0;
  }
  if (srcBit >= maskBits || dstBit >= occ.w) return false;
  const n = Math.min(maskBits - srcBit, occ.w - dstBit);
  if (n <= 0) return false;
  const dst = occ.bits.subarray(py * occ.words, py * occ.words + occ.words);
  return rangeOverlaps(maskRow, srcBit, dst, dstBit, n);
}

/* 膨胀后的掩码可以探出板外，探出的部分当作没有碰撞。实心部分必须整块落在板内，由调用方先查。 */
function overlaps(occ, dil, cx, cz) {
  const ox = cx + dil.minIx;
  const oz = cz + dil.minIz;
  for (let y = 0; y < dil.bh; y++) {
    const py = oz + y;
    if (py < 0 || py >= occ.h) continue;
    const row = dil.bits.subarray(y * dil.words, y * dil.words + dil.words);
    if (rowHits(occ, py, ox, row, dil.bw)) return true;
  }
  return false;
}

function stamp(occ, raw, cx, cz) {
  const ox = cx + raw.minIx;
  const oz = cz + raw.minIz;
  for (let y = 0; y < raw.bh; y++) {
    const py = oz + y;
    if (py < 0 || py >= occ.h) continue;
    const src = raw.bits.subarray(y * raw.words, y * raw.words + raw.words);
    let x = 0;
    const x0 = ox;
    while (x < raw.bw) {
      const word = src[x >> 5];
      const limit = Math.min(raw.bw, (x & ~31) + 32);
      if (word) {
        for (let b = x; b < limit; b++) {
          if ((word & (1 << (b & 31))) === 0) continue;
          const px = x0 + b;
          if (px < 0 || px >= occ.w) continue;
          occ.bits[py * occ.words + (px >> 5)] |= 1 << (px & 31);
        }
      }
      x = limit;
    }
  }
}

function clearGrid(occ) {
  occ.bits.fill(0);
}

/* 网格直线：对角穿过时两个邻格都算上，避免细边漏格。 */
function supercover(x0, y0, x1, y1, plot) {
  let x = Math.floor(x0);
  let y = Math.floor(y0);
  const xEnd = Math.floor(x1);
  const yEnd = Math.floor(y1);
  plot(x, y);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  if (stepX === 0 && stepY === 0) return;
  const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMaxX = stepX > 0 ? (Math.floor(x0) + 1 - x0) / dx : stepX < 0 ? (Math.floor(x0) - x0) / dx : Infinity;
  let tMaxY = stepY > 0 ? (Math.floor(y0) + 1 - y0) / dy : stepY < 0 ? (Math.floor(y0) - y0) / dy : Infinity;
  const limit = (Math.abs(xEnd - x) + Math.abs(yEnd - y) + 4) * 3;
  for (let n = 0; n < limit; n++) {
    if (x === xEnd && y === yEnd) break;
    if (Math.abs(tMaxX - tMaxY) <= 1e-9 && stepX !== 0 && stepY !== 0) {
      plot(x + stepX, y);
      plot(x, y + stepY);
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
      x += stepX;
      y += stepY;
    } else if (tMaxX < tMaxY) {
      tMaxX += tDeltaX;
      x += stepX;
    } else {
      tMaxY += tDeltaY;
      y += stepY;
    }
    plot(x, y);
  }
}

function fillCenters(ax, ay, bx, by, cx, cy, plot) {
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-8) return;
  const minY = Math.floor(Math.min(ay, by, cy));
  const maxY = Math.floor(Math.max(ay, by, cy));
  const minX = Math.floor(Math.min(ax, bx, cx));
  const maxX = Math.floor(Math.max(ax, bx, cx));
  if ((maxX - minX + 1) * (maxY - minY + 1) > 1500000) return;
  const inv = 1 / area;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
      const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) plot(x, y);
    }
  }
}

function drawTri(ax, ay, bx, by, cx, cy, plot) {
  supercover(ax, ay, bx, by, plot);
  supercover(bx, by, cx, cy, plot);
  supercover(cx, cy, ax, ay, plot);
  fillCenters(ax, ay, bx, by, cx, cy, plot);
}

/* 绕竖直轴的投影。公式与 three.js 绕 +Y 的旋转一致：x' = c x + s z，z' = -s x + c z。 */
function rasterItem(positions, yaw, cell) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const n = (positions.length / 9) | 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const rot = (x, z) => {
    const rx = c * x + s * z;
    const rz = -s * x + c * z;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (rz < minZ) minZ = rz;
    if (rz > maxZ) maxZ = rz;
    return [rx, rz];
  };
  if (n === 0 || !Number.isFinite(positions[0])) {
    minX = 0; maxX = 0; minZ = 0; maxZ = 0;
  } else {
    for (let i = 0; i < positions.length; i += 3) rot(positions[i], positions[i + 2]);
  }
  const minIx = Math.floor(minX / cell);
  const maxIx = Math.floor(maxX / cell);
  const minIz = Math.floor(minZ / cell);
  const maxIz = Math.floor(maxZ / cell);
  const bw = Math.max(1, maxIx - minIx + 1);
  const bh = Math.max(1, maxIz - minIz + 1);
  const raw = new Grid(bw, bh);
  raw.minIx = minIx;
  raw.minIz = minIz;
  raw.maxIx = maxIx;
  raw.maxIz = maxIz;
  raw.bw = bw;
  raw.bh = bh;
  const plot = (ix, iz) => {
    const x = ix - minIx;
    const y = iz - minIz;
    if (x < 0 || y < 0 || x >= bw || y >= bh) return;
    raw.bits[y * raw.words + (x >> 5)] |= 1 << (x & 31);
  };
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const a = rot(positions[o], positions[o + 2]);
    const b = rot(positions[o + 3], positions[o + 5]);
    const d = rot(positions[o + 6], positions[o + 8]);
    drawTri(a[0] / cell, a[1] / cell, b[0] / cell, b[1] / cell, d[0] / cell, d[1] / cell, (ix, iz) => plot(ix, iz));
  }
  if (n === 0) plot(0, 0);
  let area = 0;
  for (let i = 0; i < raw.bits.length; i++) {
    let w = raw.bits[i];
    while (w) { area += w & 1; w >>>= 1; }
  }
  raw.area = Math.max(1, area);
  return raw;
}

function dilate(raw, rCells) {
  const r = Math.max(0, rCells | 0);
  if (r === 0) return raw;
  const bw = raw.bw + 2 * r;
  const bh = raw.bh + 2 * r;
  const g = new Grid(bw, bh);
  g.minIx = raw.minIx - r;
  g.minIz = raw.minIz - r;
  g.bw = bw;
  g.bh = bh;
  const r2 = r * r;
  const offs = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r2) offs.push(dx, dy);
    }
  }
  for (let y = 0; y < raw.bh; y++) {
    const row = y * raw.words;
    for (let x = 0; x < raw.bw; x++) {
      if ((raw.bits[row + (x >> 5)] & (1 << (x & 31))) === 0) continue;
      for (let k = 0; k < offs.length; k += 2) {
        const px = x + r + offs[k];
        const py = y + r + offs[k + 1];
        g.bits[py * g.words + (px >> 5)] |= 1 << (px & 31);
      }
    }
  }
  return g;
}

function inside(raw, cx, cz, W, H) {
  return cx + raw.minIx >= 0 && cz + raw.minIz >= 0 && cx + raw.maxIx < W && cz + raw.maxIz < H;
}

function fits(occ, pair, cx, cz, W, H) {
  if (!inside(pair.raw, cx, cz, W, H)) return false;
  return !overlaps(occ, pair.dil, cx, cz);
}

function boxArea(placed) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    const a = p.cx + p.raw.minIx;
    const b = p.cx + p.raw.maxIx;
    const c = p.cz + p.raw.minIz;
    const d = p.cz + p.raw.maxIz;
    if (a < minX) minX = a;
    if (b > maxX) maxX = b;
    if (c < minZ) minZ = c;
    if (d > maxZ) maxZ = d;
  }
  if (!placed.length) return Infinity;
  return (maxX - minX + 1) * (maxZ - minZ + 1);
}

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function pruneFree(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.w <= 0 || a.h <= 0) continue;
    let drop = false;
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      const b = list[j];
      if (b.w <= 0 || b.h <= 0) continue;
      const insideB = a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
      if (!insideB) continue;
      const same = a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
      if (!same || j < i) { drop = true; break; }
    }
    if (!drop) out.push(a);
  }
  return out;
}

/* 占用块是实心外接矩形再加一圈间距。板的右、上各多出这一圈，最后一件不会因为间距被挤出板外。 */
function findSlot(free, bw, bh, W, H, gap, kind) {
  const iw = bw + gap;
  const ih = bh + gap;
  let best = null;
  for (let i = 0; i < free.length; i++) {
    const f = free[i];
    if (iw > f.w || ih > f.h) continue;
    if (f.x + bw > W || f.y + bh > H) continue;
    const dw = f.w - iw;
    const dh = f.h - ih;
    let score;
    if (kind === 'baf') score = f.w * f.h - iw * ih;
    else if (kind === 'bl') score = f.y * 100000 + f.x;
    else score = Math.min(dw, dh) * 100000 + Math.max(dw, dh);
    if (!best || score < best.score || (score === best.score && (f.y < best.y || (f.y === best.y && f.x < best.x)))) {
      best = { x: f.x, y: f.y, score };
    }
  }
  return best;
}

function commitSlot(free, x, y, iw, ih) {
  const placed = { x, y, w: iw, h: ih };
  const next = [];
  for (let i = 0; i < free.length; i++) {
    const f = free[i];
    if (!intersects(f, placed)) { next.push(f); continue; }
    if (placed.x > f.x) next.push({ x: f.x, y: f.y, w: placed.x - f.x, h: f.h });
    const right = placed.x + placed.w;
    if (right < f.x + f.w) next.push({ x: right, y: f.y, w: f.x + f.w - right, h: f.h });
    if (placed.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: placed.y - f.y });
    const top = placed.y + placed.h;
    if (top < f.y + f.h) next.push({ x: f.x, y: top, w: f.w, h: f.y + f.h - top });
  }
  free.length = 0;
  const pruned = pruneFree(next);
  for (let i = 0; i < pruned.length; i++) free.push(pruned[i]);
}

function packSequence(seq, masks, W, H, gap, kind) {
  const free = [{ x: 0, y: 0, w: W + gap, h: H + gap }];
  const placed = [];
  const failed = [];
  let usedX = 0;
  let usedZ = 0;
  for (let i = 0; i < seq.length; i++) {
    const item = seq[i];
    const views = masks.get(item.id);
    let best = null;
    for (let a = 0; a < views.length; a++) {
      const view = views[a];
      const slot = findSlot(free, view.raw.bw, view.raw.bh, W, H, gap, kind);
      if (!slot) continue;
      const area = Math.max(usedX, slot.x + view.raw.bw) * Math.max(usedZ, slot.y + view.raw.bh);
      const betterSlot = !best || area < best.area
        || (area === best.area && (slot.score < best.score || (slot.score === best.score && (slot.y < best.y || (slot.y === best.y && slot.x < best.x)))));
      if (betterSlot) best = { x: slot.x, y: slot.y, score: slot.score, area, view };
    }
    if (!best) { failed.push(item); continue; }
    commitSlot(free, best.x, best.y, best.view.raw.bw + gap, best.view.raw.bh + gap);
    usedX = Math.max(usedX, best.x + best.view.raw.bw);
    usedZ = Math.max(usedZ, best.y + best.view.raw.bh);
    placed.push({
      item,
      raw: best.view.raw,
      dil: best.view.dil,
      yaw: best.view.yaw,
      cx: best.x - best.view.raw.minIx,
      cz: best.y - best.view.raw.minIz,
    });
  }
  return { placed, failed };
}

function betterPack(a, b) {
  if (!b) return true;
  if (a.placed.length !== b.placed.length) return a.placed.length > b.placed.length;
  return boxArea(a.placed) < boxArea(b.placed);
}

function sequencesOf(items, masks) {
  const dim = id => masks.get(id)[0].raw;
  const idx = items.map((_, i) => i);
  const sorts = [
    (i, j) => dim(items[j].id).area - dim(items[i].id).area || i - j,
    (i, j) => Math.max(dim(items[j].id).bw, dim(items[j].id).bh) - Math.max(dim(items[i].id).bw, dim(items[i].id).bh) || i - j,
    (i, j) => dim(items[j].id).bh - dim(items[i].id).bh || i - j,
    (i, j) => dim(items[j].id).bw - dim(items[i].id).bw || i - j,
  ];
  return sorts.map(fn => idx.slice().sort(fn).map(i => items[i]));
}

function fillRatio(raw) {
  return raw.area / Math.max(1, raw.bw * raw.bh);
}

/* 只在有人轮廓明显小于外接矩形时做。把小件挪进环心、凹槽，外接矩形变小才收下。 */
function tuckHoles(placed, W, H) {
  if (placed.length < 2) return;
  if (!placed.some(p => fillRatio(p.raw) < 0.9)) return;
  const occ = new Grid(W, H);
  const order = placed.slice().sort((a, b) => a.raw.area - b.raw.area);
  for (let n = 0; n < order.length; n++) {
    const p = order[n];
    const rest = [];
    for (let i = 0; i < placed.length; i++) if (placed[i] !== p) rest.push(placed[i]);
    clearGrid(occ);
    for (let i = 0; i < rest.length; i++) stamp(occ, rest[i].raw, rest[i].cx, rest[i].cz);
    const pair = { raw: p.raw, dil: p.dil };
    let bestArea = boxArea(placed);
    let bestX = p.cx;
    let bestZ = p.cz;
    let minX = 0, minZ = 0, maxX = 0, maxZ = 0;
    if (rest.length) {
      minX = Infinity; minZ = Infinity; maxX = -Infinity; maxZ = -Infinity;
      for (let i = 0; i < rest.length; i++) {
        const q = rest[i];
        minX = Math.min(minX, q.cx + q.raw.minIx);
        maxX = Math.max(maxX, q.cx + q.raw.maxIx);
        minZ = Math.min(minZ, q.cz + q.raw.minIz);
        maxZ = Math.max(maxZ, q.cz + q.raw.maxIz);
      }
    }
    const step = Math.max(1, Math.min(4, (Math.min(p.raw.bw, p.raw.bh) / 3) | 0));
    let tests = 0;
    for (let z = minZ - p.raw.bh; z <= maxZ && tests < 3000; z += step) {
      for (let x = minX - p.raw.bw; x <= maxX && tests < 3000; x += step) {
        tests++;
        if (!fits(occ, pair, x, z, W, H)) continue;
        const trial = rest.concat([{ cx: x, cz: z, raw: p.raw }]);
        const area = boxArea(trial);
        if (area < bestArea || (area === bestArea && (z < bestZ || (z === bestZ && x < bestX)))) {
          bestArea = area;
          bestX = x;
          bestZ = z;
        }
      }
    }
    p.cx = bestX;
    p.cz = bestZ;
  }
}

function packBest(items, masks, W, H, gap) {
  const seqs = sequencesOf(items, masks);
  const kinds = ['bssf', 'baf', 'bl'];
  let best = null;
  for (let s = 0; s < seqs.length; s++) {
    for (let k = 0; k < kinds.length; k++) {
      const pack = packSequence(seqs[s], masks, W, H, gap, kinds[k]);
      if (betterPack(pack, best)) best = pack;
    }
  }
  /* 大件对调后再铺一次。件数少时这点代价能把外接矩形再压一截。 */
  if (best && items.length <= 12 && items.length >= 3) {
    const seqs = sequencesOf(items, masks);
    let order = seqs[0].slice();
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const trial = order.slice();
        const swap = trial[i];
        trial[i] = trial[j];
        trial[j] = swap;
        for (let k = 0; k < 2; k++) {
          const pack = packSequence(trial, masks, W, H, gap, k === 0 ? 'bssf' : 'baf');
          if (betterPack(pack, best)) {
            best = pack;
            order = trial;
          }
        }
      }
    }
  }
  if (best) tuckHoles(best.placed, W, H);
  return best;
}



function footprintBox(positions, x, z, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const n = positions ? positions.length : 0;
  for (let i = 0; i < n; i += 3) {
    const wx = x + c * positions[i] + s * positions[i + 2];
    const wz = z - s * positions[i] + c * positions[i + 2];
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (wz < minZ) minZ = wz;
    if (wz > maxZ) maxZ = wz;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, maxX, minZ, maxZ };
}

/* 格子对齐会把外沿推进去将近一格。按真实投影外沿再往板角靠，
   离板边落到边距，左右（或上下）相邻的外沿落到间距。
   外接盒已经咬在一起的不动，避免把塞进孔里的零件挤出来。 */
function tightenFootprints(items, placements, plateW, plateD, gap, margin) {
  const pos = new Map();
  for (let i = 0; i < items.length; i++) pos.set(items[i].id, items[i].positions);
  const boxes = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const b = footprintBox(pos.get(p.id), p.x, p.z, p.yaw || 0);
    if (!b) continue;
    boxes.push({ p, minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
  }
  if (!boxes.length) return;
  const left = -plateW / 2 + margin;
  const bottom = -plateD / 2 + margin;
  const right = plateW / 2 - margin;
  const top = plateD / 2 - margin;
  const zHit = (a, b) => a.minZ < b.maxZ - 1e-3 && b.minZ < a.maxZ - 1e-3;
  const xHit = (a, b) => a.minX < b.maxX - 1e-3 && b.minX < a.maxX - 1e-3;
  const slide = (axis) => {
    const minK = axis === 'x' ? 'minX' : 'minZ';
    const maxK = axis === 'x' ? 'maxX' : 'maxZ';
    const originK = axis === 'x' ? 'x' : 'z';
    const near = axis === 'x' ? left : bottom;
    const far = axis === 'x' ? right : top;
    const hit = axis === 'x' ? zHit : xHit;
    const tie = axis === 'x' ? 'minZ' : 'minX';
    boxes.sort((a, b) => a[minK] - b[minK] || a[tie] - b[tie]);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      let limit = near;
      let locked = false;
      for (let j = 0; j < i; j++) {
        const o = boxes[j];
        if (!hit(b, o)) continue;
        if (o[maxK] > b[minK] + 1e-3) { locked = true; break; }
        const edge = o[maxK] + gap;
        if (edge > limit) limit = edge;
      }
      if (locked) continue;
      let delta = limit - b[minK];
      if (delta >= -1e-4) continue;
      if (b[maxK] + delta > far) delta = far - b[maxK];
      if (delta >= -1e-4) continue;
      b.p[originK] += delta;
      b[minK] += delta;
      b[maxK] += delta;
    }
  };
  slide('x');
  slide('z');
  slide('x');
  slide('z');
}

/* 整组在已经排紧之后，只沿板面 X 平移。左右就是这一排的两头。
   不改前后。板外那排不跟着挪。 */
function alignPack(items, placements, plateW, plateD, margin, align) {
  const mode = align === 'right' || align === 'center' ? align : 'left';
  const pos = new Map();
  for (let i = 0; i < items.length; i++) pos.set(items[i].id, items[i].positions);
  const boxes = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const b = footprintBox(pos.get(p.id), p.x, p.z, p.yaw || 0);
    if (!b || b.minZ >= plateD / 2 - 0.01) continue;
    boxes.push({ p, minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
  }
  if (!boxes.length) return;
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (b.minX < minX) minX = b.minX;
    if (b.maxX > maxX) maxX = b.maxX;
  }
  const left = -plateW / 2 + margin;
  const right = plateW / 2 - margin;
  let dx = 0;
  if (mode === 'right') dx = right - maxX;
  else if (mode === 'center') {
    dx = -((minX + maxX) / 2);
    if (minX + dx < left) dx += left - (minX + dx);
    if (maxX + dx > right) dx -= (maxX + dx) - right;
  } else dx = left - minX;
  if (Math.abs(dx) < 1e-4) return;
  for (let i = 0; i < boxes.length; i++) boxes[i].p.x += dx;
}

/* 装箱从后边（世界 -Z）往前铺。正对前方看，后边在画面上沿，整排就像跑到上面。
   排紧、左右对齐之后，把整组平移到前边（世界 +Z）。离前边仍是边距，左右不动。
   板外那排这时还没放。 */
function anchorFront(items, placements, plateD, margin) {
  const pos = new Map();
  for (let i = 0; i < items.length; i++) pos.set(items[i].id, items[i].positions);
  let maxZ = -Infinity;
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const b = footprintBox(pos.get(p.id), p.x, p.z, p.yaw || 0);
    if (!b) continue;
    if (b.maxZ > maxZ) maxZ = b.maxZ;
  }
  if (!Number.isFinite(maxZ)) return;
  const dz = plateD / 2 - margin - maxZ;
  if (Math.abs(dz) < 1e-4) return;
  for (let i = 0; i < placements.length; i++) placements[i].z += dz;
}

/**
 * 把零件投影排进板面。
 * items: { id, positions }，positions 是非索引三角形的 xyz 序列（只用 x、z）。
 * 返回的 x、z 是零件局部原点（未旋转包围盒的中心）在世界系的位置，yaw 绕世界 +Y。
 */
export function nestPlate(items, plateX, plateZ, opts = {}) {
  const t0 = performance.now();
  const gap = Math.max(0, Number(opts.gap) || 0);
  const margin = Math.max(0, Number(opts.margin) || 0);
  const plateW = Math.max(1, plateX);
  const plateD = Math.max(1, plateZ);
  const cell = Math.max(0.4, Math.min(0.7, Math.max(plateW, plateD) / 300));
  const usableW = plateW - 2 * margin;
  const usableD = plateD - 2 * margin;
  const W = Math.max(1, Math.floor(usableW / cell));
  const H = Math.max(1, Math.floor(usableD / cell));
  const rCells = gap <= 0 ? 0 : Math.ceil(gap / cell) + 1;
  const originX = -plateW / 2 + margin;
  const originZ = -plateD / 2 + margin;
  const masks = new Map();
  let partArea = 0;
  const angles = opts.angles || (items.length > 28 ? [0, Math.PI / 2] : ANGLES);
  for (const it of items) {
    const views = [];
    for (let a = 0; a < angles.length; a++) {
      const raw = rasterItem(it.positions, angles[a], cell);
      views.push({ raw, dil: dilate(raw, rCells), yaw: angles[a] });
    }
    masks.set(it.id, views);
    partArea += views[0].raw.area * cell * cell;
  }
  const gapCells = gap <= 0 ? 0 : Math.ceil(gap / cell);
  let best = null;
  if (usableW >= cell && usableD >= cell) best = packBest(items, masks, W, H, gapCells);
  if (!best) best = { placed: [], failed: items.slice() };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of best.placed) {
    const x0 = originX + (p.cx + p.raw.minIx) * cell;
    const x1 = originX + (p.cx + p.raw.maxIx + 1) * cell;
    const z0 = originZ + (p.cz + p.raw.minIz) * cell;
    const z1 = originZ + (p.cz + p.raw.maxIz + 1) * cell;
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (z0 < minZ) minZ = z0;
    if (z1 > maxZ) maxZ = z1;
  }
  // 格子从左后角铺。排紧、左右对齐之后再整组挪到前边，见 anchorFront。
  const placements = best.placed.map(p => ({
    id: p.item.id,
    x: originX + p.cx * cell,
    z: originZ + p.cz * cell,
    yaw: p.yaw,
  }));
  // 格子把外沿对齐到格线，间距和离板边会大出将近一格。按投影外沿再靠拢到填的数。
  tightenFootprints(items, placements, plateW, plateD, gap, margin);
  alignPack(items, placements, plateW, plateD, margin, opts.align);
  anchorFront(items, placements, plateD, margin);
  let rowX = -plateW / 2 + margin;
  let rowZ = plateD / 2 + gap;
  let rowH = 0;
  for (const it of best.failed) {
    const raw = masks.get(it.id)[0].raw;
    const w = (raw.maxIx - raw.minIx + 1) * cell;
    const d = (raw.maxIz - raw.minIz + 1) * cell;
    if (rowX + w > plateW / 2 - margin && rowX > -plateW / 2 + margin + 0.1) {
      rowX = -plateW / 2 + margin;
      rowZ += rowH + gap;
      rowH = 0;
    }
    placements.push({
      id: it.id,
      x: rowX + w / 2 - raw.minIx * cell,
      z: rowZ + d / 2 - raw.minIz * cell,
      yaw: 0,
    });
    rowX += w + gap;
    rowH = Math.max(rowH, d);
  }
  const usedArea = best.placed.length ? Math.max(0, maxX - minX) * Math.max(0, maxZ - minZ) : 0;
  return {
    placements,
    gap,
    margin,
    cell,
    overflow: best.failed.length > 0,
    failed: best.failed.length,
    partArea,
    usedArea,
    plateArea: plateW * plateD,
    ms: performance.now() - t0,
  };
}
