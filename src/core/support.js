/* ================================================================
   支撑生成：makeSupportMesh / makeMicroPostMesh / addSupport /
   runGenSup（旧 btnGenSup.onclick 全体逻辑）/ clearSupports / updateSupStats。
   与旧 main.js 的差异仅两类：参数读 params.*，supStats 更新与日志改发 bus 事件。
================================================================ */
import * as THREE from 'three';
import { state, params, bus, log, toast, setProgress, nextFrame } from '../store.js';
import { supportGroup, supMat, supMatAnchor } from './scene.js';
import { ldiGapAt } from './slicer.js';
import { raiseH, raftOn, RAFT_T, mergeGeoms } from './model.js';
import { drawLayer } from './inspect.js';

export function clearSupports(refresh = true) {
  for (const s of state.supports) { supportGroup.remove(s.mesh); s.mesh.geometry.dispose(); }
  state.supports = [];
  if (refresh) { updateSupStats(); if (state.analysis) drawLayer(); }
}
export function updateSupStats() {
  const posts = state.supports.filter(s => !s.scaffold);
  const n = posts.length;
  const anchored = posts.filter(s => s.anchored).length;
  const prot = state.protectedFaces.size;
  bus.emit('supStats', { n, anchored, prot });
}

/* ================================================================
   脚手架（菱形格架——参考 Materialise e-Stage「open diamond structure」与 TANGO V-Support 栅栏墙片）
   相邻落板立柱之间沿高度连续布置**菱形格**：每格四梁汇于中心节点（真实连接，四梁合一）——
   比 X 交叉（空中相交无节点）刚性更好；开放菱形让未固化树脂自然排出（e-Stage 的核心卖点）；
   相邻柱的菱形格横向连续成墙片（TANGO V-Support 的栅栏墙特征），整片支撑成为一体格架。
   参数：crossD 梁直径 / crossStartH 起始高度（相对平台）/ crossZStep 菱形格高度 / crossMaxXY 柱距上限。
   梁两端没入立柱主干（重叠搭接不布尔）；锚定短小支撑不参与（两端已在模型上）。
================================================================ */
export function buildScaffold() {
  // 先清旧横梁（幂等：重复调用安全）
  const rest = [];
  for (const s of state.supports) {
    if (s.scaffold) { supportGroup.remove(s.mesh); s.mesh.geometry.dispose(); }
    else rest.push(s);
  }
  state.supports = rest;
  if (!params.scaffoldOn) return 0;

  const yBase = raftOn() ? RAFT_T : 0;
  const headLoss = params.tipD / 2 + (params.headLen || 0.7);   // 主干上端 ≈ 尖端 − (r_pin + 锥头长)
  const posts = [];
  for (const s of state.supports) {
    if (s.anchored) continue;
    const ax = s.x + (s.mesh.userData.jx || 0), az = s.z + (s.mesh.userData.jz || 0);   // 主干轴线 XZ（倾斜后偏离接触点）
    posts.push({ ax, az, yLo: yBase + 0.6, yHi: s.y - headLoss });   // 主干可用高度区间（锥底顶 → 中部球头）
  }
  if (posts.length < 2) return 0;

  // 邻接边：每根立柱连接 crossMaxXY 内最近的 2 根（O(n²)，900 上限内可接受）——柱距短则菱形更规整
  const maxXY = Math.max(2, params.crossMaxXY || 8);
  const edges = new Map();   // "i_j" -> [i,j]
  for (let i = 0; i < posts.length; i++) {
    const near = [];
    for (let j = 0; j < posts.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(posts[i].ax - posts[j].ax, posts[i].az - posts[j].az);
      if (d <= maxXY && d > 1e-3) near.push([d, j]);
    }
    near.sort((a, b) => a[0] - b[0]);
    for (const [, j] of near.slice(0, 2)) edges.set(Math.min(i, j) + '_' + Math.max(i, j), [i, j]);
  }

  const r = Math.max(0.1, (params.crossD || 0.5) / 2);
  const startH = Math.max(0, params.crossStartH || 0);
  const zStep = Math.max(1, params.crossZStep || 5);   // 菱形格竖直对角（层高）
  const parts = [];
  let beamN = 0;
  const SEG = 8;
  const beam = (px, py, pz, qx, qy, qz) => {
    const dx = qx - px, dy = qy - py, dz = qz - pz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.2) return;
    const g = new THREE.CylinderGeometry(r, r, len, SEG);
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len))));
    parts.push({ g, x: px + dx / 2, y: py + dy / 2, z: pz + dz / 2 });
    beamN++;
  };
  for (const [i, j] of edges.values()) {
    const A = posts[i], B = posts[j];
    const yS = Math.max(startH, A.yLo, B.yLo);         // 格架起始：起始高度且两柱均有主干
    const yE = Math.min(A.yHi, B.yHi);                 // 格架终止：任一柱主干尽端
    if (yE - yS < 0.8) continue;
    const cx = (A.ax + B.ax) / 2, cz = (A.az + B.az) / 2;   // 菱形中心节点 XZ
    for (let y0 = yS; y0 < yE - 1e-6; y0 += zStep) {
      const y1 = Math.min(y0 + zStep, yE);
      const ym = (y0 + y1) / 2;
      // 菱形四梁：两柱上下端点 → 中心节点（四梁汇一，真实连接）
      beam(A.ax, y0, A.az, cx, ym, cz);
      beam(B.ax, y0, B.az, cx, ym, cz);
      beam(A.ax, y1, A.az, cx, ym, cz);
      beam(B.ax, y1, B.az, cx, ym, cz);
    }
  }
  if (!parts.length) return 0;
  const mesh = new THREE.Mesh(mergeGeoms(parts), supMat);
  mesh.userData.scaffold = true;
  supportGroup.add(mesh);
  state.supports.push({ mesh, x: 0, z: 0, y: 0, anchored: false, scaffold: true });
  return beamN;
}

