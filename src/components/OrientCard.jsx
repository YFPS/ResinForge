import React, { useEffect, useState } from 'react';
import { Button, InputNumber, Select, Progress } from '@arco-design/web-react';
import Card from './Card.jsx';
import { useParams } from './useParams.js';
import { bus } from '../store.js';
import { runOrient, applyCandidate } from '../core/orient.js';

/* 自动朝向优化：采样精度 / 自支撑角 / 保护面权重 + 进度条 + 候选缩略图网格（订阅 bus 'orientResults'/'progress'） */
export default function OrientCard() {
  const [params, setParam] = useParams();
  const [loading, setLoading] = useState(false);
  const [prog, setProg] = useState(null);        // {p, text}，p=null 隐藏
  const [cands, setCands] = useState(null);      // null=隐藏；数组=候选
  useEffect(() => bus.on('progress', setProg), []);
  useEffect(() => bus.on('orientResults', setCands), []);

  const start = async () => {
    setLoading(true);
    try { await runOrient(); } finally { setLoading(false); }
  };

  return (
    <Card step={2} title="自动朝向优化">
      <div className="row" style={{ alignItems: 'center' }}>
        <label className="f"><span>采样精度</span>
          <Select
            value={params.orientQuality} style={{ width: 130 }}
            onChange={v => setParam('orientQuality', v)}
            options={[
              { value: 32, label: '快速 32 向' },
              { value: 64, label: '标准 64 向' },
              { value: 128, label: '精细 128 向' },
            ]}
          />
        </label>
      </div>
      <div className="row">
        <label className="f"><span>自支撑角</span><InputNumber value={params.selfAngle} min={20} max={70} step={1} onChange={v => setParam('selfAngle', v)} />°</label>
        <label className="f"><span>保护面权重</span><InputNumber value={params.protW} min={1} max={50} step={1} onChange={v => setParam('protW', v)} />x</label>
      </div>
      <div className="row">
        <Button type="primary" long loading={loading} onClick={start}>开始朝向优化</Button>
      </div>
      {prog && prog.p != null && (
        <div className="progress-wrap">
          <Progress percent={prog.p * 100} showText={false} />
          <div className="progress-text">{prog.text || ''}</div>
        </div>
      )}
      {cands && (
        <div className="orient-results">
          {cands.map(r => (
            <div key={r.idx} className={'cand' + (r.isBest ? ' best' : '')} onClick={() => applyCandidate(r.idx)}>
              <img src={r.img} width={56} height={56} alt="" />
              <div className="info">
                <b>{r.score} 分</b>{r.isBest ? ' · 推荐' : ''}<br />
                支撑 {r.supportVol.toFixed(0)}mm³ · 悬空 {r.steepArea.toFixed(0)}mm²<br />
                孤岛 {r.islandArea.toFixed(0)}mm² · 最大截面 {r.maxFill.toFixed(0)}mm²
              </div>
            </div>
          ))}
          {cands.length > 0 && (
            <Button type="primary" long onClick={() => applyCandidate(0)}>
              {`应用最佳朝向（${cands[0].score} 分）`}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
