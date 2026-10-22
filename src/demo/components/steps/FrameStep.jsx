/* 包围盒边框：顶梁 + 角立柱的笼架。主参数在外，底板打孔和加强筋收在高级设置。 */
import React from 'react';
import { Box, Download, Eraser, RefreshCw } from 'lucide-react';
import { SplitButton } from '@/components/arc/split-button/split-button';
import { params, state } from '../../../store.js';
import { FRAME_COLOR } from '../../../core/bboxFrame.js';
import { setParam, useBusLatest, useParams } from '../../bridge.js';
import {
  doBuildFrame, doClearFrame, doExportFrame, onFrameParam, setFrameVisible,
} from '../../actions.js';
import { STEPS, runTask, useDone, useUI } from '../../ui.js';
import { Choice, Grid, Num, Section, SwitchRow } from '../fields.jsx';
import { NextButton, StepPanel } from '../StepPanel.jsx';

const STEP = STEPS.find(s => s.id === 'frame');
if (params.bfArcCurve === 50) setParam('bfArcCurve', 100);
if (params.bfSupportGap == null) {
  setParam('bfSupportGap', 2);
  if (state.frame) onFrameParam();
}

const SUPPORTS = [
  { value: 'none', label: '无' },
  { value: 'y', label: 'Y型' },
  { value: 'pillar', label: '立柱' },
  { value: 'aframe', label: 'A字' },
];

const SCOPES = [
  { value: 'all', label: '全部模型' },
  { value: 'selected', label: '仅选中' },
];

function touch(setParam, key, value) {
  setParam(key, value);
  onFrameParam();
}