/* PrusaSlicer 风格分段支撑，落板支撑从上到下六部位：
   顶部球头(r_pin) → 锥头(独立圆台裙边) → 中部球头(r_back) → 主干(柱身) → 锥底(基座锥台) → 底板(筏层)
   顶部球头 + 锥头合称「顶端」；锚定短小支撑下部为「底端」（底部球头 + 锥头镜像，与顶端同构），无锥底；顶端与底端均可倾斜。
   平滑合并三原则（对应 PrusaSlicer SupportTreeMesher 的 pinhead 结构 + CHITUBOX 式重叠搭接）：
   ① 锥头为独立圆台（长度/顶宽/底宽均可调），两端没入完整球头内部（球心距 = 锥头长度）——任意宽度组合都无破面、无环缝
   ② 主干端部嵌入中部球头的球心，柱半径 = 球半径，球赤道与柱面自然相切
   ③ 不做布尔并集，重叠实体在切片偶奇填充下自然合并（同 its_merge），导出 STL 被下游切片器兼容
   顶端/底端自动朝向（对应 PrusaSlicer Head.dir）：顶端沿被托面外法线、底端沿承载面外法线倾斜，限锥角 = 自支撑角 selfAngle；
   极点 = 接触点 + 轴·pen（沿轴扎入）；落板支撑主干垂直、接驳在顶端的中部球头球心处，短小支撑主干连接两端球心（双端倾斜时斜置，落点随倾角水平偏移，均属预期行为） */
