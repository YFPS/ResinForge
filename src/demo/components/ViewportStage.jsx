import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { UploadCloud } from 'lucide-react';
import { initScene } from '../../core/scene.js';
import { useBusState } from '../bridge.js';
import ModeBar from './ModeBar.jsx';
import StatsCard from './StatsCard.jsx';
import LayerInspector from './LayerInspector.jsx';
import LogPanel from './LogPanel.jsx';

/* 3D 视口：canvas 交给 core 的 initScene（内部建 renderer / controls / rAF 循环并载入演示模型），
   这里只负责容器尺寸与浮层。流程操作在侧栏底部，视口里只留看图要用的东西。 */
export default function ViewportStage() {
  const boxRef = useRef(null);
  const canvasRef = useRef(null);
  const dropHint = useBusState('dropHint', false);

  useEffect(() => {
    initScene(canvasRef.current);
  }, []);

  /* core 只监听 window 的 resize；侧栏开合会改变视口宽度而窗口不变，
     这里观察容器尺寸，每帧至多补发一次 resize，让渲染器跟着侧栏的动画走 */
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; window.dispatchEvent(new Event('resize')); });
    });
    ro.observe(box);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, []);

  return (
    <div className="viewport" ref={boxRef}>
      <canvas ref={canvasRef} className="gl" />
      <ModeBar />
      {/* 右侧浮层列：统计卡贴顶、层检查器贴底，避免互相重叠 */}
      <div className="rightRack">
        <StatsCard />
        <LayerInspector />
      </div>
      <LogPanel />
      <AnimatePresence>
        {dropHint && (
          <motion.div
            className="dropOverlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
          >
            <div className="dropInner">
              <UploadCloud size={30} />
              <span>松开以载入 STL 文件</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
