/* 侧栏：当前步骤的参数面板。五个面板是顶栏流程导航（Arc Tabs）的 TabsContent，
   切换时由 Arc Tabs 按前进 / 后退方向滑入。侧栏可收起：宽度走 spring.smooth，收起后内容 inert。 */
import React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { TabsContent } from '@/components/arc/tabs/tabs';
import { motionTokens } from '@/components/arc/motion-tokens';
import { useNarrow, useUI } from '../ui.js';
import ModelStep from './steps/ModelStep.jsx';
import OrientStep from './steps/OrientStep.jsx';
import AnalyzeStep from './steps/AnalyzeStep.jsx';
import SupportStep from './steps/SupportStep.jsx';
import ExportStep from './steps/ExportStep.jsx';

/* 面板 360 + 与视口之间 12 的槽（滚动条不贴视口）；收起时只留这条槽。
   窄屏下侧栏浮在画布上（demo.css），收起即完全隐藏，展开不超过屏宽。 */
const SIDEBAR_W = 372;
const GUTTER = 12;

const PANELS = [
  ['model', ModelStep],
  ['orient', OrientStep],
  ['analyze', AnalyzeStep],
  ['support', SupportStep],
  ['export', ExportStep],
];

export default function Sidebar() {
  const { sidebarOpen } = useUI();
  const narrow = useNarrow();
  const reduced = useReducedMotion();
  const openW = narrow ? Math.min(SIDEBAR_W, window.innerWidth - 16) : SIDEBAR_W;
  return (
    <motion.aside
      className="sidebar"
      aria-label="步骤参数"
      initial={false}
      animate={{ width: sidebarOpen ? openW : narrow ? 0 : GUTTER }}
      transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}
    >
      <motion.div
        className="sidebarInner"
        inert={sidebarOpen ? undefined : ''}
        initial={false}
        animate={{ opacity: sidebarOpen ? 1 : 0 }}
        transition={{ duration: sidebarOpen ? motionTokens.duration.standard : motionTokens.duration.exit }}
      >
        {PANELS.map(([id, Panel]) => (
          <TabsContent key={id} value={id} className="stepPanel">
            <Panel />
          </TabsContent>
        ))}
      </motion.div>
    </motion.aside>
  );
}
