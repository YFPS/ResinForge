import * as THREE from 'three';
import { makeGroup, disposeGroup } from './models.js';
import { LIFT, SUP_ANCHOR_COLOR, SUP_COLOR, buildSupportGroup } from './supportsMock.js';
import { layoutItems } from './data.js';

/* 用离屏 three.js 渲染 Demo 缩略图。透明背景，卡片底色由 CSS 决定。
   零件缩略图：中性灰；工程缩略图：材料色 + 抬高 + 示意支撑（一眼看出哪些工程已经加好支撑）。
   所有缩略图共用一个 renderer / scene / camera，避免 WebGL 上下文数量爆炸。 */

const SIZE = 512;

function setup() {
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 5000);

  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(80, 130, 90);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9cb8ff, 1.1);
  fill.position.set(-90, 40, 70);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 1.4);
  rim.position.set(-30, 40, -110);
  scene.add(rim);

  const mat = new THREE.MeshStandardMaterial({ color: 0xc3c9d4, roughness: 0.36, metalness: 0.12 });
  const supMats = {
    ground: new THREE.MeshStandardMaterial({ color: SUP_COLOR, roughness: 0.5, metalness: 0.05 }),
    anchor: new THREE.MeshStandardMaterial({ color: SUP_ANCHOR_COLOR, roughness: 0.5, metalness: 0.05 }),
  };
  return { renderer, scene, camera, mat, supMats };
}

function frame(camera, groups) {
  const box = new THREE.Box3();
  let any = false;
  for (const g of groups) {
    g.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(g);
    if (!b.isEmpty()) { box.union(b); any = true; }
  }
  if (!any) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const fov = camera.fov * Math.PI / 180;
  const dist = (sphere.radius / Math.sin(fov / 2)) * 1.12;
  camera.position.copy(sphere.center).add(new THREE.Vector3(1, 0.58, 1.18).normalize().multiplyScalar(dist));
  camera.near = Math.max(0.1, dist - sphere.radius * 3);
  camera.far = dist + sphere.radius * 6;
  camera.lookAt(sphere.center);
  camera.updateProjectionMatrix();
}

export function createThumbnailRenderer() {
  const { renderer, scene, camera, mat, supMats } = setup();

  function shoot(groups) {
    for (const g of groups) scene.add(g);
    frame(camera, groups);
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    for (const g of groups) scene.remove(g);
    return url;
  }

  /** 单个零件 */
  function renderPart(key) {
    const g = makeGroup(key);
    g.traverse(o => { if (o.isMesh) o.material = mat; });
    const url = shoot([g]);
    disposeGroup(g);
    return url;
  }

  /** 整个工程：按工作区同一套排版，带示意支撑，模型用材料色 */
  function renderProject(project, color) {
    const items = project.items || [];
    const pos = layoutItems(items);
    const lifted = items.some(it => it.sup);
    const tinted = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).lerp(new THREE.Color(0xc3c9d4), 0.35), roughness: 0.38, metalness: 0.1,
    });
    const groups = [];
    for (const it of items) {
      const node = new THREE.Group();
      const g = makeGroup(it.key);
      g.traverse(o => { if (o.isMesh) o.material = tinted; });
      node.add(g);
      if (it.sup) node.add(buildSupportGroup(it.key, project.preset, supMats));
      const p = pos.get(it.uid) || { x: 0, z: 0 };
      node.position.set(p.x, lifted ? LIFT : 0, p.z);
      groups.push(node);
    }
    const url = shoot(groups);
    for (const n of groups) n.traverse(o => { if (o.isMesh && !o.isInstancedMesh) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
    tinted.dispose();
    return url;
  }

  function dispose() {
    renderer.dispose();
    mat.dispose();
    supMats.ground.dispose();
    supMats.anchor.dispose();
  }

  return { renderPart, renderProject, dispose };
}
