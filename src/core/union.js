/* ================================================================
   导出前布尔并（主线程侧）
   ----------------------------------------------------------------
   支撑结构由许多闭合构件互相穿插 / 贴面组成（塔：每面墙一块挤出板 + 针与转接块凸包；树：药丸、锥台……），
   导出前把它们布尔并成一张水密外壳，切片软件不必自己判并集。
   实际计算在几何后台线程（geomClient → geom.worker → manifoldKit.unionParts），主线程只发数据、收结果、记日志，
   导出期间界面照常响应。实测环面结支撑塔约 5 秒（旧版几千个贴面零件要 45 秒）。
================================================================ */
import { log } from '../store.js';
import { unionAsync } from './geomClient.js';

/**
 * parts: [{ pos?: Float32Array 世界系非索引三角形, runs?: [[起,止], ...], solids?: [{ vert, tri }] }]
 *   solids：生成侧给出的闭合流形（支撑塔）——直接按索引网格建 Manifold，不拆、不焊；有 solids 时不必再给 pos
 * 返回 { pos, nTri, shells, outShells, tinyShells, skipped, ms }；失败时返回 null（调用方按原样导出）
 */
export async function unionShells(parts) {
  const r = await unionAsync(parts);
  if (!r) return null;
  if (r.failed) { log(`布尔并失败（${r.failed}），已按原样导出`, 'warn'); return null; }
  if (typeof window !== 'undefined') window.__rejected = r.rejected;   // [DEBUG] 被内核拒收的构件（定位生成端问题用）
  log(`布尔并（后台线程）：${r.inParts.toLocaleString()} 个构件（${r.accepted.toLocaleString()} 个被内核接受）→ `
    + `${r.nTri.toLocaleString()} 三角形（原 ${r.inTris.toLocaleString()}），外壳 ${r.outShells}${r.tinyShells ? `（碎壳 ${r.tinyShells}）` : ''}${r.slivers ? `，收掉零体积碎片 ${r.slivers} 个` : ''}、genus ${r.genus}、体积 ${r.volume.toFixed(1)}mm³；`
    + `内核 ${r.msKernel.toFixed(0)}ms、取回 ${r.msFetch.toFixed(0)}ms、合计 ${r.ms.toFixed(0)}ms`
    + (r.skipped ? `；${r.skipped.toLocaleString()} 面内核拒收，原样保留` : ''), 'ok');
  if (r.rejected.length) {
    const show = r.rejected.slice(0, 8).map(x => `${x.tris}面@[${x.lo.join(',')}]×[${x.hi.join(',')}](${x.why})`).join('；');
    log(`内核拒收明细：${r.rejected.length} 个构件——${show}`, 'warn');
  }
  return { pos: r.pos, nTri: r.nTri, shells: r.inParts, outShells: r.outShells, tinyShells: r.tinyShells, slivers: r.slivers || 0, skipped: r.skipped, ms: r.ms };
}
