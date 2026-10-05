/* ================================================================
   three.js 场景：renderer / camera / OrbitControls / 灯光 / 平台网格 / 材质 /
   modelGroup / supportGroup / animate 循环 / resize / pointerRay / paintAt /
   setMode / 四模式 pointer 处理 / 拖放 STL。
   与旧 main.js 的差异仅两类：参数读 params.*，UI 副作用发 bus 事件。
   不依赖 DOM 的部分在模块级创建；renderer/controls 需 canvas，由 initScene(canvas) 完成。
================================================================ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { state, params, bus, log, toast } from '../store.js';
import { loadDemo, loadSTLBuffer } from './model.js';
import { addSupportPoint, deleteSupportNear } from './support.js';

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);
scene.fog = new THREE.Fog(0x0d1117, 300, 900);
export const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 3000);
camera.position.set(95, 75, 95);

/* 光照 = 方向光塑形 + 环境光（IBL）兜底：RoomEnvironment 经 PMREM 预滤波后作 scene.environment，
   等效简单全局光照。支撑检查要求任意角度不死黑：
   - 半球光地面色用中灰蓝（非近黑）——底面/侧下面的基础补光
   - 底部反向填充光（dl3，从下往上打）——抬亮正下方视角
   envMapIntensity 按材质微调。 */
scene.add(new THREE.HemisphereLight(0xcdd9e5, 0x55677e, 0.55));
const dl = new THREE.DirectionalLight(0xffffff, 1.1);
dl.position.set(60, 120, 40); scene.add(dl);
const dl2 = new THREE.DirectionalLight(0x8899aa, 0.35);
dl2.position.set(-80, 40, -60); scene.add(dl2);
const dl3 = new THREE.DirectionalLight(0xaabbcc, 0.5);   // 底部填充：正下视角不死黑
dl3.position.set(-20, -100, 30); scene.add(dl3);
/* 不显示坐标轴与网格底板（视图更干净，专注模型与支撑检查） */

export const modelGroup = new THREE.Group(); scene.add(modelGroup);
export const supportGroup = new THREE.Group(); scene.add(supportGroup);

export const modelMat = new THREE.MeshStandardMaterial({
  color: 0xb9c2cf, roughness: 0.55, metalness: 0.15, vertexColors: true, envMapIntensity: 0.45
});
export const supMat = new THREE.MeshStandardMaterial({ color: 0x38d996, roughness: 0.5, metalness: 0.05, envMapIntensity: 0.4 });
export const supMatAnchor = new THREE.MeshStandardMaterial({ color: 0xffb020, roughness: 0.5, metalness: 0.05, envMapIntensity: 0.4 });
export const supMatBase = new THREE.MeshStandardMaterial({ color: 0x7d8aa0, roughness: 0.7, metalness: 0.05, envMapIntensity: 0.4 });   // 格架底座整板

/* 预览渲染器（朝向候选缩略图；preserveDrawingBuffer 供 toDataURL 出图，React 渲染 <img>） */
export const prevRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
prevRenderer.setSize(112, 112);
export const prevScene = new THREE.Scene();
prevScene.background = new THREE.Color(0x0d1117);
prevScene.add(new THREE.HemisphereLight(0xcdd9e5, 0x0d1117, 1.3));
const pdl = new THREE.DirectionalLight(0xffffff, 1.6); pdl.position.set(60, 120, 40); prevScene.add(pdl);
export const prevCam = new THREE.PerspectiveCamera(40, 1, 0.1, 3000);
export const prev = { mesh: null };   // 预览模型 Mesh（model.js setGeometry 重建，orient.js 渲染缩略图）

/* 需 canvas 的句柄（initScene 后可用） */
let canvas = null;
let renderer = null;
let controls = null;
export const getRenderer = () => renderer;
export const getControls = () => controls;
export const getCanvas = () => canvas;

function resize() {
  const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

/* ================================================================
   保护面笔刷
================================================================ */
const raycaster = new THREE.Raycaster();
export function pointerRay(e) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  return raycaster;
}
export function paintAt(e) {
  if (!state.mesh) return;
  const hits = pointerRay(e).intersectObject(state.mesh);
  if (!hits.length) return;
  const hit = hits[0];
  const r = params.brushR;
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
  if (added) { colorAttr.needsUpdate = true; bus.emit('protectedChanged'); log(`保护面 +${added}（共 ${state.protectedFaces.size} 面）`); }
}
export function clearProtectedFaces() {
  state.protectedFaces.clear();
  if (state.mesh) {
    const ca = state.mesh.geometry.attributes.color;
    for (let i = 0; i < ca.array.length; i++) ca.array[i] = 1;
    ca.needsUpdate = true;
  }
  bus.emit('protectedChanged');
  log('保护面已清除');
}

