import React, { useEffect, useState } from 'react';
import { bus } from '../store.js';
import { resinSnapshot } from '../core/resinUsage.js';

function qty(n, unit) {
  if (!Number.isFinite(n) || n <= 0) return `0.00 ${unit}`;
  const digits = n < 0.01 ? 3 : 2;
  return `${n.toFixed(digits)} ${unit}`;
}

function LayersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 5.1 8 2.5l6 2.6L8 7.7 2 5.1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M2 8.15 8 10.75l6-2.6" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
      <path d="M2 11.15 8 13.75l6-2.6" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function CubeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.7 13.6 4.6v6.8L8 14.3 2.4 11.4V4.6L8 1.7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 8.05 13.6 4.6M8 8.05 2.4 4.6M8 8.05v6.25" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function BottleIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.3 1.6h3.4v2.1l1.7 1.7v6.3a2.1 2.1 0 0 1-2.1 2.1H6.7a2.1 2.1 0 0 1-2.1-2.1V5.4l1.7-1.7V1.6Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M6.3 3.7h3.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

/* 画布左下角：总层数、固化体积、按 1.3 g/mL 换算的树脂克数。不挡点击。 */
export default function ResinHud() {
  const [s, setS] = useState(() => resinSnapshot());
  useEffect(() => {
    const pull = () => setS(resinSnapshot());
    const offs = ['modelInfo', 'supStats', 'displayMesh', 'raft', 'lift'].map(ev => bus.on(ev, pull));
    const offP = bus.on('param', k => { if (k === 'layerH' || k === 'raiseH') pull(); });
    pull();
    return () => { offs.forEach(fn => fn()); offP(); };
  }, []);
  const layers = s.layers == null ? '--' : s.layers.toLocaleString('zh-CN');
  const volume = qty(s.ml, 'mL');
  const mass = qty(s.grams, 'g');
  const label = s.layers == null
    ? '还没有模型'
    : `总层数 ${layers}，总体积 ${volume}（模型 ${qty(s.modelMl, 'mL')}，支撑 ${qty(s.supportMl, 'mL')}），按 ${s.density} 克每毫升预估 ${mass}。只计固化体积，不含挂液`;
  return (
    <div className="stuResin" role="status" aria-label={label}>
      <span className="stuResinRow"><LayersIcon />总层数: <b className="tnum">{layers}</b></span>
      <span className="stuResinRow"><CubeIcon />总体积: <b className="tnum">{volume}</b></span>
      <span className="stuResinRow"><BottleIcon />树脂用量预估: <b className="tnum">{mass}</b></span>
    </div>
  );
}
