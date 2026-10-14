/* ================================================================
   切片引擎（像素级光栅化，Y 为打印方向）—— 自旧 main.js 原样移植，无 DOM 依赖
================================================================ */
import * as THREE from 'three';
import { state } from '../store.js';

let _p1x = 0, _p1z = 0, _p2x = 0, _p2z = 0, _got = 0;
export function _edge(x1, y1, z1, x2, y2, z2, z) {
  if ((y1 > z) !== (y2 > z)) {
    const t = (z - y1) / (y2 - y1);
    if (_got === 0) { _p1x = x1 + t * (x2 - x1); _p1z = z1 + t * (z2 - z1); _got = 1; }
    else { _p2x = x1 + t * (x2 - x1); _p2z = z1 + t * (z2 - z1); _got = 2; }
  }
}

export function rasterizeSection(p, tris, z, occ, setList, g, rowXs) {
  const { W, H, sx, sz, x0, z0 } = g;
  for (let r = 0; r < H; r++) if (rowXs[r].length) rowXs[r].length = 0;
  for (let t = 0; t < tris.length; t++) {
    const i3 = tris[t] * 9;   // 每个三角形占 9 个浮点（3 顶点 × xyz）
    const ax = p[i3], ay = p[i3 + 1], az = p[i3 + 2];
    const bx = p[i3 + 3], by = p[i3 + 4], bz = p[i3 + 5];
    const cx = p[i3 + 6], cy = p[i3 + 7], cz = p[i3 + 8];
    const cnt = (ay > z) + (by > z) + (cy > z);
    if (cnt === 0 || cnt === 3) continue;
    _got = 0;
    _edge(ax, ay, az, bx, by, bz, z);
    if (_got < 2) _edge(bx, by, bz, cx, cy, cz, z);
    if (_got < 2) _edge(cx, cy, cz, ax, ay, az, z);
    if (_got < 2) continue;
    const dx = _p2x - _p1x, dz = _p2z - _p1z;
    // 轮廓光栅化
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (Math.min(sx, sz) * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const wx = _p1x + dx * s / steps, wz = _p1z + dz * s / steps;
      const i = Math.floor((wx - x0) / sx), j = Math.floor((wz - z0) / sz);
      if (i >= 0 && i < W && j >= 0 && j < H) {
        const id = j * W + i;
        if (!occ[id]) { occ[id] = 1; setList.arr[setList.n++] = id; }
      }
    }
    // 行交点（扫描线填充用）
    if (Math.abs(dz) > 1e-12) {
      let j0 = Math.ceil((Math.min(_p1z, _p2z) - z0) / sz - 0.5);
      let j1 = Math.floor((Math.max(_p1z, _p2z) - z0) / sz - 0.5);
      j0 = Math.max(0, j0); j1 = Math.min(H - 1, j1);
      for (let j = j0; j <= j1; j++) {
        const py = z0 + (j + 0.5) * sz;
        const t = (py - _p1z) / dz;
        if (t >= 0 && t <= 1) rowXs[j].push(_p1x + t * dx);
      }
    }
  }
  // 偶奇填充
  for (let j = 0; j < H; j++) {
    const xs = rowXs[j]; if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let i0 = Math.ceil((xs[k] - x0) / sx - 0.5), i1 = Math.floor((xs[k + 1] - x0) / sx - 0.5);
      i0 = Math.max(0, i0); i1 = Math.min(W - 1, i1);
      const base = j * W;
      for (let i = i0; i <= i1; i++) {
        const id = base + i;
        if (!occ[id]) { occ[id] = 1; setList.arr[setList.n++] = id; }
      }
    }
  }
}

/* 面数据：法线 / 面积 / 重心 */
export function computeFaceData(pos) {
  const nf = pos.length / 9;
  const ny = new Float32Array(nf), area = new Float32Array(nf), cent = new Float32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const i = f * 9;
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
    const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
    const cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, nyy = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, nyy, nz) || 1;
    ny[f] = nyy / len;
    area[f] = len / 2;
    cent[f * 3] = (ax + bx + cx) / 3; cent[f * 3 + 1] = (ay + by + cy) / 3; cent[f * 3 + 2] = (az + bz + cz) / 3;
  }
  return { ny, area, cent };
}

