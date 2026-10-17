/* 第 3 步 · 分析：切片精度与悬空 / 孤岛判定 → 运行分析；热力图在这里开关。
   分析结果（层数、孤岛、截面）在视口右上角的统计卡里，层检查器随分析自动出现。 */
import React from 'react';
import { ScanLine } from 'lucide-react';
import Button from '@/components/arc/button/button';
import { setHeat } from '../../../core/heat.js';
import { useBusLatest } from '../../bridge.js';
import { doAnalyze } from '../../actions.js';
import { STEPS, runTask, useDone, useUI } from '../../ui.js';
import { Grid, Num, Section, SwitchRow } from '../fields.jsx';
import { NextButton, StepPanel } from '../StepPanel.jsx';

const STEP = STEPS[2];

export default function AnalyzeStep() {
  const heat = useBusLatest('heat', false);
  const slice = useBusLatest('sliceStats', null);
  const done = useDone();
  const { busy } = useUI();
  const running = busy === 'analyze';

  return (
    <StepPanel
      step={STEP}
      footer={(
        <>
          <Button
            variant="primary"
            size="md"
            loading={running}
            disabled={!!busy && !running}
            onClick={() => runTask('analyze', doAnalyze)}
          >
            <ScanLine size={16} strokeWidth={1.75} aria-hidden="true" />
            {done.analyze ? '重新分析' : '运行分析'}
          </Button>
          <NextButton from={STEP.id} emphasized={done.analyze} />
        </>
      )}
    >
      {slice ? (
        <div className="resultStrip tnum" role="status">
          <span><b>{slice.layers.toLocaleString('zh-CN')}</b> 层</span>
          <span className={slice.islandCount ? 'warnText' : ''}><b>{slice.islandCount}</b> 处孤岛</span>
          <span>最大截面 <b>{slice.maxFill.toFixed(1)}</b> mm²</span>
        </div>
      ) : null}

      <Section title="切片">
        <Grid>
          <Num k="layerH" label="层厚" min={0.025} max={0.3} step={0.005} unit="mm" />
          <Num k="gapThresh" label="悬空阈值" min={0.1} max={2} step={0.05} unit="mm" />
        </Grid>
      </Section>

      <Section title="悬空与孤岛" help="自支撑角也用于朝向评分、热力图和支撑的倾斜上限。">
        <Grid>
          <Num k="selfAngle" label="自支撑角" min={20} max={70} step={1} unit="°" />
          <Num k="minIslArea" label="孤岛最小面积" min={0.05} max={20} step={0.05} unit="mm²" />
          <Num k="minAttach" label="最小附着面积" min={0.05} max={20} step={0.05} unit="mm²" />
        </Grid>
      </Section>

      <Section title="显示">
        <SwitchRow
          label="支撑热力图"
          help="按需要支撑的程度给模型表面着色。"
          checked={heat}
          onChange={v => setHeat(v)}
        />
        {heat ? (
          <div className="heatLegend" aria-label="热力图图例">
            <span>弱</span>
            <div className="heatBar" />
            <span>强</span>
          </div>
        ) : null}
      </Section>
    </StepPanel>
  );
}
