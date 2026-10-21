import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { TerminalSquare, ChevronUp } from 'lucide-react';
import { motionTokens } from '@/components/arc/motion-tokens';
import { useBus } from '../bridge.js';

/* 左下角日志：收起时只留一条最新，点击展开完整列表 */
export default function LogPanel() {
  const [logs, setLogs] = useState([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useBus('log', ({ msg, cls }) => {
    const t = new Date().toTimeString().slice(0, 8);
    setLogs(prev => {
      const next = [...prev, { t, msg, cls }];
      if (next.length > 120) next.splice(0, next.length - 120);
      return next;
    });
  });

  useEffect(() => {
    if (open && boxRef.current) boxRef.current.scrollTop = 1e9;
  }, [logs, open]);

  /* 命令面板的「打开或收起运行日志」经这个事件开合 */
  useEffect(() => {
    const toggle = () => setOpen(o => !o);
    window.addEventListener('demo:toggle-log', toggle);
    return () => window.removeEventListener('demo:toggle-log', toggle);
  }, []);

  const latest = logs[logs.length - 1];

  return (
    <div className="logWrap">
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="logPanel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: motionTokens.spring.smooth,
              opacity: { duration: motionTokens.duration.fast },
            }}
          >
            <div className="logList" ref={boxRef}>
              {logs.map((l, i) => (
                <div key={i} className={'logLine ' + (l.cls || '')}>
                  <span className="logTime">{l.t}</span>
                  {l.msg}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <button className="logToggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <TerminalSquare size={14} />
        <span className="logLatest">{open ? '运行日志' : (latest ? latest.msg : '运行日志')}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={motionTokens.spring.snappy}>
          <ChevronUp size={14} />
        </motion.span>
      </button>
    </div>
  );
}