/* 朝向分析主函数：pos 原始顶点（模型局部，底面 y=0）, q 旋转, opts
   opts.raiseH：模型抬高（mm）。顶点旋转换到打印世界系（平台 y=0、模型底面 y=raiseH），
   使模型最底层自然成为孤岛、支撑体积包含底面到平台的抬高量 */
export function analyze(pos, q, opts) {
  const detail = !!opts.detail;
  const gridRes = opts.gridRes || 160;
  const layerH = opts.layerH, gapThresh = opts.gapThresh;
  const raiseHv = opts.raiseH || 0;
  const nv = pos.length / 3, nf = nv / 3;
  const p = new Float32Array(pos.length);
  const rot = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
  for (let i = 0; i < nv; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    p[i * 3] = rot[0] * x + rot[4] * y + rot[8] * z;
    p[i * 3 + 1] = rot[1] * x + rot[5] * y + rot[9] * z + raiseHv;
    p[i * 3 + 2] = rot[2] * x + rot[6] * y + rot[10] * z;
  }
  let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i]; if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1]; if (p[i + 1] > maxY) maxY = p[i + 1];
    if (p[i + 2] < minZ) minZ = p[i + 2]; if (p[i + 2] > maxZ) maxZ = p[i + 2];
  }
  const spanX = Math.max(maxX - minX, 1e-6), spanY = Math.max(maxY - minY, 1e-6), spanZ = Math.max(maxZ - minZ, 1e-6);
  const cell = Math.max(spanX, spanZ) / gridRes;
  const W = Math.max(4, Math.min(512, Math.round(spanX / cell) || 4));
  const H = Math.max(4, Math.min(512, Math.round(spanZ / cell) || 4));
  const sx = spanX / W, sz = spanZ / H;
  const g = { W, H, sx, sz, x0: minX, z0: minZ, minY, layerH, layers: 0 };
  const layers = Math.max(1, Math.ceil(spanY / layerH));
  g.layers = layers;
  // 三角形按 Y 分桶
  const bins = new Array(layers);
  for (let l = 0; l < layers; l++) bins[l] = [];
  for (let f = 0; f < nf; f++) {
    const i3 = f * 9;   // 每个三角形占 9 个浮点（3 顶点 × xyz）
    const y1 = p[i3 + 1], y2 = p[i3 + 4], y3 = p[i3 + 7];
    let lo = Math.floor((Math.min(y1, y2, y3) - minY) / layerH);
    let hi = Math.floor((Math.max(y1, y2, y3) - minY) / layerH);
    lo = Math.max(0, lo); hi = Math.min(layers - 1, hi);
    for (let l = lo; l <= hi; l++) bins[l].push(f);
  }
  const N = W * H;
  const lastMat = new Float32Array(N).fill(minY - raiseHv);   // 参考面 = 平台顶面（世界系 y=0 处）
  const prevOcc = new Uint8Array(N), curOcc = new Uint8Array(N);
  const setList = { arr: new Int32Array(N), n: 0 };
  const rowXs = new Array(H); for (let j = 0; j < H; j++) rowXs[j] = [];
  const cellArea = sx * sz;
  // 面积阈值物理化（mm² → 像素数）：与网格分辨率无关
  const minIslPx = Math.max(1, Math.ceil((opts.minIslArea ?? 0.5) / cellArea));
  const attachPx = Math.max(1, Math.ceil((opts.minAttachArea ?? 1) / cellArea));
  const lMin = raiseHv > 0 ? 0 : 1;   // 抬高时首层悬空于平台（或底板）之上，需参与孤岛判定
  // detail 模式启用 LDI：位图改由区间表采样，悬空 gap 精确到区间边界（可用 useLDI:false 回退位图路径）
  let ld = null, ldCursor = null, ldMatch = null, ldAct = null;
  if (detail && opts.useLDI !== false) {
    const all = new Int32Array(nf); for (let f = 0; f < nf; f++) all[f] = f;
    ld = buildLDI(p, all, g);
    ldCursor = new Int32Array(N);          // 列内游标（随层单调推进）
    ldMatch = new Int32Array(N);           // 各列命中区间索引（悬空测量 O(1)）
    ldAct = { next: 0, active: [] };       // 活动列集合（按首区间入口激活，区间用尽失活）
  }
  let supportVol = 0, islandArea = 0, maxFill = 0;
  const overhang = detail ? [] : null;   // 栅格悬空点
  const islands = detail ? [] : null;     // 精确孤岛
  const visited = detail ? new Uint8Array(N) : null;
  const stack = detail ? new Int32Array(N) : null;
  // 区域邻接有向图：节点 = 每层连通域（含噪点小域，保证边权总和 = 像素级重叠数），
  // 边 = 与下层的重叠（权重 = 重叠像素数）。孤岛判定 = 出边权重总和 < attachPx。
  const graph = detail ? { nodes: [], adj: [], labels: new Int32Array(N).fill(-1), prevLabels: new Int32Array(N).fill(-1) } : null;
  // 浮空链：下面什么都没有的连通块（太小、没判孤岛时）是一条浮空链的起点；往上只搭在浮空链上的层继续算浮空，接上已托住的结构即托住。
  // 浮空链长到「最小孤岛面积」还没接上任何托住的结构 → 起点那一层判为孤岛（种子落在尖上），这条链从此算托住。
  // 只按「与下层的接触面积」判的话，从一个小尖开始往上长的结构（朝下的锥尖、指尖、剑尖）一层也判不成孤岛：
  // 起点太小被当噪点，往上每层都搭在下层上（实测锥尖朝下、抬高 4mm：0 个支撑点，整件悬空）。墙上的小凸点几层内就并进墙里，不会误报
  const chain = detail ? [] : null;            // 每节点 { open, root }
  const rootPix = detail ? new Map() : null;   // 浮空链起点 → 像素表

  for (let l = 0; l < layers; l++) {
    const z = minY + (l + 0.5) * layerH + 1e-5;
    if (ld) sampleLDILayer(ld, z, curOcc, setList, ldCursor, ldMatch, ldAct);
    else { curOcc.fill(0); setList.n = 0; rasterizeSection(p, bins[l], z, curOcc, setList, g, rowXs); }
    const cnt = setList.n;
    if (cnt > maxFill) maxFill = cnt;

    for (let k = 0; k < cnt; k++) {
      const id = setList.arr[k];
      let gap, surfY;
      if (ld) {
        const m = ldMatch[id];
        if (m < 0) continue;   // 理论不发生（置位像素必有覆盖区间）
        const inY = ld.ys[2 * m];
        const below = m > ld.offs[id] ? ld.ys[2 * (m - 1) + 1] : (minY - raiseHv);
        gap = inY - below; surfY = inY;
      } else {
        gap = z - lastMat[id]; surfY = z - layerH / 2;
        lastMat[id] = z;
      }
      if (gap > gapThresh) {
        const i0c = id % W, j0c = (id / W) | 0;
        // 5x5 坡度自支撑判定：上一层邻域有材料则视为斜面可自支撑
        let slope = false;
        for (let dj = -2; dj <= 2 && !slope; dj++) {
          const jj = j0c + dj; if (jj < 0 || jj >= H) continue;
          for (let di = -2; di <= 2; di++) {
            const ii = i0c + di; if (ii < 0 || ii >= W) continue;
            if (prevOcc[jj * W + ii]) { slope = true; break; }
          }
        }
        if (!slope) {
          supportVol += gap * cellArea;
          const wx = g.x0 + (i0c + 0.5) * sx, wz = g.z0 + (j0c + 0.5) * sz;
          if (detail) {
            // 不设上限：旧实现在 40000 处静默截断，逐层自下而上收集——抬高后的整片底面就能把配额吃光，
            // 上部结构的悬空点全部丢失（实测悬臂雕像 90836 点只收 40000，横梁/球底候选为 0）
            overhang.push({ x: wx, z: wz, y: surfY, gap });
          } else {
            let iso = true;
            for (let dj = -1; dj <= 1 && iso; dj++) {
              const jj = j0c + dj; if (jj < 0 || jj >= H) continue;
              for (let di = -1; di <= 1; di++) {
                const ii = i0c + di; if (ii < 0 || ii >= W) continue;
                if (prevOcc[jj * W + ii]) { iso = false; break; }
              }
            }
            if (iso) islandArea += cellArea;
          }
        }
      }
    }

    if (detail) {
      visited.fill(0);
      for (let k = 0; k < cnt; k++) {
        const id = setList.arr[k];
        if (visited[id]) continue;
        let head = 0, tl = 0;
        stack[tl++] = id; visited[id] = 1;
        const comp = [];
        while (head < tl) {
          const c = stack[head++];
          comp.push(c);
          const ci = c % W, cj = (c / W) | 0;
          if (ci + 1 < W && curOcc[c + 1] && !visited[c + 1]) { visited[c + 1] = 1; stack[tl++] = c + 1; }
          if (ci - 1 >= 0 && curOcc[c - 1] && !visited[c - 1]) { visited[c - 1] = 1; stack[tl++] = c - 1; }
          if (cj + 1 < H && curOcc[c + W] && !visited[c + W]) { visited[c + W] = 1; stack[tl++] = c + W; }
          if (cj - 1 >= 0 && curOcc[c - W] && !visited[c - W]) { visited[c - W] = 1; stack[tl++] = c - W; }
        }
        {
          // 图节点登记（所有连通域）；边权按下层节点归集
          const nid = graph.nodes.length;
          const ovBy = new Map();
          let si = 0, sj = 0;
          for (let c = 0; c < comp.length; c++) {
            const cc = comp[c];
            graph.labels[cc] = nid;
            si += cc % W; sj += (cc / W) | 0;
            const t = graph.prevLabels[cc];
            if (prevOcc[cc] && t >= 0) ovBy.set(t, (ovBy.get(t) || 0) + 1);
          }
          let outW = 0;
          const edges = [];
          for (const [t, w] of ovBy) { edges.push({ t, w }); outW += w; }
          // 与下层的接触面积不足阈值 → 视为孤岛（单像素搭接强度不够，剥离会撕裂）。
          // 阈值取「最小附着面积」与「自身面积一半」的较小者：小截面（尖顶/球顶/细柱顶 < 1mm²）完全落在下层材料上时
          // 重叠必然 < 1mm²，只用前者会被一律误判为孤岛（实测悬臂雕像球顶 76/76 像素全重叠仍判孤岛）
          const isIsl = l >= lMin && comp.length >= minIslPx && outW < Math.min(attachPx, Math.ceil(comp.length * 0.5));
          graph.nodes.push({
            id: nid, layer: l, y: z, px: comp.length, area: comp.length * cellArea,
            cx: g.x0 + (si / comp.length + 0.5) * sx,
            cz: g.z0 + (sj / comp.length + 0.5) * sz,
            island: isIsl,
            pixels: isIsl ? Int32Array.from(comp) : null   // 孤岛保留像素表，供关键点提取（M4）
          });
          graph.adj.push(edges);
          if (isIsl) {
            const nd = graph.nodes[nid];
            islands.push({ y: nd.y, area: nd.area, px: nd.px, cx: nd.cx, cz: nd.cz, layer: nd.layer, node: nid });
          }
          let open = false, root = -1;
          if (!isIsl && l >= lMin) {
            if (!edges.length) { open = true; root = nid; rootPix.set(nid, Int32Array.from(comp)); }
            else {
              open = true;
              let bestW = -1;
              for (const { t, w } of edges) { const c = chain[t]; if (!c.open) { open = false; break; } if (w > bestW) { bestW = w; root = c.root; } }
            }
            if (open && comp.length >= minIslPx) {
              const rn = graph.nodes[root];
              if (!rn.island) {
                rn.island = true; rn.pixels = rootPix.get(root); rn.chainTip = true;
                islands.push({ y: rn.y, area: rn.area, px: rn.px, cx: rn.cx, cz: rn.cz, layer: rn.layer, node: root });
              }
              open = false; root = -1;
            }
          }
          chain.push({ open, root });
        }
      }
    }
    if (detail) { graph.prevLabels.set(graph.labels); graph.labels.fill(-1); }
    prevOcc.set(curOcc);
  }
  return {
    metrics: { supportVol, islandArea, maxFill: maxFill * cellArea, height: spanY, layers },
    overhang, islands, grid: g, p, bins, rowXs, setList,
    raiseH: raiseHv, minIslPx, attachPx, ld, graph
  };
}