export function makeSupportMesh(x, yTip, z, yBase = 0, anchored = false, nrmTop = null, nrmBot = null) {
  const tipR = Math.max(0.05, params.tipD / 2);       // 顶部球头半径 r_pin
  const midR = Math.max(tipR * 1.5, params.midD / 2); // 中部球头半径 r_back = 主干半径
  const baseR = Math.max(midR, params.baseD / 2);     // 锥底底半径
  const penRaw = params.pen;
  const pen = Math.min(1, Math.max(0, isNaN(penRaw) ? 0.2 : penRaw)); // 球头嵌入深度（扎入模型表面）
  const coneTopR = Math.max(0.03, (params.headTopD || tipR * 2) / 2);   // 锥头顶部半径
  const coneBotR = Math.max(0.03, (params.headBotD || midR * 2) / 2);   // 锥头底部半径
  const nHeadsG = anchored ? 2 : 1;
  // 退化兜底：跨度容不下顶端+底端（+锥头 0.12 下限 + 0.15 余量）时拒绝生成，
  // 否则锥头压扁、主干消失，渲染成一对互相贯穿的对顶球头（实测 Arm_Left 羽毛尖端 0.99mm 断支撑）
  if (yTip - yBase < nHeadsG * (tipR + midR) + 0.15 + 0.12 * nHeadsG) return null;
  const span = yTip - yBase;
  const nHeads = nHeadsG;
  const headLenRaw = params.headLen;
  let robe = Math.max(0.12, isNaN(headLenRaw) ? 0.7 : headLenRaw);    // 锥头长度（两球心距）
  robe = Math.min(robe, Math.max(0.12, (span - nHeads * (tipR + midR) - 0.15) / nHeads));
  const parts = [];
  const SEG = 12;
  // 顶端规范形（底端同构、镜像使用）：极点在原点、体沿 −Y 展开。球头为完整球，锥头圆台两端没入球心——
  // 任意宽度组合都无破面，重叠实体在切片偶奇填充下自然合并（同 CHITUBOX 标准件的搭接方式）
  const pinC = -tipR, backC = -(tipR + robe);
  const headGeom = mergeGeoms([
    { g: new THREE.SphereGeometry(tipR, SEG, 8), y: pinC },                                            // 顶部球头
    { g: new THREE.SphereGeometry(midR, SEG, 10), y: backC },                                          // 中部球头
    { g: new THREE.CylinderGeometry(coneTopR, coneBotR, robe, SEG, 1, true), y: (pinC + backC) / 2 },  // 锥头圆台
  ]);
  // 端头朝向：轴 = −n（钝端→尖端）。顶端以被托悬空面的外法线（朝下）为准，底端以承载面外法线（朝上）为准；
  // 限锥角 = 自支撑角；8° 死区（近平面不倾斜，吸收细分法线噪声）
  const cosSelf = Math.cos(params.selfAngle * Math.PI / 180);
  const cosDead = Math.cos(8 * Math.PI / 180);
  const headAxis = (n, isTop) => {
    if (!n) return null;
    const ok = isTop ? (n[1] < -cosSelf - 1e-6 && n[1] > -cosDead)
                     : (n[1] > cosSelf + 1e-6 && n[1] < cosDead);
    return ok ? new THREE.Vector3(-n[0], -n[1], -n[2]).normalize() : null;
  };
  const axisT = headAxis(nrmTop, true);
  // 顶端：绕极点旋转（+Y → 轴）后放到极点。极点 = 接触点 + 轴·pen（沿轴扎入模型 pen 深；
  // 垂直时退化为 (0, span+pen, 0)。若极点只沿 +Y 偏移，倾斜时顶部球头会甩到表面外侧——方向就反了）
  const axT = axisT ? axisT.x : 0, ayT = axisT ? axisT.y : 1, azT = axisT ? axisT.z : 0;
  const poleTX = axT * pen, poleTY = span + ayT * pen, poleTZ = azT * pen;
  const topHead = headGeom.clone();
  if (axisT) topHead.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisT)));
  parts.push({ g: topHead, x: poleTX, y: poleTY, z: poleTZ });
  // 顶部中部球头球心（主干上端点）= 极点 − 轴·(r_pin + 锥头长)
  const jt = { x: poleTX - axT * (tipR + robe), y: poleTY - ayT * (tipR + robe), z: poleTZ - azT * (tipR + robe) };
  let jb, axisB = null;
  if (anchored) {
    // 底端（顶端镜像）：沿承载面法线倾斜；极点 = 下接触点 + 轴·pen（扎入下方表面）
    axisB = headAxis(nrmBot, false);
    const axB = axisB ? axisB.x : 0, ayB = axisB ? axisB.y : -1, azB = axisB ? axisB.z : 0;
    const poleBX = axB * pen, poleBY = ayB * pen, poleBZ = azB * pen;
    const anch = headGeom.clone();
    anch.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axisB || new THREE.Vector3(0, -1, 0))));
    parts.push({ g: anch, x: poleBX, y: poleBY, z: poleBZ });
    jb = { x: poleBX - axB * (tipR + robe), y: poleBY - ayB * (tipR + robe), z: poleBZ - azB * (tipR + robe) };
  } else {
    // 锥底（随主干水平偏移）
    const pedH = Math.min(1.2, Math.max(0.5, span * 0.15), span * 0.45);
    parts.push({ g: new THREE.CylinderGeometry(midR, baseR, pedH, SEG + 2), x: jt.x, y: pedH / 2, z: jt.z });
    jb = { x: jt.x, y: pedH, z: jt.z };
  }
  // 主干：连接上下中部球头球心（锚定且双头倾斜时可斜置；两端藏于球内，斜置无缝）；跨度退化已在函数头拒绝生成
  const dx = jt.x - jb.x, dy = jt.y - jb.y, dz = jt.z - jb.z;
  const plen = Math.hypot(dx, dy, dz);
  if (plen > 0.1) {
    const pg = new THREE.CylinderGeometry(midR, midR, plen, SEG + 2);
    if (Math.abs(dx) + Math.abs(dz) > 1e-6) pg.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / plen, dy / plen, dz / plen))));
    parts.push({ g: pg, x: jb.x + dx / 2, y: jb.y + dy / 2, z: jb.z + dz / 2 });
  }
  const geom = mergeGeoms(parts);
  const mesh = new THREE.Mesh(geom, anchored ? supMatAnchor : supMat);
  mesh.position.set(x, yBase, z);
  mesh.userData.tiltDeg = axisT ? Math.round(Math.acos(ayT) * 180 / Math.PI) : 0;          // 顶端倾角（调试/验证）
  mesh.userData.tiltDegBot = axisB ? Math.round(Math.acos(-(axisB.y)) * 180 / Math.PI) : 0; // 底端倾角
  mesh.userData.jx = jt.x; mesh.userData.jz = jt.z;   // 主干顶部球心（局部 XZ）：杆身防粘连的真实站位
  if (anchored) { mesh.userData.jbx = jb.x; mesh.userData.jbz = jb.z; }   // 主干底部球心（锚定）
  return mesh;
}

/* 微型短柱（CHITUBOX 标准件风格）：锚定跨度容不下顶端+底端时的短支撑替代方案。
   实测 CHITUBOX 在同一模型上用 Ø0.8mm 球端微柱铺 0.5~2mm 短间隙（178 根），几何干净、易掰除；
   简单圆柱 + 两端半球，竖直不倾斜，永不退化。尖端/底端各扎入表面 0.1mm */
export function makeMicroPostMesh(x, yTip, z, yBase) {
  const midR = Math.max(params.tipD * 1.5 / 2, params.midD / 2);
  const span = yTip - yBase;
  const embed = 0.1;
  const yT = span - midR + embed;   // 顶部球心（尖端扎入被托面）
  const yB = midR - embed;          // 底部球心（底端扎入承载面）
  const parts = [
    { g: new THREE.SphereGeometry(midR, 10, 8), y: yT },
    { g: new THREE.SphereGeometry(midR, 10, 8), y: yB },
  ];
  if (yT - yB > 0.05) parts.push({ g: new THREE.CylinderGeometry(midR, midR, yT - yB, 12), y: (yT + yB) / 2 });
  const mesh = new THREE.Mesh(mergeGeoms(parts), supMatAnchor);
  mesh.position.set(x, yBase, z);
  mesh.userData.tiltDeg = 0; mesh.userData.tiltDegBot = 0;
  mesh.userData.jx = 0; mesh.userData.jz = 0;
  mesh.userData.jbx = 0; mesh.userData.jbz = 0;   // 竖直直柱：球心站位即接触点
  return mesh;
}

