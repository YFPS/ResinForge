/* PROTOTYPE — 打印网板如果换成点云或色块，看起来是什么。
   星尘是细点，散开是软点团，扫描是六角点阵加光带，方砖和错砖是黑色圆角矩形，块与块之间留间隔。
   方砖默认 18 mm。只画黑块，缝里和四周都不铺浅色底板。
   打开 /studio.html?proto=bed ，左右方向键换方案。正式网格仍由 updateBuildVolume 画，这里只是把它盖住。
   看完删本文件，并撤掉 StudioApp 里的挂载。 */
import { useEffect, useLayoutEffect, useState } from 'react';
import * as THREE from 'three';
import { scene } from '../core/scene.js';
import { plateAxisOrigin } from '../core/model.js';

const VARIANTS = [
  { id: 'dust', name: '星尘' },
  { id: 'mist', name: '散开' },
  { id: 'pulse', name: '扫描' },
  { id: 'tile', name: '方砖' },
  { id: 'bond', name: '错砖' },
];

const VERT = `
attribute float aAlpha;
attribute float aSize;
varying float vAlpha;
varying vec2 vXZ;
uniform float uTime;
uniform float uViewH;
uniform float uAnimate;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vXZ = position.xz;
  vAlpha = aAlpha;
  float wave = 0.0;
  if (uAnimate > 0.5) {
    float s = sin(dot(position.xz, vec2(0.085, 0.028)) - uTime * 2.1);
    wave = smoothstep(0.35, 0.92, s);
  }
  float mm = aSize * mix(1.0, 0.78 + 0.95 * wave, step(0.5, uAnimate));
  float px = mm * uViewH * 0.5 * projectionMatrix[1][1] / max(gl_Position.w, 0.001);
  gl_PointSize = clamp(px, 1.25, 56.0);
}
`;

