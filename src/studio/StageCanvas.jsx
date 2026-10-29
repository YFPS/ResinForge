import React, { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { UploadCloud } from 'lucide-react';
import { initScene } from '../core/scene.js';
import { useBusState } from '../demo/bridge.js';
import SliceRail from './ViewportChrome.jsx';

export default function StageCanvas() {
  const canvasRef = useRef(null);
  const dropHint = useBusState('dropHint', false);

  useEffect(() => {
    initScene(canvasRef.current);
  }, []);

  return (
    <div className="stuStage">
      <canvas ref={canvasRef} className="gl" />
      <SliceRail />
      <AnimatePresence>
        {dropHint && (
          <motion.div className="dropOverlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
            <div className="dropInner">
              <UploadCloud size={30} />
              <span>松开以载入模型</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
