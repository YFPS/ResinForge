import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import AnimatedCounter from '@/components/arc/animated-counter/animated-counter';
import Badge from '@/components/arc/badge/badge';
import { motionTokens } from '@/components/arc/motion-tokens';
import { useBusState } from '../bridge.js';

/* 右上角统计卡：分析结果 + 支撑统计；数字用 animated-counter 滚动。
   还没生成支撑时，有孤岛就标「待支撑」。生成之后只报仍没被结构托住的孤岛，全部托住就收起。 */
function islandNote(slice, sup) {
  if (!slice || !(slice.islandCount > 0)) return null;
  if (!sup || sup.islOpen == null) return `${slice.islandCount} 处孤岛待支撑`;
  if (sup.islOpen <= 0) return null;
  return `${sup.islOpen} 处孤岛仍悬空`;
}

export default function StatsCard() {
  const slice = useBusState('sliceStats', null);
  const sup = useBusState('supStats', null);
  const empty = !slice;
  const note = islandNote(slice, sup);

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
      {note && (
        <Badge tone="warning" size="sm" className="statsBadge">
          {note}
        </Badge>
      )}
    </div>
  );
}
