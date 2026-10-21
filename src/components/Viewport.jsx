import React, { useEffect, useRef, useState } from 'react';
import { Radio, Slider, Tooltip, Message } from '@arco-design/web-react';
import { bus } from '../store.js';
import { initScene, setMode, setSupportHotkeys } from '../core/scene.js';
import { setLayerCanvas, drawLayer } from '../core/inspect.js';

const RadioGroup = Radio.Group;

const MODES = [
  { value: 'orbit', label: '🖱 旋转', tip: '单击选中模型。已选中的模型上按住左键拖动是在板面上移动；从空白处拖出框线可框选。Delete 删除选中的模型。Ctrl+Z 撤回，Ctrl+Shift+Z 或 Ctrl+Y 重做。中键拖动平移视角，右键拖动旋转。只选中一个时，右键点在模型上可沿坐标轴移动、旋转或放大缩小' },
  { value: 'paint', label: '🖌 保护面', tip: '左键在模型表面涂保护面。中键拖动平移视角，右键拖动旋转' },
  { value: 'add', label: '添加支撑', tip: '左键点击模型表面手动加支撑。鼠标停在模型上会显示高度线，也就是当前这一层的截面。中键拖动平移视角，右键拖动旋转' },
  { value: 'del', label: '删除支撑', tip: '按 D 进入删除支撑。点支撑杆或支撑点选中，变成洋红色，按 Del 删除。拖出框线可以多选。点一下只选中一个时，再按 D 删除这一个。按 A 进入添加支撑。中键拖动平移视角，右键拖动旋转' },
  { value: 'poly', label: '⌇ 多线段', tip: '在模型上逐点单击画折线，双击或按回车沿折线按支撑间距加支撑。Esc 放弃。中键拖动平移视角，右键拖动旋转' },
];

function ModeBar() {
  const [mode, setModeState] = useState('orbit');
  useEffect(() => bus.on('mode', setModeState), []);
  useEffect(() => { setSupportHotkeys(true); }, []);
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
      <div className={'drop-hint' + (dropHint ? ' show' : '')}>松开以载入模型</div>
      <ModeBar />
      <Inspector />
      <LogPanel />
    </div>
  );
}