/* 陡峭悬空面（法线判定，保护面加权）—— 早期废弃函数，保留以维持 API 兼容（实际使用 steepFaces） */
export function steepFaceMetric(faces, q, selfAngleDeg, prot, protW) {
  const rot = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
  const cosv = Math.cos(selfAngleDeg * Math.PI / 180);
  const { ny, area, cent } = faces;
  const nf = ny.length;
  let steepArea = 0, protHit = 0;
  const pts = [];
  for (let f = 0; f < nf; f++) {
    // 旋转法线（仅取 y 分量）
    // 法线原值需从 cent? 面法线 y = ny[f]（原始朝向），旋转后 y 分量：
    // n' = R * n，此处用原始面法线仅存了 y 分量 —— 需要完整法线
    // 修正：在 computeFaceData 中补充存储完整法线
    void rot; void f;
    break;
  }
  return { steepArea, protHit, pts };
}

/* 由于法线旋转需要完整向量，重写为基于完整法线数组 */
export function computeFaceDataFull(pos) {
  const nf = pos.length / 9;
  const nrm = new Float32Array(nf * 3), area = new Float32Array(nf), cent = new Float32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    const i = f * 9;
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
    const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
    const cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, nyy = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, nyy, nz) || 1;
    nrm[f * 3] = nx / len; nrm[f * 3 + 1] = nyy / len; nrm[f * 3 + 2] = nz / len;
    area[f] = len / 2;
    cent[f * 3] = (ax + bx + cx) / 3; cent[f * 3 + 1] = (ay + by + cy) / 3; cent[f * 3 + 2] = (az + bz + cz) / 3;
  }
  return { nrm, area, cent };
}

