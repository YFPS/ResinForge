/* 这套界面的文案与格式化；步骤标题、说明与检查器里的一两句话集中在这里。 */

export const STEP_COPY = {
  model: {
    title: '模型',
    help: '打开 STL、OBJ 或 3MF，或先用演示模型看一遍完整流程。',
  },
  orient: {
    title: '朝向',
    help: '找一个支撑更少、孤岛更少的摆放方向。候选缩略图直接点选套用，可以跳过。',
  },
  analyze: {
    title: '逐层分析',
    help: '按层厚切片，找孤岛与悬空。支撑点的位置由这份分析决定。',
  },
  support: {
    title: '支撑',
    help: '格架塔从接触点落到平台。先选粗细，再按需微调六项；高级参数收在折叠区里。',
  },
  export: {
    title: '导出',
    help: '选底板，导出合并 STL 或仅支撑 STL，交给切片软件。',
  },
};

/** 千分位；没有值给一个不抢戏的短横 */
export const fmtInt = v => (Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');

/** 一位小数；没有值给短横 */
export const fmt1 = v => (Number.isFinite(v) ? v.toFixed(1) : '—');

export const fmt2 = v => (Number.isFinite(v) ? v.toFixed(2) : '—');

/** 演示模型的中文名（core 的名字带「(演示)」后缀，界面拆成名字） */
export function splitDemoName(name) {
  const m = /^(.*)\(演示\)$/.exec(name || '');
  return m ? { name: m[1], demo: true } : { name: name || '', demo: false };
}