export default function FrameStep() {
  const [params, setParam] = useParams();
  const info = useBusLatest('modelInfo', null);
  const frame = useBusLatest('frame', state.frame);
  const done = useDone();
  const { busy } = useUI();
  const kind = params.bfSupport || 'pillar';
  const swatch = '#' + FRAME_COLOR.toString(16).padStart(6, '0');

  return (
    <StepPanel
      step={STEP}
      footer={(
        <>
          <SplitButton
            label={done.frame ? '重新生成' : '生成边框'}
            icon={done.frame ? <RefreshCw size={16} strokeWidth={1.75} /> : <Box size={16} strokeWidth={1.75} />}
            disabled={!info || !!busy}
            onClick={() => runTask('frame', doBuildFrame)}
            actions={[
              { label: '清除边框', icon: <Eraser size={16} strokeWidth={1.75} />, disabled: !frame, destructive: true, onSelect: doClearFrame },
              { label: '仅导出边框', icon: <Download size={16} strokeWidth={1.75} />, disabled: !frame, onSelect: () => runTask('export-frame', doExportFrame) },
            ]}
          />
          <NextButton from={STEP.id} emphasized={done.frame} />
        </>
      )}
    >
      <Section title="范围" help="笼架按模型加上已生成支撑和底板的世界体积往外留间距。选「仅选中」时，没选中任何模型就包住全部。">
        <Choice
          ariaLabel="边框范围"
          options={SCOPES}
          value={params.bfScope || 'all'}
          onChange={v => touch(setParam, 'bfScope', v)}
        />
      </Section>

      <Section title="边框" help="顶面四条梁，四角立柱落到平台。没有底面梁。支撑间距是边框内壁到支撑外表面的空隙，没有支撑时不生效。">
        <Grid stack>
          <Num k="bfBeam" label="边框宽度" min={0.4} max={12} step={0.1} unit="mm" onChange={onFrameParam} />
          <Num k="bfOffset" label="水平间距" min={0} max={30} step={0.5} unit="mm" onChange={onFrameParam} />
          <Num k="bfSupportGap" label="支撑间距" min={0} max={30} step={0.5} unit="mm" onChange={onFrameParam} />
          <Num k="bfTop" label="顶部高出" min={0} max={40} step={0.5} unit="mm" onChange={onFrameParam} />
        </Grid>
      </Section>

      <Section title="支撑" help="沿四条顶边往下接。无：只有四角立柱。Y 型：主干加两根分叉。立柱：边上再加直柱。A 字：两脚汇到一点再接到顶梁。">
        <Choice
          ariaLabel="边框支撑类型"
          options={SUPPORTS}
          value={kind}
          onChange={v => touch(setParam, 'bfSupport', v)}
        />
        {kind === 'y' ? (
          <Grid>
            <Num k="bfYHeight" label="分叉高度" min={4} max={60} step={1} unit="mm" onChange={onFrameParam} />
            <Num k="bfYSpacing" label="支撑间距" min={8} max={80} step={1} unit="mm" onChange={onFrameParam} />
          </Grid>
        ) : null}
        {kind === 'pillar' ? (
          <Grid stack>
            <Num k="bfPillarSpacing" label="立柱间距" min={6} max={80} step={1} unit="mm" onChange={onFrameParam} />
            <Num k="bfPillarW" label="立柱宽度" min={0.4} max={12} step={0.1} unit="mm" onChange={onFrameParam} />
            <Num k="bfPillarD" label="立柱高度" min={0.4} max={12} step={0.1} unit="mm" onChange={onFrameParam} />
          </Grid>
        ) : null}
        {kind === 'aframe' ? (
          <Grid stack>
            <Num k="bfASpacing" label="A字间距" min={8} max={80} step={1} unit="mm" onChange={onFrameParam} />
            <Num k="bfABase" label="底部宽度" min={4} max={60} step={1} unit="mm" onChange={onFrameParam} />
            <Num k="bfAConverge" label="汇聚高度" min={4} max={80} step={1} unit="mm" onChange={onFrameParam} />
          </Grid>
        ) : null}
      </Section>

      <Section title="显示">
        <SwitchRow
          label="显示边框"
          desc="藏起来仍保留几何，导出照旧可以带上"
          checked={params.bfVisible !== false}
          onChange={v => { setParam('bfVisible', v); setFrameVisible(v); }}
        />
        <SwitchRow
          label="跟随模型"
          desc="模型移动，或支撑重新生成之后，按新体积重算"
          checked={params.bfFollow !== false}
          onChange={v => setParam('bfFollow', v)}
        />
        {frame ? (
          <dl className="summary">
            <div><dt>外形</dt><dd className="tnum">{frame.sizeText}</dd></div>
            <div><dt>体积</dt><dd>{frame.wrappedSupports ? '模型 + 支撑' : '仅模型'}</dd></div>
            <div><dt>三角面</dt><dd className="tnum">{frame.triangles.toLocaleString('zh-CN')}</dd></div>
            <div><dt>立柱</dt><dd className="tnum">{frame.pillars}{frame.inner ? ` + 内部 ${frame.inner}` : ''}</dd></div>
          </dl>
        ) : null}
        <div className="legend">
          <span><i style={{ background: swatch }} />包围盒边框</span>
        </div>
      </Section>

      <details className="adv">
        <summary>高级设置</summary>

        {kind === 'y' ? (
          <Section title="Y 型加强" help="相邻 Y 之间、单根内部、分叉到角、主干到角，可以分开开。">
            <SwitchRow label="相邻 Y 之间" checked={!!params.bfYBetween} onChange={v => touch(setParam, 'bfYBetween', v)} />
            <SwitchRow label="单根内部" checked={!!params.bfYWithin} onChange={v => touch(setParam, 'bfYWithin', v)} />
            <SwitchRow label="分叉到角立柱" checked={!!params.bfYBranch} onChange={v => touch(setParam, 'bfYBranch', v)} />
            <SwitchRow label="主干到角立柱" checked={!!params.bfYTrunk} onChange={v => touch(setParam, 'bfYTrunk', v)} />
            <Grid>
              <Num k="bfReinfSpacing" label="加强间距" min={2} max={30} step={0.5} unit="mm" onChange={onFrameParam} />
              <Num k="bfReinfLayers" label="最大层数" min={1} max={12} step={1} unit="层" onChange={onFrameParam} />
              <Num k="bfReinfRatio" label="宽度系数" min={0.3} max={1.4} step={0.05} onChange={onFrameParam} />
            </Grid>
          </Section>
        ) : null}

        {kind === 'pillar' ? (
          <Section title="立柱加强">
            <SwitchRow
              label="边与边之间加强"
              desc="含四角立柱，按层生成"
              checked={!!params.bfReinf}
              onChange={v => touch(setParam, 'bfReinf', v)}
            />
            {params.bfReinf ? (
              <>
                <Choice
                  ariaLabel="立柱加强类型"
                  options={[{ value: 'x', label: 'X型' }, { value: 'rice', label: '米字' }]}
                  value={params.bfReinfType === 'rice' ? 'rice' : 'x'}
                  onChange={v => touch(setParam, 'bfReinfType', v)}
                />
                <Grid>
                  <Num k="bfReinfLayers" label="层数" min={1} max={12} step={1} unit="层" onChange={onFrameParam} />
                  <Num k="bfReinfRatio" label="宽度系数" min={0.3} max={1.4} step={0.05} onChange={onFrameParam} />
                </Grid>
              </>
            ) : null}
            <SwitchRow
              label="圆弧角"
              desc="顶梁下方一段内凹填充，只在立柱模式下生成"
              checked={!!params.bfArc}
              onChange={v => touch(setParam, 'bfArc', v)}
            />
            {params.bfArc ? (
              <Grid>
                <Num k="bfArcH" label="圆弧高度" min={0} max={30} step={0.5} unit="mm" onChange={onFrameParam} />
                <Num k="bfArcCurve" label="弧度" min={0} max={100} step={5} unit="%" onChange={onFrameParam} />
              </Grid>
            ) : null}
          </Section>
        ) : null}

        {kind === 'aframe' ? (
          <Section title="A 字加强">
            <SwitchRow label="横杆" checked={!!params.bfACross} onChange={v => touch(setParam, 'bfACross', v)} />
            {params.bfACross ? (
              <Grid>
                <Num k="bfACrossRatio" label="横杆位置" min={0.15} max={0.85} step={0.05} onChange={onFrameParam} />
              </Grid>
            ) : null}
            <SwitchRow label="斜撑加强" checked={!!params.bfReinf} onChange={v => touch(setParam, 'bfReinf', v)} />
            {params.bfReinf ? (
              <>
                <Choice
                  ariaLabel="A字加强类型"
                  options={[
                    { value: 'ladder', label: '梯形' },
                    { value: 'diamond', label: '菱形' },
                    { value: 'radial', label: '辐射' },
                  ]}
                  value={['ladder', 'diamond', 'radial'].includes(params.bfReinfType) ? params.bfReinfType : 'ladder'}
                  onChange={v => touch(setParam, 'bfReinfType', v)}
                />
                <Grid>
                  <Num k="bfReinfLayers" label="层数" min={2} max={8} step={1} unit="层" onChange={onFrameParam} />
                  <Num k="bfReinfRatio" label="宽度系数" min={0.3} max={1.4} step={0.05} onChange={onFrameParam} />
                </Grid>
              </>
            ) : null}
            <SwitchRow label="接到角立柱" checked={!!params.bfAToCorner} onChange={v => touch(setParam, 'bfAToCorner', v)} />
          </Section>
        ) : null}

        <Section title="底板" help="底面贴在平台上。立柱会穿进板里一段，导出时和笼架是同一壳。">
          <SwitchRow label="生成底板" checked={!!params.bfPlate} onChange={v => touch(setParam, 'bfPlate', v)} />
          {params.bfPlate ? (
            <>
              <Grid stack>
                <Num k="bfPlateH" label="板厚" min={0.4} max={6} step={0.1} unit="mm" onChange={onFrameParam} />
                <Num k="bfPlateOffset" label="外扩" min={0} max={20} step={0.5} unit="mm" onChange={onFrameParam} />
                <Num k="bfPlateAngle" label="栅角" min={0} max={45} step={1} unit="°" onChange={onFrameParam} />
              </Grid>
              <SwitchRow label="打孔" checked={!!params.bfHoles} onChange={v => touch(setParam, 'bfHoles', v)} />
              {params.bfHoles ? (
                <>
                  <Choice
                    ariaLabel="孔形"
                    options={[{ value: 'circle', label: '圆孔' }, { value: 'square', label: '方孔' }]}
                    value={params.bfHoleShape === 'square' ? 'square' : 'circle'}
                    onChange={v => touch(setParam, 'bfHoleShape', v)}
                  />
                  <Grid>
                    <Num k="bfHoleR" label="孔半径" min={0.3} max={6} step={0.1} unit="mm" onChange={onFrameParam} />
                    <Num k="bfHoleSpacing" label="孔间距" min={1.5} max={20} step={0.5} unit="mm" onChange={onFrameParam} />
                  </Grid>
                </>
              ) : null}
            </>
          ) : null}
        </Section>
      </details>
    </StepPanel>
  );
}


