import React, { useEffect, useRef, useState } from 'react';
import { Radio, Slider, Tooltip, Message } from '@arco-design/web-react';
import { bus } from '../store.js';
import { initScene, setMode } from '../core/scene.js';
import { setLayerCanvas, drawLayer } from '../core/inspect.js';

const RadioGroup = Radio.Group;

const MODES = [
  { value: 'orbit', label: '🖱 旋转', tip: '左键 / 中键拖动旋转视角，按住右键拖动平移视角，滚轮缩放' },
  { value: 'paint', label: '🖌 保护面', tip: '左键在模型表面涂保护面；按住右键拖动平移视角，中键拖动旋转' },
  { value: 'add', label: '➕ 加支撑', tip: '左键点击模型表面手动加支撑；按住右键拖动平移视角，中键拖动旋转' },
  { value: 'del', label: '✂ 删支撑', tip: '左键点击支撑删除；按住右键拖动平移视角，中键拖动旋转' },
];

function ModeBar() {
  const [mode, setModeState] = useState('orbit');
  useEffect(() => bus.on('mode', setModeState), []);
  return (
    <div className="mode-bar">
      <RadioGroup
        type="button" value={mode}
        onChange={m => setMode(m)}
        options={MODES.map(m => ({
          value: m.value,
          label: <Tooltip content={m.tip}><span>{m.label}</span></Tooltip>,
        }))}
      />
    </div>
  );
}

function LogPanel() {
  const [logs, setLogs] = useState([]);
  const boxRef = useRef(null);
  useEffect(() => bus.on('log', ({ msg, cls }) => {
    const t = new Date().toTimeString().slice(0, 8);
    setLogs(prev => {
      const next = [...prev, { t, msg, cls }];
      if (next.length > 120) next.splice(0, next.length - 120);   // 同旧代码：最多保留 120 条
      return next;
    });
  }), []);
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = 1e9;   // 自动滚底
  }, [logs]);
  return (
    <div className="log-panel" ref={boxRef}>
      {logs.map((l, i) => (
        <div key={i} className={l.cls || ''}><span className="t">[{l.t}]</span>{l.msg}</div>
      ))}
    </div>
  );
}

function Inspector() {
  const [show, setShow] = useState(false);
  const [layers, setLayers] = useState(100);
  const [layer, setLayer] = useState(1);
  const [label, setLabel] = useState('');
  const canvasRef = useRef(null);
  /* canvas 元素引用交给 core 的 drawLayer（canvas 绘制保留在 core） */
  useEffect(() => {
    setLayerCanvas(canvasRef.current);
    return () => setLayerCanvas(null);
  }, []);
  useEffect(() => bus.on('inspector', ({ show, layers, firstIsland }) => {
    setShow(show);
    if (show) { setLayers(layers); setLayer(firstIsland); }
  }), []);
  useEffect(() => bus.on('layerLabel', setLabel), []);
  return (
    <div className="inspector" style={{ display: show ? 'block' : 'none' }}>
      <h4>层检查器 · 红=孤岛（脚下无料）· 蓝=本层 · 暗青=下层残影</h4>
      <canvas ref={canvasRef} width={256} height={256} className="layer-canvas" />
      <Slider
        min={1} max={layers} value={layer}
        onChange={v => { setLayer(v); drawLayer(v); }}
      />
      <div className="layer-label">{label}</div>
    </div>
  );
}

export default function Viewport() {
  const canvasRef = useRef(null);
  const [dropHint, setDropHint] = useState(false);
  useEffect(() => {
    initScene(canvasRef.current);   // 无 StrictMode，只执行一次
  }, []);
  useEffect(() => bus.on('dropHint', setDropHint), []);
  useEffect(() => bus.on('toast', msg => {
    Message.info({ content: msg, duration: 2200 });   // 同旧 toast：2.2s 消失
  }), []);
  return (
    <div className="viewport">
      <canvas ref={canvasRef} className="gl" />
      <div className={'drop-hint' + (dropHint ? ' show' : '')}>松开以载入 STL 文件</div>
      <ModeBar />
      <Inspector />
      <LogPanel />
    </div>
  );
}
