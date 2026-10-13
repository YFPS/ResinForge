/* ================================================================
   几何后台线程客户端（主线程侧）
   ----------------------------------------------------------------
   manifold-3d 的支撑塔实体化、支撑点布点与导出布尔并放在常驻 Worker（geom.worker.js）里算，主线程只收发数据，界面不卡。
   - 常驻一个 Worker：WASM 只编译一次；任务排队，一次算一个
   - 实体化「新的作废旧的」：还在排队、没开始算的旧实体化请求直接作废（连续加点 / 改参数时只算最后一次）；
     已经在算的那一个算完后由调用方按自己的序号丢弃
   - 请求数据按值复制（类型数组复制是整块内存拷贝，很快），不转交：Worker 中途出错时原数据还在，能改在主线程重算
   - Worker 起不来（不支持模块 Worker、加载失败）→ 退回主线程计算：结果相同，只是会卡，日志提示一次
   - 换新 Worker：emscripten 的 WASM 堆只增不减，连续处理百万面级的实体化 / 布尔并后会碎片化直到越界
     （实测环面结细模板 115 万面：同一个 Worker 做到第 12 次「实体化 + 布尔并」报 memory access out of bounds，
     之后每个任务都报 null function，刷新页面前再也生成不了支撑）。所以按本 Worker 处理过的三角形累计，超过预算就在两次任务之间
     换一个新 Worker（重新实例化 WASM，零点几秒）；任务若报 WASM 越界类错误，丢掉这个 Worker，在新 Worker 里把它重算一次
================================================================ */
import { encodeSpec, decodeSpec } from './geomCodec.js';
import { log } from '../store.js';

let worker = null;          // 常驻 Worker；null = 尚未创建
let broken = false;         // Worker 不可用 → 一律主线程
let nextId = 1;
let current = null;         // 正在算的任务
const queue = [];           // 排队的任务 { id, op, payload, resolve, reject }
let load = 0;               // 本 Worker 已处理的三角形累计（实体化输出 + 布尔并输入输出）
const LOAD_MAX = 6e6;       // 超过就换新 Worker：约为实测出错时累计量（环面结细模板约 4 千万）的七分之一
const TRAP = /memory access out of bounds|null function|unreachable|out of memory|table index|signature mismatch|Aborted|RuntimeError/i;
const loadOf = (op, r) => (!r ? 0 : op === 'solidify' ? (r.stats && r.stats.tris) || 0 : op === 'union' ? (r.inTris || 0) + (r.nTri || 0) : 0);

/** 丢掉当前 Worker（下一个任务到来时 pump 再起一个新的） */
function retire() {
  try { if (worker) worker.terminate(); } catch { /* 已结束 */ }
  worker = null;
  load = 0;
}

/** 被更新的请求取代时的错误（调用方据 aborted 安静退出） */
export function abortedError() { const e = new Error('已被更新的请求取代'); e.aborted = true; return e; }

function startWorker() {
  try {
    worker = new Worker(new URL('./geom.worker.js', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
    return false;
  }
  worker.onmessage = e => {
    const { id, ok, result, error } = e.data || {};
    if (!current || current.id !== id) return;
    const job = current;
    current = null;
    if (ok) {
      load += loadOf(job.op, result);
      if (load > LOAD_MAX) retire();
      job.resolve(result);
    } else if (TRAP.test(error || '') && !job.retried) {
      // WASM 越界 / 堆耗尽：这个实例已经坏了（之后每个任务都会报 null function），换新 Worker 把这个任务重算一次（请求数据是按值复制的，还在）
      log(`几何后台线程内存耗尽（${error}），已换新线程重算`, 'warn');
      retire();
      job.retried = true;
      queue.unshift(job);
    } else job.reject(new Error(error));
    pump();
  };
  worker.onerror = ev => { if (ev && ev.preventDefault) ev.preventDefault(); fail(); };
  worker.onmessageerror = () => fail();
  return true;
}

/** Worker 坏了：此后一律主线程；正在算的与排队的任务改在主线程重算 */
function fail() {
  if (!broken) log('几何后台线程不可用，实体化 / 布尔并改在主线程计算（结果相同，计算时界面会卡）', 'warn');
  broken = true;
  try { if (worker) worker.terminate(); } catch { /* 已结束 */ }
  worker = null;
  const jobs = (current ? [current] : []).concat(queue.splice(0));
  current = null;
  for (const job of jobs) runLocal(job).then(job.resolve, job.reject);
}

let localKit = null;
async function runLocal(job) {
  if (!localKit) {
    const kit = await import('./manifoldKit.js');
    localKit = { kit, MF: await kit.loadManifold() };
  }
  const { kit, MF } = localKit;
  if (job.op === 'solidify') return kit.solidifySpec(MF, decodeSpec(job.payload));
  if (job.op === 'layout') return kit.layoutPoints(MF, job.payload.charts, job.payload.opts);
  return kit.unionParts(MF, job.payload.parts);
}

function pump() {
  if (current || !queue.length) return;
  if (!broken && !worker && !startWorker()) { fail(); return; }
  if (broken) {
    for (const job of queue.splice(0)) runLocal(job).then(job.resolve, job.reject);
    return;
  }
  current = queue.shift();
  try {
    worker.postMessage({ id: current.id, op: current.op, payload: current.payload });
  } catch {
    fail();
  }
}

function submit(op, payload) {
  return new Promise((resolve, reject) => {
    queue.push({ id: nextId++, op, payload, resolve, reject });
    pump();
  });
}

/**
 * 支撑塔几何规格 → 实体（manifoldKit.solidifySpec 的结果：{ parts, pos, nrm, stats } 或 null）。
 * 排队中还没开始算的旧实体化请求就地作废（reject aborted）。
 */
export function solidifyAsync(spec) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].op !== 'solidify') continue;
    queue[i].reject(abortedError());
    queue.splice(i, 1);
  }
  return submit('solidify', encodeSpec(spec).data);
}

/** 导出前布尔并（manifoldKit.unionParts 的结果）；parts 里的类型数组按值复制，不影响主线程上的显示几何 */
export function unionAsync(parts) {
  return submit('union', { parts });
}

/** 支撑点布点（manifoldKit.layoutPoints：边缘环 + 内部按覆盖补点 + Lloyd 松弛）：charts 为各图块投影三角形 Float64Array，返回同序的二维点数组 */
export function layoutAsync(charts, opts) {
  return submit('layout', { charts, opts });
}

/** 调试 / 验收：后台线程状态 */
export function geomWorkerState() {
  return { mode: broken ? 'main' : (worker ? 'worker' : 'idle'), busy: current ? current.op : null, queued: queue.length, load };
}
