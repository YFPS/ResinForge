/* ================================================================
   导出二进制 STL：合并模型与/或支撑顶点数据（80 字节头 + 4 字节面数 + 每面 50 字节）。
   写出前统一 Y-up → Z-up 逆变换 (x,y,z) → (x,-z,y)，与载入的 rotateX(-90°) 互逆。
   大模型导出用 part.source（聚类前的原始顶点），显示和支撑用的是简化网格。
   params.unionExport 打开时，支撑先经 manifold-3d 布尔并成一张水密外壳（见 union.js）。
================================================================ */
import * as THREE from 'three';
import { state, params, log, toast, setProgress } from '../store.js';
import { raftOn, raftMargin, RAFT_T, buildGridRaftGeom, raftAnchor, placeVertex, raiseH, ensureAutoPlateGeom } from './model.js';
import { unionShells } from './union.js';

/* 跑在 Tauri 桌面壳（打包后的 exe）里还是普通浏览器：写出方式不同（见 exportSTL 尾部） */
const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 把 mesh 的位移烘进顶点副本——布尔并要的是真实世界坐标，烘过之后写出的位移就归零 */
function bakeOffset({ arr, dx, dy, dz }) {
  if (!dx && !dy && !dz) return arr;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 3) {
    out[i] = arr[i] + dx; out[i + 1] = arr[i + 1] + dy; out[i + 2] = arr[i + 2] + dz;
  }
  return out;
}

function writeFace(dv, off, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz) || 1;
  dv.setFloat32(off, nx / nl, true); dv.setFloat32(off + 4, ny / nl, true); dv.setFloat32(off + 8, nz / nl, true); off += 12;
  dv.setFloat32(off, ax, true); dv.setFloat32(off + 4, ay, true); dv.setFloat32(off + 8, az, true); off += 12;
  dv.setFloat32(off, bx, true); dv.setFloat32(off + 4, by, true); dv.setFloat32(off + 8, bz, true); off += 12;
  dv.setFloat32(off, cx, true); dv.setFloat32(off + 4, cy, true); dv.setFloat32(off + 8, cz, true); off += 12;
  dv.setUint16(off, 0, true);
  return off + 2;
}

