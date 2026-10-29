/* 几何后台线程：manifold-3d 的支撑塔实体化、支撑点布点、导出布尔并与画线切割都在这里算，主线程只收发数据，界面不卡。
   常驻：WASM 只在第一次任务时编译一次；任务由 geomClient.js 排队，一次只算一个。
   消息：{ id, op: 'solidify' | 'union' | 'layout' | 'autoplate' | 'cut', payload } → { id, ok, result | error }；结果里的类型数组整块转交（零拷贝） */
import { loadManifold, solidifySpec, unionParts, layoutPoints, buildAutoPlate } from './manifoldKit.js';
import { cutByPlane } from './cutKit.js';
import { decodeSpec } from './geomCodec.js';

let MF = null;

self.onmessage = async (e) => {
  const { id, op, payload } = e.data || {};
  try {
    if (!MF) MF = await loadManifold();
    if (op === 'solidify') {
      const r = solidifySpec(MF, decodeSpec(payload));
      if (!r) { self.postMessage({ id, ok: true, result: null }); return; }
      const transfer = [r.pos.buffer, r.nrm.buffer];
      for (const p of r.parts) transfer.push(p.vert.buffer, p.tri.buffer);
      self.postMessage({ id, ok: true, result: r }, transfer);
    } else if (op === 'layout') {
      const r = layoutPoints(MF, payload.charts, payload.opts);
      self.postMessage({ id, ok: true, result: r }, r.map(a => a.buffer));
    } else if (op === 'union') {
      const r = unionParts(MF, payload.parts);
      self.postMessage({ id, ok: true, result: r }, r && r.pos ? [r.pos.buffer] : []);
    } else if (op === 'autoplate') {
      const r = buildAutoPlate(MF, payload);
      self.postMessage({ id, ok: true, result: r }, r ? [r.vert.buffer, r.tri.buffer] : []);
    } else if (op === 'cut') {
      // 切不开是正常结果（不是异常）：result.ok === false，由调用方按 code / reason 提示
      const r = cutByPlane(MF, payload);
      self.postMessage({ id, ok: true, result: r }, r.ok ? [r.upper.pos.buffer, r.lower.pos.buffer] : []);
    } else {
      throw new Error('未知的几何任务：' + op);
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