export function addSupport(x, y, z, anchorY = null, nrmTop = null, nrmBot = null, micro = false) {
  const anchored = anchorY !== null;
  const yBase = anchored ? anchorY : (raftOn() ? RAFT_T : 0);   // 落板支撑落在筏层顶面
  const mesh = micro ? makeMicroPostMesh(x, y, z, yBase) : makeSupportMesh(x, y, z, yBase, anchored, nrmTop, nrmBot);
  if (!mesh) return null;   // 跨度退化被拒（见 makeSupportMesh 退化兜底）
  supportGroup.add(mesh);
  state.supports.push({ mesh, x, z, y, anchored, tiltDeg: mesh.userData.tiltDeg || 0, tiltDegBot: mesh.userData.tiltDegBot || 0 });
  updateSupStats();
  return mesh;   // 返回真值供调用方判定放置成功（null = 退化被拒）
}

export async function runGenSup(opts = {}) {
  const islandsOnly = !!opts.islandsOnly;   // 自动孤岛支撑：只为孤岛位置补打（增量，不清空现有支撑）
  if (!state.analysis) return toast('请先运行逐层分析');
  if (!islandsOnly) clearSupports(false);
  const A = state.analysis;
  const spacing = Math.max(1, params.spacing);
  // 合并两个来源：栅格悬空点 + 陡峭面重心（孤岛模式不走普通候选池）
  let all = islandsOnly ? [] : [...A.overhang.map(o => ({ x: o.x, y: o.y, z: o.z })), ...A.steepPts];
  if (!all.length && !islandsOnly) {
    log('没有检测到需要支撑的悬空区域');
    updateSupStats();
    return;
  }
  // 区域面积过滤（参考 BambuStudio Minimum Support Area / Orca "Remove Small Overhangs" / Wang Z. support-relevant 框架）：
  // 2mm 格 26 邻域并查集聚类出连通悬空区域，区域面积 < 阈值 → 整区不生成支撑（尖刺小帽点缀支撑的主要来源）。
  // 孤岛不走此过滤（真孤岛无桥可架，必须支撑）——其种子由图节点单独保障。
  const minSupArea = Math.max(0.1, params.minSupArea || 2);
  const cellArea = A.grid.sx * A.grid.sz;
  let areaPruned = 0;
  {
    const cq = 2;   // 聚类格 2mm
    const ck2 = (i, j, k) => ((j + 4096) * 8192 + (i + 4096)) * 8192 + (k + 4096);   // (x,y,z) 格索引
    const parent = new Map(), rootArea = new Map(), candCell = new Array(all.length);
    const find = k => { let r = k; while (parent.get(r) !== r) r = parent.get(r); let c = k; while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; } return r; };
    for (let i = 0; i < all.length; i++) {
      const pt = all[i];
      const i0 = Math.floor(pt.x / cq), j0 = Math.floor(pt.y / cq), k0 = Math.floor(pt.z / cq);
      const k = ck2(i0, j0, k0);
      candCell[i] = k;
      if (!parent.has(k)) parent.set(k, k);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
        if (!di && !dj && !dk) continue;
        const nk = ck2(i0 + di, j0 + dj, k0 + dk);
        if (parent.has(nk)) { const ra = find(k), rb = find(nk); if (ra !== rb) parent.set(ra, rb); }
      }
    }
    for (let i = 0; i < all.length; i++) {
      const r = find(candCell[i]);
      rootArea.set(r, (rootArea.get(r) || 0) + (all[i].area ?? cellArea));
    }
    const before = all.length;
    all = all.filter((_, i) => (rootArea.get(find(candCell[i])) || 0) >= minSupArea);
    areaPruned = before - all.length;
  }
  if (!all.length && !islandsOnly) {
    log(`没有需要支撑的悬空区域（区域面积过滤 <${minSupArea}mm² 后为空）`);
    updateSupStats();
    return;
  }
  // 孤岛模式：无孤岛关键点可放时直接提示返回（不清空、不动现有支撑）
  if (islandsOnly && (!A.graph || !A.graph.nodes.some(n => n.island))) {
    log('自动孤岛支撑：未检测到孤岛，无需补打');
    return;
  }
  setProgress(0.4, '均匀布点（泊松盘）…'); await nextFrame();
  // 孤岛周界降采样仍按 spacing 体素（每体素保留最低点）
  const cell = spacing;
  const key = (x, y, z) => ((Math.floor(y / cell) + 4096) * 8192 + (Math.floor(x / cell) + 4096)) * 8192 + (Math.floor(z / cell) + 4096);
  // 均匀布点（参考 Bridson 2007 泊松盘的离散候选集变体 + PrusaSlicer permanent 种子语义）：
  // 孤岛关键点作为种子预置占位；候选池按高度升序贪心，与已放置点保持 spacing 三维最小间距。
  // 三维距离在斜面上大于 XY 投影距，天然近似测地均匀。空间哈希格 = spacing/√3。
  const r = spacing, hCell = r / Math.sqrt(3), r2 = r * r * 0.999;
  const cellOf = (x, y, z) => [Math.floor(x / hCell), Math.floor(y / hCell), Math.floor(z / hCell)];
  const hkey = (i, j, k) => ((i + 4096) * 8192 + (j + 4096)) * 8192 + (k + 4096);
  const hash = new Map();   // cellKey -> 已放置点数组
  const farFromPlaced = (x, y, z) => {
    const [ci, cj, ck] = cellOf(x, y, z);
    // ±2 邻域（125 格）：格子对角线 2·spacing/√3 > spacing，±1 会漏掉隔格近点
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) for (let dk = -2; dk <= 2; dk++) {
      const arr = hash.get(hkey(ci + di, cj + dj, ck + dk));
      if (!arr) continue;
      for (const p of arr) {
        if ((p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2 < r2) return false;
      }
    }
    return true;
  };
  const registerPt = pt => {
    const [ci, cj, ck] = cellOf(pt.x, pt.y, pt.z);
    const hk = hkey(ci, cj, ck);
    let arr = hash.get(hk);
    if (!arr) hash.set(hk, arr = []);
    arr.push(pt);
  };
  // 候选池：悬空点 + 陡峭面重心，按高度升序（自下而上、确定性顺序）
  const clusters = all.slice().sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
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
      // 种子带上孤岛 id（覆盖兜底定位用）
      if (lowest) periVox.set(key(lowest.x, lowest.y, lowest.z), lowest);   // 最低点先入图（同体素被更低周界点取代亦可，杜绝重复）
      for (const pt of periVox.values()) keypoints.push({ ...pt, node: nd.id });
    }
  }
  setProgress(0.7, '生成支撑几何体…'); await nextFrame();
  // 布点策略：孤岛关键点（周界+最低点）优先 → 普通悬空点体素聚类；尖端高度来自 LDI 区间入口（贴面精确）
  let suppressed = 0, placed = 0, anchoredN = 0, flushSkipped = 0, heldN = 0, stubN = 0, microN = 0;
  const MAX = 900;   // 抬高后模型底面轮廓会铺满布点，上限需覆盖底面 + 上层特征
  const baseN = islandsOnly ? state.supports.filter(s => !s.scaffold).length : 0;   // 增量模式：上限含既有支撑
  const ndMap = A.graph ? new Map(A.graph.nodes.map(n => [n.id, n])) : null;
  const posL = state.mesh.geometry.attributes.position.array;
  const rh = raiseH();
  // 世界系顶点（局部 + 抬高）：与分析产出的世界系悬空点、Y 分桶保持一致
  const pos = new Float32Array(posL.length);
  for (let i = 0; i < posL.length; i++) pos[i] = posL[i] + (i % 3 === 1 ? rh : 0);
  const nf = pos.length / 9;
  const useShort = params.shortSup;
  // 最小支撑跨度：顶端+底端几何下限（2×(r_pin+r_back)+锥头下限与余量）+ 0.3mm 余量。
  // 短于此跨度的锚定/落板支撑会退化为对顶球头疙瘩（实测 Arm_Left 羽毛尖端），直接按短跨豁免跳过
  const tipR0 = Math.max(0.05, params.tipD / 2);
  const midR0 = Math.max(tipR0 * 1.5, params.midD / 2);
  const minSupLen = 2 * (tipR0 + midR0) + 0.39 + 0.3;
  // 保护面扫描的面重心预计算（一次性 O(面数)）：无保护面时保持 null，tryPlace 完全跳过扫描
  let protCent = null;
  if (state.protectedFaces.size) {
    protCent = new Float32Array(nf * 3);
    for (let f = 0; f < nf; f++) {
      const i = f * 9;
      protCent[f * 3] = (pos[i] + pos[i + 3] + pos[i + 6]) / 3;
      protCent[f * 3 + 1] = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3;
      protCent[f * 3 + 2] = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3;
    }
  }
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
  // 用途①贴面过滤②锚定底盘（命中任意距离的下方表面都优于落板贯穿模型）；返回 {y, f}（f=承载面索引，供底端朝向）
  const findBelow = (x, yTip, z) => rayDown(x, yTip - 0.05, z);
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
  // 放置单根支撑：贴面过滤 → 短跨/锚定面过滤 → 保护面抑制（廉价过滤前置）。
  // 保护面最近面扫描是 O(全部面)，必须放在所有廉价过滤之后、且仅在有保护面时执行——
  // 否则 7 万候选 × 21 万面 ≈ 百亿次距离计算，主线程同步冻结（Arm_Left 实测浏览器未响应）
  const faces = state.faces;
  const tryPlace = (c, below) => {
    if (c.y < 0.25) return 'low';                 // 贴板/低于筏层顶的点不支撑（世界系）
    const tipY = c.y;                        // 不做抬升钳制，避免尖端扎进模型
    // 贴面过滤：尖端正下方 0.15mm 已在实体内 → 该点本就由模型自身托住，无需支撑。
    // （不能用向下射线的距离判定：射线起点若在实体内，会一路穿到实体底面而误判为悬空）
    if (isSolidAt(c.x, tipY - 0.15, c.z)) return 'flush';
    if (below !== null && tipY - below.y < 0.8) return 'held';   // 下方 0.8mm 内已有材料 → 桥接即可，不生成支撑（Formlabs 短跨豁免）
    // 最小跨度过滤：跨度容不下顶端+底端的锚定支撑 → 微型短柱（CHITUBOX 标准件风格）；
    // 常规底端锚定仍要求可信承载面（法线过平的侧壁/悬空面拒绝）。落板支撑过短仍跳过（应从板面长起）
    let micro = false;
    if (below !== null) {
      if (tipY - below.y >= minSupLen) {
        // 锚定面可信度：命中面法线过平（竖直侧壁/悬空下表面）→ 不能承载，拒绝锚定。
        // （实测 Arm_Left 羽毛尖端：向下射线 1~3mm 内命中相邻羽枝侧壁，法线 y≈0.1~0.3，生成的短支撑毫无意义）
        if (below.f >= 0 && faces && faces.nrm[below.f * 3 + 1] < 0.5) return 'stub';
      } else {
        micro = true;   // span ∈ [0.8, minSupLen)：直柱微支撑，对锚面平整度要求低，不做承载面检查
      }
    } else if (tipY - (raftOn() ? RAFT_T : 0) < minSupLen) return 'stub';
    // 最近面保护检测（仅存在保护面时；重心已预计算，单次 O(面数)）
    if (protCent) {
      let nearest = -1, nd2 = 1e9;
      for (let f = 0; f < nf; f++) {
        const d2 = (protCent[f * 3] - c.x) ** 2 + (protCent[f * 3 + 1] - tipY) ** 2 + (protCent[f * 3 + 2] - c.z) ** 2;
        if (d2 < nd2) { nd2 = d2; nearest = f; }
      }
      if (nearest >= 0 && state.protectedFaces.has(nearest) && nd2 < 25) return 'suppressed';
    }
    const anchorY = below !== null ? below.y : null;
    if (anchorY !== null) anchoredN++;
    // 端头朝向法线：顶端 = 射线探测真实接触面；底端 = 锚定射线的承载面（findBelow 命中面）
    let nrmTop = null, nrmBot = null;
    if (faces) {
      const pf = probeFace(c.x, tipY, c.z);
      if (pf >= 0) nrmTop = [faces.nrm[pf * 3], faces.nrm[pf * 3 + 1], faces.nrm[pf * 3 + 2]];
      if (anchorY !== null && below.f >= 0) nrmBot = [faces.nrm[below.f * 3], faces.nrm[below.f * 3 + 1], faces.nrm[below.f * 3 + 2]];
    }
    const ok = addSupport(c.x, tipY, c.z, anchorY, nrmTop, nrmBot, micro);
    if (!ok) return 'stub';   // 兜底：几何仍判退化（不应发生，微柱几何永不退化）
    placed++;
    if (micro) microN++;
    return 'placed';
  };
  const tally = r => { if (r === 'suppressed') suppressed++; else if (r === 'flush') flushSkipped++; else if (r === 'held') heldN++; else if (r === 'stub') stubN++; };
  // 第二相：候选池泊松盘贪心 + 覆盖锥过滤 + 锥底防粘连
  // 覆盖锥（Vanek 2014 Clever Support coverage）：已放置低点支撑的自支撑锥
  // （半径 = 高差 × tan(自支撑角)，高差上限 12mm，0.9 余量）覆盖其上方连通坡面的悬空点——
  // 坡面底部钉住后向上逐层有重叠，无需重复布满。孤岛种子永不参与被过滤（第一相先放）。
  const tanSelf = Math.tan(params.selfAngle * Math.PI / 180);
  const fuseR2 = (params.baseD * 1.05) ** 2;   // 锥底最小 XY 间距²（防基座粘连）
  const placedPts = [];   // 已放置点（覆盖锥判定）
  const pedPts = [];      // 落板支撑 XY（锥底粘连判定）
  const covHash = new Map();   // XZ 哈希（格 3mm），覆盖锥加速
  const covReg = p => {
    const k = (Math.floor(p.x / 3) + 4096) * 8192 + (Math.floor(p.z / 3) + 4096);
    let a = covHash.get(k); if (!a) covHash.set(k, a = []); a.push(p);
  };
  const coveredBy = (c) => {
    const ci = Math.floor(c.x / 3), ck = Math.floor(c.z / 3);
    for (let di = -4; di <= 4; di++) for (let dk = -4; dk <= 4; dk++) {   // ±4 格 ≥ 最大覆盖半径 12·tan45·0.9
      const arr = covHash.get((ci + di + 4096) * 8192 + (ck + dk + 4096));
      if (!arr) continue;
      for (const p of arr) {
        if (p.y > c.y + 0.05) continue;
        const dy = c.y - p.y;
        if (dy > 12) continue;
        const rcov = dy * tanSelf * 0.9;
        if ((p.x - c.x) ** 2 + (p.z - c.z) ** 2 <= rcov * rcov) return true;
      }
    }
    return false;
  };
  // 杆身级防粘连（对所有支撑生效，含种子）：XY 净距 < 中段直径+0.4mm 且 Y 区间重叠 → 互斥。
  // 泊松盘只约束尖端点；支撑是有体积的杆，杆身/球头互撞必须显式判定。
  // 站位用主干球心的真实 XZ（倾斜端头会让杆身偏离接触点，登记接触点会漏判）。
  // Y 区间按实际网格范围外扩 0.2mm（顶端/底端扎入 pen 超出名义端点），间隙判据 0.1mm。
  const shaftList = [];   // 已放置支撑的主干球心 {x, z, yLo, yHi}（Y 已外扩）
  const shaftClear = params.midD + 0.4;
  const shaftFused = (x, z, yLo, yHi) => {
    for (const p of shaftList) {
      if ((p.x - x) ** 2 + (p.z - z) ** 2 >= shaftClear * shaftClear) continue;
      if (yHi < p.yLo - 0.3 || yLo > p.yHi + 0.3) continue;
      return true;
    }
    return false;
  };
  // 放置后登记主干站位：顶部球心（jt）+ 锚定时的底部球心（jb）
  const regShaft = (c, yLo) => {
    const m = state.supports[state.supports.length - 1].mesh;
    shaftList.push({ x: c.x + (m.userData.jx || 0), z: c.z + (m.userData.jz || 0), yLo: yLo - 0.2, yHi: c.y + 0.2 });
    if (m.userData.jbx !== undefined) shaftList.push({ x: c.x + m.userData.jbx, z: c.z + m.userData.jbz, yLo: yLo - 0.2, yHi: c.y + 0.2 });
  };
  // 增量模式：预登记现有支撑站位，新放支撑避开旧支撑（杆身防粘连）
  if (islandsOnly) {
    for (const s of state.supports) {
      if (s.scaffold) continue;
      const g = s.mesh.geometry; g.computeBoundingBox();
      const yLo = g.boundingBox.min.y + s.mesh.position.y - 0.1, yHi = g.boundingBox.max.y + s.mesh.position.y + 0.1;
      shaftList.push({ x: s.x + (s.mesh.userData.jx || 0), z: s.z + (s.mesh.userData.jz || 0), yLo, yHi });
      if (s.mesh.userData.jbx !== undefined) shaftList.push({ x: s.x + s.mesh.userData.jbx, z: s.z + s.mesh.userData.jbz, yLo, yHi });
    }
  }
  // 第一相：孤岛关键点（种子预置，占位进泊松哈希 + 覆盖锥）。
  // 种子间同样做杆身互撞检查——多岛屿密集模型上「首根豁免」会让密集区种子互贴（实测 223 岛 1002 对互粘）；
  // 被挡种子的孤岛由相邻岛屿的支撑物理覆盖 rim（同一悬空区域的相邻区域），不强制补放。
  let keyPlaced = 0, seedFused = 0;
  let seedI = 0;
  for (const c of keypoints) {
    if (placed + baseN >= MAX) break;
    if (++seedI % 2000 === 0) { setProgress(0.45, '孤岛关键点布点…'); await nextFrame(); }   // 周期让帧，防主线程冻结
    if (islandsOnly) {   // 增量：该孤岛附近已有支撑则跳过（同覆盖兜底 near 判据）
      const nd = ndMap && ndMap.get(c.node);
      if (nd && state.supports.some(s => !s.scaffold && Math.hypot(s.x - nd.cx, s.z - nd.cz) < 2 && Math.abs(s.y - nd.y) < 2)) continue;
    }
    const below = useShort ? findBelow(c.x, c.y, c.z) : null;
    const yLo = below ? below.y : 0;
    if (shaftFused(c.x, c.z, yLo - 0.2, c.y + 0.2)) { seedFused++; continue; }
    const r = tryPlace(c, below);
    if (r === 'placed') {
      keyPlaced++; registerPt(c); placedPts.push(c); covReg(c);
      regShaft(c, yLo);
      const sr = state.supports[state.supports.length - 1];
      sr.origin = 'seed'; sr.node = c.node;   // 归因标签（排查用）
      if (!sr.anchored) pedPts.push({ x: c.x + (sr.mesh.userData.jx || 0), z: c.z + (sr.mesh.userData.jz || 0) });
    } else tally(r);
  }
  let sampled = 0, covPruned = 0, fusePruned = 0, shaftPruned = 0;
  let poolI = 0;
  for (const c of islandsOnly ? [] : clusters) {   // 孤岛模式：不走普通候选池
    if (placed + baseN >= MAX) break;
    if (++poolI % 2000 === 0) { setProgress(0.5 + 0.15 * poolI / clusters.length, '布点过滤（泊松/覆盖锥/防粘连）…'); await nextFrame(); }   // 周期让帧，防主线程冻结
    if (!farFromPlaced(c.x, c.y, c.z)) continue;   // 泊松盘最小间距（3D）
    if (coveredBy(c)) { covPruned++; continue; }    // 覆盖锥过滤
    const below = useShort ? findBelow(c.x, c.y, c.z) : null;
    if (below === null) {
      // 落板：锥底在平台层互不重叠（与高度差无关，故用 XY 判定）
      let fused = false;
      for (const p of pedPts) { if ((p.x - c.x) ** 2 + (p.z - c.z) ** 2 < fuseR2) { fused = true; break; } }
      if (fused) { fusePruned++; continue; }
    }
    const yLo = below ? below.y : 0;
    if (shaftFused(c.x, c.z, yLo - 0.2, c.y + 0.2)) { shaftPruned++; continue; }   // 杆身防粘连（落板↔短小、短小↔短小）
    const r = tryPlace(c, below);
    if (r === 'placed') {
      registerPt(c); sampled++; placedPts.push(c); covReg(c);
      regShaft(c, yLo);
      const sr = state.supports[state.supports.length - 1];
      sr.origin = 'pool';   // 归因标签
      if (!sr.anchored) pedPts.push({ x: c.x + (sr.mesh.userData.jx || 0), z: c.z + (sr.mesh.userData.jz || 0) });
    } else tally(r);
  }
  // 覆盖兜底（先于终检）：附近无支撑的孤岛，逐个尝试其关键点直到一根落地。
  // 不做互撞检查——悬空优先于互粘；与已有支撑互贴的去重阶段保护（同为种子不互清）。
  let coverFix = 0;
  if (A.graph) {
    for (const nd of A.graph.nodes) {
      if (!nd.island) continue;
      const near = state.supports.some(s => Math.hypot(s.x - nd.cx, s.z - nd.cz) < 2 && Math.abs(s.y - nd.y) < 2);
      if (near) continue;
      const kps = keypoints.filter(c => c.node === nd.id);   // 该孤岛的全部关键点逐个尝试，直到一根落地
      for (const kp of kps) {
        if (placed + baseN >= MAX) break;
        const r = tryPlace(kp, useShort ? findBelow(kp.x, kp.y, kp.z) : null);
        if (r === 'placed') {
          coverFix++; keyPlaced++;
          const sr = state.supports[state.supports.length - 1];
          sr.origin = 'seed'; sr.node = nd.id;
          break;
        }
      }
    }
  }
  // 终检去重（最后执行）：放置期无法预知候选自身的球心偏移（倾斜端头互甩），事后按真球心站位复核清冗。
  // 互粘对去冗策略：普通池优先于种子；同为种子（含兜底）不清——相邻孤岛被同一支撑钉住属可接受。
  let deduped = 0;
  if (!islandsOnly) {   // 增量模式不清既有支撑，跳过终检去重（新放种子互贴同为 seed 本就不清）
    const ents = [];
    state.supports.forEach((s, idx) => {
      const g = s.mesh.geometry; g.computeBoundingBox();
      const yLo = g.boundingBox.min.y + s.mesh.position.y - 0.1, yHi = g.boundingBox.max.y + s.mesh.position.y + 0.1;
      const jx = s.mesh.userData.jx || 0, jz = s.mesh.userData.jz || 0;
      ents.push({ idx, x: s.x + jx, z: s.z + jz, yLo, yHi, s });
      if (s.anchored && s.mesh.userData.jbx !== undefined) ents.push({ idx, x: s.x + s.mesh.userData.jbx, z: s.z + s.mesh.userData.jbz, yLo, yHi, s });
    });
    const gone = new Set();
    for (let i = 0; i < ents.length; i++) {
      if (gone.has(ents[i].idx)) continue;
      for (let j = i + 1; j < ents.length; j++) {
        const a = ents[i], b = ents[j];
        if (a.idx === b.idx || gone.has(b.idx)) continue;          // 同一支撑的上下球心不算互粘
        if (a.s.origin === 'seed' && b.s.origin === 'seed') continue; // 双种子互贴：相邻孤岛共钉，接受
        if (a.yHi < b.yLo - 0.1 || a.yLo > b.yHi + 0.1) continue;
        if (Math.hypot(a.x - b.x, a.z - b.z) >= shaftClear - 0.2) continue;
        const drop = a.s.origin === 'pool' ? a : b;   // 去普通池的；都去不了则去后放的 b
        gone.add(drop.idx);
      }
    }
    if (gone.size) {
      const rest = [];
      state.supports.forEach((s, idx) => {
        if (gone.has(idx)) { supportGroup.remove(s.mesh); s.mesh.geometry.dispose(); deduped++; }
        else rest.push(s);
      });
      state.supports = rest;
      placed -= deduped;
    }
  }
  setProgress(null);
  const crossN = buildScaffold();   // 脚手架：相邻落板立柱间 X 形交叉横梁（幂等重建）
  if (islandsOnly) {
    const islTotal = A.graph ? A.graph.nodes.filter(n => n.island).length : 0;
    if (!placed) log('自动孤岛支撑：所有孤岛附近均已有支撑，无需补打');
    else log(`自动孤岛支撑：新增 ${placed} 根（孤岛 ${islTotal} 处 · 关键点补打 ${keyPlaced}，锚定 ${anchoredN}，落板 ${placed - anchoredN}，微型短柱 ${microN}，已托住跳过 ${heldN}，过短跳过 ${stubN}）`, 'ok');
  } else {
    log(`支撑生成：${placed} 根（候选 ${all.length}（区域面积滤除 ${areaPruned}） → 泊松抽样 ${sampled}，孤岛关键点 ${keyPlaced}/${keypoints.length}，覆盖锥滤除 ${covPruned}，锥底防粘连滤除 ${fusePruned}，杆身防粘连滤除 ${shaftPruned + seedFused}，终检去重 ${deduped}，覆盖补放 ${coverFix}，已托住跳过 ${heldN}，微型短柱 ${microN}，过短跳过 ${stubN}，短小支撑锚定 ${anchoredN}，落板 ${placed - anchoredN}，贴面跳过 ${flushSkipped}，保护面抑制 ${suppressed} 处）`, 'ok');
  }
  if (params.scaffoldOn) log(`脚手架格架：${crossN} 根菱形格梁（起始高 ${params.crossStartH}mm · 格高 ${params.crossZStep}mm · 柱距 ≤ ${params.crossMaxXY}mm）`, crossN ? 'ok' : 'warn');
  updateSupStats();
  if (state.analysis) drawLayer();
}
