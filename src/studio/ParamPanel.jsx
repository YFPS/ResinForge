import React from 'react';
import { NextSlotContext } from '../demo/components/StepPanel.jsx';
import OrientStep from '../demo/components/steps/OrientStep.jsx';
import AnalyzeStep from '../demo/components/steps/AnalyzeStep.jsx';
import SupportStep from '../demo/components/steps/SupportStep.jsx';
import ExportStep from '../demo/components/steps/ExportStep.jsx';

/* 「模型」步骤没有右侧参数卡：打开文件在顶栏，模型列表在左侧卡片，简化 / 演示模型 / 下一步在底栏；
   再留一张「载入模型」卡只会重复顶栏的按钮，所以这一步整张卡不渲染。 */
const PANELS = { orient: OrientStep, analyze: AnalyzeStep, support: SupportStep, export: ExportStep };

/** 这一步在右侧有没有参数卡（ShellC 据此决定要不要渲染卡片容器，不留空壳） */
export const hasParamPanel = stage => Object.prototype.hasOwnProperty.call(PANELS, stage);

export default function ParamPanel({ stage }) {
  const Step = PANELS[stage];
  if (!Step) return null;
  /* 朝向的采样数在 Studio 里用不到：hideQuality 收起这一节；涂画开关与笔刷参数搬到视口工具坞（protectInToolbar）。
     这两个 prop 只对 OrientStep 生效，其余步骤忽略。 */
  return (
    <NextSlotContext.Provider value="external">
      <div className="stuWizard"><Step hideQuality protectInToolbar /></div>
    </NextSlotContext.Provider>
  );
}