const FRAG = `
varying float vAlpha;
varying vec2 vXZ;
uniform float uTime;
uniform float uSoft;
uniform float uAnimate;
uniform vec3 uColor;
uniform vec3 uHot;
void main() {
  vec2 p = gl_PointCoord - vec2(0.5);
  float d = length(p);
  if (d > 0.5) discard;
  float edge = mix(0.36, 0.0, uSoft);
  float disk = smoothstep(0.5, edge, d);
  float core = smoothstep(0.18, 0.0, d);
  float a = vAlpha * (disk * (1.0 - 0.25 * uSoft) + core * (0.25 + 0.85 * uSoft));
  float wave = 0.0;
  if (uAnimate > 0.5) {
    float s = sin(dot(vXZ, vec2(0.085, 0.028)) - uTime * 2.1);
    wave = smoothstep(0.35, 0.92, s);
    a *= mix(0.28, 1.0, wave);
  }
  if (a < 0.012) discard;
  gl_FragColor = vec4(mix(uColor, uHot, wave), a);
}
`;

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
uniform float uGap;
uniform float uRad;
uniform float uStagger;
uniform vec2 uHalf;
uniform vec3 uInk;
uniform vec3 uGapCol;
uniform float uFlush;
uniform float uSide;
uniform vec2 uOrigin;
uniform vec2 uCount;
void main() {
  vec2 p = vWorld.xz;
  if (abs(p.x) > uHalf.x || abs(p.y) > uHalf.y) discard;
  if (uFlush > 0.5) {
    /* 只留黑块。缝、圆角外和四周都不铺色，避免再出一圈浅色底板。 */
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
    return;
  }
  float row = floor(p.y / uPitch.y + 0.5);
  float shift = uStagger * mod(row, 2.0) * uPitch.x * 0.5;
  vec2 q = vec2(p.x + shift, p.y);
  vec2 local = mod(q + uPitch * 0.5, uPitch) - uPitch * 0.5;
  vec2 box = uPitch * 0.5 - vec2(uGap * 0.5);
  float rad = min(uRad, min(box.x, box.y));
  vec2 d = abs(local) - box + rad;
  float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - rad;
  vec2 center = q - local;
  center.x -= shift;
  float insidePlate = step(abs(center.x) + box.x, uHalf.x - 0.3) * step(abs(center.y) + box.y, uHalf.y - 0.3);
  float aa = max(fwidth(dist), 0.001);
  float tile = (1.0 - smoothstep(-aa, aa, dist)) * insidePlate;
  gl_FragColor = vec4(mix(uGapCol, uInk, tile), 1.0);
}
`;

function readVariant() {
  const id = new URLSearchParams(location.search).get('variant');
  return VARIANTS.some(v => v.id === id) ? id : 'dust';
}

const TILE_MIN = 3;
const TILE_MAX = 18;

function clampTile(n) {
  return Math.min(TILE_MAX, Math.max(TILE_MIN, Math.round(n)));
}

function readTileSize() {
  const raw = new URLSearchParams(location.search).get('tile');
  if (raw == null || raw === '') return 18;
  const n = Number(raw);
  return Number.isFinite(n) ? clampTile(n) : 6;
}

function hash(a, b) {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
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

/* 网格先藏起来。星尘留板框，散开连板框一起收掉，扫描只留一道很淡的框。
   方砖不要浅色包边，板框也收掉。轴不动。 */
function showPlate(variant) {
  for (const { obj, role, mat } of plateLines()) {
    if (role === 'grid' || (role === 'edge' && variant === 'tile')) {
      obj.visible = false;
      /* 网格线比板面高 0.01 mm，深度上分不清，会在缝里闪成虚线。方砖时把它沉下去。 */
      if (role === 'grid') obj.position.y = variant === 'tile' ? -4 : 0;
      continue;
    }
    if (variant === 'mist') {
      obj.visible = false;
      continue;
    }
    if (variant === 'pulse') {
      obj.visible = true;
      if (!mat.transparent || mat.opacity !== 0.32) {
        mat.transparent = true;
        mat.opacity = 0.32;
        mat.needsUpdate = true;
      }
      continue;
    }
    obj.visible = true;
    obj.position.y = 0;
    if (mat.transparent || mat.opacity !== 1) {
      mat.transparent = false;
      mat.opacity = 1;
      mat.needsUpdate = true;
    }
  }
}

function restorePlate() {
  for (const { obj, mat } of plateLines()) {
    obj.visible = true;
    obj.position.y = 0;
    mat.transparent = false;
    mat.opacity = 1;
    mat.needsUpdate = true;
  }
}

function lookOf(variant, theme) {
  const dark = theme !== 'light';
  if (variant === 'mist') {
    return {
      color: dark ? 0xe8f3fc : 0x3a495a,
      hot: dark ? 0xe8f3fc : 0x3a495a,
      soft: 0.94,
      animate: 0,
      blending: dark ? THREE.AdditiveBlending : THREE.NormalBlending,
    };
  }
  if (variant === 'pulse') {
    return {
      color: dark ? 0x8ea0b4 : 0x667586,
      hot: dark ? 0xf4f8ff : 0x1e4fbe,
      soft: 0.2,
      animate: 1,
      blending: THREE.NormalBlending,
    };
  }
  return {
    color: dark ? 0xd7e3ef : 0x4c5b6c,
    hot: dark ? 0xffffff : 0x2c3948,
    soft: 0.18,
    animate: 0,
    blending: THREE.NormalBlending,
  };
}

function pushPoint(buf, x, y, z, alpha, size) {
  buf.pos.push(x, y, z);
  buf.alpha.push(alpha);
  buf.size.push(size);
}

/* 星尘：几乎铺满的细点，略微错开，免得看成另一张网。 */
function fillDust(buf, hx, hz) {
  const step = 1.8;
  const n = Math.max(1, Math.floor((hx * 2 - 2.4) / step));
  const m = Math.max(1, Math.floor((hz * 2 - 2.4) / step));
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const x = -n * step / 2 + i * step + (hash(i, j) - 0.5) * 0.42;
      const z = -m * step / 2 + j * step + (hash(j + 9, i) - 0.5) * 0.42;
      if (Math.abs(x) > hx - 1.1 || Math.abs(z) > hz - 1.1) continue;
      const nx = x / hx;
      const nz = z / hz;
      const vig = 1 - 0.42 * (nx * nx + nz * nz);
      pushPoint(buf, x, 0.12, z, 0.46 + 0.48 * vig, 0.62);
    }
  }
  return `间距 1.8 mm`;
}

/* 散开：疏的大软点浮在一层薄雾里，靠近板边就淡掉，不画框。 */
function fillMist(buf, hx, hz) {
  const fade = (x, z) => {
    const t = Math.min(hx - Math.abs(x), hz - Math.abs(z)) / 16;
    const c = Math.max(0, Math.min(1, t));
    return c * c;
  };
  const step = 8;
  const n = Math.ceil(hx * 2 / step);
  const m = Math.ceil(hz * 2 / step);
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const x = -hx + i * step + (hash(i, j) - 0.5) * 5.2;
      const z = -hz + j * step + (hash(j, i + 4) - 0.5) * 5.2;
      const a = fade(x, z);
      if (a < 0.04) continue;
      const h = hash(i + 2, j + 5);
      pushPoint(buf, x, 0.2 + h * 1.35, z, a * (0.14 + 0.2 * hash(j, i)), 2.1 + h * 2.3);
    }
  }
  const fine = 2.7;
  const fn = Math.ceil(hx * 2 / fine);
  const fm = Math.ceil(hz * 2 / fine);
  for (let i = 0; i <= fn; i++) {
    for (let j = 0; j <= fm; j++) {
      const x = -hx + i * fine + (hash(i + 20, j) - 0.5) * 1.3;
      const z = -hz + j * fine + (hash(j, i + 30) - 0.5) * 1.3;
      const a = fade(x, z);
      if (a < 0.05) continue;
      pushPoint(buf, x, 0.1 + hash(i, j + 8) * 0.35, z, a * (0.28 + 0.4 * hash(i + 1, j + 1)), 0.34 + hash(j + 3, i) * 0.4);
    }
  }
  return '疏密两层';
}

/* 扫描：六角点阵，光带在着色器里沿板面走。 */
function fillPulse(buf, hx, hz) {
  const step = 5;
  const rowH = step * Math.sqrt(3) / 2;
  const rows = Math.max(1, Math.floor((hz * 2 - 3) / rowH));
  const cols = Math.max(1, Math.floor((hx * 2 - 3) / step));
  const z0 = -((rows - 1) * rowH) / 2;
  for (let r = 0; r < rows; r++) {
    const z = z0 + r * rowH;
    const x0 = -((cols - 1) * step) / 2 + (r % 2) * step / 2;
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * step;
      if (Math.abs(x) > hx - 1.6 || Math.abs(z) > hz - 1.6) continue;
      pushPoint(buf, x, 0.12, z, 0.9, 1.05);
    }
  }
  return '六角 5 mm · 光带在扫';
}

/* 方砖按用户给的边长排正方块，缝不填色，外沿也不画浅色包边。 */
function tileLayout(px, pz, side) {
  const gap = Math.max(0.4, side * 0.25);
  const pitch = side + gap;
  const cols = Math.max(1, Math.floor((px + gap - 0.01) / pitch));
  const rows = Math.max(1, Math.floor((pz + gap - 0.01) / pitch));
  const spanX = cols * side + (cols - 1) * gap;
  const spanZ = rows * side + (rows - 1) * gap;
  return {
    gap,
    pitch,
    cols,
    rows,
    spanX,
    spanZ,
    rad: Math.min(side * 0.22, side * 0.45),
  };
}

/* 方砖 / 错砖：黑色圆角矩形。方砖的缝是空的；错砖仍铺在浅一档的底板上。 */
function makeTiles(variant, frame, theme, tileSize) {
  const dark = theme !== 'light';
  const bond = variant === 'bond';
  const fit = bond ? null : tileLayout(frame.px, frame.pz, tileSize);
  const pitch = bond ? [14, 6.2] : [fit.pitch, fit.pitch];
  const gap = bond ? 1.4 : fit.gap;
  const geo = new THREE.PlaneGeometry(bond ? frame.px : fit.spanX, bond ? frame.pz : fit.spanZ, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uPitch: { value: new THREE.Vector2(pitch[0], pitch[1]) },
      uGap: { value: gap },
      uRad: { value: bond ? 1.25 : fit.rad },
      uStagger: { value: bond ? 1 : 0 },
      uHalf: { value: new THREE.Vector2(frame.px / 2, frame.pz / 2) },
      uInk: { value: new THREE.Color(0x141414) },
      uGapCol: { value: new THREE.Color(dark ? 0x3a4454 : 0xd7dbe2) },
      uFlush: { value: bond ? 0 : 1 },
      uSide: { value: bond ? 0 : tileSize },
      uOrigin: { value: new THREE.Vector2(bond ? 0 : -fit.spanX / 2, bond ? 0 : -fit.spanZ / 2) },
      uCount: { value: new THREE.Vector2(bond ? 0 : fit.cols, bond ? 0 : fit.rows) },
    },
    vertexShader: TILE_VERT,
    fragmentShader: TILE_FRAG,
    depthTest: true,
    depthWrite: true,
    transparent: !bond,
    toneMapped: false,
  });
  mat.fog = false;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'bedProtoCloud';
  mesh.position.y = 0.03;
  mesh.raycast = () => {};
  const cols = bond ? Math.max(1, Math.floor((frame.px - 1) / pitch[0])) : fit.cols;
  const rows = bond ? Math.max(1, Math.floor((frame.pz - 1) / pitch[1])) : fit.rows;
  const kind = bond ? '圆角长块，错开半格' : `方块 ${tileSize.toFixed(0)} mm`;
  mesh.userData.stat = `${(cols * rows).toLocaleString('zh-CN')} 块 · ${kind} · 间隔 ${gap.toFixed(1)} mm`;
  return mesh;
}

function makeCloud(variant, frame, theme, tileSize) {
  if (variant === 'tile' || variant === 'bond') return makeTiles(variant, frame, theme, tileSize);
  const buf = { pos: [], alpha: [], size: [] };
  const hx = frame.px / 2;
  const hz = frame.pz / 2;
  const label = variant === 'mist' ? fillMist(buf, hx, hz) : variant === 'pulse' ? fillPulse(buf, hx, hz) : fillDust(buf, hx, hz);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  geo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(buf.alpha, 1));
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(buf.size, 1));
  geo.computeBoundingSphere();
  const look = lookOf(variant, theme);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uViewH: { value: 900 },
      uSoft: { value: look.soft },
      uAnimate: { value: look.animate && !reduce ? 1 : 0 },
      uColor: { value: new THREE.Color(look.color) },
      uHot: { value: new THREE.Color(look.hot) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: look.blending,
    toneMapped: false,
  });
  mat.fog = false;
  const points = new THREE.Points(geo, mat);
  points.name = 'bedProtoCloud';
  points.raycast = () => {};
  points.frustumCulled = true;
  const count = buf.alpha.length;
  const stat = `${count.toLocaleString('zh-CN')} 点 · ${label}`;
  points.userData.stat = stat;
  return points;
}

function dropCloud() {
  const old = scene.getObjectByName('bedProtoCloud');
  if (!old) return;
  scene.remove(old);
  old.geometry.dispose();
  old.material.dispose();
}

export default function BedProto() {
  if (!import.meta.env.DEV) return null;
  if (new URLSearchParams(location.search).get('proto') !== 'bed') return null;
  return <BedProtoLive initial={readVariant()} />;
}

function BedProtoLive({ initial }) {
  const [variant, setVariant] = useState(initial);
  const [tileSize, setTileSize] = useState(readTileSize);
  const [stat, setStat] = useState('正在铺点');
  const current = VARIANTS.find(v => v.id === variant) || VARIANTS[0];

  useEffect(() => {
    document.documentElement.dataset.bedProto = variant;
    return () => { delete document.documentElement.dataset.bedProto; };
  }, [variant]);

  useLayoutEffect(() => {
    let key = '';
    const rebuild = () => {
      const frame = plateAxisOrigin();
      const theme = themeName();
      const next = `${frame.px}:${frame.pz}:${theme}:${variant}:${variant === 'tile' ? tileSize : '-'}`;
      /* 板面网格会在换机型、换主题时整组重建，每一帧都再藏一次。 */
      showPlate(variant);
      let cloud = scene.getObjectByName('bedProtoCloud');
      if (cloud && key === next) return cloud;
      dropCloud();
      cloud = makeCloud(variant, frame, theme, tileSize);
      scene.add(cloud);
      key = next;
      setStat(prev => (prev === cloud.userData.stat ? prev : cloud.userData.stat));
      return cloud;
    };
    rebuild();
    const mo = new MutationObserver(rebuild);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    let raf = 0;
    const loop = (t) => {
      const cloud = rebuild();
      const uniforms = cloud && cloud.material && cloud.material.uniforms;
      if (uniforms && uniforms.uTime) uniforms.uTime.value = t * 0.001;
      if (uniforms && uniforms.uViewH) {
        const canvas = document.querySelector('.stuStage canvas');
        if (canvas && canvas.height) uniforms.uViewH.value = canvas.height;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      dropCloud();
    };
  }, [variant, tileSize]);

  useLayoutEffect(() => () => { restorePlate(); }, []);

  const bumpTile = (dir) => {
    setTileSize(prev => {
      const next = clampTile(prev + dir);
      const url = new URL(location.href);
      url.searchParams.set('tile', String(next));
      history.replaceState(null, '', url);
      return next;
    });
  };

  const pick = (dir) => {
    const i = VARIANTS.findIndex(v => v.id === variant);
    const next = VARIANTS[(i + dir + VARIANTS.length) % VARIANTS.length].id;
    const url = new URL(location.href);
    url.searchParams.set('proto', 'bed');
    url.searchParams.set('variant', next);
    history.replaceState(null, '', url);
    setVariant(next);
  };

  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); pick(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); pick(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [variant]);

  return (
    <div className="bedProtoSwitch" role="toolbar" aria-label="网板演示方案">
      <button type="button" onClick={() => pick(-1)} aria-label="上一个方案">‹</button>
      <span>{current.name}<small>{stat}</small></span>
      {variant === 'tile' && (
        <div className="bedProtoSize" role="group" aria-label="方砖大小">
          <button type="button" onClick={() => bumpTile(-1)} disabled={tileSize <= TILE_MIN} aria-label="缩小方砖">−</button>
          <b>{tileSize} mm</b>
          <button type="button" onClick={() => bumpTile(1)} disabled={tileSize >= TILE_MAX} aria-label="放大方砖">+</button>
        </div>
      )}
      <button type="button" onClick={() => pick(1)} aria-label="下一个方案">›</button>
    </div>
  );
}
