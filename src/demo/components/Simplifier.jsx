/* 简化表单：方式（保真度 / 面数比）+ 同一条弹性滑杆 + 简化按钮。demo 的模型步骤面板与 studio 的工具栏浮层共用。 */
import { useState } from 'react';
import { Rabbit, Snail } from 'lucide-react';
import Button from '@/components/arc/button/button';
import { ElasticSlider } from '@/components/arc/elastic-slider/elastic-slider';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { useBusLatest } from '../bridge.js';
import { doSimplify } from '../actions.js';
import { runTask, useUI } from '../ui.js';
import { Choice } from './fields.jsx';

/* 横条里的两种简化方式：交给 Arc 分段控件，选中块会滑过去 */
const SIMP_MODES = [
  { value: 'fidelity', label: '保真度' },
  { value: 'ratio', label: '面数比' },
];

/* 整数是常用档，拖到附近会卡住；1 / 5 / 10 标出来，其余只作刻度 */
const FIDELITY_MARKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(value =>
  value === 1 || value === 5 || value === 10 ? { value, label: String(value) } : value,
);
/* 面数比走同一条滑杆。只在 25 / 50 / 75 落档，避免每一个百分点都把拇指吸住。 */
const RATIO_MARKS = [25, 50, 75].map(value => ({ value, label: String(value) }));

export default function Simplifier({ compact = false }) {
  const info = useBusLatest('modelInfo', null);
  const { busy } = useUI();
  const [simpMode, setSimpMode] = useState('fidelity');
  const [fidelity, setFidelity] = useState(5);
  const [ratioPct, setRatioPct] = useState(50);
  const simpIds = info
    ? ((info.selectedIds && info.selectedIds.length) ? info.selectedIds : (info.activeId ? [info.activeId] : []))
    : [];
  const beforeNf = info && info.parts
    ? info.parts.filter(p => simpIds.includes(p.id)).reduce((s, p) => s + (p.nf || 0), 0)
    : 0;
  const afterNf = Math.round(beforeNf * ratioPct / 100);
  const fidelityMode = simpMode === 'fidelity';
  const faceText = n => Math.round(n).toLocaleString('zh-CN');
  const faceLabel = info ? '当前面数' : '还没有模型';
  const blocked = !info || beforeNf < 8 || !!busy;
  const run = () => runTask('simplify', () => doSimplify(
    fidelityMode ? { mode: 'fidelity', fidelity } : { mode: 'ratio', ratio: ratioPct / 100 },
  ));

  /* 工作室里点工具栏「简化」：一条横条，滑杆在中间，面数和按钮在右边。 */
  if (compact) {
    return (
      <div className="simpBar">
        <span className="simpBarBrand">简化</span>
        <SegmentedControl
          className="simpBarSeg"
          options={SIMP_MODES}
          value={simpMode}
          onValueChange={setSimpMode}
          label="简化方式"
        />
        <ElasticSlider
          key={simpMode}
          className="simpBarSlider"
          label={fidelityMode ? '保真度' : '保留比例'}
          min={1}
          max={fidelityMode ? 10 : 99.99}
          step={0.01}
          largeStep={fidelityMode ? 1 : 10}
          value={fidelityMode ? fidelity : ratioPct}
          format={fidelityMode ? (v => v.toFixed(2)) : (v => `${v.toFixed(2)}%`)}
          marks={fidelityMode ? FIDELITY_MARKS : RATIO_MARKS}
          startIcon={<Snail size={18} strokeWidth={1.75} aria-label="简化多" />}
          endIcon={<Rabbit size={18} strokeWidth={1.75} aria-label="简化少" />}
          onValueChange={fidelityMode ? setFidelity : setRatioPct}
        />
        <span className="simpBarStat tnum">{info ? `${faceText(fidelityMode ? beforeNf : afterNf)} 面` : '无模型'}</span>
        <button type="button" className="simpBarGo" disabled={blocked} onClick={run}>
          {busy === 'simplify' ? '简化中' : '简化'}
        </button>
      </div>
    );
  }

  return (
    <div className={compact ? 'simp simpCompact' : 'simp'}>
      <div className="simpHead">
        {compact || simpIds.length > 1 ? (
          <div className="simpLead">
            {compact ? <p className="simpTitle">简化</p> : null}
            {simpIds.length > 1 ? <p className="simpMeta">{simpIds.length} 个模型</p> : null}
          </div>
        ) : null}
        <div className="simpFigs">
          <p className="simpFig">
            <span className="simpFigLabel">{faceLabel}</span>
            <span className="simpFigValue tnum">{info ? faceText(beforeNf) : '无'}</span>
          </p>
          {fidelityMode ? null : (
            <p className="simpFig simpFigAfter">
              <span className="simpFigLabel">预计面数</span>
              <span className="simpFigValue tnum">{info ? faceText(afterNf) : '无'}</span>
            </p>
          )}
        </div>
      </div>
      <Choice
        ariaLabel="简化方式"
        value={simpMode}
        onChange={setSimpMode}
        options={[
          { value: 'fidelity', label: '按保真度' },
          { value: 'ratio', label: '按面数比' },
        ]}
      />
      <ElasticSlider
        key={simpMode}
        label={fidelityMode ? '保真度' : '保留比例'}
        min={1}
        max={fidelityMode ? 10 : 99.99}
        step={0.01}
        largeStep={fidelityMode ? 1 : 10}
        value={fidelityMode ? fidelity : ratioPct}
        format={fidelityMode ? (v => v.toFixed(2)) : (v => `${v.toFixed(2)}%`)}
        marks={fidelityMode ? FIDELITY_MARKS : RATIO_MARKS}
        startIcon={<Snail size={20} strokeWidth={1.75} aria-label="简化多" />}
        endIcon={<Rabbit size={20} strokeWidth={1.75} aria-label="简化少" />}
        onValueChange={fidelityMode ? setFidelity : setRatioPct}
      />
      {!compact ? (
        <p className="hint">数值越高，减得越少，表面越接近原来的样子。简化的是当前选中的模型；没有多选时，简化正在使用的这一件。简化后需要重新分析和生成支撑。</p>
      ) : null}
      <div className="simpFoot">
        <Button
          className="simpGo"
          variant="primary"
          size="md"
          loading={busy === 'simplify'}
          onClick={run}
          disabled={blocked}
        >
          简化
        </Button>
      </div>
    </div>
  );
}
