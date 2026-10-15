/* ================================================================
   朝向优化：randomQuat / canonicalQuats / 评分循环 / renderCandidates / applyOrientation。
   与旧 main.js 的差异：缩略图不再 drawImage 到 DOM canvas，而是用离屏 prevRenderer
   （preserveDrawingBuffer:true）toDataURL 出图，连同评分数据经 bus 'orientResults' 交给 React。
================================================================ */
import * as THREE from 'three';
import { state, params, bus, log, toast, setProgress, nextFrame } from '../store.js';
import { analyze, computeFaceDataFull, steepFaces } from './slicer.js';
import { raiseH, activePart, bakeActiveLayout, bakePartRotation, capturePartSnaps, commitGeomHistory } from './model.js';
import { clearSupports } from './support.js';
import { hideInspector } from './inspect.js';
import { prevRenderer, prevScene, prevCam, prev } from './scene.js';

export function randomQuat() {
  const u1 = Math.random(), u2 = Math.random() * Math.PI * 2, u3 = Math.random() * Math.PI * 2;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return new THREE.Quaternion(a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)).normalize();
}
export function canonicalQuats() {
  const qs = [new THREE.Quaternion()];
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const ax of axes) {
    for (const ang of [Math.PI / 2, Math.PI, -Math.PI / 2]) {
      qs.push(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...ax), ang));
    }
  }
  return qs;
}

let lastList = null;   // 最近一次候选（React 点击缩略图 → applyCandidate(i)）

export async function runOrient() {
  const part = activePart();
  if (!part) return toast('请先载入模型');
  const pos = part.geom.attributes.position.array;
  const facesF = computeFaceDataFull(pos);
  const nRand = params.orientQuality;
  const selfAngle = params.selfAngle;
  const protW = params.protW;
  // 粗分析参数（只评当前零件，多模型时不会把整板当成一个物体）
  const bb = part.geom.boundingBox;
  const spanY = bb.max.y - bb.min.y;
  const coarseH = Math.max(0.15, spanY / 160);
  const cands = [...canonicalQuats()];
  for (let i = 0; i < nRand; i++) cands.push(randomQuat());
  const results = [];
  const total = cands.length;
  log(`朝向优化${state.parts.length > 1 ? `（${part.name}）` : ''}：${total} 个候选 · 粗层厚 ${coarseH.toFixed(2)}mm · 自支撑角 ${selfAngle}°`);
  const t0 = performance.now();
  for (let i = 0; i < total; i++) {
    const q = cands[i];
    const r = await analyze(pos, q, { gridRes: 128, layerH: coarseH, gapThresh: Math.max(0.5, coarseH * 2.5), raiseH: raiseH() });
    const sf = steepFaces(facesF, q, selfAngle, part.protected, protW, false);
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
}

function renderCandidates(list) {
  lastList = list;
  if (!prev.mesh) { bus.emit('orientResults', []); return; }
  // 缩略图取景：预览网格绕原点旋转，转完后并不落在 y=0 上，按「高度」取景会把很多朝向切掉下半截；
  // 改为按几何外接球取景——半径与朝向无关、球心随旋转移动；相机方向固定（斜上前方），距离让外接球恰好入画
  const geom = prev.mesh.geometry;
  if (!geom.boundingSphere) geom.computeBoundingSphere();
  const sphere = geom.boundingSphere, center = new THREE.Vector3();
  const viewDir = new THREE.Vector3(0, 0.7, 1.3).normalize();
  const dist = sphere.radius * 1.04 / Math.sin(THREE.MathUtils.degToRad(prevCam.fov / 2));
  const items = list.map((r, idx) => {
    // 渲染缩略图（离屏，dataURL 交给 React 的 <img>）
    prev.mesh.quaternion.copy(r.q);
    center.copy(sphere.center).applyQuaternion(r.q);
    prevCam.position.copy(viewDir).multiplyScalar(dist).add(center);
    prevCam.lookAt(center);
    prevRenderer.render(prevScene, prevCam);
    return {
      idx, score: r.score, isBest: idx === 0,
      supportVol: r.supportVol, steepArea: r.steepArea,
      islandArea: r.islandArea, maxFill: r.maxFill,
      img: prevRenderer.domElement.toDataURL(),
    };
  });
  bus.emit('orientResults', items);
}

export function applyCandidate(idx) {
  const r = lastList && lastList[idx];
  if (r) applyOrientation(r);
}

export function applyOrientation(r) {
  const part = activePart();
  if (!part) return;
  const before = capturePartSnaps(state.parts);
  // 视口里转过的角度先烤进几何，候选四元数加在用户看见的形状上
  bakePartRotation(part);
  const geom = part.geom;
  geom.applyQuaternion(r.q);
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
  geom.translate(-cx, -bb.min.y, -cz);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  if (prev.mesh) prev.mesh.quaternion.identity();
  // 保护面随几何保留（面索引不变），顶点色不变；多模型时按新占地重新排版
  state.analysis = null;
  clearSupports(false);
  bus.emit('sliceStats', null);
  hideInspector();
  bus.emit('orientResults', null);
  bakeActiveLayout();
  log(`已应用朝向（评分 ${r.score}）：支撑体积 ${r.supportVol.toFixed(0)}mm³，请运行逐层分析`, 'ok');
  toast('朝向已应用，请运行逐层分析');
  commitGeomHistory('应用朝向', before);
}
