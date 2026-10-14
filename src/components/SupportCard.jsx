import React, { useEffect, useState } from 'react';
import { Button, Checkbox, InputNumber, Select, Tooltip } from '@arco-design/web-react';
import Card from './Card.jsx';
import { useParams } from './useParams.js';
import { bus, state } from '../store.js';
import { runGenSup, clearSupports, rebuildStructure, setPointsOnly } from '../core/support.js';

/* 支撑生成：支撑塔（格架塔）+ 支撑点参数 + 结构参数 +
   自动支撑（清空重建）/ 自动孤岛支撑（增量补点）/ 按当前参数重建结构（复用已有支撑点）+ supStats */
export default function SupportCard() {
  const [params, setParam] = useParams();
  const [busy, setBusy] = useState('');
  const [stats, setStats] = useState(null);
  const [pointsOnly, setPointsOnlyUi] = useState(false);
  useEffect(() => bus.on('supStats', setStats), []);

  const run = async (kind, fn) => { setBusy(kind); try { await fn(); } finally { setBusy(''); } };
  const num = (k, label, min, max, step, unit = 'mm', title) => (
    <label className="f"><span>{label}</span><InputNumber value={params[k]} min={min} max={max} step={step} title={title} onChange={v => setParam(k, v)} />{unit}</label>
  );
  const fail = stats ? (stats.noHead || 0) + (stats.unroutable || 0) : 0;

  return (
    <Card step={5} title="支撑生成">
      <div className="row">
        {num('spacing', '支撑间距', 1, 10, 0.5)}
        {num('edgeInset', '边缘距离', 0, 10, 0.1)}
        {num('minSupArea', '最小悬空面积', 0.5, 50, 0.5, 'mm²')}
      </div>
      <div className="row" style={{ alignItems: 'center' }}>
        <Checkbox checked={params.shortSup} onChange={v => setParam('shortSup', v)}>短小支撑（连不上格架的点用十字短杆接到下方表面 / 平台）</Checkbox>
        <Checkbox checked={pointsOnly} onChange={v => { setPointsOnlyUi(v); setPointsOnly(v); }}>只显示支撑点</Checkbox>
      </div>
      <div className="hint">模型默认从平台抬高 {params.raiseH}mm。加点时点到另一件模型，摄影机会跳过去。</div>
      <div className="row" style={{ alignItems: 'center' }}>
        <label className="f"><span>接触朝向</span>
          <Select size="small" style={{ width: 110 }} value={params.tipMode} onChange={v => setParam('tipMode', v)}
            options={[{ label: '沿法线', value: 'normal' }, { label: '竖直', value: 'vertical' }, { label: '固定角度', value: 'fixed' }]} />
        </label>
        {num('tipTilt', '接触最大倾角', 0, 75, 5, '°', '接触端与竖直方向的夹角上限（沿法线时钳制、固定角度时直接采用）；针身 / 分支仍受自支撑角约束')}
      </div>
      <div className="row">
        {num('esCell', '格宽', 1.5, 8, 0.5, 'mm', '墙距（原 Diamond width）：格架最小孔格宽')}
        {num('esDiamAngle', '斜边角', 25, 80, 5, '°', '斜边仰角（不低于自支撑临界角）')}
        {num('esGap', '与模型最小间距', 0, 3, 0.1, 'mm', 'Margin to part：格架（节点 / 板条）与模型保持的最小净距，支撑头与连接杆不受此限')}
      </div>
      <div className="row">
        {num('esBarW', '边宽', 0.15, 2, 0.05, 'mm', 'Edge width：斜边在墙面内的宽度')}
        {num('esBarT', '边厚', 0.15, 1.5, 0.05, 'mm', 'Edge thickness：墙厚（默认同边宽，杆件截面为方形）')}
        {num('esColRatio', '柱高宽比', 2, 20, 1, '', 'Column height to width ratio：展宽前柱内格数（手册推荐 7）')}
      </div>
      <div className="row">
        {num('esHullRed', '壳层缩减', 0, 3, 1, '级', 'Hull reduction：每下降一个柱高，格宽翻倍一次（孔洞放大省料、利于排液），最多翻倍这么多级（0=底部全密，细支撑用；套用模板时自动设定）')}
        {num('esTowerMaxR', '最大展宽', 0, 10, 1, '格', '每下降一个柱高（柱高宽比 × 格宽）向四周展宽一格，每侧最多展宽的格数')}
        {num('esNeedleMax', '针最大长', 1, 12, 0.5, 'mm', '格架节点到接触点的十字针最大长度')}
      </div>
      <div className="row">
        {num('esConnW', '连接宽', 0.1, 1.5, 0.05, 'mm', 'Connection width：十字针针身板宽（默认同边宽）')}
        {num('esNeedleT', '针板厚', 0.1, 1, 0.05, 'mm', '十字针「+」截面的板厚（默认同连接宽，针身截面为方形）')}
        {num('esTipW', '接触直径', 0.05, 1, 0.05, 'mm', 'Contact width：针尖接触模型处的宽度')}
      </div>
      <div className="row">
        {num('esContactMargin', '接触边距', 0, 2, 0.1, 'mm', 'Contact margin：贴模型前保持接触直径的细直段长')}
        {num('esTaper', '过渡段长', 0.2, 3, 0.1, 'mm', '连接宽 → 接触直径 的渐缩长度')}
        {num('pen', '接触深度', 0, 1, 0.05, 'mm', 'Penetration length：针尖沿针轴扎入模型的深度')}
      </div>
      <div className="row">
        {num('esFoundH', '基础带高', 0, 3, 0.1, 'mm', 'Foundation maximum height：塔底墙下沿实心带高')}
        {num('esNotchH', '缺口高', 0, 2, 0.1, 'mm', 'Foundation maximum notch height：基础带底边三角缺口高')}
      </div>
      <div className="row" style={{ alignItems: 'center' }}>
        <Checkbox checked={params.esMidBars} onChange={v => setParam('esMidBars', v)}>墙内竖杆（墙上每半格一根）</Checkbox>
      </div>
      <div className="hint">光固化支撑塔：正交墙上的斜边在竖杆处折返（孔为三角形），减去外扩净距的模型；每个支撑点沿竖杆 / 斜边找到落地路径（被模型挡住时绕行），路径所在格随深度展宽，相邻支撑点的格并成连续塔块；自平台逐层向上只保留有支撑的节点（无打印孤岛），接入点下为尖顶、往下铺满；杆件在节点处经节点板圆滑相接；孔洞按壳层缩减逐级放大；塔底为带三角缺口的基础带。十字针自格架节点直通接触点（十字板对齐格架墙向）：连接宽 → 过渡段渐缩 → 接触宽（接触边距段）→ 扎入渗透长度；接不上格架的点依次改走就近接格架 / 分叉 / 十字短杆，仍接不上的标红。</div>
      <div className="row">
        <Button type="primary" style={{ flex: 1 }} loading={busy === 'auto'} onClick={() => run('auto', () => runGenSup())}>自动支撑</Button>
        <Tooltip content="只为孤岛位置补支撑点（不清空现有支撑点），然后重建结构">
          <Button style={{ flex: 1 }} loading={busy === 'isl'} onClick={() => run('isl', () => runGenSup({ islandsOnly: true }))}>自动孤岛支撑</Button>
        </Tooltip>
      </div>
      <div className="row">
        <Tooltip content="复用现有支撑点，按当前参数重新生成结构">
          <Button style={{ flex: 1 }} loading={busy === 'rebuild'} onClick={() => run('rebuild', rebuildStructure)}>按当前参数重建结构</Button>
        </Tooltip>
        <Button onClick={() => clearSupports()}>清空</Button>
      </div>
      {stats && stats.points !== undefined && (
        <div className="kvbox">
          <div className="kv"><span>支撑点</span><b className={stats.points ? 'good' : ''}>{stats.points}</b></div>
          {stats.ok !== undefined && <div className="kv"><span>已生成结构</span><b className="good">{stats.ok}</b></div>}
          {stats.needles !== undefined && <div className="kv"><span>十字针 / 塔块</span><b style={{ color: '#38d996' }}>{stats.needles} / {stats.towers}</b></div>}
          {stats.nodes !== undefined && <div className="kv"><span>格架节点 / 杆件</span><b>{stats.nodes} / {stats.bars}</b></div>}
          {stats.anchors !== undefined && <div className="kv"><span>短小支撑</span><b style={{ color: '#ffb020' }}>{stats.anchors}</b></div>}
          {stats.ok !== undefined && <div className="kv"><span>无法支撑</span><b className={fail ? 'warn' : 'good'}>{fail}</b></div>}
          <div className="kv"><span>保护面</span><b>{stats.prot.toLocaleString()} 面</b></div>
        </div>
      )}
    </Card>
  );
}
