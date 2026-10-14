/* ================================================================
   自动底板（按支撑投影自动生成）——框架无关，core 层，不 import React
   ----------------------------------------------------------------
   算法对照 3DPrintProject/3d 的 js/base-plate-creator.js（用户 2026-10-14 指定的参考实现）：
   - 尺寸：支撑投影外接矩形（支撑点的 XZ 包围盒；无支撑点时回退模型包围盒）+ 每侧外扩 apOffset
   - 轮廓：矩形，或四角切角八边形（apCorner / apCornerLen，切角不超过半边长）
   - 孔：蜂窝六边形阵（外接圆半径 apHoleR、孔壁厚 apWall；水平间距 = √3·r + 壁厚，
     垂直间距 = 1.5·r + 0.75·壁厚，奇行偏移半间距——与参考公式一致），孔心 ±r 必须完全落在
     「轮廓 − 2 × 边框宽」内；有效区放不下任何孔时退回实心板
   - 栅角：底面轮廓 = 顶面轮廓等距内缩 apHeight × tan(apChamferAngle)，侧壁成斜面
   几何在几何后台线程里算（manifoldKit.buildAutoPlate，经 geomClient.autoPlateAsync）；
   轮廓 / 孔在规格里是**相对底板中心**的 XZ 点列，中心 cx / cz 单独给（生成时平移）。
================================================================ */
import { state, params } from '../store.js';

const num = (v, d) => (Number.isFinite(v) ? v : d);

/** 支撑投影外接矩形 + 外扩（mm）：支撑点的 XZ 包围盒；没有支撑点时回退模型包围盒。返回 {cx, cz, w, d} 或 null */
export function autoPlateRect() {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of state.supportPoints || []) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  if (x0 === Infinity) {
    const bb = state.mesh && state.mesh.geometry && state.mesh.geometry.boundingBox;
    if (!bb) return null;
    x0 = bb.min.x; x1 = bb.max.x; z0 = bb.min.z; z1 = bb.max.z;
  }
  const off = Math.max(0, num(params.apOffset, 5));
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, w: Math.max(1, x1 - x0 + 2 * off), d: Math.max(1, z1 - z0 + 2 * off) };
}

/** 顶面轮廓多边形（相对底板中心的 XZ 点列）：矩形或四角切角八边形（对照参考 createChamferedRectShape） */
export function plateOutline(w, d, cornerOn, cornerLen) {
  const x = w / 2, y = d / 2;
  const c = cornerOn ? Math.max(0, Math.min(cornerLen, Math.min(w, d) / 2 - 0.05)) : 0;
  return c > 0.05
    ? [[x, -y + c], [x, y - c], [x - c, y], [-x + c, y], [-x, y - c], [-x, -y + c], [-x + c, -y], [x - c, -y]]
    : [[x, -y], [x, y], [-x, y], [-x, -y]];
}

/** 蜂窝孔（相对中心的六边形点列数组，与参考 createHoneycombHoles 的间距与过滤一致）；放不下返回 [] */
export function honeycombHoles(w, d, holeR, wall, border) {
  const innerW = w - 2 * border, innerD = d - 2 * border;
  if (innerW < 2 * holeR + wall || innerD < 2 * holeR + wall) return [];
  const sx = holeR * Math.sqrt(3) + wall;            // 水平：对边距 + 壁厚
  const sz = holeR * 1.5 + wall * 0.75;              // 垂直：0.75 × 高 + 0.75 × 壁厚
  const cols = Math.max(1, Math.floor(innerW / sx) + 1);
  const rows = Math.max(1, Math.floor(innerD / sz) + 1);
  const out = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const offX = (row % 2 === 0) ? 0 : sx / 2;
      const px = -innerW / 2 + col * sx + offX;
      const pz = -innerD / 2 + row * sz;
      if (px - holeR < -innerW / 2 || px + holeR > innerW / 2) continue;   // 六边形必须完全在有效区内
      if (pz - holeR < -innerD / 2 || pz + holeR > innerD / 2) continue;
      const poly = [];
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (Math.PI / 3) * i;      // 顶点朝上（同参考）
        poly.push([px + holeR * Math.cos(a), pz + holeR * Math.sin(a)]);
      }
      out.push(poly);
    }
  }
  return out;
}

/** 当前自动底板的完整规格（纯数据；轮廓 / 孔已算好，worker 直接用）。没有模型与支撑点时返回 null */
export function autoPlateSpec() {
  const r = autoPlateRect();
  if (!r) return null;
  const t = Math.max(0.4, num(params.apHeight, 2));
  const ang = Math.max(0, Math.min(60, num(params.apChamferAngle, 15))) * Math.PI / 180;
  const border = Math.max(0, num(params.apBorder, 2.5));
  const holeR = Math.max(0.5, num(params.apHoleR, 8.66));
  const cornerOn = !!params.apCorner;
  const cornerLen = Math.max(0, num(params.apCornerLen, 5));
  return {
    cx: r.cx, cz: r.cz, w: r.w, d: r.d, t,
    border, holeR,
    wall: Math.max(0.2, num(params.apWall, 1.5)),
    chamferW: params.apChamfer ? Math.max(0, t * Math.tan(ang)) : 0,
    corner: cornerOn, cornerLen,
    outline: plateOutline(r.w, r.d, cornerOn, cornerLen),
    holes: honeycombHoles(r.w, r.d, holeR, Math.max(0.2, num(params.apWall, 1.5)), border),
  };
}

/** 规格指纹：参数 / 投影没变（1e-3 内）就不重算几何（轮廓与孔由它们唯一决定，不参与指纹） */
export function plateFingerprint(s) {
  if (!s) return '';
  return [s.cx, s.cz, s.w, s.d, s.t, s.border, s.holeR, s.wall, s.chamferW, s.corner ? 1 : 0, s.cornerLen]
    .map(v => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v).join('|');
}
