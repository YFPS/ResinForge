/* 第 4 步 · 支撑：结构 → 手动编辑 → 布点 → 接触 → 结构细节，主操作是带变体菜单的「生成支撑」。
   结构参数按功能分组（格架 / 柱与展宽 / 十字针 / 基础带），全部可见、不藏在「高级」里——分组本身就让长列表好扫读。 */
import React from 'react';
import { Crosshair, Eraser, RefreshCw, ShieldAlert, Sparkles } from 'lucide-react';
import { SplitButton } from '@/components/arc/split-button/split-button';
import { state } from '../../../store.js';
import { setMode } from '../../../core/scene.js';
import { handleRaiseHChange } from '../../../core/model.js';
import { SUPPORT_TEMPLATES, getSupportTemplate } from '../../../core/supportTemplates.js';
import { joinLiftWanted } from '../../../core/joinPlate.js';
import { useBusLatest, useBusValue, useParams } from '../../bridge.js';
import { activeSupportTemplate, applySupportTemplate, doClearSupports, doGenSupports, doRebuild, doTogglePoints, focusModel, splitModelName } from '../../actions.js';
import { STEPS, runTask, useDone, useUI } from '../../ui.js';
import { Choice, Grid, Num, Section, SwitchRow } from '../fields.jsx';
import { NextButton, StepPanel } from '../StepPanel.jsx';

const STEP = STEPS[3];

const EDIT_MODES = [
  { value: 'orbit', label: '浏览' },
  { value: 'add', label: '加点' },
  { value: 'del', label: '删点' },
];

const TIP_MODES = [
  { value: 'normal', label: '沿法线' },
  { value: 'vertical', label: '竖直' },
  { value: 'fixed', label: '固定角度' },
];

const TEMPLATE_OPTIONS = SUPPORT_TEMPLATES.map(t => ({ value: t.id, label: t.name }));

/* 支撑模板：按支撑粗细一键套用一组工艺参数。
   选中即套用，选项显示的就是当前生效的模板（参数与某套模板完全一致才点亮，手动改过任一项则都不点亮）——
   「重新生成」与套用用的是同一套参数。旧实现的选项只是面板里的本地状态：选了「粗」不点「套用」就点「重新生成」，
   生成的仍是上一次的参数，面板却显示粗档的数值；切换步骤回来选项又回到「细」，与实际参数无关 */
function TemplatePicker() {
  const [params, setParam] = useParams();
  const active = activeSupportTemplate(params);
  const tpl = getSupportTemplate(active);
  return (
    <Section title="模板" desc="按支撑粗细套用一组工艺参数，选中即生效；已有支撑时按新参数重新布点（手动加的点保留）并生成结构。不改动模型抬高（标准 4 mm）与临界角（标准 45°）。">
      <Choice
        label="支撑粗细"
        options={TEMPLATE_OPTIONS}
        value={active || ''}
        onChange={id => { if (id !== active) runTask('sup-tpl', () => applySupportTemplate(id, setParam)); }}
      />
      <p className="hint">
        {tpl
          ? `当前生效：支撑杆直径 ${tpl.diameter} mm · 接触宽 ${tpl.tipW} mm · 支撑间距 ${tpl.spacing} mm · 格宽 ${tpl.cell} mm · ${tpl.source}（切片层厚在分析步骤设置）`
          : '当前参数不属于任何模板（默认值，或套用后手动改过某项）。点选一档即按该模板写入参数。'}
      </p>
    </Section>
  );
}