export function steepFaces(facesF, q, selfAngleDeg, prot, protW, collectPts) {
  const rot = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
  const cosv = Math.cos(selfAngleDeg * Math.PI / 180);
  const { nrm, area, cent } = facesF;
  const nf = area.length;
  let steepArea = 0, protHit = 0;
  const pts = collectPts ? [] : null;
  for (let f = 0; f < nf; f++) {
    const nx = nrm[f * 3], nyv = nrm[f * 3 + 1], nz = nrm[f * 3 + 2];
    const ry = rot[1] * nx + rot[5] * nyv + rot[9] * nz;
    if (ry < -cosv) {
      const w = prot.has(f) ? protW : 1;
      steepArea += area[f] * w;
      if (prot.has(f)) protHit += area[f];
      if (collectPts) {
        const cx = cent[f * 3], cy = cent[f * 3 + 1], cz = cent[f * 3 + 2];
        pts.push({
          x: rot[0] * cx + rot[4] * cy + rot[8] * cz,
          y: rot[1] * cx + rot[5] * cy + rot[9] * cz,
          z: rot[2] * cx + rot[6] * cy + rot[10] * cz,
          area: area[f],  // 面面积：供区域面积过滤
          f               // 面索引：支撑点法线直取 + 大三角形细分采样
        });
      }
    }
  }
  return { steepArea, protHit, pts };
}

