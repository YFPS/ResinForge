import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { makeGroup, disposeGroup } from './models.js';
import { LIFT, SUP_ANCHOR_COLOR, SUP_COLOR, buildSupportGroup } from './supportsMock.js';

/* 工作区的 3D 视口（Demo 自带的轻量场景，不走 core/scene.js）：
   平台 + 零件 + 示意支撑；左键旋转、右键平移、滚轮缩放（与 Studio 的视角约定一致），按需渲染。
   零件位置由调用方算好传进来（data.js 的 layoutItems）。 */

function readVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function createWorkspaceScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 1, 6000);
  camera.position.set(150, 140, 210);
  scene.add(camera);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f98, 1.25));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(120, 220, 160);
  scene.add(key);
  const back = new THREE.DirectionalLight(0xdfe8ff, 0.7);
  back.position.set(-160, 120, -140);
  scene.add(back);
  const head = new THREE.DirectionalLight(0xffffff, 0.55);   // 头灯：转到哪一面哪一面迎光
  head.position.set(0, 0, 1);
  camera.add(head);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
  controls.target.set(0, 18, 0);
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  /* 平台 */
  const plate = new THREE.Group();
  scene.add(plate);
  const plateMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.82, metalness: 0.1 });
  const lineMat = new THREE.LineBasicMaterial({ color: 0x6f7680, transparent: true, opacity: 0.55 });
  const volMat = new THREE.LineBasicMaterial({ color: 0x7c8590, transparent: true, opacity: 0.22 });
  let plateSize = { x: 218, z: 123, y: 220 };

  function setPlate(machine) {
    for (const c of [...plate.children]) { plate.remove(c); c.geometry?.dispose(); }
    plateSize = { x: machine.plateX, z: machine.plateZ, y: machine.plateY };
    const slab = new THREE.Mesh(new THREE.BoxGeometry(plateSize.x, 3, plateSize.z), plateMat);
    slab.position.y = -1.5;
    plate.add(slab);
    // 10 mm 网格
    const pts = [];
    const hx = plateSize.x / 2, hz = plateSize.z / 2;
    for (let x = -Math.floor(hx / 10) * 10; x <= hx; x += 10) pts.push(x, 0.02, -hz, x, 0.02, hz);
    for (let z = -Math.floor(hz / 10) * 10; z <= hz; z += 10) pts.push(-hx, 0.02, z, hx, 0.02, z);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    plate.add(new THREE.LineSegments(gg, lineMat));
    // 成型空间外框
    const box = new THREE.BoxGeometry(plateSize.x, plateSize.y, plateSize.z);
    box.translate(0, plateSize.y / 2, 0);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), volMat);
    box.dispose();
    plate.add(edges);
    render();
  }

  /* 零件 + 支撑 */
  const itemsRoot = new THREE.Group();
  scene.add(itemsRoot);
  const supMats = {
    ground: new THREE.MeshStandardMaterial({ color: SUP_COLOR, roughness: 0.5, metalness: 0.05 }),
    anchor: new THREE.MeshStandardMaterial({ color: SUP_ANCHOR_COLOR, roughness: 0.5, metalness: 0.05 }),
  };
  const entries = new Map();   // uid → { key, model, supports, preset, mat }

  // 材料色混一点中性灰，免得高饱和色（紫 / 黑）在视口里看不清形状
  const tint = color => new THREE.Color(color).lerp(new THREE.Color(0xb9bec7), 0.35);
  const modelMaterial = color => new THREE.MeshStandardMaterial({ color: tint(color), roughness: 0.42, metalness: 0.06 });

  /**
   * items: [{ uid, key, sup }]；positions: Map(uid → {x, z})；
   * opts: { color, preset（结构按哪一档出）, lifted（模型是否抬高）, selected, outside: Set(uid) }
   */
  function setItems(items, positions, opts) {
    const keep = new Set(items.map(it => it.uid));
    for (const [uid, e] of entries) {
      if (keep.has(uid)) continue;
      itemsRoot.remove(e.node);
      disposeGroup(e.model);
      e.mat.dispose();
      entries.delete(uid);
    }
    const lifted = !!opts.lifted;
    for (const it of items) {
      let e = entries.get(it.uid);
      if (!e) {
        const model = makeGroup(it.key);
        const mat = modelMaterial(opts.color);
        model.traverse(o => { if (o.isMesh) o.material = mat; });
        const node = new THREE.Group();
        node.add(model);
        node.userData.uid = it.uid;
        itemsRoot.add(node);
        e = { key: it.key, model, node, mat, supports: null, preset: null };
        entries.set(it.uid, e);
      }
      e.mat.color.copy(tint(opts.color));
      const sel = opts.selected === it.uid;
      e.mat.emissive.set(opts.outside?.has(it.uid) ? 0x7a1f1f : sel ? 0x1d4ed8 : 0x000000);
      e.mat.emissiveIntensity = sel || opts.outside?.has(it.uid) ? 0.32 : 0;
      const p = positions.get(it.uid) || { x: 0, z: 0 };
      e.node.position.set(p.x, lifted ? LIFT : 0, p.z);
      const wantSup = it.sup ? opts.preset : null;
      if (e.preset !== wantSup) {
        if (e.supports) { e.node.remove(e.supports); e.supports.traverse(o => { if (o.isInstancedMesh) o.dispose(); }); }
        e.supports = wantSup ? buildSupportGroup(it.key, wantSup, supMats) : null;
        if (e.supports) e.node.add(e.supports);
        e.preset = wantSup;
      }
    }
    render();
  }

  /* 视角 */
  function frameAll() {
    const box = new THREE.Box3().setFromObject(itemsRoot);
    const plateBox = new THREE.Box3(new THREE.Vector3(-plateSize.x / 2, 0, -plateSize.z / 2), new THREE.Vector3(plateSize.x / 2, 30, plateSize.z / 2));
    if (box.isEmpty()) box.copy(plateBox);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 28);
    const fov = camera.fov * Math.PI / 180;
    const dist = r / Math.sin(fov / 2) * 1.25;
    const dir = new THREE.Vector3(0.62, 0.52, 0.86).normalize();
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    camera.near = Math.max(0.5, dist / 200);
    camera.far = dist * 20;
    camera.updateProjectionMatrix();
    controls.update();
    render();
  }

  /* 拾取 */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function toNdc(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
  }
  function pickPlate(clientX, clientY) {
    toNdc(clientX, clientY);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    if (Math.abs(hit.x) > plateSize.x / 2 || Math.abs(hit.z) > plateSize.z / 2) return null;
    return { x: hit.x, z: hit.z };
  }
  function pickItem(clientX, clientY) {
    toNdc(clientX, clientY);
    const meshes = [];
    for (const e of entries.values()) e.model.traverse(o => { if (o.isMesh) meshes.push(o); });
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (!hit) return null;
    let o = hit.object;
    while (o && !o.userData.uid) o = o.parent;
    return o ? o.userData.uid : null;
  }

  /* 渲染：按需，一帧至多一次 */
  let queued = false;
  function render() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      renderer.render(scene, camera);
    });
  }
  controls.addEventListener('change', render);

  function setTheme() {
    scene.background = new THREE.Color(readVar('--ws-viewport', '#101012'));
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    plateMat.color.set(light ? 0xb4b9c1 : 0x5b6068);
    lineMat.color.set(light ? 0x8d939c : 0x7b828c);
    render();
  }

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  }

  function dispose() {
    controls.dispose();
    for (const e of entries.values()) { disposeGroup(e.model); e.mat.dispose(); }
    entries.clear();
    supMats.ground.dispose(); supMats.anchor.dispose();
    plateMat.dispose(); lineMat.dispose(); volMat.dispose();
    renderer.dispose();
  }

  setTheme();
  return { setPlate, setItems, frameAll, pickPlate, pickItem, resize, setTheme, dispose, plateSize: () => plateSize };
}
