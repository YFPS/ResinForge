import React, { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { RadioCards } from '@/components/arc/radio-cards/radio-cards';
import { Accordion } from '@/components/arc/accordion/accordion';
import { ChipGroup } from '@/components/arc/chip-group/chip-group';
import { state, params } from '../store.js';
import { setHeat } from '../core/heat.js';
import { setMode } from '../core/scene.js';
import { handleRaiseHChange } from '../core/model.js';
import { SUP_COLOR, SUP_ANCHOR_COLOR } from '../core/scene.js';
import { joinLiftWanted } from '../core/joinPlate.js';
import { SUPPORT_TEMPLATES, trunkLinkage } from '../core/supportTemplates.js';
import { useBusLatest, useParams } from '../demo/bridge.js';
import {
  DEMOS, activeSupportTemplate, applySupportTemplate, doApplyCandidate, doLoadDemo,
  doRebuild, doSetSupView, focusModel, pickSTL, setBaseType, splitModelName,
} from '../demo/actions.js';
import { runTask } from '../demo/ui.js';
import { ControlRow, EmptyBox, HeatScale, KV, Legend, Num, Section, SwitchRow } from './parts.jsx';
import { fmt1, fmt2, fmtInt } from './copy.jsx';

const hex = n => '#' + n.toString(16).padStart(6, '0');

/* ================================================================
   1 · 模型
   ================================================================ */
export function ModelPanel() {
  const info = useBusLatest('modelInfo', null);
  const parts = (info && info.parts) || [];
  const demoName = parts.length === 1 && parts[0].demo ? parts[0].name : null;
  const activeDemo = demoName ? (DEMOS.find(d => demoName.includes(d.label)) || {}).kind : null;

  const dims = info ? info.sizeText.replace(/mm\s*$/, '').split('×').map(s => parseFloat(s.trim())) : [];
  const [sx, sy, sz] = dims;
  const fits = Number.isFinite(sx) && sx <= params.plateX && sz <= params.plateZ && sy <= params.plateY;
  const over = Number.isFinite(sx) ? Math.max(0, sx - params.plateX, sz - params.plateZ, sy - params.plateY) : 0;
  const usage = useMemo(() => measureMesh(state.mesh), [info]);

  return (
    <>
      <Section title="演示模型" aside="内置 5 件" note="先用它把流程走一遍，换模型会清空结果。">
        <ChipGroup
          label="演示模型"
          multiple={false}
          options={DEMOS.map(d => ({ value: d.kind, label: d.label }))}
          value={activeDemo ? [activeDemo] : []}
          onValueChange={v => {
            const next = v[v.length - 1];
            if (!next || next === activeDemo) return;
            runTask('model-demo', () => doLoadDemo(next));
          }}
        />
      </Section>

      <Section title="零件" aside={parts.length ? `${parts.length} 件` : '—'}>
        {parts.length ? (
          <>
            <div className="rf-parts">
              {parts.map(p => {
                const active = (info.selectedIds && info.selectedIds.length)
                  ? info.selectedIds.includes(p.id)
                  : info.activeId === p.id || info.focusId === p.id;
                return (
                  <button key={p.id} type="button" className="rf-part" data-active={active || undefined} onClick={() => focusModel(p.id)}>
                    <span className="rf-partName">{splitModelName(p.name).name}</span>
                    <span className="rf-partMeta">{fmtInt(p.nf)} 面</span>
                    <span className="rf-partSize">{p.sx.toFixed(1)} × {p.sy.toFixed(1)} × {p.sz.toFixed(1)} mm</span>
                  </button>
                );
              })}
            </div>
            <div className="rf-inlineActions">
              <Button variant="secondary" size="sm" onClick={() => pickSTL(true)}>
                <Plus size={14} strokeWidth={1.9} aria-hidden="true" />
                追加文件…
              </Button>
              <span className="rf-secNote" style={{ margin: 0 }}>多件会重新排版到板面中央。</span>
            </div>
          </>
        ) : <EmptyBox>板上还没有模型。打开 STL，或用上面的演示模型。</EmptyBox>}
      </Section>

      <Section title="板面适配" aside={`${params.plateX} × ${params.plateZ} mm`}>
        <KV
          rows={[
            ['模型占地', info ? `${fmt1(sx)} × ${fmt1(sz)}` : '—', info ? 'mm' : ''],
            ['打印高度', info ? `${fmt1(sy)}` : '—', info ? `mm / 上限 ${params.plateY}` : ''],
          ]}
        />
        <div className="rf-fit" data-ok={fits ? 'true' : 'false'}>
          <i aria-hidden="true" />
          {info ? (fits ? '在板面与高度上限内' : `超出 ${fmt1(over)} mm，换机型或缩小模型`) : '还没有模型可以核对'}
        </div>
      </Section>

      <Section title="用料" aside="按 1.1 g/cm³ 估算">
        <KV
          rows={[
            ['体积', usage ? fmt2(usage.vol) : '—', usage ? 'cm³' : ''],
            ['表面积', usage ? fmt1(usage.area) : '—', usage ? 'cm²' : ''],
            ['树脂用量', usage ? fmt1(usage.vol * 1.1) : '—', usage ? 'g' : ''],
          ]}
        />
        <p className="rf-secNote">不含支撑与底板；最终用量以切片软件为准。</p>
      </Section>
    </>
  );
}

/* 从合并网格的顶点位置直接量体积与表面积：闭合网格的有符号四面体体积，取绝对值。 */
function measureMesh(mesh) {
  if (!mesh || !mesh.geometry) return null;
  const pos = mesh.geometry.attributes && mesh.geometry.attributes.position;
  if (!pos) return null;
  const p = pos.array;
  let vol = 0;
  let area = 0;
  for (let i = 0; i + 8 < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
    const cx = p[i + 6], cy = p[i + 7], cz = p[i + 8];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    area += Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
  }
  return { vol: Math.abs(vol) / 1000, area: area / 100 };
}

/* ================================================================
   2 · 朝向
   ================================================================ */
export function OrientPanel() {
  const [p, setParam] = useParams();
  const items = useBusLatest('orientResults', null) || [];
  const mode = useBusLatest('mode', 'orbit');

  return (
    <>
      <Section title="采样" aside="越多越准">
        <SegmentedControl
          label="采样数"
          options={[{ value: '32', label: '快速 32' }, { value: '64', label: '标准 64' }, { value: '128', label: '精细 128' }]}
          value={String(p.orientQuality)}
          onValueChange={v => setParam('orientQuality', Number(v))}
        />
        <p className="rf-secNote">随机采样 + 13 个正交朝向，按支撑体积 32%、孤岛 18%、陡峭悬空 20%、截面 20%、高度 10% 评分。</p>
      </Section>

      <Section title="候选朝向" aside={items.length ? `${items.length} 个` : '—'}>
        {items.length ? (
          <div className="rf-candidates">
            {items.map(it => (
              <button
                key={it.idx}
                type="button"
                className="rf-cand"
                data-applied={it.applied || undefined}
                onClick={() => runTask('orient-apply', () => doApplyCandidate(it.idx))}
                title={`支撑体积 ${fmtInt(it.supportVol)} mm³ · 陡峭悬空 ${fmt1(it.steepArea)} mm² · 最大截面 ${fmt1(it.maxFill)} mm²`}
              >
                <img src={it.img} alt={`朝向候选 ${it.idx + 1}，评分 ${it.score}`} />
                <span className="rf-candMeta">
                  <span>{it.applied ? '已套用' : `评分 ${it.score}`}</span>
                  {it.isBest ? <span className="rf-candBest">推荐</span> : null}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <EmptyBox>
            还没有候选。点下方「计算朝向」后会按评分排出 8 个方向，缩略图直接点选套用。
          </EmptyBox>
        )}
      </Section>

      <Section title="保护面" aside={`${state.protectedFaces.size} 个面`}>
        <SwitchRow
          label="涂画保护面"
          hint="按住左键在模型上涂画；这些面在评分与支撑里都被避开。"
          checked={mode === 'protect'}
          onChange={v => setMode(v ? 'protect' : 'orbit')}
        />
        <Num k="brushR" label="笔刷半径" min={1} max={12} step={0.5} unit="mm" />
      </Section>
    </>
  );
}

/* ================================================================
   3 · 逐层分析
   ================================================================ */
export function AnalyzePanel() {
  const [p, setParam] = useParams();
  const slice = useBusLatest('sliceStats', null);
  const heat = useBusLatest('heat', false);

  return (
    <>
      <Section title="结果" aside={slice ? `层厚 ${params.layerH} mm` : '—'}>
        <KV
          rows={[
            ['层数', slice ? fmtInt(slice.layers) : '—', slice ? '层' : ''],
            ['孤岛', slice ? String(slice.islandCount) : '—', slice ? '处' : ''],
            ['孤岛面积', slice ? fmt1(slice.totIslandArea) : '—', slice ? 'mm²' : ''],
            ['陡峭悬空', slice ? fmt1(slice.steepArea) : '—', slice ? 'mm²' : ''],
            ['最大截面', slice ? fmt1(slice.maxFill) : '—', slice ? 'mm²' : ''],
            ['支撑体积估算', slice ? fmtInt(slice.supportVol) : '—', slice ? 'mm³' : ''],
          ]}
        />
      </Section>

      <Section title="显示">
        <SwitchRow
          label="支撑热力图"
          hint="按需要支撑的程度给表面着色：蓝为不需要，红为最需要。"
          checked={heat}
          onChange={v => setHeat(v)}
        />
        {heat ? <HeatScale /> : null}
      </Section>

      <Section title="参数">
        <div className="rf-grid2">
          <Num k="layerH" label="层厚" min={0.025} max={0.3} step={0.005} unit="mm" />
          <Num k="gapThresh" label="悬空阈值" min={0.1} max={2} step={0.05} unit="mm" />
        </div>
        <Accordion
          defaultOpen={-1}
          items={[{
            title: '悬空与孤岛判定',
            content: (
              <div className="rf-adv">
                <div className="rf-grid2">
                  <Num k="selfAngle" label="自支撑角" min={20} max={70} step={1} unit="°" />
                  <Num k="minIslArea" label="孤岛最小面积" min={0.05} max={20} step={0.05} unit="mm²" />
                  <Num k="minAttach" label="最小附着面积" min={0.05} max={20} step={0.05} unit="mm²" />
                  <Num k="raiseH" label="模型抬高" min={0} max={15} step={0.5} unit="mm" onChange={handleRaiseHChange} />
                </div>
                <p className="rf-secNote">改层厚或抬高后要重跑分析；分析与支撑是同一个高度上的同一份几何。</p>
              </div>
            ),
          }]}
        />
      </Section>
    </>
  );
}

/* ================================================================
   4 · 支撑
   ================================================================ */
export function SupportPanel() {
  const [p, setParam] = useParams();
  useBusLatest('supStats', null);      // 结构统计更新时重绘（数值以 state 为准）
  const supView = useBusLatest('supView', 'full');
  const mode = useBusLatest('mode', 'orbit');
  const active = activeSupportTemplate(p);
  const tpl = SUPPORT_TEMPLATES.find(t => t.id === active) || null;
  const points = (state.supportPoints || []).length;
  const stats = state.supportStats;

  return (
    <>
      <Section title="结构" aside={stats && stats.ms ? `${stats.ms} ms` : '—'}>
        <KV
          rows={[
            ['支撑点', fmtInt(points), '个'],
            ['十字针', stats ? fmtInt(stats.needles) : '—', '根'],
            ['格架节点', stats ? fmtInt(stats.nodes) : '—', '个'],
            ['仍悬空孤岛', stats ? String((stats.islOpen || 0) + (stats.islFail || 0)) : '—', '处'],
          ]}
        />
      </Section>

      <Section title="粗细" aside={tpl ? `主干 ${fmt2(tpl.diameter)} mm` : '自定义'}>
        <ChipGroup
          label="支撑粗细"
          multiple={false}
          options={SUPPORT_TEMPLATES.map(t => ({ value: t.id, label: t.name }))}
          value={active ? [active] : []}
          onValueChange={v => {
            const id = v[v.length - 1];
            if (!id || id === active) return;
            runTask('sup-tpl', () => applySupportTemplate(id, setParam));
          }}
        />
        <p className="rf-secNote">
          {tpl
            ? `模板同时改杆径、格宽、针长、间距与底部疏密；已有支撑会按新参数重新布点，手动加的点保留。来源：${tpl.source}。`
            : '当前六项参数不是任何模板的原样值。点一档即套用该模板。'}
        </p>
      </Section>

      <Section title="支撑参数" aside="mm">
        <div className="rf-grid2">
          <Num
            k="esBarW" label="主干直径" min={0.15} max={2} step={0.05} unit="mm"
            onChange={v => {
              const d = trunkLinkage(v);
              for (const key of Object.keys(d)) if (key !== 'esBarW') setParam(key, d[key]);
            }}
          />
          <Num k="esTipW" label="接触直径" min={0.05} max={2} step={0.05} unit="mm" />
          <Num k="pen" label="接触深度" min={0} max={1} step={0.05} unit="mm" />
          <Num k="spacing" label="支撑间距" min={1} max={10} step={0.5} unit="mm" />
          <Num k="esGap" label="与模型最小间距" min={0} max={3} step={0.1} unit="mm" />
          <Num k="smallScale" label="小支撑缩放" min={0.3} max={1.5} step={0.05} unit="×" />
        </div>
        <p className="rf-secNote">主干直径一调，杆件、格宽、针长、间距与底部疏密按同一套公式一起缩放；改完点「重新生成」生效。</p>
      </Section>

      <Section title="显示与编辑">
        <ControlRow label="支撑显示">
          <SegmentedControl
            label="支撑显示"
            options={[{ value: 'full', label: '全部' }, { value: 'needle', label: '连接体' }, { value: 'point', label: '接触点' }]}
            value={supView}
            onValueChange={doSetSupView}
          />
        </ControlRow>
        <ControlRow label="手动编辑">
          <SegmentedControl
            label="手动编辑"
            options={[{ value: 'orbit', label: '浏览' }, { value: 'add', label: '加点' }, { value: 'del', label: '删点' }]}
            value={mode === 'add' || mode === 'del' ? mode : 'orbit'}
            onValueChange={setMode}
          />
        </ControlRow>
        <p className="rf-secNote">加点模式里按在支撑杆身或针尖上都能选中这一根（悬停出现蓝环）；按住拖动移动它的针尖，松手后才重建结构，Esc 取消。只点一下是选中。</p>
      </Section>

      <Accordion
        defaultOpen={-1}
        items={[{
          title: '高级设置',
          content: (
            <div className="rf-adv">
              <h4>格架</h4>
              <div className="rf-grid2">
                <Num k="esCell" label="格宽" min={1.5} max={8} step={0.5} unit="mm" />
                <Num k="esDiamAngle" label="斜边角" min={25} max={80} step={5} unit="°" />
              </div>
              <SwitchRow label="墙内竖杆" hint="墙上每半格加一根竖杆。" checked={params.esMidBars} onChange={v => setParam('esMidBars', v)} />
              <h4>十字针</h4>
              <div className="rf-grid2">
                <Num k="esNeedleMax" label="针最大长" min={1} max={20} step={0.5} unit="mm" />
                <Num k="esContactMargin" label="接触边距" min={0} max={2} step={0.1} unit="mm" />
              </div>
              <h4>基础带</h4>
              <div className="rf-grid2">
                <Num k="esFoundH" label="基础带高" min={0} max={3} step={0.1} unit="mm" />
                <Num k="esNotchH" label="缺口高" min={0} max={2} step={0.1} unit="mm" />
              </div>
              <h4>布点</h4>
              <div className="rf-grid2">
                <Num k="edgeInset" label="边缘距离" min={0} max={10} step={0.1} unit="mm" />
                <Num k="raiseH" label="模型抬高" min={0} max={15} step={0.5} unit="mm" onChange={handleRaiseHChange} />
              </div>
              <SwitchRow
                label="短小支撑"
                hint="竖直下方被模型挡住时，锚到另一个表面。"
                checked={params.shortSup}
                onChange={v => setParam('shortSup', v)}
              />
            </div>
          ),
        }]}
      />
    </>
  );
}

/* ================================================================
   5 · 导出
   ================================================================ */
export function ExportPanel() {
  const [p, setParam] = useParams();
  useBusLatest('supStats', null);      // 同上：触发重绘
  const base = p.autoPlateOn ? 'auto' : 'join';
  const points = (state.supportPoints || []).length;

  return (
    <>
      <Section title="底板">
        <RadioCards
          layout="list"
          aria-label="底板类型"
          value={base}
          minColumnWidth={260}
          onValueChange={v => runTask('base', () => setBaseType(v, setParam))}
          options={[
            { value: 'join', label: '连接底板', description: '支撑塔底部锯齿收成一条立板，模型随板再抬高。' },
            { value: 'auto', label: '自动底板', description: '按支撑投影生成蜂窝孔板，支撑从板顶面往上生成。' },
          ]}
        />
      </Section>

      {base === 'join' ? (
        <Section title="连接底板" note={`模型会再抬高 ${fmt2(joinLiftWanted(p))} mm，支撑整段都在板顶上面。`}>
          <SwitchRow label="栅角" hint="贴台面的底角斜切 0.6 mm。" checked={p.baseChamfer} onChange={v => { setParam('baseChamfer', v); if (points) runTask('base-chamfer', doRebuild); }} />
          <SwitchRow label="去掉外伸" hint="交叉墙的底板收到外墙齐平。" checked={p.baseFlush} onChange={v => { setParam('baseFlush', v); if (points) runTask('base-flush', doRebuild); }} />
          <SwitchRow label="底板开孔" hint="连接条上按格架打孔，少用材料。" checked={p.baseHole} onChange={v => { setParam('baseHole', v); if (points) runTask('base-hole', doRebuild); }} />
        </Section>
      ) : (
        <Section title="自动底板">
          <div className="rf-grid2">
            <Num k="apHeight" label="板厚" min={0.4} max={4} step={0.1} unit="mm" />
            <Num k="apOffset" label="外扩距离" min={0} max={8} step={0.5} unit="mm" />
            <Num k="apBorder" label="边框宽" min={0} max={8} step={0.5} unit="mm" />
            <Num k="apHoleR" label="孔半径" min={1} max={10} step={0.5} unit="mm" />
          </div>
          <SwitchRow label="板底栅角" checked={p.apChamfer} onChange={v => setParam('apChamfer', v)} />
        </Section>
      )}

      <Section title="导出">
        <SwitchRow
          label="导出前布尔并"
          hint="把支撑与底板并成一张水密外壳；关掉则由切片软件处理重叠。"
          checked={p.unionExport}
          onChange={v => setParam('unionExport', v)}
        />
        <KV
          rows={[
            ['支撑点', fmtInt(points), '个'],
            ['模型 + 支撑', 'model_with_supports.stl', ''],
            ['仅支撑', 'supports_only.stl', ''],
            ['单位', 'mm · Z 轴向上', ''],
          ]}
        />
        <Legend items={[
          { color: hex(SUP_COLOR), label: '落板支撑 / 底板' },
          { color: hex(SUP_ANCHOR_COLOR), label: '短小支撑' },
          { color: '#5f6468', label: '模型' },
        ]} />
      </Section>
    </>
  );
}

