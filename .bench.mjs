/* M5 性能基准：通过 CDP 驱动无头 Chrome，真实时间测量 LDI vs 位图路径 */
import { spawn } from 'node:child_process';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DBG = 9223;
const APP = process.argv[2] || 'http://127.0.0.1:8111/index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DBG}`, '--no-first-run', '--no-proxy-server',
  '--enable-precise-memory-info',
  '--user-data-dir=' + process.env.LOCALAPPDATA + '/Temp/rf-cdp-profile', 'about:blank'
], { stdio: 'ignore' });

try {
  let targets = null;
  for (let i = 0; i < 60; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json(); if (targets && targets.length) break; } catch {}
    await sleep(300);
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let mid = 0;
  const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise(res => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable');
  await send('Page.navigate', { url: APP });
  // 等应用初始化（CDN 加载 three.js）
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    const r = await send('Runtime.evaluate', { expression: '!!(window.__dbg && window.state && window.state.mesh)', returnByValue: true });
    ready = r.result && r.result.result && r.result.result.value === true;
    if (!ready) await sleep(500);
  }
  if (!ready) throw new Error('app not ready');

  const expr = `(async () => {
    const T = window.THREE;
    const out = {};
    const g = new T.TorusKnotGeometry(13, 3.8, 1000, 100);
    g.scale(1.5, 1.5, 1.5);
    g.computeBoundingBox();
    const bb = g.boundingBox;
    g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    const gi = g.index ? g.toNonIndexed() : g;
    const pos = gi.attributes.position.array;
    out.tris = pos.length / 9;
    const q = new T.Quaternion();
    const mem = () => performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(0) : null;
    const opts = { gridRes: 288, layerH: 0.1, gapThresh: 0.35, detail: true, raiseH: 4, minIslArea: 0.5, minAttachArea: 1 };
    const m0 = mem();
    let t0 = performance.now();
    const A = window.__dbg.analyze(pos, q, opts);
    out.ldiMs = +(performance.now() - t0).toFixed(0);
    out.ldiIntervals = A.ld.offs[A.ld.offs.length - 1];
    out.ldiDangling = A.ld.dangling;
    out.islands = A.islands.length;
    out.graphNodes = A.graph.nodes.length;
    const m1 = mem();
    t0 = performance.now();
    const B = window.__dbg.analyze(pos, q, { ...opts, useLDI: false });
    out.bmpMs = +(performance.now() - t0).toFixed(0);
    out.bmpIslands = B.islands.length;
    const m2 = mem();
    out.memMB = { before: m0, afterLDI: m1, afterBmp: m2 };
    out.ratio = +(out.ldiMs / Math.max(1, out.bmpMs)).toFixed(2);
    const all = new Int32Array(pos.length / 9); for (let i = 0; i < all.length; i++) all[i] = i;
    t0 = performance.now();
    window.__dbg.buildLDI(pos, all, A.grid);
    out.buildLDIMs = +(performance.now() - t0).toFixed(0);
    return out;
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 240000 });
  if (r.result && r.result.exceptionDetails) console.log('PAGE EXCEPTION:', JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  else console.log(JSON.stringify((r.result && r.result.result && r.result.result.value) ?? r, null, 1));
} finally {
  chrome.kill();
}
process.exit(0);