function TowerParams() {
  const [params, setParam] = useParams();
  return (
    <>
      <Section title="格架" desc="正交墙上的斜边在竖杆处折返，孔为三角形。">
        <Grid>
          <Num k="esCell" label="格宽" min={1.5} max={8} step={0.5} unit="mm" />
          <Num k="esDiamAngle" label="斜边角" min={25} max={80} step={5} unit="°" />
          <Num k="esBarW" label="边宽" min={0.15} max={2} step={0.05} unit="mm" />
          <Num k="esBarT" label="边厚" min={0.15} max={1.5} step={0.05} unit="mm" />
        </Grid>
        <SwitchRow
          label="墙内竖杆"
          desc="墙上每半格加一根竖杆，更结实"
          checked={params.esMidBars}
          onChange={v => setParam('esMidBars', v)}
        />
      </Section>
      <Section title="柱与展宽" desc="每下降一个柱高向外展宽一格。壳层缩减决定底部孔格疏密：0 = 底部全密（细支撑），1 = 底部每柱高放大一倍（粗支撑）；套用模板时自动设定。">
        <Grid>
          <Num k="esGap" label="离模净距" min={0} max={3} step={0.1} unit="mm" />
          <Num k="esColRatio" label="柱高宽比" min={2} max={20} step={1} />
          <Num k="esHullRed" label="壳层缩减" min={0} max={3} step={1} unit="级" />
          <Num k="esTowerMaxR" label="最大展宽" min={0} max={10} step={1} unit="格" />
        </Grid>
      </Section>
      <Section title="十字针" desc="从格架节点直通接触点，末端渐缩后扎入模型。">
        <Grid>
          <Num k="esNeedleMax" label="针最大长" min={1} max={12} step={0.5} unit="mm" />
          <Num k="esConnW" label="连接宽" min={0.1} max={1.5} step={0.05} unit="mm" />
          <Num k="esNeedleT" label="针板厚" min={0.1} max={1} step={0.05} unit="mm" />
          <Num k="esTaper" label="过渡段长" min={0.2} max={3} step={0.1} unit="mm" />
          <Num k="esTipW" label="接触宽" min={0.05} max={1} step={0.05} unit="mm" />
          <Num k="esContactMargin" label="接触边距" min={0} max={2} step={0.1} unit="mm" />
          <Num k="pen" label="渗透长度" min={0} max={1} step={0.05} unit="mm" />
        </Grid>
      </Section>
      <Section title="基础带">
        <Grid>
          <Num k="esFoundH" label="基础带高" min={0} max={3} step={0.1} unit="mm" />
          <Num k="esNotchH" label="缺口高" min={0} max={2} step={0.1} unit="mm" />
        </Grid>
      </Section>
    </>
  );
}