/* ================================================================
   交互模式（旋转 / 保护面 / 加支撑 / 删支撑）
================================================================ */
export function setMode(m) {
  state.mode = m;
  // 控制器常开：右键任何模式下都可拖动平移视角、中键拖动旋转；左键只在「旋转」模式旋转，其他模式留给涂画/加/删支撑
  controls.enabled = true;
  controls.mouseButtons.LEFT = (m === 'orbit') ? THREE.MOUSE.ROTATE : null;
  canvas.style.cursor = m === 'orbit' ? 'grab' : 'crosshair';
  bus.emit('mode', m);
}

/* ================================================================
   初始化：renderer / controls / 事件 / 动画循环 / 启动流程
================================================================ */
export function initScene(canvasEl) {
  canvas = canvasEl;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  /* 环境光照（IBL ≈ 简易全局光照）：主场景与缩略图场景各自 PMREM（纹理绑定 GL 上下文，不能跨 renderer 共享） */
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const pmremPrev = new THREE.PMREMGenerator(prevRenderer);
  prevScene.environment = pmremPrev.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose(); pmremPrev.dispose();
  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 22, 0);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  // 鼠标键位（切片软件惯例）：按住右键拖动平移视角、中键拖动旋转（各模式通用），滚轮缩放；
  // 左键仅在「旋转」模式下旋转，其余模式留给涂画/加删支撑
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
  controls.screenSpacePanning = true;   // 平移沿屏幕平面（上下拖 = 画面上下移），不是沿地面
  canvas.addEventListener('contextmenu', e => e.preventDefault());   // 右键拖动平移时不弹系统菜单
  window.addEventListener('resize', resize);

  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;   // 仅左键触发涂画/加/删支撑；右键（平移）/ 中键（旋转）交给 OrbitControls
    if (state.mode === 'paint') { state.painting = true; paintAt(e); }
    else if (state.mode === 'add' && state.mesh) {
      const hits = pointerRay(e).intersectObject(state.mesh);
      if (hits.length) {
        const h = hits[0];
        if (state.protectedFaces.has(h.faceIndex)) { toast('该面为保护面，已阻止添加支撑'); return; }
        // 命中面法线作为接触端朝向（模型仅平移变换，几何面法线即世界系方向）；朝上的面无从支撑
        const fn = h.face ? h.face.normal : null;
        if (fn && fn.y > 0.3) { toast('只能在朝下（悬空）的表面添加支撑点'); return; }
        // 加点后整体重建结构（树/格架分支互连，不能单根追加）——与 PrusaSlicer 的支撑点编辑一致
        addSupportPoint(h.point, fn ? [fn.x, fn.y, fn.z] : null);
      }
    } else if (state.mode === 'del' && state.supports.length) {
      const hits = pointerRay(e).intersectObjects(supportGroup.children);
      if (hits.length) deleteSupportNear(hits[0].point);   // 删除最近的支撑点并重建结构
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (state.painting && state.mode === 'paint') paintAt(e);
  });
  window.addEventListener('pointerup', () => { state.painting = false; });

  /* 拖放 STL */
  window.addEventListener('dragover', e => { e.preventDefault(); bus.emit('dropHint', true); });
  window.addEventListener('dragleave', e => { if (e.target === document.body || e.target === canvas.parentElement) bus.emit('dropHint', false); });
  window.addEventListener('drop', e => {
    e.preventDefault(); bus.emit('dropHint', false);
    const f = e.dataTransfer.files[0];
    if (f && /\.stl$/i.test(f.name)) f.arrayBuffer().then(b => loadSTLBuffer(b, f.name));
    else if (f) toast('请拖入 .stl 文件');
  });

  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();

  /* 启动 */
  resize();
  loadDemo('knot');
  log('ResinForge v0.1 就绪：像素级切片 + 多目标朝向优化 + 孤岛检测 + 语义保护面权重', 'ok');
  log('流程：载入模型 → 朝向优化 → (涂保护面) → 逐层分析 → 生成支撑 → 导出 STL');
}
