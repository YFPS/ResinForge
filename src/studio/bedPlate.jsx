/* Studio 打印网板：18 mm 黑色圆角方砖，缝和四周留出视口底色，不铺浅色底板。
   线网格和板框收起，坐标轴保留。演示页和旧界面仍用 scene.js 的线网格。
   开发时打开 ?proto=bed 会改走原来的方案切换，这里让开。 */
import { useLayoutEffect, useState } from 'react';
import * as THREE from 'three';
import { scene } from '../core/scene.js';
import { plateAxisOrigin } from '../core/model.js';

const TILE_MIN = 3;
const TILE_MAX = 18;
const TILE_KEY = 'resinforge:bed.tile';

const TILE_VERT = `
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const TILE_FRAG = `
varying vec3 vWorld;
uniform vec2 uPitch;
uniform float uRad;
uniform float uSide;
uniform vec2 uOrigin;
uniform vec2 uCount;
uniform vec3 uInk;
void main() {
  vec2 p = vWorld.xz;
  vec2 fw = fwidth(p);
  float tileAa = max(max(fw.x, fw.y), 0.0001);
  vec2 tileLocal = p - uOrigin;
  vec2 tileCell = floor(tileLocal / uPitch);
  if (tileCell.x < 0.0 || tileCell.y < 0.0 || tileCell.x >= uCount.x || tileCell.y >= uCount.y) discard;
  vec2 tileIn = tileLocal - tileCell * uPitch;
  if (tileIn.x >= uSide || tileIn.y >= uSide) discard;
  vec2 tileC = tileIn - vec2(uSide * 0.5);
  float tileRad = min(uRad, uSide * 0.5 - 0.02);
  vec2 tileD = abs(tileC) - vec2(uSide * 0.5 - tileRad);
  float tileDist = length(max(tileD, 0.0)) + min(max(tileD.x, tileD.y), 0.0) - tileRad;
  if (tileDist > tileAa) discard;
  gl_FragColor = vec4(uInk, 1.0 - smoothstep(-tileAa, tileAa, tileDist));
}
`;

function clampTile(n) {
  return Math.min(TILE_MAX, Math.max(TILE_MIN, Math.round(n)));
}

function readTileSize() {
  try {
    const n = Number(localStorage.getItem(TILE_KEY));
    if (Number.isFinite(n) && n > 0) return clampTile(n);
  } catch { /* 隐私模式读不到时用 18 mm */ }
  return 18;
}

function writeTileSize(n) {
  try { localStorage.setItem(TILE_KEY, String(n)); } catch { /* 写失败就只留在这一页 */ }
}

function themeName() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function plateLines() {
  const group = scene.getObjectByName('buildVolume');
  if (!group) return [];
  const out = [];
  group.traverse(obj => {
    const role = obj.material && obj.material.userData && obj.material.userData.role;
    if (role === 'grid' || role === 'edge') out.push({ obj, role, mat: obj.material });
  });
  return out;
}

/* 线网格沉到板面下面，避免和方砖缝在深度上闪成虚线。板框收起。轴不动。 */
function hideLinePlate() {
  for (const { obj, role } of plateLines()) {
    obj.visible = false;
    if (role === 'grid') obj.position.y = -4;
  }
}

function restoreLinePlate() {
  for (const { obj, mat } of plateLines()) {
    obj.visible = true;
    obj.position.y = 0;
    if (mat) {
      mat.transparent = false;
      mat.opacity = 1;
      mat.needsUpdate = true;
    }
  }
}

function tileLayout(px, pz, side) {
  const gap = Math.max(0.4, side * 0.25);
  const pitch = side + gap;
  const cols = Math.max(1, Math.floor((px + gap - 0.01) / pitch));
  const rows = Math.max(1, Math.floor((pz + gap - 0.01) / pitch));
  const spanX = cols * side + (cols - 1) * gap;
  const spanZ = rows * side + (rows - 1) * gap;
  return { gap, pitch, cols, rows, spanX, spanZ, rad: Math.min(side * 0.22, side * 0.45) };
}

function dropPlate() {
  const old = scene.getObjectByName('bedPlate');
  if (!old) return;
  scene.remove(old);
  old.geometry.dispose();
  old.material.dispose();
}

function makePlate(frame, theme, tileSize) {
  const fit = tileLayout(frame.px, frame.pz, tileSize);
  const geo = new THREE.PlaneGeometry(fit.spanX, fit.spanZ, 1, 1);
  geo.rotateX(-Math.PI / 2);
  /* 深色视口近黑，纯黑砖会融进底色。深色用一档可见的墨色，浅色保持近黑。 */
  const ink = theme === 'light' ? 0x141414 : 0x3a3d46;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uPitch: { value: new THREE.Vector2(fit.pitch, fit.pitch) },
      uRad: { value: fit.rad },
      uSide: { value: tileSize },
      uOrigin: { value: new THREE.Vector2(-fit.spanX / 2, -fit.spanZ / 2) },
      uCount: { value: new THREE.Vector2(fit.cols, fit.rows) },
      uInk: { value: new THREE.Color(ink) },
    },
    vertexShader: TILE_VERT,
    fragmentShader: TILE_FRAG,
    depthTest: true,
    depthWrite: true,
    transparent: true,
    toneMapped: false,
  });
  mat.fog = false;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'bedPlate';
  mesh.position.y = 0.03;
  mesh.raycast = () => {};
  mesh.userData.fit = fit;
  return mesh;
}

function protoBedOn() {
  return import.meta.env.DEV && new URLSearchParams(location.search).get('proto') === 'bed';
}

/* 方砖边长。挂在底栏这一排，和工具坞、下一步并排。 */
export default function BedPlate() {
  const [tileSize, setTileSize] = useState(readTileSize);
  if (protoBedOn()) return null;
  return <BedPlateLive tileSize={tileSize} setTileSize={setTileSize} />;
}

function BedPlateLive({ tileSize, setTileSize }) {
  useLayoutEffect(() => {
    let key = '';
    const rebuild = () => {
      const frame = plateAxisOrigin();
      const theme = themeName();
      const next = `${frame.px}:${frame.pz}:${theme}:${tileSize}`;
      hideLinePlate();
      const cloud = scene.getObjectByName('bedPlate');
      if (cloud && key === next) return;
      dropPlate();
      const mesh = makePlate(frame, theme, tileSize);
      scene.add(mesh);
      key = next;
    };
    rebuild();
    const mo = new MutationObserver(rebuild);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    let raf = 0;
    const loop = () => {
      rebuild();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      dropPlate();
      restoreLinePlate();
    };
  }, [tileSize]);

  const bump = (dir) => {
    setTileSize(prev => {
      const next = clampTile(prev + dir);
      writeTileSize(next);
      return next;
    });
  };

  return (
    <div className="stuBedSize" role="group" aria-label="方砖大小">
      <button type="button" onClick={() => bump(-1)} disabled={tileSize <= TILE_MIN} aria-label="缩小方砖">−</button>
      <b>{tileSize} mm</b>
      <button type="button" onClick={() => bump(1)} disabled={tileSize >= TILE_MAX} aria-label="放大方砖">+</button>
    </div>
  );
}
