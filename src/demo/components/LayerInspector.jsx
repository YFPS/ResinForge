import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Slider } from '@/components/arc/slider/slider';
import { motionTokens } from '@/components/arc/motion-tokens';
import { useBus, useBusState } from '../bridge.js';
import { setLayerCanvas, drawLayer, getCurLayer } from '../../core/inspect.js';

/* 右下角层检查器浮层：2D canvas 由 core 绘制（setLayerCanvas 交出元素引用），这里只做外壳 */
export default function LayerInspector() {
  const [show, setShow] = useState(false);
  const [layers, setLayers] = useState(100);
  const [layer, setLayer] = useState(1);
  const label = useBusState('layerLabel', '');
  const canvasRef = useRef(null);

  /* canvas 随浮层挂载/卸载，元素引用同步给 core。
     core 在分析结束时已经绘制过一次（那时 canvas 还没挂载），所以拿到引用后要补画当前层。 */
  useEffect(() => {
    if (!show) return undefined;
    setLayerCanvas(canvasRef.current);
    drawLayer(getCurLayer());
    return () => setLayerCanvas(null);
  }, [show]);

  useBus('inspector', ({ show: next, layers: total, firstIsland }) => {
    setShow(next);
    if (next) { setLayers(total); setLayer(firstIsland); }
  });

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="inspector"
          initial={{ opacity: 0, y: 12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ ...motionTokens.spring.smooth, opacity: { duration: motionTokens.duration.fast } }}
        >
          <div className="inspHead">
            <span>层检查器</span>
            <span className="inspLegend">红=孤岛 · 蓝=本层 · 暗青=下层残影</span>
          </div>
          <canvas ref={canvasRef} width={256} height={256} className="layerCanvas" />
          <Slider
            label="层"
            min={1}
            max={layers}
            step={1}
            value={layer}
            format={v => `${v} / ${layers}`}
            onValueChange={v => { setLayer(v); drawLayer(v); }}
          />
          <div className="layerLabel tnum">{label}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
