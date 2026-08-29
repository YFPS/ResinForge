import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/* ================================================================
   基础工具
================================================================ */
const $ = id => document.getElementById(id);
const nextFrame = () => new Promise(r => requestAnimationFrame(r));
function log(msg, cls = '') {
  const t = new Date().toTimeString().slice(0, 8);
  const el = document.createElement('div');
  if (cls) el.className = cls;
  el.innerHTML = `<span class="t">[${t}]</span>${msg}`;
  $('log').appendChild(el);
  while ($('log').children.length > 120) $('log').firstChild.remove();
  $('log').scrollTop = 1e9;
}
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}
function setProgress(p, text) {
  $('progressWrap').style.display = p == null ? 'none' : 'block';
  if (p != null) { $('progressFill').style.width = (p * 100).toFixed(1) + '%'; $('progressText').textContent = text || ''; }
}

/* ================================================================
   three.js 场景
================================================================ */
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.fog = new THREE.Fog(0x0d1117, 300, 900);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 3000);
camera.position.set(95, 75, 95);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 22, 0);
controls.enableDamping = true; controls.dampingFactor = 0.12;

scene.add(new THREE.HemisphereLight(0xcdd9e5, 0x0d1117, 1.15));
const dl = new THREE.DirectionalLight(0xffffff, 1.6);
dl.position.set(60, 120, 40); scene.add(dl);
const dl2 = new THREE.DirectionalLight(0x8899aa, 0.5);
dl2.position.set(-80, 40, -60); scene.add(dl2);

/* 打印平台：不显示实体板（演示画面更干净），仅以网格标示成型平面；网格尺寸跟随机器配置 */
let gridMesh = null;
function buildPlate() {
  const L = parseFloat($('plateX').value) || 150, W = parseFloat($('plateZ').value) || 85;
  if (gridMesh) { scene.remove(gridMesh); gridMesh.geometry.dispose(); gridMesh.material.dispose(); }
  const gs = Math.max(L, W);
  gridMesh = new THREE.GridHelper(gs, Math.max(10, Math.round(gs / 5)), 0x2a3648, 0x1c2532);
  scene.add(gridMesh);
}
['plateX', 'plateZ'].forEach(id => $(id).addEventListener('change', buildPlate));
scene.add(new THREE.AxesHelper(12));

const modelGroup = new THREE.Group(); scene.add(modelGroup);
const supportGroup = new THREE.Group(); scene.add(supportGroup);

const modelMat = new THREE.MeshStandardMaterial({
  color: 0xb9c2cf, roughness: 0.55, metalness: 0.15, vertexColors: true
});
const supMat = new THREE.MeshStandardMaterial({ color: 0x38d996, roughness: 0.5, metalness: 0.05 });
const supMatAnchor = new THREE.MeshStandardMaterial({ color: 0xffb020, roughness: 0.5, metalness: 0.05 });

/* 预览渲染器（朝向候选缩略图） */
const prevRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
prevRenderer.setSize(112, 112);
const prevScene = new THREE.Scene();
prevScene.background = new THREE.Color(0x0d1117);
prevScene.add(new THREE.HemisphereLight(0xcdd9e5, 0x0d1117, 1.3));
const pdl = new THREE.DirectionalLight(0xffffff, 1.6); pdl.position.set(60, 120, 40); prevScene.add(pdl);
const prevCam = new THREE.PerspectiveCamera(40, 1, 0.1, 3000);
let prevMesh = null;

