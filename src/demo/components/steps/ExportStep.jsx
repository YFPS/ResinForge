/* 第 5 步 · 导出：底板三选一 → 尺寸 → 导出内容核对 → 导出（模型 + 支撑 / 仅支撑）。
   导出成功在按钮上原地确认（「已导出」），不靠 toast。 */
import React, { useEffect, useRef, useState } from 'react';
import { Check, Download, Layers } from 'lucide-react';
import { SplitButton } from '@/components/arc/split-button/split-button';
import { RadioCards } from '@/components/arc/radio-cards/radio-cards';
import Button from '@/components/arc/button/button';
import { state } from '../../../store.js';
import { supMat, supMatAnchor } from '../../../core/scene.js';
import { handleRaftMarginChange, updateRaft } from '../../../core/model.js';
import { useBusLatest, useBusValue, useParams } from '../../bridge.js';
import { currentBaseType, doExport, setBaseType, splitModelName } from '../../actions.js';
import { STEPS, goStep, useUI } from '../../ui.js';
import { Grid, Num, Section } from '../fields.jsx';
import { StepPanel } from '../StepPanel.jsx';

const STEP = STEPS[4];

const BASES = [
  { value: 'none', label: '无底板', description: '支撑直接落在打印平台上' },
  { value: 'raft', label: '实心筏层', description: '1.2mm 厚的圆板托住全部支撑' },
  { value: 'grid', label: '网格底板', description: '带孔的板，树脂可以从孔里流走' },
];

/* 图例颜色直接取 3D 场景里支撑的材质色，保证与视口一致 */
const swatch = mat => '#' + mat.color.getHexString();

export default function ExportStep() {
  const [, setParam] = useParams();
  const info = useBusLatest('modelInfo', null);
  const points = useBusValue(['supStats', 'sliceStats', 'modelInfo'], () => (state.supportPoints || []).length);
  const { busy } = useUI();
  const baseType = currentBaseType();
  const [justExported, setJustExported] = useState('');
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const exportNow = includeModel => {
    doExport(includeModel);
    setJustExported(includeModel ? 'all' : 'sup');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setJustExported(''), 2400);
  };

  const { name } = splitModelName(info && info.name);
  const baseLabel = BASES.find(b => b.value === baseType).label;

  return (
    <StepPanel
      step={STEP}
      footer={(
        <SplitButton
          label={justExported ? '已导出' : '导出模型和支撑'}
          icon={justExported ? <Check size={16} strokeWidth={1.75} /> : <Download size={16} strokeWidth={1.75} />}
          disabled={!info || !!busy}
          onClick={() => exportNow(true)}
          actions={[
            { label: '仅导出支撑', icon: <Layers size={16} strokeWidth={1.75} />, disabled: !points && baseType === 'none', onSelect: () => exportNow(false) },
          ]}
        />
      )}
    >
      <Section title="底板">
        <RadioCards
          aria-label="底板类型"
          layout="list"
          value={baseType}
          onValueChange={v => setBaseType(v, setParam)}
          options={BASES}
        />
      </Section>

      {baseType !== 'none' ? (
        <Section title="底板尺寸">
          <Grid>
            <Num k="raftMargin" label="外接边距" min={1} max={10} step={0.5} unit="mm" onChange={handleRaftMarginChange} />
            {baseType === 'grid' ? (
              <>
                <Num k="gridT" label="板厚" min={0.4} max={2} step={0.1} unit="mm" onChange={updateRaft} />
                <Num k="gridBar" label="梁宽" min={0.3} max={2} step={0.1} unit="mm" onChange={updateRaft} />
                <Num k="gridStep" label="孔距" min={1.5} max={8} step={0.5} unit="mm" onChange={updateRaft} />
              </>
            ) : null}
          </Grid>
        </Section>
      ) : null}

      <Section title="导出内容">
        <dl className="summary">
          <div><dt>模型</dt><dd title={name}>{name || '未载入'}</dd></div>
          <div>
            <dt>支撑</dt>
            <dd className="tnum">
              {points ? `${points.toLocaleString('zh-CN')} 个支撑点` : (
                <span className="summaryEmpty">
                  还没有支撑
                  <Button variant="ghost" size="sm" onClick={() => goStep('support')}>去生成</Button>
                </span>
              )}
            </dd>
          </div>
          <div><dt>底板</dt><dd>{baseLabel}</dd></div>
        </dl>
        <div className="legend">
          <span><i style={{ background: swatch(supMat) }} />落到平台的支撑</span>
          <span><i style={{ background: swatch(supMatAnchor) }} />锚在模型上的短小支撑</span>
        </div>
        <p className="hint">STL 已转成 Z 轴朝上，可以直接放进 CHITUBOX 或 Lychee。</p>
      </Section>
    </StepPanel>
  );
}