export default function SupportStep() {
  const [params, setParam] = useParams();
  const mode = useBusLatest('mode', 'orbit');
  const info = useBusLatest('modelInfo', null);
  const pointsOnly = useBusLatest('pointsOnly', false);
  const points = useBusValue(['supStats', 'sliceStats', 'modelInfo'], () => (state.supportPoints || []).length);
  const done = useDone();
  const { busy } = useUI();
  const running = busy.startsWith('sup');

  /* 底部一行要放下 SplitButton + 「下一步：导出」（共 320px），完成态文案用短的「重新生成」，刷新图标已说明是再来一次 */
  const label = running ? '正在生成…' : done.support ? '重新生成' : '生成支撑';
  const actions = [
    { label: '只补孤岛支撑', icon: <ShieldAlert size={16} strokeWidth={1.75} />, onSelect: () => runTask('sup-isl', () => doGenSupports({ islandsOnly: true })) },
    { label: '按当前参数重建结构', icon: <RefreshCw size={16} strokeWidth={1.75} />, disabled: !points, onSelect: () => runTask('sup-rebuild', doRebuild) },
    { label: '清空支撑', icon: <Eraser size={16} strokeWidth={1.75} />, destructive: true, disabled: !points, onSelect: doClearSupports },
  ];

  return (
    <StepPanel
      step={STEP}
      footer={(
        <>
          <SplitButton
            label={label}
            icon={done.support && !running ? <RefreshCw size={16} strokeWidth={1.75} /> : <Sparkles size={16} strokeWidth={1.75} />}
            disabled={!!busy}
            onClick={() => runTask('sup-auto', () => doGenSupports())}
            actions={actions}
          />
          <NextButton from={STEP.id} emphasized={done.support} />
        </>
      )}
    >
      <Section
        title="结构"
        aside={points ? <span className="secMeta tnum">{points.toLocaleString('zh-CN')} 个支撑点</span> : null}
        desc="支撑塔：格架从平台升起，十字针从节点接到接触点。"
      >
        <p className="hint">连不上格架的支撑点依次改走：就近接格架 → 分叉（一主干两头）→ 十字短杆；仍接不上的标红、不生成结构。</p>
      </Section>

      <TemplatePicker />

      <Section title="手动编辑" desc="按 A 进入加点，点模型朝下的表面。按 D 进入删点。点支撑杆或支撑点都会选中并变成洋红，按 Del 才删除。拖出框线可以一次选中多个。点一下只选中一个时，再按 D 就删掉这一个。按住 Ctrl 再点或再框是追加。中键平移视角，右键旋转视角。">
        <Choice
          ariaLabel="手动编辑模式"
          options={EDIT_MODES}
          value={mode === 'add' || mode === 'del' ? mode : 'orbit'}
          onChange={setMode}
        />
        {info && info.parts && info.parts.length > 1 ? (
          <div className="partList" role="list" aria-label="跳到模型">
            {info.parts.map(p => (
              <button
                key={p.id}
                type="button"
                role="listitem"
                className={'partRow' + ((info.selectedIds && info.selectedIds.length ? info.selectedIds.includes(p.id) : info.focusId === p.id || info.activeId === p.id) ? ' active' : '')}
                onClick={() => focusModel(p.id)}
              >
                <Crosshair size={15} strokeWidth={1.75} aria-hidden="true" />
                <span className="partName">{splitModelName(p.name).name}</span>
                <span className="partMeta">跳转</span>
              </button>
            ))}
          </div>
        ) : null}
      </Section>

      <Section title="显示" desc="支撑点是贴在接触位置上的小球。隐藏结构后仍然可以删点。">
        <SwitchRow
          label="只显示支撑点"
          desc="收起支撑杆和格架"
          checked={!!pointsOnly}
          onChange={doTogglePoints}
        />
      </Section>

      <Section
        title="布点"
        desc="模型底面默认离平台 4mm。"
      >
        <Grid>
          <Num k="spacing" label="支撑间距" min={1} max={10} step={0.5} unit="mm" />
          <Num k="edgeInset" label="边缘距离" min={0} max={10} step={0.1} unit="mm" />
          <Num k="minSupArea" label="最小悬空面积" min={0.5} max={50} step={0.5} unit="mm²" />
          <Num k="raiseH" label="模型抬高" min={0} max={15} step={0.5} unit="mm" onChange={handleRaiseHChange} />
        </Grid>
        {joinLiftWanted(params) ? (
          <p className="hint">开着连接底板：模型再抬高一个板高 {+joinLiftWanted(params).toFixed(2)} mm，离平台共 {+(Math.max(0, params.raiseH || 0) + joinLiftWanted(params)).toFixed(2)} mm。</p>
        ) : null}
        <SwitchRow
          label="短小支撑"
          desc="竖直下方被模型挡住时，锚到另一个表面"
          checked={params.shortSup}
          onChange={v => setParam('shortSup', v)}
        />
        {params.shortSup ? (
          <p className="hint">连不上格架的点用十字短杆接到下方表面或平台（两端收到接触宽），先于「分叉 / 标红」。</p>
        ) : null}
      </Section>

      <Section title="接触">
        <Choice label="接触朝向" options={TIP_MODES} value={params.tipMode} onChange={v => setParam('tipMode', v)} />
        <Grid>
          <Num k="tipTilt" label="接触最大倾角" min={0} max={75} step={5} unit="°" />
        </Grid>
      </Section>

      <TowerParams />
    </StepPanel>
  );
}
