import React, { useEffect, useState } from 'react';
import { readPerf } from '../core/scene.js';

function memText(bytes) {
  if (!bytes) return '—';
  const mb = bytes / (1024 * 1024);
  return (mb >= 100 ? Math.round(mb) : mb.toFixed(1)) + ' MB';
}

/* 画布左上角：FPS、JS 堆、渲染循环占用的主线程比例。半秒刷一次，不挡点击。 */
export default function PerfHud() {
  const [s, setS] = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const p = readPerf();
      if (p.ready) setS({ fps: p.fps, cpu: p.cpu, mem: p.mem });
      timer = setTimeout(tick, 500);
    };
    let timer = setTimeout(tick, 400);
    return () => { alive = false; clearTimeout(timer); };
  }, []);
  return (
    <div className="stuPerf" role="status" aria-label="性能">
      <span>FPS</span>
      <b className="tnum">{s ? s.fps : '—'}</b>
      <span>内存</span>
      <b className="tnum">{s ? memText(s.mem) : '—'}</b>
      <span>CPU</span>
      <b className="tnum">{s ? s.cpu + '%' : '—'}</b>
    </div>
  );
}