/* ================================================================
   LDI 引擎（分层深度图：每个 XZ 栅格列沿 +Y 方向的材料区间表）
   构建：三角形在 XZ 平面光栅化出覆盖列，列中心射线与三角形求精确交点
   （XZ 重心插值，平面上精确），交点带法线 y 符号（ny<0 进入 / ny>0 离开）。
   列内排序后：同向且间距 < eps 的交点去重（镶嵌共享边会产生重复交点），
   再做深度扫描（depth>0 为实体）——并集语义，天然兼容重叠/非流形输入。
   参考：Shade et al. "Layered Depth Images", SIGGRAPH 1998
================================================================ */
export function buildLDI(p, tris, g) {
  const { W, H, sx, sz, x0, z0 } = g;
  const N = W * H;
  const cols = new Array(N);
  for (let t = 0; t < tris.length; t++) {
    const i3 = tris[t] * 9;
    const ax = p[i3], ay = p[i3 + 1], az = p[i3 + 2];
    const bx = p[i3 + 3], by = p[i3 + 4], bz = p[i3 + 5];
    const cx = p[i3 + 6], cy = p[i3 + 7], cz = p[i3 + 8];
    // XZ 重心坐标（2D 叉积形式）；denom≈0 → 垂直壁，不产生交点（预期行为）
    const v1x = bx - ax, v1z = bz - az, v0x = cx - ax, v0z = cz - az;
    const denom = v1x * v0z - v1z * v0x;
    if (Math.abs(denom) < 1e-14) continue;
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);   // (B−A)×(C−A) 的 y 分量符号
    const dir = ny < 0 ? 1 : -1;                                // +1=进入实体（底面），-1=离开（顶面）
    const xMin = Math.min(ax, bx, cx), xMax = Math.max(ax, bx, cx);
    const zMin = Math.min(az, bz, cz), zMax = Math.max(az, bz, cz);
    // 仅遍历「列中心可能落在三角形内」的列（紧致包围盒）
    const i0 = Math.max(0, Math.ceil((xMin - x0) / sx - 0.5)), i1 = Math.min(W - 1, Math.floor((xMax - x0) / sx - 0.5));
    const j0 = Math.max(0, Math.ceil((zMin - z0) / sz - 0.5)), j1 = Math.min(H - 1, Math.floor((zMax - z0) / sz - 0.5));
    for (let j = j0; j <= j1; j++) {
      const qz = z0 + (j + 0.5) * sz;
      for (let i = i0; i <= i1; i++) {
        const qx = x0 + (i + 0.5) * sx;
        const v2x = qx - ax, v2z = qz - az;
        const u = (v2x * v0z - v2z * v0x) / denom;   // u: B 方向
        const v = (v1x * v2z - v1z * v2x) / denom;   // v: C 方向
        if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
        const c = j * W + i;
        (cols[c] || (cols[c] = [])).push(ay + u * (by - ay) + v * (cy - ay), dir);
      }
    }
  }
  // 排序 → 同向近距去重 → 深度扫描出区间（并集语义）
  const EPS = 1e-4;
  const nInt = new Int32Array(N);
  let total = 0, dangling = 0;
  for (let c = 0; c < N; c++) {
    const arr = cols[c];
    if (!arr || !arr.length) continue;
    // 按 y 排序（y, dir 交替存储）
    const n = arr.length >> 1;
    const ev = new Array(n);
    for (let k = 0; k < n; k++) ev[k] = [arr[2 * k], arr[2 * k + 1]];
    ev.sort((a, b) => a[0] - b[0]);
    const ivs = [];
    let depth = 0, inY = 0, prevY = -1e18, prevDir = 0;
    for (const [y, d] of ev) {
      if (d === prevDir && y - prevY < EPS) continue;   // 镶嵌重复交点去重
      prevY = y; prevDir = d;
      if (d > 0) { if (depth === 0) inY = y; depth++; }
      else if (depth > 0) { depth--; if (depth === 0) ivs.push(inY, y); }
    }
    if (depth !== 0) dangling++;   // 非流形：未闭合列
    nInt[c] = ivs.length >> 1;
    cols[c] = ivs;
    total += nInt[c];
  }
  const offs = new Int32Array(N + 1);
  for (let c = 0; c < N; c++) offs[c + 1] = offs[c] + nInt[c];
  const ys = new Float32Array(total * 2);
  for (let c = 0; c < N; c++) {
    if (!nInt[c]) continue;
    ys.set(cols[c], offs[c] * 2);
  }
  // 非空列按首区间入口排序——供顺序层采样维护活动列集合（摊还 O(活动列数)）
  const ne = [];
  for (let c = 0; c < N; c++) if (nInt[c]) ne.push(c);
  ne.sort((a, b) => ys[offs[a] * 2] - ys[offs[b] * 2]);
  return { W, H, sx, sz, x0, z0, nInt, offs, ys, dangling, nonEmpty: Int32Array.from(ne) };
}

