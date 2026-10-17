import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Box, Droplets, Layers, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { motionTokens } from '@/components/arc/motion-tokens';
import { bus } from '../store.js';
import { resinSnapshot } from '../core/resinUsage.js';

function qty(n, unit) {
  if (!Number.isFinite(n) || n <= 0) return `0.00 ${unit}`;
  const digits = n < 0.01 ? 3 : 2;
  return `${n.toFixed(digits)} ${unit}`;
}

function Row({ icon, label, value, sub, accent }) {
  return (
    <div className={'stuSumRow' + (sub ? ' sub' : '')}>
      <span className="stuSumLabel">
        {icon ? <span className="stuSumIco" aria-hidden="true">{icon}</span> : <span className="stuSumIco" aria-hidden="true" />}
        {label}
      </span>
      <b className={'tnum' + (accent ? ' accent' : '')}>{value}</b>
    </div>
  );
}

/* 画布左下角摘要卡。默认展开；收起后变成一条竖着的矩形，只留层数和体积。
   体积只计固化树脂，不含挂液。连接底板算在支撑里，自动底板单独一行。 */
export default function ResinHud() {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(true);
  const [s, setS] = useState(() => resinSnapshot());
  const faceRef = useRef(null);
  const [size, setSize] = useState(null);
  const [settle, setSettle] = useState(false);
  useEffect(() => {
    const pull = () => setS(resinSnapshot());
    const offs = ['modelInfo', 'supStats', 'displayMesh', 'raft', 'lift'].map(ev => bus.on(ev, pull));
    const offP = bus.on('param', k => { if (k === 'layerH' || k === 'raiseH') pull(); });
    pull();
    return () => { offs.forEach(fn => fn()); offP(); };
  }, []);
  useLayoutEffect(() => {
    const el = faceRef.current;
    if (!el) return;
    const shell = el.closest('.stuResin');
    const extraW = shell ? shell.offsetWidth - shell.clientWidth : 0;
    const extraH = shell ? shell.offsetHeight - shell.clientHeight : 0;
    const next = { w: el.offsetWidth + extraW, h: el.offsetHeight + extraH };
    setSize(prev => (prev && prev.w === next.w && prev.h === next.h ? prev : next));
  }, [open, s.layers, s.ml, s.grams, s.modelMl, s.supportMl, s.raftMl]);
  useEffect(() => { if (size) setSettle(true); }, [size]);
  const fade = reduce
    ? { duration: 0 }
    : { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] };
  const layers = s.layers == null ? '--' : s.layers.toLocaleString('zh-CN');
  const volume = qty(s.ml, 'mL');
  const mass = qty(s.grams, 'g');
  const briefMl = s.layers == null ? '--' : (s.ml < 0.01 && s.ml > 0 ? s.ml.toFixed(3) : (s.ml || 0).toFixed(1));
  const label = s.layers == null
    ? '还没有模型'
    : `总层数 ${layers}，总体积 ${volume}（模型 ${qty(s.modelMl, 'mL')}，支撑 ${qty(s.supportMl, 'mL')}，底板 ${qty(s.raftMl, 'mL')}），按 ${s.density} 克每毫升预估 ${mass}。只计固化体积，不含挂液`;
  const ico = { size: 14, strokeWidth: 1.75 };
  const face = open ? (
    <>
      <header className="stuSumHead">
        <span className="stuSumTitle">摘要</span>
        <button type="button" className="stuSumFold" aria-expanded="true" aria-label="收起摘要" onClick={() => setOpen(false)}>
          <PanelLeftClose size={14} strokeWidth={1.75} />
        </button>
      </header>
      <div className="stuSumBody">
        <Row icon={<Box {...ico} />} label="体积" value={volume} />
        <Row sub label="模型" value={qty(s.modelMl, 'mL')} />
        <Row sub label="支撑" value={qty(s.supportMl, 'mL')} />
        <Row sub label="底板" value={qty(s.raftMl, 'mL')} />
        <Row icon={<Droplets {...ico} />} label="树脂用量" value={mass} accent />
        <Row icon={<Layers {...ico} />} label="层数" value={layers} />
      </div>
    </>
  ) : (
    <button type="button" className="stuResinSpine" aria-expanded="false" aria-label={`展开摘要，${layers} 层，${volume}`} onClick={() => setOpen(true)}>
      <PanelLeftOpen size={14} strokeWidth={1.75} />
      <span className="tnum">{layers}</span>
      <span>层</span>
      <span className="tnum">{briefMl}</span>
      <span>mL</span>
    </button>
  );
  return (
    <section
      className="stuResin"
      data-open={open ? '1' : '0'}
      aria-label={label}
      style={size ? {
        width: size.w,
        height: size.h,
        transition: !settle || reduce
          ? 'none'
          : 'width 0.4s cubic-bezier(0.16, 1, 0.3, 1), height 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
      } : undefined}
    >
      <motion.div
        key={open ? 'open' : 'shut'}
        ref={faceRef}
        className="stuResinFace"
        data-open={open ? '1' : '0'}
        initial={reduce ? false : { opacity: 0, filter: `blur(${motionTokens.blur.subtle}px)` }}
        animate={{ opacity: 1, filter: 'blur(0px)' }}
        transition={fade}
      >
        {face}
      </motion.div>
    </section>
  );
}
