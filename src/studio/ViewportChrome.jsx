import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Pause, Play } from 'lucide-react';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { state } from '../store.js';
import { setOrthographic, setSlicePreview, sliceMeshSpan } from '../core/scene.js';
import { drawLayer } from '../core/inspect.js';
import { useBus, useBusLatest } from '../demo/bridge.js';

const VIEW = [
  { value: 'perspective', label: '透视' },
  { value: 'ortho', label: '正交' },
];

export function HeaderViewControls() {
  const [ortho, setOrtho] = useState(false);
  useBus('projection', mode => setOrtho(mode === 'ortho'));
  return (
    <SegmentedControl
      className="stuViewSwitch"
      label="投影"
      options={VIEW}
      value={ortho ? 'ortho' : 'perspective'}
      onValueChange={v => {
        const on = v === 'ortho';
        setOrtho(on);
        setOrthographic(on);
      }}
    />
  );
}

function spanOf() {
  const A = state.analysis;
  if (A && A.grid && A.grid.layers > 0) {
    const g = A.grid;
    return {
      kind: 'layer',
      max: g.layers,
      yOf(v) { return g.minY + v * g.layerH; },
    };
  }
  const span = sliceMeshSpan();
  if (!span || span.y1 - span.y0 < 0.4) return null;
  return { kind: 'height', max: 1000, y0: span.y0, y1: span.y1 };
}

export default function SliceRail() {
  const info = useBusLatest('modelInfo', null);
  const slice = useBusLatest('sliceStats', null);
  const [level, setLevel] = useState(null);
  const [playing, setPlaying] = useState(false);
  const levelRef = useRef(null);
  const timer = useRef(0);
  const span = info ? spanOf() : null;
  const top = span ? span.max : 0;
  const value = !span || level == null ? top : level;
  const atTop = value >= top;

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = 0;
    setPlaying(false);
  };

  useEffect(() => () => { stop(); setSlicePreview(null); }, []);
  useEffect(() => {
    stop();
    levelRef.current = null;
    setLevel(null);
    setSlicePreview(null);
  }, [info && info.name, slice && slice.layers]);
  useBus('history', () => {
    stop();
    levelRef.current = null;
    setLevel(null);
    setSlicePreview(null);
  });

  if (!span) return null;

  const apply = v => {
    const now = spanOf();
    if (!now) return;
    const next = Math.max(0, Math.min(now.max, Math.round(v)));
    levelRef.current = next;
    setLevel(next);
    if (next >= now.max) {
      setSlicePreview(null);
      return;
    }
    if (now.kind === 'layer') {
      const layer = Math.max(1, next);
      setSlicePreview(now.yOf(layer));
      drawLayer(layer);
      return;
    }
    setSlicePreview(now.y0 + (now.y1 - now.y0) * (next / now.max));
  };
  const shown = span.kind === 'layer' ? Math.max(1, Math.round(atTop ? span.max : value)) : value;
  const mm = span.kind === 'layer'
    ? span.yOf(shown)
    : span.y0 + (span.y1 - span.y0) * ((atTop ? span.max : value) / span.max);
  const step = n => apply((atTop ? span.max : value) + n);

  const scrub = e => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = 1 - (e.clientY - r.top) / Math.max(1, r.height);
    apply(Math.min(1, Math.max(0, t)) * span.max);
  };

  const togglePlay = () => {
    if (playing) { stop(); return; }
    setPlaying(true);
    if (atTop) apply(span.kind === 'layer' ? 1 : 0);
    timer.current = setInterval(() => {
      const now = spanOf();
      if (!now) { stop(); return; }
      const cur = levelRef.current == null ? 0 : levelRef.current;
      const jump = now.kind === 'layer' ? 1 : Math.max(1, Math.round(now.max / 80));
      if (cur + jump >= now.max) { apply(now.max); stop(); return; }
      apply(cur + jump);
    }, 45);
  };

  return (
    <div className="stuSlice">
      <div className="stuSliceRead">
        <label className="stuSliceNum">
          <input
            inputMode="numeric"
            aria-label={span.kind === 'layer' ? '层号' : '高度'}
            value={span.kind === 'layer' ? shown : mm.toFixed(2)}
            onChange={e => {
              const n = Number(e.target.value);
              if (!Number.isFinite(n)) return;
              apply(span.kind === 'layer' ? n : (n - span.y0) / Math.max(0.001, span.y1 - span.y0) * span.max);
            }}
          />
          <span className="stuSliceSpin">
            <button type="button" aria-label="上一层" onClick={() => step(1)}><ChevronUp size={10} /></button>
            <button type="button" aria-label="下一层" onClick={() => step(-1)}><ChevronDown size={10} /></button>
          </span>
        </label>
        <span className="stuSliceMm">{mm.toFixed(2)} mm</span>
      </div>
      <div
        className="stuSliceTrack"
        onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); scrub(e); }}
        onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) scrub(e); }}
      >
        <span className="stuSliceLine" />
        <span className="stuSliceThumb" style={{ bottom: `${(value / span.max) * 100}%` }} />
      </div>
      <button type="button" className="stuSlicePlay" aria-label={playing ? '暂停' : '播放切片'} aria-pressed={playing} onClick={togglePlay}>
        {playing ? <Pause size={12} /> : <Play size={12} />}
      </button>
    </div>
  );
}