/* 层采样：y 处位图 ⇔ 该列某区间覆盖 y。输出与 rasterizeSection 相同的 Uint8Array。
   两种模式：
   - 随机访问（层检查器滑条）：不传 cursor/match/act，全列扫描
   - 顺序推进（analyze 逐层）：传 cursor + act——act 维护活动列集合（按首区间入口激活、
     区间用尽失活），cursor 列内游标单调推进，摊还 O(活动列数)；match 记录命中区间索引。
   occ 清除：顺序模式由调用方保证传入 setList，本函数只清上一层的置位像素。 */
export function sampleLDILayer(ld, y, occ, setList, cursor, match, act) {
  if (setList) {
    for (let i = 0; i < setList.n; i++) occ[setList.arr[i]] = 0;
    setList.n = 0;
  } else occ.fill(0);
  if (act) {
    // 激活：nonEmpty 已按首区间入口排序
    while (act.next < ld.nonEmpty.length) {
      const c = ld.nonEmpty[act.next];
      if (ld.ys[ld.offs[c] * 2] > y) break;
      act.active.push(c); act.next++;
    }
    let w = 0;
    for (let i = 0; i < act.active.length; i++) {
      const c = act.active[i];
      const b = ld.offs[c], e = b + ld.nInt[c];
      let k = cursor[c]; if (k < b) k = b;
      while (k < e && ld.ys[2 * k + 1] < y) k++;
      cursor[c] = k;
      if (k >= e) continue;                    // 列区间用尽 → 失活
      act.active[w++] = c;
      if (y >= ld.ys[2 * k]) {
        occ[c] = 1;
        if (setList) setList.arr[setList.n++] = c;
        if (match) match[c] = k;   // 仅覆盖列记录（悬空测量只读本层置位像素）
      }
    }
    act.active.length = w;
    return occ;
  }
  const N = ld.W * ld.H;
  for (let c = 0; c < N; c++) {
    let m = -1;
    const b = ld.offs[c], e = b + ld.nInt[c];
    if (b < e) {
      let k = b;
      for (; k < e && y > ld.ys[2 * k + 1]; k++);
      if (k < e && y >= ld.ys[2 * k]) m = k;
    }
    if (m >= 0) {
      occ[c] = 1;
      if (setList) setList.arr[setList.n++] = c;
    }
    if (match) match[c] = m;
  }
  return occ;
}