function resize() {
  const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

/* ================================================================
   状态
================================================================ */
const state = {
  mesh: null,               // 模型 Mesh（非索引 geometry，底部贴 y=0）
  protectedFaces: new Set(),
  supports: [],             // {mesh,x,z,y}
  analysis: null,           // 详细分析结果
  orientResult: null,        // 当前最佳朝向候选
  mode: 'orbit',
  painting: false,
};
window.state = state;   // 调试/自动化访问口
window.THREE = THREE;  // 调试/自动化访问口
let faces = null; // {ny, area, cent} 原始面数据（随几何变化重建）

/* 打印工艺参数：世界系 = 打印系（平台顶面 y=0，模型底面抬高 raiseH，筏层厚 RAFT_T） */
const RAFT_T = 1.2;    // 筏层厚度（mm），固定
let raftMesh = null;   // 筏层显示 Mesh
const raiseH = () => Math.max(0, parseFloat($('raiseH').value) || 0);   // 模型抬高（mm）
const raftOn = () => $('raftOn').checked;
const raftMargin = () => parseFloat($('raftMargin').value) || 3;

/* ================================================================
   切片引擎（像素级光栅化，Y 为打印方向）
================================================================ */
let _p1x = 0, _p1z = 0, _p2x = 0, _p2z = 0, _got = 0;
function _edge(x1, y1, z1, x2, y2, z2, z) {
  if ((y1 > z) !== (y2 > z)) {
    const t = (z - y1) / (y2 - y1);
    if (_got === 0) { _p1x = x1 + t * (x2 - x1); _p1z = z1 + t * (z2 - z1); _got = 1; }
    else { _p2x = x1 + t * (x2 - x1); _p2z = z1 + t * (z2 - z1); _got = 2; }
  }
}

function rasterizeSection(p, tris, z, occ, setList, g, rowXs) {
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
function computeFaceData(pos) {
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
function analyze(pos, q, opts) {
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
  const lMin = raiseHv > 0 ? 0 : 1;   // 抬高时首层悬空于筏层之上，需参与孤岛判定
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
            if (overhang.length < 40000) overhang.push({ x: wx, z: wz, y: surfY, gap });
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
          // 与下层的接触面积不足阈值 → 视为孤岛（单像素搭接强度不够，剥离会撕裂）
          const isIsl = l >= lMin && comp.length >= minIslPx && outW < attachPx;
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

/* 陡峭悬空面（法线判定，保护面加权） */
function steepFaceMetric(faces, q, selfAngleDeg, prot, protW) {
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
function computeFaceDataFull(pos) {
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

function steepFaces(facesF, q, selfAngleDeg, prot, protW, collectPts) {
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
          z: rot[2] * cx + rot[6] * cy + rot[10] * cz
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
function buildLDI(p, tris, g) {
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
function sampleLDILayer(ld, y, occ, setList, cursor, match, act) {
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
function ldiGapAt(ld, c, z, floorY) {
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
function compareLDI(gridRes = 288, layerH = 0.1) {
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
function p2triCount(p) { return p.length / 9; }

/* 诊断：某列的全部原始交点（含法线 y 符号），供对照验证排错 */
function ldiColumnCrossings(p, g, ci, cj) {
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

/* ================================================================
   模型载入
================================================================ */
function setGeometry(geom, name) {
  clearSupports(false);
  state.protectedFaces.clear();
  state.analysis = null;
  state.orientResult = null;
  $('orientResults').style.display = 'none';
  $('sliceStats').innerHTML = '';
  $('supStats').innerHTML = '';
  $('inspector').style.display = 'none';

  if (geom.index) geom = geom.toNonIndexed();
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
  geom.translate(-cx, -bb.min.y, -cz);
  geom.computeBoundingBox();

  // 顶点色（保护面显示）
  const vc = geom.attributes.position.count;
  const colors = new Float32Array(vc * 3).fill(1);
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  if (state.mesh) { modelGroup.remove(state.mesh); state.mesh.geometry.dispose(); }
  state.mesh = new THREE.Mesh(geom, modelMat);
  state.mesh.position.y = raiseH();   // 世界系：模型底面抬高到筏层上方
  modelGroup.add(state.mesh);
  faces = computeFaceDataFull(geom.attributes.position.array);

  if (prevMesh) { prevScene.remove(prevMesh); }
  prevMesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xb9c2cf, roughness: 0.55, metalness: 0.15 }));
  prevScene.add(prevMesh);

  const bb2 = geom.boundingBox;
  const size = bb2.max.clone().sub(bb2.min);
  const nf = geom.attributes.position.count / 3;
  $('modelInfo').innerHTML = `<div class="kv"><span>文件</span><b>${name}</b></div>
    <div class="kv"><span>尺寸</span><b>${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm</b></div>
    <div class="kv"><span>三角形</span><b>${nf.toLocaleString()}</b></div>`;
  // 相机适配
  const r = Math.max(size.x, size.y, size.z);
  camera.position.set(r * 1.4, r * 1.15, r * 1.4);
  controls.target.set(0, size.y * 0.35, 0);
  log(`模型已载入：${name}（${nf.toLocaleString()} 面，${size.y.toFixed(1)}mm 高）`, 'ok');
  if (nf > 120000) log('⚠ 面数较大，分析可能较慢', 'warn');
  const pX = parseFloat($('plateX').value) || 150, pZ = parseFloat($('plateZ').value) || 85;
  if (size.x > pX || size.z > pZ) log(`⚠ 模型底面 ${size.x.toFixed(0)}×${size.z.toFixed(0)}mm 超出板面 ${pX}×${pZ}mm`, 'warn');
  updateRaft();
}

/* 筏层显示：模型 XZ 外接圆半径 + 边距，厚 RAFT_T，顶面即落板支撑的着落面 */
function updateRaft() {
  if (raftMesh) { scene.remove(raftMesh); raftMesh.geometry.dispose(); raftMesh = null; }
  if (!state.mesh || !raftOn()) return;
  const bb = state.mesh.geometry.boundingBox;
  const r = Math.hypot(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2 + raftMargin();
  raftMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, RAFT_T, 64),
    new THREE.MeshStandardMaterial({ color: 0x2a3444, roughness: 0.9, metalness: 0.05, transparent: true, opacity: 0.85 })
  );
  raftMesh.position.y = RAFT_T / 2;
  scene.add(raftMesh);
}
$('raftOn').addEventListener('change', () => { updateRaft(); toast('筏层设置已变更，请重新生成支撑'); });
$('raftMargin').addEventListener('change', updateRaft);
$('raiseH').addEventListener('change', () => {
  const h = raiseH();
  if (state.mesh) state.mesh.position.y = h;
  clearSupports(false); updateSupStats();
  state.analysis = null;
  $('inspector').style.display = 'none';
  $('sliceStats').innerHTML = '';
  log(`抬高已改为 ${h}mm，请重新运行逐层分析`, 'warn');
});

/* 内置演示模型 */
function mergeGeoms(parts) {
  const geoms = parts.map(pt => {
    let g = pt.g; if (g.index) g = g.toNonIndexed();
    g.applyMatrix4(new THREE.Matrix4().makeTranslation(pt.x || 0, pt.y || 0, pt.z || 0));
    return g;
  });
  let total = 0;
  geoms.forEach(g => total += g.attributes.position.count * 3);
  const arr = new Float32Array(total);
  let off = 0;
  geoms.forEach(g => { arr.set(g.attributes.position.array, off); off += g.attributes.position.array.length; });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  out.computeVertexNormals();
  return out;
}
function loadDemo(kind) {
  let g;
  if (kind === 'knot') {
    g = new THREE.TorusKnotGeometry(13, 3.8, 200, 30);
    g.scale(1.5, 1.5, 1.5);
  } else if (kind === 'mushroom') {
    g = mergeGeoms([
      { g: new THREE.CylinderGeometry(3.5, 5.5, 22, 28), y: 11 },
      (() => { // 伞盖做成 1.2mm 封闭薄壳：开口的零厚度半球会被切片按实心圆盘填充，与真实几何不符
        const pts = [];
        for (let i = 0; i <= 24; i++) { const th = i / 24 * Math.PI / 2; pts.push(new THREE.Vector2(15.8 * Math.sin(th), 22 + 15.8 * Math.cos(th))); } // 内球面：顶→赤道
        for (let i = 24; i >= 0; i--) { const th = i / 24 * Math.PI / 2; pts.push(new THREE.Vector2(17.0 * Math.sin(th), 22 + 17.0 * Math.cos(th))); } // 外球面：赤道→顶
        return { g: new THREE.LatheGeometry(pts, 48), y: 0 };
      })(),
    ]);
  } else if (kind === 'tier') {
    g = mergeGeoms([
      { g: new THREE.CylinderGeometry(3, 4, 20, 24), y: 10 },         // 立柱
      { g: new THREE.CylinderGeometry(13, 13, 3, 32), y: 21.5 },      // 下层平台
      { g: new THREE.CylinderGeometry(10, 10, 3, 32), y: 26.5 },       // 上层平台（悬空 2mm）
    ]);
  } else {
    g = mergeGeoms([
      { g: new THREE.BoxGeometry(30, 5, 30), y: 2.5 },
      { g: new THREE.CylinderGeometry(7, 10, 30, 24), y: 20 },
      { g: new THREE.SphereGeometry(8, 24, 16), y: 50 },
      { g: new THREE.BoxGeometry(30, 2.5, 2.5), y: 40 },
      { g: new THREE.BoxGeometry(1.5, 28, 2.5), x: 14, y: 54 },
    ]);
  }
  setGeometry(g, { knot: '环面结(演示)', mushroom: '蘑菇(演示)', tier: '双层平台(演示)', statue: '悬臂雕像(演示)' }[kind]);
}

/* STL 载入 */
const stlLoader = new STLLoader();
function loadSTLBuffer(buf, name) {
  try {
    let g = stlLoader.parse(buf);
    if (g.index) g = g.toNonIndexed();
    g.rotateX(-Math.PI / 2); // STL 惯例 Z-up → Y-up
    setGeometry(g, name);
    log('已按 STL 惯例将 Z-up 转为 Y-up，如需调整可运行朝向优化');
  } catch (e) {
    log('STL 解析失败：' + e.message, 'warn');
  }
}
$('btnLoad').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  f.arrayBuffer().then(b => loadSTLBuffer(b, f.name));
};
document.querySelectorAll('[data-demo]').forEach(b => b.onclick = () => loadDemo(b.dataset.demo));
window.addEventListener('dragover', e => { e.preventDefault(); $('dropHint').classList.add('show'); });
window.addEventListener('dragleave', e => { if (e.target === document.body || e.target === canvas.parentElement) $('dropHint').classList.remove('show'); });
window.addEventListener('drop', e => {
  e.preventDefault(); $('dropHint').classList.remove('show');
  const f = e.dataTransfer.files[0];
  if (f && /\.stl$/i.test(f.name)) f.arrayBuffer().then(b => loadSTLBuffer(b, f.name));
  else if (f) toast('请拖入 .stl 文件');
});

/* ================================================================
   保护面笔刷
================================================================ */
const raycaster = new THREE.Raycaster();
function pointerRay(e) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  return raycaster;
}
function paintAt(e) {
  if (!state.mesh) return;
  const hits = pointerRay(e).intersectObject(state.mesh);
  if (!hits.length) return;
  const hit = hits[0];
  const r = parseFloat($('brushR').value);
  const colorAttr = state.mesh.geometry.attributes.color;
  const pos = state.mesh.geometry.attributes.position;
  const fi = hit.face.a / 3;
  const hp = state.mesh.worldToLocal(hit.point.clone());   // 命中点为世界系，面重心在局部系，需转换（模型被抬高 raiseH）
  const nf = pos.count / 3;
  let added = 0;
  for (let f = 0; f < nf; f++) {
    if (state.protectedFaces.has(f)) continue;
    const i = f * 9;
    const cx = (pos.array[i] + pos.array[i + 3] + pos.array[i + 6]) / 3;
    const cy = (pos.array[i + 1] + pos.array[i + 4] + pos.array[i + 7]) / 3;
    const cz = (pos.array[i + 2] + pos.array[i + 5] + pos.array[i + 8]) / 3;
    if (Math.hypot(cx - hp.x, cy - hp.y, cz - hp.z) <= r) {
      state.protectedFaces.add(f); added++;
      const v = f * 3;
      for (let k = 0; k < 3; k++) {
        colorAttr.setXYZ(v + k, 1, 0.38, 0.38);
      }
    }
  }
  if (added) { colorAttr.needsUpdate = true; log(`保护面 +${added}（共 ${state.protectedFaces.size} 面）`); }
}
$('btnClearProt').onclick = () => {
  state.protectedFaces.clear();
  if (state.mesh) {
    const ca = state.mesh.geometry.attributes.color;
    for (let i = 0; i < ca.array.length; i++) ca.array[i] = 1;
    ca.needsUpdate = true;
  }
  log('保护面已清除');
};

/* ================================================================
   朝向优化
================================================================ */
function randomQuat() {
  const u1 = Math.random(), u2 = Math.random() * Math.PI * 2, u3 = Math.random() * Math.PI * 2;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return new THREE.Quaternion(a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)).normalize();
}
function canonicalQuats() {
  const qs = [new THREE.Quaternion()];
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const ax of axes) {
    for (const ang of [Math.PI / 2, Math.PI, -Math.PI / 2]) {
      qs.push(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...ax), ang));
    }
  }
  return qs;
}

$('btnOrient').onclick = async () => {
  if (!state.mesh) return toast('请先载入模型');
  const pos = state.mesh.geometry.attributes.position.array;
  const facesF = computeFaceDataFull(pos);
  const nRand = parseInt($('orientQuality').value);
  const selfAngle = parseFloat($('selfAngle').value);
  const protW = parseFloat($('protW').value);
  // 粗分析参数
  const bb = state.mesh.geometry.boundingBox;
  const spanY = bb.max.y - bb.min.y;
  const coarseH = Math.max(0.15, spanY / 160);
  const cands = [...canonicalQuats()];
  for (let i = 0; i < nRand; i++) cands.push(randomQuat());
  const results = [];
  const total = cands.length;
  log(`朝向优化：${total} 个候选 · 粗层厚 ${coarseH.toFixed(2)}mm · 自支撑角 ${selfAngle}°`);
  const t0 = performance.now();
  for (let i = 0; i < total; i++) {
    const q = cands[i];
    const r = analyze(pos, q, { gridRes: 128, layerH: coarseH, gapThresh: Math.max(0.5, coarseH * 2.5), raiseH: raiseH() });
    const sf = steepFaces(facesF, q, selfAngle, state.protectedFaces, protW, false);
    results.push({
      q, supportVol: r.metrics.supportVol, islandArea: r.metrics.islandArea,
      maxFill: r.metrics.maxFill, height: r.metrics.height, steepArea: sf.steepArea, protHit: sf.protHit
    });
    if (i % 2 === 1 || i === total - 1) {
      setProgress((i + 1) / total, `候选 ${i + 1}/${total}`);
      await nextFrame();
    }
  }
  // 归一化评分
  const mx = k => Math.max(1e-9, ...results.map(r => r[k]));
  const msv = mx('supportVol'), mia = mx('islandArea'), mmf = mx('maxFill'), mh = mx('height'), msa = mx('steepArea');
  for (const r of results) {
    r.w = 0.32 * (r.supportVol / msv) + 0.18 * (r.islandArea / mia) + 0.2 * (r.steepArea / msa) + 0.2 * (r.maxFill / mmf) + 0.1 * (r.height / mh);
  }
  results.sort((a, b) => a.w - b.w);
  const worstW = results[results.length - 1].w;
  for (const r of results) r.score = Math.max(1, Math.round(100 * (1 - r.w / worstW)));
  setProgress(null);
  log(`朝向优化完成：${((performance.now() - t0) / 1000).toFixed(1)}s · 最佳评分 ${results[0].score}`, 'ok');
  renderCandidates(results.slice(0, 8));
  state.orientResult = results[0];
};

function renderCandidates(list) {
  const box = $('orientResults');
  box.innerHTML = ''; box.style.display = 'block';
  if (!prevMesh) return;
  const scale = 1 / Math.max(1e-6, (() => {
    prevMesh.geometry.computeBoundingSphere();
    return prevMesh.geometry.boundingSphere.radius;
  })());
  list.forEach((r, idx) => {
    const div = document.createElement('div');
    div.className = 'cand' + (idx === 0 ? ' best' : '');
    const c = document.createElement('canvas'); c.width = 112; c.height = 112;
    const info = document.createElement('div'); info.className = 'info';
    info.innerHTML = `<b>${r.score} 分</b>${idx === 0 ? ' · 推荐' : ''}<br>
      支撑 ${r.supportVol.toFixed(0)}mm³ · 悬空 ${r.steepArea.toFixed(0)}mm²<br>
      孤岛 ${r.islandArea.toFixed(0)}mm² · 最大截面 ${r.maxFill.toFixed(0)}mm²`;
    div.append(c, info);
    div.onclick = () => applyOrientation(r);
    box.appendChild(div);
    // 渲染缩略图
    prevMesh.quaternion.copy(r.q);
    prevCam.position.set(0, r.height * 0.7, r.height * 1.3).normalize().multiplyScalar(r.height * 1.9);
    prevCam.lookAt(0, r.height * 0.35, 0);
    prevRenderer.render(prevScene, prevCam);
    c.getContext('2d').drawImage(prevRenderer.domElement, 0, 0);
  });
  const btn = document.createElement('button');
  btn.className = 'primary'; btn.style.width = '100%';
  btn.textContent = `应用最佳朝向（${list[0].score} 分）`;
  btn.onclick = () => applyOrientation(list[0]);
  box.appendChild(btn);
  void scale;
}

function applyOrientation(r) {
  if (!state.mesh) return;
  const geom = state.mesh.geometry;
  geom.applyQuaternion(r.q);
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
  geom.translate(-cx, -bb.min.y, -cz);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  prevMesh.quaternion.identity();
  faces = computeFaceDataFull(geom.attributes.position.array);
  // 保护面随几何保留（面索引不变），顶点色不变
  state.analysis = null;
  clearSupports(false);
  $('sliceStats').innerHTML = '';
  $('inspector').style.display = 'none';
  $('orientResults').style.display = 'none';
  log(`已应用朝向（评分 ${r.score}）：支撑体积 ${r.supportVol.toFixed(0)}mm³，请运行逐层分析`, 'ok');
  toast('朝向已应用，请运行逐层分析');
}

/* ================================================================
   详细切片分析 + 层检查器
================================================================ */
$('btnSlice').onclick = async () => {
  if (!state.mesh) return toast('请先载入模型');
  const geom = state.mesh.geometry;
  const pos = geom.attributes.position.array;
  const layerH = parseFloat($('layerH').value);
  const gapThresh = parseFloat($('gapThresh').value);
  const selfAngle = parseFloat($('selfAngle').value);
  setProgress(0.05, '逐层切片中…');
  await nextFrame();
  const t0 = performance.now();
  const idQ = new THREE.Quaternion();
  const rh = raiseH();
  const r = analyze(pos, idQ, {
    gridRes: 288, layerH, gapThresh, detail: true, raiseH: rh,
    minIslArea: parseFloat($('minIslArea').value), minAttachArea: parseFloat($('minAttach').value)
  });
  setProgress(0.85, '陡峭悬空面分析…');
  await nextFrame();
  const sf = steepFaces(faces, idQ, selfAngle, state.protectedFaces, 1, true);
  if (rh > 0) for (const pt of sf.pts) pt.y += rh;   // 面重心为局部坐标，抬到世界系
  r.steepPts = sf.pts;
  r.protSteep = sf.protHit;
  state.analysis = r;
  setProgress(null);
  const m = r.metrics;
  const totIslandArea = r.islands.reduce((s, i) => s + i.area, 0);
  $('sliceStats').innerHTML = `
    <div class="kv"><span>总层数</span><b>${m.layers.toLocaleString()}</b></div>
    <div class="kv"><span>抬高 / 筏层</span><b>${rh}mm / ${raftOn() ? RAFT_T + 'mm' : '关'}</b></div>
    <div class="kv"><span>孤岛数量</span><b class="${r.islands.length ? 'warn' : 'good'}">${r.islands.length} 处</b></div>
    <div class="kv"><span>孤岛总面积</span><b>${totIslandArea.toFixed(1)} mm²</b></div>
    <div class="kv"><span>陡峭悬空面积</span><b>${sf.steepArea.toFixed(1)} mm²</b></div>
    <div class="kv"><span>触保护面悬空</span><b class="${sf.protHit > 0 ? 'warn' : 'good'}">${sf.protHit.toFixed(1)} mm²</b></div>
    <div class="kv"><span>预估支撑体积</span><b>${m.supportVol.toFixed(1)} mm³</b></div>
    <div class="kv"><span>最大截面</span><b>${m.maxFill.toFixed(1)} mm²</b></div>`;
  log(`逐层分析完成：${m.layers} 层 · 孤岛 ${r.islands.length} 处 · ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'ok');
  // 日志框逐层输出孤岛数量（仅列出存在孤岛的层）
  if (r.islands.length) {
    const byLayer = new Map();
    for (const isl of r.islands) {
      const e = byLayer.get(isl.layer) || { n: 0, area: 0, y: isl.y };
      e.n++; e.area += isl.area;
      byLayer.set(isl.layer, e);
    }
    for (const [layer, e] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
      log(`孤岛 @ 层 ${layer + 1}/${m.layers} · y=${e.y.toFixed(2)}mm · ${e.n} 处 · 面积 ${e.area.toFixed(1)}mm²`, 'warn');
    }
  }
  // 分析格与机器像素关系提示：格子粗于 2 个机器像素时，薄壁/细柱悬空可能漏检
  const pxMm = (parseFloat($('pixelUm').value) || 24) / 1000;
  const cellMm = Math.max(r.grid.sx, r.grid.sz);
  if (cellMm > pxMm * 2) log(`⚠ 分析格 ${cellMm.toFixed(2)}mm ≈ ${(cellMm / pxMm).toFixed(0)}× 机器像素（${(pxMm * 1000).toFixed(0)}µm），细于 ${(pxMm * 2).toFixed(2)}mm 的悬空结构可能漏检`, 'warn');
  // 层检查器
  $('inspector').style.display = 'block';
  $('layerSlider').max = m.layers;
  const firstIsland = r.islands.length ? Math.max(1, r.islands[0].layer + 1) : 1;
  $('layerSlider').value = firstIsland;
  drawLayer();
};

function sliceAt(layerIdx) {
  const A = state.analysis;
  const nl = A.bins.length;
  // 钳制索引：NaN / 越界 / 空 bins 均回退到安全值，避免 undefined 崩溃
  let li = Number.isFinite(layerIdx) ? layerIdx : 0;
  if (nl === 0) return new Uint8Array(A.grid.W * A.grid.H);
  li = Math.max(0, Math.min(li, nl - 1));
  const z = A.grid.minY + (li + 0.5) * A.grid.layerH + 1e-5;
  const N = A.grid.W * A.grid.H;
  const occ = new Uint8Array(N);
  if (A.ld) sampleLDILayer(A.ld, z, occ);
  else {
    const sl = { arr: new Int32Array(N), n: 0 };
    rasterizeSection(A.p, A.bins[li], z, occ, sl, A.grid, A.rowXs);
  }
  return occ;
}

function drawLayer() {
  const A = state.analysis; if (!A) return;
  const l = parseInt($('layerSlider').value);
  const occ = sliceAt(l - 1);
  const occPrev = l > 1 ? sliceAt(l - 2) : null;
  const { W, H, sx, sz: szg, x0, z0 } = A.grid;
  // 孤岛高亮：本层连通域与下层接触面积不足阈值（阈值来自逐层分析，已按像素面积换算）
  const visited = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const islandMask = new Uint8Array(W * H);
  const lMin = A.raiseH > 0 ? 1 : 2;   // 抬高时首层（滑块 1）悬空于筏层之上
  let islandCount = 0;
  for (let i = 0; i < W * H; i++) {
    if (!occ[i] || visited[i]) continue;
    let head = 0, tl = 0;
    stack[tl++] = i; visited[i] = 1;
    const comp = [];
    while (head < tl) {
      const c = stack[head++]; comp.push(c);
      const ci = c % W, cj = (c / W) | 0;
      if (ci + 1 < W && occ[c + 1] && !visited[c + 1]) { visited[c + 1] = 1; stack[tl++] = c + 1; }
      if (ci - 1 >= 0 && occ[c - 1] && !visited[c - 1]) { visited[c - 1] = 1; stack[tl++] = c - 1; }
      if (cj + 1 < H && occ[c + W] && !visited[c + W]) { visited[c + W] = 1; stack[tl++] = c + W; }
      if (cj - 1 >= 0 && occ[c - W] && !visited[c - W]) { visited[c - W] = 1; stack[tl++] = c - W; }
    }
    if (l >= lMin && comp.length >= A.minIslPx) {
      let ov = 0;
      if (occPrev) for (const c of comp) if (occPrev[c]) ov++;
      if (ov < A.attachPx) { islandCount++; for (const c of comp) islandMask[c] = 1; }
    }
  }
  // 绘制（叠加显示：红=孤岛，蓝=本层附着材料，暗青=下层残影——直观看出每块材料脚下是否有支撑）
  const img = new ImageData(W, H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const id = j * W + i;
    if (occ[id]) {
      if (islandMask[id]) { img.data[id * 4] = 235; img.data[id * 4 + 1] = 70; img.data[id * 4 + 2] = 70; }
      else { img.data[id * 4] = 62; img.data[id * 4 + 1] = 110; img.data[id * 4 + 2] = 200; }
      img.data[id * 4 + 3] = 235;
    } else if (occPrev && occPrev[id]) {
      img.data[id * 4] = 56; img.data[id * 4 + 1] = 76; img.data[id * 4 + 2] = 70;
      img.data[id * 4 + 3] = 150;
    }
  }
  const cv = $('layerCanvas');
  const ctx = cv.getContext('2d');
  const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(tmp, 0, 0, cv.width, cv.height);
  // 支撑叠加
  ctx.strokeStyle = 'rgba(56,217,150,.9)'; ctx.fillStyle = 'rgba(56,217,150,.9)';
  const spanX = W * sx, spanZ = H * szg;
  for (const s of state.supports) {
    const px = (s.x - x0) / spanX * cv.width, pz = (s.z - z0) / spanZ * cv.height;
    ctx.beginPath(); ctx.arc(px, pz, 2.5, 0, Math.PI * 2); ctx.fill();
  }
  const z = A.grid.minY + (l - 0.5) * A.grid.layerH;
  $('layerLabel').textContent = `层 ${l}/${A.grid.layers} · y=${z.toFixed(2)}mm · 本层孤岛 ${islandCount} 处 · 支撑 ${state.supports.length}`;
}
$('layerSlider').addEventListener('input', drawLayer);

/* ================================================================
   支撑生成
================================================================ */
function clearSupports(refresh = true) {
  for (const s of state.supports) { supportGroup.remove(s.mesh); s.mesh.geometry.dispose(); }
  state.supports = [];
  if (refresh) { updateSupStats(); if (state.analysis) drawLayer(); }
}
function updateSupStats() {
  const n = state.supports.length;
  const anchored = state.supports.filter(s => s.anchored).length;
  const prot = state.protectedFaces.size;
  $('supStats').innerHTML = `
    <div class="kv"><span>当前支撑数</span><b class="${n ? 'good' : ''}">${n}</b></div>
    <div class="kv"><span>锚定短小支撑</span><b style="color:#ffb020">${anchored}</b></div>
    <div class="kv"><span>落板支撑</span><b style="color:#38d996">${n - anchored}</b></div>
    <div class="kv"><span>保护面</span><b>${prot.toLocaleString()} 面</b></div>`;
}
/* PrusaSlicer 风格分段支撑，落板支撑从上到下六部位：
   顶部球头(r_pin) → 锥头(切线裙边) → 中部球头(r_back) → 主干(柱身) → 锥底(基座锥台) → 底板(筏层)
   锚定短小支撑底部为「反向销头」（底部球头 + 锥头镜像），无锥底、不倾斜。
   平滑合并三原则（对应 PrusaSlicer SupportTreeMesher 的 pinhead 切线几何）：
   ① 锥头与两球头在切线圆处相接：半锥角 α = asin((r_back − r_pin) / 球心距)，相切无折角
   ② 主干端部嵌入中部球头的球心，柱半径 = 球半径，球赤道与柱面自然相切
   ③ 不做布尔并集，重叠实体在切片偶奇填充下自然合并（同 its_merge），导出 STL 被下游切片器兼容
   销头自动朝向（对应 PrusaSlicer Head.dir）：沿接触面外法线倾斜，限锥角 = 自支撑角 selfAngle；
   极点 = 接触点 + 轴·pen（沿轴扎入），主干保持垂直、接驳在倾斜销头的中部球头球心处（落点随倾角水平偏移，属预期行为） */
function makeSupportMesh(x, yTip, z, yBase = 0, anchored = false, nrm = null) {
  const tipR = Math.max(0.05, parseFloat($('tipD').value) / 2);       // 顶部球头半径 r_pin
  const midR = Math.max(tipR * 1.5, parseFloat($('midD').value) / 2); // 中部球头半径 r_back = 主干半径
  const baseR = Math.max(midR, parseFloat($('baseD').value) / 2);     // 锥底底半径
  const pen = Math.min(0.3, Math.max(0.1, tipR));                     // 扎入深度
  const span = Math.max(0.4, yTip - yBase);                           // 总跨度（局部系 y=0 在 yBase）
  const nHeads = anchored ? 2 : 1;
  let robe = Math.max(0.4, midR * 1.8);
  robe = Math.min(robe, Math.max(0.12, (span - nHeads * (tipR + midR) - 0.15) / nHeads));
  const alpha = Math.asin(Math.min(0.9, (midR - tipR) / robe));       // 锥头半锥角（切线几何）
  const a1 = Math.PI / 2 - alpha, sinA = Math.sin(alpha), cosA = Math.cos(alpha);
  const parts = [];
  const SEG = 12;
  // 销头规范形：极点在原点、体沿 −Y 展开（顶部球头只露切线圆以上，中部球头露切线圆以下，锥头沿切线连接）
  const pinC = -tipR, backC = -(tipR + robe);
  const yA = pinC + tipR * sinA, yB = backC + midR * sinA;            // 两端切线圆高度
  const headGeom = mergeGeoms([
    { g: new THREE.SphereGeometry(tipR, SEG, 8, 0, Math.PI * 2, 0, a1), y: pinC },                         // 顶部球头
    { g: new THREE.SphereGeometry(midR, SEG, 10, 0, Math.PI * 2, a1, Math.PI - a1), y: backC },            // 中部球头
    { g: new THREE.CylinderGeometry(tipR * cosA, midR * cosA, yA - yB, SEG, 1, true), y: (yA + yB) / 2 },  // 锥头裙边
  ]);
  // 销头倾角：轴 = −n（钝端→尖端）；法线与垂直向下夹角 > 自支撑角 → 保持垂直；
  // 8° 死区：近平底（偏差 <8°）也不倾斜——吸收细分法线噪声，避免平底出现莫名斜头
  let axis = null;
  if (nrm && !anchored) {
    const cosSelf = Math.cos(parseFloat($('selfAngle').value) * Math.PI / 180);
    const cosDead = Math.cos(8 * Math.PI / 180);
    if (nrm[1] < -cosSelf - 1e-6 && nrm[1] > -cosDead) axis = new THREE.Vector3(-nrm[0], -nrm[1], -nrm[2]).normalize();
  }
  // 顶部销头：绕极点旋转（+Y → 轴）后放到极点。极点 = 接触点 + 轴·pen（沿轴扎入模型 pen 深；
  // 垂直时退化为 (0, span+pen, 0)。若极点只沿 +Y 偏移，倾斜时顶部球头会甩到表面外侧——方向就反了）
  const ax0 = axis ? axis.x : 0, ay0 = axis ? axis.y : 1, az0 = axis ? axis.z : 0;
  const poleX = ax0 * pen, poleY = span + ay0 * pen, poleZ = az0 * pen;
  const topHead = headGeom.clone();
  if (axis) topHead.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis)));
  parts.push({ g: topHead, x: poleX, y: poleY, z: poleZ });
  // 中部球头球心（倾斜后位置）= 极点 − 轴·(r_pin + 锥头长)
  const bcx = poleX - ax0 * (tipR + robe), bcy = poleY - ay0 * (tipR + robe), bcz = poleZ - az0 * (tipR + robe);
  // 底部：锚定→反向销头（垂直）；落板→锥底（随主干水平偏移）
  let pillarBotY;
  if (anchored) {
    const anch = headGeom.clone();
    anch.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI));
    parts.push({ g: anch, y: -pen });
    pillarBotY = -pen + (tipR + robe);
  } else {
    const pedH = Math.min(1.2, Math.max(0.5, span * 0.15), span * 0.45);
    parts.push({ g: new THREE.CylinderGeometry(midR, baseR, pedH, SEG + 2), x: bcx, y: pedH / 2, z: bcz });   // 锥底
    pillarBotY = pedH;
  }
  // 主干：顶端嵌入中部球头球心，垂直向下；跨度不足时退化为销头直抵锥底/对顶
  const pillarLen = bcy - pillarBotY;
  if (pillarLen > 0.1) parts.push({ g: new THREE.CylinderGeometry(midR, midR, pillarLen, SEG + 2), x: bcx, y: pillarBotY + pillarLen / 2, z: bcz });
  const geom = mergeGeoms(parts);
  const mesh = new THREE.Mesh(geom, anchored ? supMatAnchor : supMat);
  mesh.position.set(x, yBase, z);
  mesh.userData.tiltDeg = axis ? Math.round(Math.acos(ay0) * 180 / Math.PI) : 0;   // 调试/验证用
  return mesh;
}
function addSupport(x, y, z, anchorY = null, nrm = null) {
  const anchored = anchorY !== null;
  const yBase = anchored ? anchorY : (raftOn() ? RAFT_T : 0);   // 落板支撑落在筏层顶面
  const mesh = makeSupportMesh(x, y, z, yBase, anchored, nrm);
  supportGroup.add(mesh);
  state.supports.push({ mesh, x, z, y, anchored, tiltDeg: mesh.userData.tiltDeg || 0 });
  updateSupStats();
}

$('btnGenSup').onclick = async () => {
  if (!state.analysis) return toast('请先运行逐层分析');
  clearSupports(false);
  const A = state.analysis;
  const spacing = Math.max(1, parseFloat($('spacing').value));
  // 合并两个来源：栅格悬空点 + 陡峭面重心
  const all = [...A.overhang.map(o => ({ x: o.x, y: o.y, z: o.z })), ...A.steepPts];
  if (!all.length) {
    log('没有检测到需要支撑的悬空区域');
    updateSupStats();
    return;
  }
  setProgress(0.4, '网格降采样布点…'); await nextFrame();
  // 每个 spacing×spacing×spacing 体素保留最低点，避免连续表面被聚成一组；
  // Y 也参与分格：上下多层的悬空点（如双层平台）不会互相覆盖
  const cell = spacing;
  const key = (x, y, z) => ((Math.floor(y / cell) + 4096) * 8192 + (Math.floor(x / cell) + 4096)) * 8192 + (Math.floor(z / cell) + 4096);
  const reps = new Map();
  for (const pt of all) {
    const k = key(pt.x, pt.y, pt.z);
    if (!reps.has(k) || pt.y < reps.get(k).y) reps.set(k, pt);
  }
  const clusters = Array.from(reps.values()).sort((a, b) => a.y - b.y);
  // M4 图引导布点：孤岛关键点（周界降采样 + 全岛最低点）优先放置，与普通池同体素去重。
  // 周界支撑防孤岛边缘翘曲；最低点支撑孤岛根部的最大落差处。
  const keypoints = [];
  if (A.graph && A.ld) {
    const floorY = A.grid.minY - A.raiseH;
    const { W: GW, H: GH } = A.grid;
    for (const nd of A.graph.nodes) {
      if (!nd.island || !nd.pixels) continue;
      const pixSet = new Set(nd.pixels);
      let lowest = null;
      const periVox = new Map();
      for (const cc of nd.pixels) {
        const ci = cc % GW, cj = (cc / GW) | 0;
        const wx = A.grid.x0 + (ci + 0.5) * A.grid.sx, wz = A.grid.z0 + (cj + 0.5) * A.grid.sz;
        const gr = ldiGapAt(A.ld, cc, nd.y, floorY);
        if (!gr) continue;
        const pt = { x: wx, y: gr.surfY, z: wz };
        if (!lowest || pt.y < lowest.y) lowest = pt;
        const isPeri =
          (ci + 1 >= GW || !pixSet.has(cc + 1)) ||
          (ci - 1 < 0 || !pixSet.has(cc - 1)) ||
          (cj + 1 >= GH || !pixSet.has(cc + GW)) ||
          (cj - 1 < 0 || !pixSet.has(cc - GW));
        if (isPeri) {
          const k = key(wx, pt.y, wz);
          if (!periVox.has(k) || pt.y < periVox.get(k).y) periVox.set(k, pt);
        }
      }
      if (lowest) keypoints.push(lowest);
      for (const pt of periVox.values()) keypoints.push(pt);
    }
  }
  setProgress(0.7, '生成支撑几何体…'); await nextFrame();
  // 布点策略：孤岛关键点（周界+最低点）优先 → 普通悬空点体素聚类；尖端高度来自 LDI 区间入口（贴面精确）
  let suppressed = 0, placed = 0, anchoredN = 0, flushSkipped = 0;
  const MAX = 900;   // 抬高后模型底面轮廓会铺满布点，上限需覆盖底面 + 上层特征
  const posL = state.mesh.geometry.attributes.position.array;
  const rh = raiseH();
  // 世界系顶点（局部 + 抬高）：与分析产出的世界系悬空点、Y 分桶保持一致
  const pos = new Float32Array(posL.length);
  for (let i = 0; i < posL.length; i++) pos[i] = posL[i] + (i % 3 === 1 ? rh : 0);
  const nf = pos.length / 9;
  const useShort = $('shortSup').checked;
  // 向下射线核心（Möller–Trumbore，不剔背面）：复用分析的 Y 分桶，返回 oy 下方最高命中 {y, f}
  const rayDown = (x, oy, z, tMin = 0.1) => {
    const g = A.grid;
    const tipL = Math.min(A.bins.length - 1, Math.max(0, Math.floor((oy - g.minY) / g.layerH)));
    let bestY = -1e9, bestF = -1;
    for (let l = tipL; l >= 0; l--) {
      // 该 bin 顶部已低于当前最高命中 → 更下方不可能更高，提前结束
      if (bestY > -1e8 && g.minY + (l + 1) * g.layerH <= bestY) break;
      const bin = A.bins[l];
      for (let k = 0; k < bin.length; k++) {
        const i = bin[k] * 9;
        const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
        const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
        const cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8];
        // M-T：方向 (0,-1,0) 特化
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        const px = -e2z, pz = e2x;            // p = d × e2, d=(0,-1,0) → p=(-e2z, 0, e2x)
        const det = e1x * px + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const tx = x - ax, ty = oy - ay, tz = z - az;
        const u = (tx * px + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = -qy * inv;                  // v = d·q, d=(0,-1,0) → -qy
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > tMin) {
          const hy = oy - t;
          if (hy > bestY) { bestY = hy; bestF = bin[k]; }   // 取最高（最近）命中
        }
      }
    }
    return bestY > -1e8 ? { y: bestY, f: bestF } : null;
  };
  // 用途①贴面过滤②锚定底盘（命中任意距离的下方表面都优于落板贯穿模型）
  const findBelow = (x, yTip, z) => { const r = rayDown(x, yTip - 0.05, z); return r ? r.y : null; };
  // 接触面探测：从尖端上方 0.05mm 竖直向下取最近命中面——真实被触面，比「最近质心面」可靠
  const probeFace = (x, tipY, z) => {
    const r = rayDown(x, tipY + 0.05, z, 0.005);   // tMin 小阈值：命中 0.05 处的被触面（findBelow 的 0.1 会把它排除）
    if (!r || Math.abs(r.y - tipY) > 0.3) return -1;   // 命中离预期表面太远（薄壳顶盖等），法线不可信
    return r.f;
  };
  // 点是否落在模型实体内部：沿 +X 射线做奇偶计数，复用 Y 分桶
  // 用于贴面过滤——向下射线从实体内部起射时会误判为"下方悬空"，必须改用实体判定
  const isSolidAt = (x, y, z) => {
    const g = A.grid;
    let l = Math.floor((y - g.minY) / g.layerH);
    l = Math.max(0, Math.min(A.bins.length - 1, l));
    const bin = A.bins[l];
    let cnt = 0;
    for (let k = 0; k < bin.length; k++) {
      const i = bin[k] * 9;
      const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
      const e1x = pos[i + 3] - ax, e1y = pos[i + 4] - ay, e1z = pos[i + 5] - az;
      const e2x = pos[i + 6] - ax, e2y = pos[i + 7] - ay, e2z = pos[i + 8] - az;
      const hy = -e2z, hz = e2y;                 // d × e2, d=(1,0,0) → (0, -e2z, e2y)
      const det = e1y * hy + e1z * hz;
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const tx = x - ax, ty = y - ay, tz = z - az;
      const u = (ty * hy + tz * hz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = qx * inv;                        // v = d·q, d=(1,0,0) → qx
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 1e-7) cnt++;
    }
    return (cnt & 1) === 1;
  };
  // 放置单根支撑：保护面抑制 → 贴面过滤 → 锚定探测。返回状态供计数
  const placedVox = new Set();   // 已放置体素（关键点与普通池互斥去重）
  const tryPlace = (c) => {
    if (c.y < 0.25) return 'low';                 // 贴板/低于筏层顶的点不支撑（世界系）
    const tipY = c.y;                        // 不做抬升钳制，避免尖端扎进模型
    // 最近面保护检测
    let nearest = -1, nd2 = 1e9;
    for (let f = 0; f < nf; f++) {
      const i = f * 9;
      const cx = (pos[i] + pos[i + 3] + pos[i + 6]) / 3;
      const cy = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3;
      const cz = (pos[i] + pos[i + 5] + pos[i + 8]) / 3;
      const d2 = (cx - c.x) ** 2 + (cy - tipY) ** 2 + (cz - c.z) ** 2;
      if (d2 < nd2) { nd2 = d2; nearest = f; }
    }
    if (nearest >= 0 && state.protectedFaces.has(nearest) && nd2 < 25) return 'suppressed';
    // 贴面过滤：尖端正下方 0.15mm 已在实体内 → 该点本就由模型自身托住，无需支撑。
    // （不能用向下射线的距离判定：射线起点若在实体内，会一路穿到实体底面而误判为悬空）
    if (isSolidAt(c.x, tipY - 0.15, c.z)) return 'flush';
    const below = findBelow(c.x, tipY, c.z);
    const anchorY = (useShort && below !== null) ? below : null;
    if (anchorY !== null) anchoredN++;
    // 销头朝向法线：射线探测真实接触面（比最近质心面可靠）；锚定短小支撑不倾斜
    let nrm = null;
    if (anchorY === null && faces) {
      const pf = probeFace(c.x, tipY, c.z);
      if (pf >= 0) nrm = [faces.nrm[pf * 3], faces.nrm[pf * 3 + 1], faces.nrm[pf * 3 + 2]];
    }
    addSupport(c.x, tipY, c.z, anchorY, nrm);
    placed++;
    placedVox.add(key(c.x, tipY, c.z));
    return 'placed';
  };
  const tally = r => { if (r === 'suppressed') suppressed++; else if (r === 'flush') flushSkipped++; };
  // 第一相：孤岛关键点（优先保障，不受普通池挤占）
  let keyPlaced = 0;
  for (const c of keypoints) {
    if (placed >= MAX) break;
    const r = tryPlace(c);
    if (r === 'placed') keyPlaced++; else tally(r);
  }
  // 第二相：普通聚类池
  for (const c of clusters) {
    if (placed >= MAX) break;
    if (placedVox.has(key(c.x, c.y, c.z))) continue;
    tally(tryPlace(c));
  }
  setProgress(null);
  log(`支撑生成：${placed} 根（聚类 ${clusters.length} 组，孤岛关键点 ${keyPlaced}/${keypoints.length}，短小支撑锚定 ${anchoredN}，落板 ${placed - anchoredN}，贴面跳过 ${flushSkipped}，保护面抑制 ${suppressed} 处）`, 'ok');
  updateSupStats();
  if (state.analysis) drawLayer();
};
$('btnClearSup').onclick = () => clearSupports();

/* ================================================================
   导出二进制 STL
================================================================ */
function exportSTL(includeModel, includeSupports, filename) {
  const arrays = [];
  if (includeModel && state.mesh) arrays.push({ arr: state.mesh.geometry.attributes.position.array, dx: 0, dy: state.mesh.position.y, dz: 0 });
  if (includeSupports) {
    // 筏层：模型 XZ 外接圆 + 边距，与场景显示一致
    if (raftOn() && state.mesh) {
      const bb = state.mesh.geometry.boundingBox;
      const rr = Math.hypot(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2 + raftMargin();
      const rg = new THREE.CylinderGeometry(rr, rr, RAFT_T, 48).toNonIndexed();
      arrays.push({ arr: rg.attributes.position.array, dx: 0, dy: RAFT_T / 2, dz: 0 });
    }
    for (const s of state.supports) {
      let a = s.mesh.geometry.attributes.position.array;
      if (s.mesh.geometry.index) a = s.mesh.geometry.toNonIndexed().attributes.position.array;
      arrays.push({ arr: a, dx: s.mesh.position.x, dy: s.mesh.position.y, dz: s.mesh.position.z });
    }
  }
  let count = 0;
  for (const a of arrays) count += a.arr.length / 9;
  if (!count) return toast('没有可导出的内容');
  const buf = new ArrayBuffer(84 + count * 50);
  const dv = new DataView(buf);
  const header = 'ResinForge v0.1 auto supports';
  for (let i = 0; i < Math.min(80, header.length); i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, count, true);
  let off = 84;
  for (const a of arrays) {
    const p = a.arr;
    for (let f = 0; f < p.length; f += 9) {
      // 场景为 Y-up 世界系，写出时回转 STL 惯例 Z-up（载入时 rotateX(-90°) 的逆变换）：(x,y,z) → (x,-z,y)
      const ax = p[f] + a.dx, ay = -(p[f + 2] + a.dz), az = p[f + 1] + a.dy;
      const bx = p[f + 3] + a.dx, by = -(p[f + 5] + a.dz), bz = p[f + 4] + a.dy;
      const cx = p[f + 6] + a.dx, cy = -(p[f + 8] + a.dz), cz = p[f + 7] + a.dy;
      let ux = bx - ax, uy = by - ay, uz = bz - az;
      let vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(off, nx / nl, true); dv.setFloat32(off + 4, ny / nl, true); dv.setFloat32(off + 8, nz / nl, true); off += 12;
      dv.setFloat32(off, ax, true); dv.setFloat32(off + 4, ay, true); dv.setFloat32(off + 8, az, true); off += 12;
      dv.setFloat32(off, bx, true); dv.setFloat32(off + 4, by, true); dv.setFloat32(off + 8, bz, true); off += 12;
      dv.setFloat32(off, cx, true); dv.setFloat32(off + 4, cy, true); dv.setFloat32(off + 8, cz, true); off += 12;
      dv.setUint16(off, 0, true); off += 2;
    }
  }
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  log(`已导出 ${filename}（${count.toLocaleString()} 三角形，已回转换 Z-up）`, 'ok');
}
$('btnExportAll').onclick = () => exportSTL(true, true, 'model_with_supports.stl');
$('btnExportSup').onclick = () => exportSTL(false, true, 'supports_only.stl');

/* ================================================================
   交互模式（旋转 / 保护面 / 加支撑 / 删支撑）
================================================================ */
function setMode(m) {
  state.mode = m;
  controls.enabled = (m === 'orbit');
  for (const [id, mm] of [['mOrbit', 'orbit'], ['mPaint', 'paint'], ['mAdd', 'add'], ['mDel', 'del']]) {
    $(id).classList.toggle('on', mm === m);
  }
  canvas.style.cursor = m === 'orbit' ? 'grab' : 'crosshair';
}
$('mOrbit').onclick = () => setMode('orbit');
$('mPaint').onclick = () => setMode('paint');
$('mAdd').onclick = () => setMode('add');
$('mDel').onclick = () => setMode('del');

canvas.addEventListener('pointerdown', e => {
  if (state.mode === 'paint') { state.painting = true; paintAt(e); }
  else if (state.mode === 'add' && state.mesh) {
    const hits = pointerRay(e).intersectObject(state.mesh);
    if (hits.length) {
      const h = hits[0];
      const fi = h.face.a / 3;
      if (state.protectedFaces.has(fi)) { toast('该面为保护面，已阻止添加支撑'); return; }
      // 命中面法线作为销头朝向（模型仅平移变换，几何面法线即世界系方向）
      const fn = h.face ? h.face.normal : null;
      addSupport(h.point.x, h.point.y, h.point.z, null, fn ? [fn.x, fn.y, fn.z] : null);
      log(`手动支撑 @ (${h.point.x.toFixed(1)}, ${h.point.y.toFixed(1)}, ${h.point.z.toFixed(1)})`);
      if (state.analysis) drawLayer();
    }
  } else if (state.mode === 'del' && state.supports.length) {
    const hits = pointerRay(e).intersectObjects(supportGroup.children);
    if (hits.length) {
      const mesh = hits[0].object;
      const idx = state.supports.findIndex(s => s.mesh === mesh);
      if (idx >= 0) {
        supportGroup.remove(mesh); mesh.geometry.dispose();
        state.supports.splice(idx, 1);
        updateSupStats();
        if (state.analysis) drawLayer();
      }
    }
  }
});
canvas.addEventListener('pointermove', e => {
  if (state.painting && state.mode === 'paint') paintAt(e);
});
window.addEventListener('pointerup', () => { state.painting = false; });

/* ================================================================
   启动
================================================================ */
window.__dbg = { loadDemo, rasterizeSection, analyze, buildLDI, sampleLDILayer, compareLDI, ldiColumnCrossings };   // 调试/自动化访问口
buildPlate();
resize();
loadDemo('knot');
log('ResinForge v0.1 就绪：像素级切片 + 多目标朝向优化 + 孤岛检测 + 语义保护面权重', 'ok');
log('流程：载入模型 → 朝向优化 → (涂保护面) → 逐层分析 → 生成支撑 → 导出 STL');
