import React, { useEffect, useState } from 'react';
import { Button, Checkbox, InputNumber, Tooltip } from '@arco-design/web-react';
import Card from './Card.jsx';
import { useParams } from './useParams.js';
import { bus } from '../store.js';
import { runGenSup, clearSupports, buildScaffold, updateSupStats } from '../core/support.js';

/* 支撑生成：顶端/锥头/底盘/间距等几何参数 + 短小支撑开关 + 脚手架交叉横梁 +
   自动支撑（全流程，清空重建）/ 自动孤岛支撑（只为孤岛位置增量补打）+ supStats（订阅 bus 'supStats'） */
export default function SupportCard() {
  const [params, setParam] = useParams();
  const [loading, setLoading] = useState(false);
  const [loadingIsl, setLoadingIsl] = useState(false);
  const [stats, setStats] = useState(null);
  useEffect(() => bus.on('supStats', setStats), []);

  const start = async (isl) => {
    isl ? setLoadingIsl(true) : setLoading(true);
    try { await runGenSup({ islandsOnly: isl }); } finally { isl ? setLoadingIsl(false) : setLoading(false); }
  };

  return (
    <Card step={5} title="支撑生成">
      <div className="row">
        <label className="f"><span>顶部球头</span><InputNumber value={params.tipD} min={0.1} max={1} step={0.05} title="顶部球头直径（接触模型的球头）" onChange={v => setParam('tipD', v)} />mm</label>
        <label className="f"><span>嵌入深度</span><InputNumber value={params.pen} min={0} max={1} step={0.05} title="球头扎入模型表面的深度" onChange={v => setParam('pen', v)} />mm</label>
        <label className="f"><span>中段直径</span><InputNumber value={params.midD} min={0.2} max={3} step={0.1} title="中部球头与主干直径" onChange={v => setParam('midD', v)} />mm</label>
      </div>
      <div className="row">
        <label className="f"><span>锥头长度</span><InputNumber value={params.headLen} min={0.1} max={5} step={0.05} onChange={v => setParam('headLen', v)} />mm</label>
        <label className="f"><span>锥头顶宽</span><InputNumber value={params.headTopD} min={0.05} max={2} step={0.05} title="锥头顶部宽度，默认同顶部球头直径" onChange={v => setParam('headTopD', v)} />mm</label>
        <label className="f"><span>锥头底宽</span><InputNumber value={params.headBotD} min={0.1} max={3} step={0.1} title="锥头底部宽度，默认同中段直径" onChange={v => setParam('headBotD', v)} />mm</label>
      </div>
      <div className="row">
        <label className="f"><span>底盘直径</span><InputNumber value={params.baseD} min={1} max={6} step={0.5} onChange={v => setParam('baseD', v)} />mm</label>
        <label className="f"><span>支撑间距</span><InputNumber value={params.spacing} min={1} max={10} step={0.5} onChange={v => setParam('spacing', v)} />mm</label>
        <label className="f"><span>最小悬空面积</span><InputNumber value={params.minSupArea} min={0.5} max={50} step={0.5} onChange={v => setParam('minSupArea', v)} />mm²</label>
      </div>
      <div className="row" style={{ alignItems: 'center' }}>
        <Checkbox checked={params.shortSup} onChange={v => setParam('shortSup', v)}>短小支撑（锚定模型表面）</Checkbox>
      </div>
      <div className="row" style={{ alignItems: 'center' }}>
        <Checkbox checked={params.scaffoldOn} onChange={v => { setParam('scaffoldOn', v); buildScaffold(); updateSupStats(); }}>脚手架（立柱间交叉横梁）</Checkbox>
      </div>
      {params.scaffoldOn && (
        <div className="row">
          <label className="f"><span>横梁直径</span><InputNumber value={params.crossD} min={0.2} max={2} step={0.1} onChange={v => setParam('crossD', v)} />mm</label>
          <label className="f"><span>起始高度</span><InputNumber value={params.crossStartH} min={0} max={20} step={0.5} onChange={v => setParam('crossStartH', v)} />mm</label>
          <label className="f"><span>Z 间距</span><InputNumber value={params.crossZStep} min={2} max={20} step={0.5} onChange={v => setParam('crossZStep', v)} />mm</label>
          <label className="f"><span>XY 间距</span><InputNumber value={params.crossMaxXY} min={3} max={20} step={0.5} onChange={v => setParam('crossMaxXY', v)} />mm</label>
        </div>
      )}
      <div className="hint" style={{ marginTop: 2 }}>支撑为分段结构（顶端→柱身→基座/底端），顶端球头扎入表面微量深度（嵌入深度可调）。悬空点下方有模型表面时锚定到该表面（琥珀色），否则落到筏层（绿色）。下方 0.8mm 内已有材料的点视为已托住，不生成支撑。</div>
      <div className="row">
        <Button type="primary" style={{ flex: 1 }} loading={loading} onClick={() => start(false)}>自动支撑</Button>
        <Tooltip content="仅为检测到的孤岛位置补打支撑（不清空现有支撑）">
          <Button style={{ flex: 1 }} loading={loadingIsl} onClick={() => start(true)}>自动孤岛支撑</Button>
        </Tooltip>
        <Button onClick={() => clearSupports()}>清空</Button>
      </div>
      {stats && (
        <div className="kvbox">
          <div className="kv"><span>当前支撑数</span><b className={stats.n ? 'good' : ''}>{stats.n}</b></div>
          <div className="kv"><span>锚定短小支撑</span><b style={{ color: '#ffb020' }}>{stats.anchored}</b></div>
          <div className="kv"><span>落板支撑</span><b style={{ color: '#38d996' }}>{stats.n - stats.anchored}</b></div>
          <div className="kv"><span>保护面</span><b>{stats.prot.toLocaleString()} 面</b></div>
        </div>
      )}
    </Card>
  );
}