/* 精确悬空测量：像素列内覆盖 z 的区间，其入口即支撑尖端高度（贴面精确），
   gap = 区间入口 − 下方区间的出口（无下方材料时为平台面 floorY） */
export function ldiGapAt(ld, c, z, floorY) {
  const b = ld.offs[c], e = b + ld.nInt[c];
  for (let k = b; k < e; k++) {
    const inY = ld.ys[2 * k], outY = ld.ys[2 * k + 1];
    if (z >= inY && z <= outY) {
      const below = k > b ? ld.ys[2 * (k - 1) + 1] : floorY;
      return { gap: inY - below, surfY: inY };
    }
  }
  return null;
}

/* 对照验证（M1 验收）：同一栅格下逐层比较 LDI 采样位图与 rasterizeSection 位图。
   coreDiff = 差异像素中「3×3 邻域内无边界」的内核差异——边界口径差可接受，内核差异不可接受。 */
export function compareLDI(gridRes = 288, layerH = 0.1) {
  if (!state.mesh) return null;
  const pos = state.mesh.geometry.attributes.position.array;
  const idQ = new THREE.Quaternion();
  const A = analyze(pos, idQ, { gridRes, layerH, gapThresh: 0.35, detail: false, raiseH: 0 });
  const g = A.grid, N = g.W * g.H;
  const all = new Int32Array(p2triCount(A.p)); for (let i = 0; i < all.length; i++) all[i] = i;
  const ld = buildLDI(A.p, all, g);
  const occA = new Uint8Array(N), occB = new Uint8Array(N);
  let diffTotal = 0, coreDiff = 0, maxLayerDiff = 0, coreA1 = 0, coreA0 = 0;   // coreA1: LDI 漏材（不可接受）；coreA0: 位图幻影洞/LDI 多算（并集语义修正）
  for (let l = 0; l < A.metrics.layers; l++) {
    const z = g.minY + (l + 0.5) * layerH + 1e-5;
    occA.fill(0); A.setList.n = 0;
    rasterizeSection(A.p, A.bins[l], z, occA, A.setList, g, A.rowXs);
    sampleLDILayer(ld, z, occB);
    let layerDiff = 0;
    for (let i = 0; i < N; i++) {
      if (occA[i] === occB[i]) continue;
      diffTotal++; layerDiff++;
      let uniform = true;
      const ci = i % g.W, cj = (i / g.W) | 0, v = occA[i];
      for (let dj = -1; dj <= 1 && uniform; dj++) {
        const jj = cj + dj; if (jj < 0 || jj >= g.H) { uniform = false; break; }
        for (let di = -1; di <= 1; di++) {
          const ii = ci + di; if (ii < 0 || ii >= g.W) { uniform = false; break; }
          if (occA[jj * g.W + ii] !== v) { uniform = false; break; }
        }
      }
      if (uniform) { coreDiff++; if (v === 1) coreA1++; else coreA0++; }
    }
    if (layerDiff > maxLayerDiff) maxLayerDiff = layerDiff;
  }
  // 定位前几个内核差异列，输出其区间表用于诊断
  const coreSamples = [];
  for (let l = 0; l < A.metrics.layers && coreSamples.length < 5; l++) {
    const z = g.minY + (l + 0.5) * layerH + 1e-5;
    occA.fill(0); A.setList.n = 0;
    rasterizeSection(A.p, A.bins[l], z, occA, A.setList, g, A.rowXs);
    sampleLDILayer(ld, z, occB);
    for (let i = 0; i < N && coreSamples.length < 5; i++) {
      if (occA[i] === occB[i]) continue;
      const ci = i % g.W, cj = (i / g.W) | 0, v = occA[i];
      let uniform = true;
      for (let dj = -1; dj <= 1 && uniform; dj++) {
        const jj = cj + dj; if (jj < 0 || jj >= g.H) { uniform = false; break; }
        for (let di = -1; di <= 1; di++) {
          const ii = ci + di; if (ii < 0 || ii >= g.W) { uniform = false; break; }
          if (occA[jj * g.W + ii] !== v) { uniform = false; break; }
        }
      }
      if (uniform) {
        const b = ld.offs[i], e = b + ld.nInt[i];
        const ivs = [];
        for (let k = b; k < e; k++) ivs.push([+ld.ys[2 * k].toFixed(2), +ld.ys[2 * k + 1].toFixed(2)]);
        coreSamples.push({ layer: l, z: +z.toFixed(3), ci, cj, occA: v, wx: +(g.x0 + (ci + 0.5) * g.sx).toFixed(2), wz: +(g.z0 + (cj + 0.5) * g.sz).toFixed(2), ivs });
      }
    }
  }
  return { layers: A.metrics.layers, pixels: N * A.metrics.layers, diffTotal, coreDiff, coreA1, coreA0, maxLayerDiff, dangling: ld.dangling, intervals: ld.offs[N], coreSamples };
}
export function p2triCount(p) { return p.length / 9; }

