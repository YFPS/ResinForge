/* 步骤面板骨架：标题与说明 → 可滚动的参数区 → 固定在底部的操作区。
   操作区始终是「这一步的主操作 + 下一步」：主操作恒为主按钮（做完后文案变成「重新…」）；
   「下一步」平时是幽灵按钮，这一步做完后加上描边，提示可以往下走（不强制，顶栏随时可跳到任意一步）。 */
import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowRight, Check } from 'lucide-react';
import Badge from '@/components/arc/badge/badge';
import Button from '@/components/arc/button/button';
import { Progress } from '@/components/arc/progress/progress';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import { motionTokens } from '@/components/arc/motion-tokens';
import { useBusLatest } from '../bridge.js';
import { STEPS, goStep, stepIndex, useDone } from '../ui.js';

export function StepPanel({ step, footer, children }) {
  const done = useDone();
  return (
    <div className="stepPanelInner">
      <header className="stepHead">
        <div className="stepHeadRow">
          <h2 className="stepTitle">{step.title}</h2>
          {done[step.id] ? <Badge tone="success" size="sm" icon={<Check size={12} strokeWidth={2} />}>已完成</Badge> : null}
        </div>
        <p className="stepDesc">{step.desc}</p>
      </header>
      {/* 边缘渐隐只在那一侧确有被遮住的内容时出现（Arc ScrollArea 按溢出量计算），滚动时提示上下还有参数 */}
      <ScrollArea className="stepScroll" viewportClassName="stepViewport" fade={20}>
        <div className="stepBody">{children}</div>
      </ScrollArea>
      <StepFooter>{footer}</StepFooter>
    </div>
  );
}

/** 底部操作区；长任务进行中在按钮上方显示 core 报告的进度 */
function StepFooter({ children }) {
  const progress = useBusLatest('progress', null);
  const reduced = useReducedMotion();
  const show = !!progress && progress.p != null;
  return (
    <footer className="stepFoot">
      <AnimatePresence initial={false}>
        {show && (
          <motion.div
            key="progress"
            className="footProgress"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { duration: motionTokens.duration.exit, ease: [...motionTokens.ease.exit] } }}
            transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}
          >
            <div className="footProgressInner">
              <Progress value={Math.round(progress.p * 100)} label={progress.text || '处理中'} showValue />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="footRow">{children}</div>
    </footer>
  );
}

/** 「下一步」：这一步完成后由幽灵按钮变为描边按钮 */
export function NextButton({ from, emphasized }) {
  const next = STEPS[stepIndex(from) + 1];
  if (!next) return null;
  return (
    <Button variant={emphasized ? 'secondary' : 'ghost'} size="md" onClick={() => goStep(next.id)}>
      下一步：{next.label}
      <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
    </Button>
  );
}
