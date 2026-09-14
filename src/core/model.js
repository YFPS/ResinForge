/* ================================================================
   模型载入：setGeometry / loadDemo（4 个内置 demo）/ loadSTLBuffer / mergeGeoms /
   updateRaft / 参数辅助（raiseH / raftOn / raftMargin）。
   与旧 main.js 的差异仅两类：参数读 params.*，DOM 赋值改发 bus 事件。
================================================================ */
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { state, params, bus, log, toast } from '../store.js';
import { scene, camera, modelGroup, modelMat, prevScene, prev, getControls } from './scene.js';
import { computeFaceDataFull } from './slicer.js';
import { clearSupports, updateSupStats } from './support.js';
import { hideInspector } from './inspect.js';

/* 打印工艺参数：世界系 = 打印系（平台顶面 y=0，模型底面抬高 raiseH，筏层厚 RAFT_T） */
export const RAFT_T = 1.2;    // 筏层厚度（mm），固定
let raftMesh = null;          // 筏层显示 Mesh
export const raiseH = () => Math.max(0, params.raiseH || 0);   // 模型抬高（mm）
export const raftOn = () => params.raftOn;
export const raftMargin = () => params.raftMargin || 3;

export function setGeometry(geom, name) {
  clearSupports(false);
  state.protectedFaces.clear();
  state.analysis = null;
  state.orientResult = null;
  bus.emit('orientResults', null);   // 隐藏朝向候选区
  bus.emit('sliceStats', null);
  bus.emit('supStats', null);
  hideInspector();

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
  state.faces = computeFaceDataFull(geom.attributes.position.array);

  if (prev.mesh) { prevScene.remove(prev.mesh); }
  prev.mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xb9c2cf, roughness: 0.55, metalness: 0.15 }));
  prevScene.add(prev.mesh);

  const bb2 = geom.boundingBox;
  const size = bb2.max.clone().sub(bb2.min);
  const nf = geom.attributes.position.count / 3;
  bus.emit('modelInfo', {
    name,
    sizeText: `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm`,
    nf,
  });
  // 相机适配；旋转中心 = 模型包围盒中心（世界系，含抬高）
  const r = Math.max(size.x, size.y, size.z);
  camera.position.set(r * 1.4, r * 1.15, r * 1.4);
  getControls().target.set(0, raiseH() + size.y / 2, 0);
  log(`模型已载入：${name}（${nf.toLocaleString()} 面，${size.y.toFixed(1)}mm 高）`, 'ok');
  if (nf > 120000) log('⚠ 面数较大，分析可能较慢', 'warn');
  const pX = params.plateX || 150, pZ = params.plateZ || 85;
  if (size.x > pX || size.z > pZ) log(`⚠ 模型底面 ${size.x.toFixed(0)}×${size.z.toFixed(0)}mm 超出板面 ${pX}×${pZ}mm`, 'warn');
  updateRaft();
}

/* 筏层显示：模型 XZ 外接圆半径 + 边距，厚 RAFT_T，顶面即落板支撑的着落面 */
export function updateRaft() {
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

/* 参数变更副作用（复刻旧 main.js 的 change 监听；React 组件 onChange 调用） */
export function handleRaftOnChange() { updateRaft(); toast('筏层设置已变更，请重新生成支撑'); }
export function handleRaftMarginChange() { updateRaft(); }
export function handleRaiseHChange() {
  const h = raiseH();
  if (state.mesh) state.mesh.position.y = h;
  clearSupports(false); updateSupStats();
  state.analysis = null;
  hideInspector();
  bus.emit('sliceStats', null);
  log(`抬高已改为 ${h}mm，请重新运行逐层分析`, 'warn');
}

/* 内置演示模型 */
export function mergeGeoms(parts) {
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
export function loadDemo(kind) {
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
export function loadSTLBuffer(buf, name) {
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
