import React from 'react';
import { NextSlotContext } from '../demo/components/StepPanel.jsx';
import ModelStep from '../demo/components/steps/ModelStep.jsx';
import OrientStep from '../demo/components/steps/OrientStep.jsx';
import AnalyzeStep from '../demo/components/steps/AnalyzeStep.jsx';
import SupportStep from '../demo/components/steps/SupportStep.jsx';
import ExportStep from '../demo/components/steps/ExportStep.jsx';

const PANELS = { model: ModelStep, orient: OrientStep, analyze: AnalyzeStep, support: SupportStep, export: ExportStep };

export default function ParamPanel({ stage }) {
  const Step = PANELS[stage];
  /* 模型概况与列表在左侧浮层卡片、简化在底部工具栏，右边参数面板不再重复显示（两个 prop 只对 ModelStep 生效）；
     「下一步」也不在这一栏，改由视口底栏的 StageNext 独立承担 */
  return (
    <NextSlotContext.Provider value="external">
      <div className="stuWizard"><Step hideCurrentModel hideSimplify /></div>
    </NextSlotContext.Provider>
  );
}
