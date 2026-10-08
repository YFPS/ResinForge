import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import AnimatedCounter from '@/components/arc/animated-counter/animated-counter';
import Badge from '@/components/arc/badge/badge';
import { motionTokens } from '@/components/arc/motion-tokens';
import { useBusState } from '../bridge.js';

/* 右上角统计卡：分析结果 + 支撑统计；数字用 animated-counter 滚动 */
export default function StatsCard() {
  const slice = useBusState('sliceStats', null);
  const sup = useBusState('supStats', null);
  const empty = !slice;

  return (
    <div className="statsCard">
      <AnimatePresence mode="wait" initial={false}>
        {empty ? (
          <motion.div
            key="empty"
            className="statsEmpty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: motionTokens.duration.fast }}
          >
            运行「分析」查看孤岛与悬空统计
          </motion.div>
        ) : (
          <motion.div
            key="stats"
            className="statsGrid"
            initial={{ opacity: 0, y: 6, filter: `blur(${motionTokens.blur.subtle}px)` }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -6, filter: `blur(${motionTokens.blur.subtle}px)` }}
            transition={{
              y: motionTokens.spring.smooth,
              opacity: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] },
              filter: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] },
            }}
          >
            <AnimatedCounter value={slice.layers} label="总层数" />
            <AnimatedCounter value={slice.islandCount} label="孤岛" />
            <AnimatedCounter value={slice.totIslandArea} decimals={1} suffix="mm²" label="孤岛面积" />
            <AnimatedCounter value={slice.maxFill} decimals={1} suffix="mm²" label="最大截面" />
            {sup && sup.points !== undefined && (
              <AnimatedCounter value={sup.points} label="支撑点" />
            )}
            {sup && sup.ok !== undefined && (
              <AnimatedCounter value={sup.ok} label="已生成结构" />
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {slice && slice.islandCount > 0 && (
        <Badge tone="warning" size="sm" className="statsBadge">
          {slice.islandCount} 处孤岛待支撑
        </Badge>
      )}
    </div>
  );
}
