import React, { useEffect, useState } from 'react';
import { Button, InputNumber, Switch } from '@arco-design/web-react';
import Card from './Card.jsx';
import { useParams } from './useParams.js';
import { bus } from '../store.js';
import { runSliceAnalysis } from '../core/inspect.js';
import { handleRaiseHChange } from '../core/model.js';
import { setHeat } from '../core/heat.js';

/* 切片与孤岛分析：层厚/悬空阈值/抬高/孤岛最小面积/最小附着面积 + sliceStats（订阅 bus 'sliceStats'）。
   抬高变更副作用复刻旧监听：模型 position.y 更新 + clearSupports(false) + 清分析 + 隐藏检查器（core 内完成）。
   支撑热力图：模型表面按支撑需求强度着色（蓝→红），有分析数据时用 LDI 精确高差。 */
export default function SliceCard() {
  const [params, setParam] = useParams();
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState(null);
  const [heat, setHeatOn] = useState(false);
  useEffect(() => bus.on('sliceStats', setStats), []);
  useEffect(() => bus.on('heat', setHeatOn), []);

  const start = async () => {
    setLoading(true);
    try { await runSliceAnalysis(); } finally { setLoading(false); }
  };

  return (
    <Card step={4} title="切片与孤岛分析">
      <div className="row">
        <label className="f"><span>层厚</span><InputNumber value={params.layerH} min={0.025} max={0.3} step={0.005} onChange={v => setParam('layerH', v)} />mm</label>
        <label className="f"><span>悬空阈值</span><InputNumber value={params.gapThresh} min={0.1} max={2} step={0.05} onChange={v => setParam('gapThresh', v)} />mm</label>
        <label className="f"><span>抬高</span><InputNumber value={params.raiseH} min={0} max={15} step={0.5} onChange={v => { setParam('raiseH', v); handleRaiseHChange(); }} />mm</label>
      </div>
      <div className="row">
        <label className="f"><span>孤岛最小面积</span><InputNumber value={params.minIslArea} min={0.05} max={20} step={0.05} onChange={v => setParam('minIslArea', v)} />mm²</label>
        <label className="f"><span>最小附着面积</span><InputNumber value={params.minAttach} min={0.05} max={20} step={0.05} onChange={v => setParam('minAttach', v)} />mm²</label>
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>模型按「抬高」悬于筏层上方，最底层作为孤岛参与检测；与下层接触面积不足「最小附着面积」的连通域同样视为孤岛。</div>
      <div className="row">
        <Button type="primary" long loading={loading} onClick={start}>运行逐层分析</Button>
      </div>
      <div className="row" style={{ alignItems: 'center', marginTop: 6 }}>
        <Switch checked={heat} onChange={v => setHeat(v)} />
        <span style={{ fontSize: 12, color: '#8b949e' }}>支撑热力图（蓝=无需支撑 → 红=强需求）</span>
      </div>
      {heat && (
        <div className="heat-legend">
          <span>弱</span><div className="heat-bar" /><span>强</span>
        </div>
      )}
      {stats && (
        <div className="kvbox" style={{ marginTop: 6 }}>
          <div className="kv"><span>总层数</span><b>{stats.layers.toLocaleString()}</b></div>
          <div className="kv"><span>抬高 / 筏层</span><b>{stats.raiseText}</b></div>
          <div className="kv"><span>孤岛数量</span><b className={stats.islandCount ? 'warn' : 'good'}>{stats.islandCount} 处</b></div>
          <div className="kv"><span>孤岛总面积</span><b>{stats.totIslandArea.toFixed(1)} mm²</b></div>
          <div className="kv"><span>陡峭悬空面积</span><b>{stats.steepArea.toFixed(1)} mm²</b></div>
          <div className="kv"><span>触保护面悬空</span><b className={stats.protHit > 0 ? 'warn' : 'good'}>{stats.protHit.toFixed(1)} mm²</b></div>
          <div className="kv"><span>预估支撑体积</span><b>{stats.supportVol.toFixed(1)} mm³</b></div>
          <div className="kv"><span>最大截面</span><b>{stats.maxFill.toFixed(1)} mm²</b></div>
        </div>
      )}
    </Card>
  );
}
