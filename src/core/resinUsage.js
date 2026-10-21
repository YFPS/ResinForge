/* 树脂用量：模型 + 支撑（含连接底板 / 自动底板）的固化体积 × 密度。
   体积用网格有符号体积（散度定理），平移和旋转不改变结果。
   支撑在视口里是多块闭合实体拼在一起，格架「+」柱和针根埋进柱的交叉会被加多次，
   所以支撑体积略高于导出时布尔并之后的并集体积。针尖扎进模型的那一小段同样算了两次。
   密度 1.3 g/mL（2026-10-17 指定）。这里只计固化下去的树脂，不含平台和模型表面的挂液。 */
import { state, params } from '../store.js';
import { raftObject } from './model.js';

export const RESIN_DENSITY = 1.3;

const volCache = new WeakMap();

/** 三角形网格的有符号体积（mm³）。index 缺省时按非索引三角形顺序读。 */
export function signedVolumeMm3(pos, index) {
  if (!pos || pos.length < 9) return 0;
  const n = index ? index.length : pos.length / 3;
  let v = 0;
  for (let i = 0; i < n; i += 3) {
    const ia = (index ? index[i] : i) * 3;
    const ib = (index ? index[i + 1] : i + 1) * 3;
    const ic = (index ? index[i + 2] : i + 2) * 3;
    const ax = pos[ia], ay = pos[ia + 1], az = pos[ia + 2];
    const bx = pos[ib], by = pos[ib + 1], bz = pos[ib + 2];
    const cx = pos[ic], cy = pos[ic + 1], cz = pos[ic + 2];
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

function geometryVolume(geom) {
  if (!geom || !geom.attributes || !geom.attributes.position) return 0;
  const hit = volCache.get(geom);
  if (hit !== undefined) return hit;
  const index = geom.index ? geom.index.array : null;
  const v = Math.abs(signedVolumeMm3(geom.attributes.position.array, index));
  volCache.set(geom, v);
  return v;
}

/* 包围盒八个角经过世界矩阵后的最高点。层数从平台顶面 y=0 算到这里。 */
function meshTopY(mesh) {
  const geom = mesh.geometry;
  if (!geom.boundingBox) geom.computeBoundingBox();
  const b = geom.boundingBox;
  if (!b) return 0;
  mesh.updateMatrixWorld();
  const m = mesh.matrixWorld.elements;
  let top = 0;
  for (const x of [b.min.x, b.max.x]) {
    for (const y of [b.min.y, b.max.y]) {
      for (const z of [b.min.z, b.max.z]) {
        const wy = m[4] * x + m[5] * y + m[6] * z + m[13];
        if (wy > top) top = wy;
      }
    }
  }
  return top;
}

/**
 * 当前画面的用量。
 * layers 没有模型时为 null。体积单位 mm³，毫升 = mm³ / 1000。
 * supportMl 含落板支撑、短小支撑和连接底板。自动底板单独记在 raftMl。
 */
export function resinSnapshot() {
  const layerH = params.layerH > 0 ? params.layerH : 0.05;
  let top = 0;
  let modelMm3 = 0;
  let supportMm3 = 0;
  let raftMm3 = 0;
  if (state.mesh) {
    modelMm3 = geometryVolume(state.mesh.geometry);
    top = Math.max(top, meshTopY(state.mesh));
  }
  for (const s of state.supports || []) {
    if (!s.mesh || !s.mesh.geometry) continue;
    supportMm3 += geometryVolume(s.mesh.geometry);
    top = Math.max(top, meshTopY(s.mesh));
  }
  const raft = raftObject();
  if (raft && raft.geometry) {
    raftMm3 = geometryVolume(raft.geometry);
    top = Math.max(top, meshTopY(raft));
  }
  const mm3 = modelMm3 + supportMm3 + raftMm3;
  const ml = mm3 / 1000;
  const layers = state.mesh ? Math.max(1, Math.ceil((top - 1e-4) / layerH)) : null;
  return {
    layers,
    ml,
    grams: ml * RESIN_DENSITY,
    modelMl: modelMm3 / 1000,
    supportMl: supportMm3 / 1000,
    raftMl: raftMm3 / 1000,
    points: (state.supportPoints || []).length,
    density: RESIN_DENSITY,
  };
}
