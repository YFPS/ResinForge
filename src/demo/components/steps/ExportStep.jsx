/* 第 5 步 · 导出：底板二选一（连接底板 / 自动底板）→ 导出内容核对 → 导出（模型 + 支撑 / 仅支撑）。
   导出成功在按钮上原地确认（「已导出」），不靠 toast。 */
import React, { useEffect, useRef, useState } from 'react';
import { Check, Download, Layers } from 'lucide-react';
import { SplitButton } from '@/components/arc/split-button/split-button';
import { RadioCards } from '@/components/arc/radio-cards/radio-cards';
import Button from '@/components/arc/button/button';
import { state } from '../../../store.js';
import { supMat, supMatAnchor } from '../../../core/scene.js';
import { updateRaft } from '../../../core/model.js';
import { joinLiftWanted } from '../../../core/joinPlate.js';
import { useBusLatest, useBusValue, useParams } from '../../bridge.js';
import { currentBaseType, doExport, onAutoPlateThickness, setBaseChamfer, setBaseFlush, setBaseHole, setBaseType, splitModelName } from '../../actions.js';
import { STEPS, goStep, runTask, useUI } from '../../ui.js';
import { Grid, Num, Section, SwitchRow } from '../fields.jsx';
import { StepPanel } from '../StepPanel.jsx';

const STEP = STEPS[4];

const BASES = [
  { value: 'join', label: '连接底板', description: '支撑塔底部收成一条立起来的连接条，模型随之抬高一个板高' },
  { value: 'auto', label: '自动底板', description: '按支撑投影自动定尺寸：栅角 + 蜂窝孔' },
];

/* 图例颜色直接取 3D 场景里支撑的材质色，保证与视口一致 */
const swatch = mat => '#' + mat.color.getHexString();

export default function ExportStep() {
  const [params, setParam] = useParams();
  const info = useBusLatest('modelInfo', null);
  const points = useBusValue(['supStats', 'sliceStats', 'modelInfo'], () => (state.supportPoints || []).length);
  const { busy } = useUI();
  const baseType = currentBaseType();
  const [justExported, setJustExported] = useState('');
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const exportNow = includeModel => {
    runTask('export', async () => {
      await doExport(includeModel);
      setJustExported(includeModel ? 'all' : 'sup');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setJustExported(''), 2400);
    });
  };

  const { name } = splitModelName(info && info.name);
  const baseLabel = BASES.find(b => b.value === baseType).label;
  const joinH = +joinLiftWanted(params).toFixed(2);
  const bases = BASES.map(b => (b.value === 'join'
    ? { ...b, description: `支撑塔底部收成一条立起来的连接条，模型随之抬高 ${joinH} mm，支撑在板顶上面` }
    : b));

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
            { label: '仅导出支撑', icon: <Layers size={16} strokeWidth={1.75} />, disabled: !points, onSelect: () => exportNow(false) },
          ]}
        />
      )}
    >
      <Section title="底板">
        <RadioCards
          aria-label="底板类型"
          layout="list"
          value={baseType}
          onValueChange={v => runTask('base-type', () => setBaseType(v, setParam))}
          options={bases}
        />
        {/* 子类分组：连接底板的三个子选项（选中连接底板时显示） */}
        {baseType === 'join' ? (
          <div className="subRows" aria-label="连接底板选项">
            <SwitchRow
              label="栅角"
              desc="连接条贴着台面的底角斜切一小截"
              checked={!!params.baseChamfer}
              onChange={v => runTask('base-chamfer', () => setBaseChamfer(v, setParam))}
            />
            <SwitchRow
              label="去掉外伸"
              desc="交叉墙伸到外墙外面的底板收掉，外沿保持齐平"
              checked={!!params.baseFlush}
              onChange={v => runTask('base-flush', () => setBaseFlush(v, setParam))}
            />
            <SwitchRow
              label="底板开孔"
              desc="连接条上按格子打菱形孔，少用一些材料"
              checked={!!params.baseHole}
              onChange={v => runTask('base-hole', () => setBaseHole(v, setParam))}
            />
          </div>
        ) : null}
      </Section>

      {baseType === 'auto' ? (
        <Section title="自动底板" desc="板形跟随支撑投影的轮廓（向外扩一段圆角边）；孔为蜂窝六边形阵，边框保持实心；没有支撑时不生成。板厚垫在支撑下面，模型按板厚抬高，支撑从底板顶面往上生成。">
          <Grid>
            <Num k="apOffset" label="外扩距离" min={0} max={30} step={0.5} unit="mm" onChange={updateRaft} />
            <Num k="apHeight" label="板厚" min={0.4} max={10} step={0.1} unit="mm" onChange={onAutoPlateThickness} />
            <Num k="apBorder" label="边框宽" min={0} max={10} step={0.5} unit="mm" onChange={updateRaft} />
            <Num k="apHoleR" label="蜂窝孔径" min={1} max={20} step={0.5} unit="mm" onChange={updateRaft} />
            <Num k="apWall" label="孔壁厚" min={0.3} max={6} step={0.1} unit="mm" onChange={updateRaft} />
          </Grid>
          <SwitchRow
            label="栅角"
            desc="底面向内收缩，侧壁成斜面"
            checked={!!params.apChamfer}
            onChange={v => { setParam('apChamfer', v); updateRaft(); }}
          />
          {params.apChamfer ? (
            <Grid>
              <Num k="apChamferAngle" label="栅角角度" min={0} max={60} step={1} unit="°" onChange={updateRaft} />
            </Grid>
          ) : null}
        </Section>
      ) : null}

      <Section title="导出">
        <SwitchRow
          label="熔合成单一实体"
          desc="导出前把所有支撑构件布尔并成一张水密外壳，去掉互相穿插的内壁（可能要几秒）"
          checked={!!params.unionExport}
          onChange={v => setParam('unionExport', v)}
        />
      </Section>

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