export async function exportSTL(includeModel, includeSupports, filename) {
  const arrays = [];
  const modelParts = [];
  if (includeModel) {
    for (const p of state.parts) {
      const pos = p.source || (p.geom && p.geom.attributes.position && p.geom.attributes.position.array);
      if (pos && pos.length >= 9) modelParts.push({ part: p, pos });
    }
  }
  if (includeSupports) {
    const supParts = [];
    if (state.mesh && params.autoPlateOn) {
      // 自动底板（按支撑投影，几何在后台线程）：单一水密实体走内核路径；规格变了这里先算好（与显示共用缓存）
      const g = await ensureAutoPlateGeom();
      if (g) {
        const nf = new Float32Array(g.tri.length * 3);
        for (let i = 0; i < g.tri.length; i++) {
          const v = g.tri[i] * 3;
          nf[i * 3] = g.vert[v]; nf[i * 3 + 1] = g.vert[v + 1]; nf[i * 3 + 2] = g.vert[v + 2];
        }
        supParts.push({ arr: nf, dx: 0, dy: 0, dz: 0, solids: [{ vert: g.vert, tri: g.tri }] });
      }
    } else if (state.mesh && params.gridRaftOn) {
      const anchor = raftAnchor();
      const g = buildGridRaftGeom();
      supParts.push({ arr: g.attributes.position.array, dx: anchor.x, dy: 0, dz: anchor.z, runs: g.userData.runs });
    } else if (state.mesh && raftOn()) {
      const bb = state.mesh.geometry.boundingBox;
      const anchor = raftAnchor();
      const rr = Math.hypot(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2 + raftMargin();
      const rg = new THREE.CylinderGeometry(rr, rr, RAFT_T, 48).toNonIndexed();
      supParts.push({ arr: rg.attributes.position.array, dx: anchor.x, dy: RAFT_T / 2, dz: anchor.z });
    }
    for (const s of state.supports) {
      const g = s.mesh.geometry;
      let a = g.attributes.position.array;
      if (g.index) a = g.toNonIndexed().attributes.position.array;
      supParts.push({ arr: a, dx: s.mesh.position.x, dy: s.mesh.position.y, dz: s.mesh.position.z, runs: g.userData.runs, solids: g.userData.solids });
    }
    /* 布尔并：把一堆「面贴面」堆叠的构件熔成一张水密外壳。
       模型不参与并集——支撑必须能撕下来，两者留在一个文件里但保持各自独立的壳。 */
    let merged = null;
    if (params.unionExport && supParts.length) {
      setProgress(0.05, '布尔并（后台线程）…');
      try {
        merged = await unionShells(supParts.map(p => ({
          // 有 solids 的（支撑塔）只交实体网格，不再复制一份显示用的非索引顶点（环面结约 23MB）
          pos: p.solids ? null : bakeOffset(p), runs: p.runs,
          // 支撑塔：每面墙 / 每段针都是闭合流形，索引网格原样交给内核（只烘位移），不拆、不焊
          solids: p.solids ? p.solids.map(sd => ({ vert: bakeOffset({ arr: sd.vert, dx: p.dx, dy: p.dy, dz: p.dz }), tri: sd.tri })) : null,
        })));
      }
      catch (e) { log(`布尔并异常（${e.message}），已按原样导出`, 'warn'); }
      if (!merged) log('布尔并未生效，导出的是构件堆叠原样', 'warn');
      setProgress(null);
    }
    if (merged) arrays.push({ arr: merged.pos, dx: 0, dy: 0, dz: 0 });
    else arrays.push(...supParts);
  }
  let count = 0;
  for (const m of modelParts) count += m.pos.length / 9;
  for (const a of arrays) count += a.arr.length / 9;
  if (!count) { toast('没有可导出的内容'); return false; }
  const buf = new ArrayBuffer(84 + count * 50);
  const dv = new DataView(buf);
  const header = 'ResinForge v0.1 auto supports';
  for (let i = 0; i < Math.min(80, header.length); i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, count, true);
  let off = 84;
  const tmp = [0, 0, 0];
  const lift = raiseH();
  for (const m of modelParts) {
    const p = m.pos;
    for (let f = 0; f < p.length; f += 9) {
      placeVertex(m.part, p[f], p[f + 1], p[f + 2], tmp);
      const ax = tmp[0], ay = -tmp[2], az = tmp[1] + lift;
      placeVertex(m.part, p[f + 3], p[f + 4], p[f + 5], tmp);
      const bx = tmp[0], by = -tmp[2], bz = tmp[1] + lift;
      placeVertex(m.part, p[f + 6], p[f + 7], p[f + 8], tmp);
      off = writeFace(dv, off, ax, ay, az, bx, by, bz, tmp[0], -tmp[2], tmp[1] + lift);
    }
  }
  for (const a of arrays) {
    const p = a.arr;
    for (let f = 0; f < p.length; f += 9) {
      const ax = p[f] + a.dx, ay = -(p[f + 2] + a.dz), az = p[f + 1] + a.dy;
      const bx = p[f + 3] + a.dx, by = -(p[f + 5] + a.dz), bz = p[f + 4] + a.dy;
      const cx = p[f + 6] + a.dx, cy = -(p[f + 8] + a.dz), cz = p[f + 7] + a.dy;
      off = writeFace(dv, off, ax, ay, az, bx, by, bz, cx, cy, cz);
    }
  }
  /* 写出：桌面版（Tauri）用系统保存对话框 + 写文件——WebView2 里 a[download] 不会保存文件；
     浏览器版照旧触发下载。dialog 的 save() 会把选中的路径自动加进 fs scope（插件内置行为），
     所以 writeFile 只需要 fs:allow-write-file 权限（capabilities/default.json）。
     两个插件动态 import：浏览器版不打进主包，也不在非 Tauri 环境执行。 */
  const name = filename || 'export.stl';
  if (IS_TAURI) {
    try {
      const [{ save }, { writeFile }] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
      ]);
      const path = await save({ title: '导出 STL', defaultPath: name, filters: [{ name: 'STL 模型', extensions: ['stl'] }] });
      if (!path) { log('导出已取消：没有选择保存位置'); return false; }
      await writeFile(path, new Uint8Array(buf));
      log(`已导出 ${name}（${count.toLocaleString()} 三角形，已回转换 Z-up）→ ${path}`, 'ok');
      return true;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      toast(`导出失败：${msg}`);
      log(`导出失败：${msg}`, 'warn');
      return false;
    }
  }
  const blob = new Blob([buf], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a');
  el.href = url; el.download = name; el.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  log(`已导出 ${name}（${count.toLocaleString()} 三角形，已回转换 Z-up）`, 'ok');
  return true;
}
