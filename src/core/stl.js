/* ================================================================
   导出二进制 STL：合并模型与/或支撑顶点数据（80 字节头 + 4 字节面数 + 每面 50 字节）。
   写出前统一 Y-up → Z-up 逆变换 (x,y,z) → (x,-z,y)，与载入的 rotateX(-90°) 互逆。
================================================================ */
import * as THREE from 'three';
import { state, params, log, toast } from '../store.js';
import { raftOn, raftMargin, RAFT_T, buildGridRaftGeom } from './model.js';

export function exportSTL(includeModel, includeSupports, filename) {
  const arrays = [];
  if (includeModel && state.mesh) arrays.push({ arr: state.mesh.geometry.attributes.position.array, dx: 0, dy: state.mesh.position.y, dz: 0 });
  if (includeSupports) {
    // 底板：网格底板（多孔梁格）或实心筏层，与场景显示一致
    if (state.mesh && params.gridRaftOn) {
      arrays.push({ arr: buildGridRaftGeom().attributes.position.array, dx: 0, dy: 0, dz: 0 });
    } else if (state.mesh && raftOn()) {
      const bb = state.mesh.geometry.boundingBox;
      const rr = Math.hypot(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2 + raftMargin();
      const rg = new THREE.CylinderGeometry(rr, rr, RAFT_T, 48).toNonIndexed();
      arrays.push({ arr: rg.attributes.position.array, dx: 0, dy: RAFT_T / 2, dz: 0 });
    }
    for (const s of state.supports) {
      let a = s.mesh.geometry.attributes.position.array;
      if (s.mesh.geometry.index) a = s.mesh.geometry.toNonIndexed().attributes.position.array;
      arrays.push({ arr: a, dx: s.mesh.position.x, dy: s.mesh.position.y, dz: s.mesh.position.z });
    }
  }
  let count = 0;
  for (const a of arrays) count += a.arr.length / 9;
  if (!count) return toast('没有可导出的内容');
  const buf = new ArrayBuffer(84 + count * 50);
  const dv = new DataView(buf);
  const header = 'ResinForge v0.1 auto supports';
  for (let i = 0; i < Math.min(80, header.length); i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, count, true);
  let off = 84;
  for (const a of arrays) {
    const p = a.arr;
    for (let f = 0; f < p.length; f += 9) {
      // 场景为 Y-up 世界系，写出时回转 STL 惯例 Z-up（载入时 rotateX(-90°) 的逆变换）：(x,y,z) → (x,-z,y)
      const ax = p[f] + a.dx, ay = -(p[f + 2] + a.dz), az = p[f + 1] + a.dy;
      const bx = p[f + 3] + a.dx, by = -(p[f + 5] + a.dz), bz = p[f + 4] + a.dy;
      const cx = p[f + 6] + a.dx, cy = -(p[f + 8] + a.dz), cz = p[f + 7] + a.dy;
      let ux = bx - ax, uy = by - ay, uz = bz - az;
      let vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(off, nx / nl, true); dv.setFloat32(off + 4, ny / nl, true); dv.setFloat32(off + 8, nz / nl, true); off += 12;
      dv.setFloat32(off, ax, true); dv.setFloat32(off + 4, ay, true); dv.setFloat32(off + 8, az, true); off += 12;
      dv.setFloat32(off, bx, true); dv.setFloat32(off + 4, by, true); dv.setFloat32(off + 8, bz, true); off += 12;
      dv.setFloat32(off, cx, true); dv.setFloat32(off + 4, cy, true); dv.setFloat32(off + 8, cz, true); off += 12;
      dv.setUint16(off, 0, true); off += 2;
    }
  }
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  log(`已导出 ${filename}（${count.toLocaleString()} 三角形，已回转换 Z-up）`, 'ok');
}