/* 诊断：某列的全部原始交点（含法线 y 符号），供对照验证排错 */
export function ldiColumnCrossings(p, g, ci, cj) {
  const qx = g.x0 + (ci + 0.5) * g.sx, qz = g.z0 + (cj + 0.5) * g.sz;
  const out = [];
  const nf = p.length / 9;
  for (let f = 0; f < nf; f++) {
    const i3 = f * 9;
    const ax = p[i3], ay = p[i3 + 1], az = p[i3 + 2];
    const bx = p[i3 + 3], by = p[i3 + 4], bz = p[i3 + 5];
    const cx = p[i3 + 6], cy = p[i3 + 7], cz = p[i3 + 8];
    const v1x = bx - ax, v1z = bz - az, v0x = cx - ax, v0z = cz - az;
    const denom = v1x * v0z - v1z * v0x;
    if (Math.abs(denom) < 1e-14) continue;
    const v2x = qx - ax, v2z = qz - az;
    const u = (v2x * v0z - v2z * v0x) / denom;
    const v = (v1x * v2z - v1z * v2x) / denom;
    if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    out.push({ y: +(ay + u * (by - ay) + v * (cy - ay)).toFixed(4), ny: ny > 0 ? 1 : (ny < 0 ? -1 : 0) });
  }
  out.sort((a, b) => a.y - b.y);
  return out;
}
