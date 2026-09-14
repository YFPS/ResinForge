import React from 'react';
import { InputNumber } from '@arco-design/web-react';
import Card from './Card.jsx';
import { useParams } from './useParams.js';

/* 机器配置：板面 X / Z / 像素µm —— 驱动模型越界警告与分析格/机器像素比提示（网格底板已移除） */
export default function MachineCard() {
  const [params, setParam] = useParams();
  const set = (k) => (v) => setParam(k, v);
  return (
    <Card title="机器配置">
      <div className="row">
        <label className="f"><span>板面 X</span><InputNumber value={params.plateX} min={50} max={400} step={1} onChange={set('plateX')} />mm</label>
        <label className="f"><span>板面 Z</span><InputNumber value={params.plateZ} min={50} max={400} step={1} onChange={set('plateZ')} />mm</label>
        <label className="f"><span>像素</span><InputNumber value={params.pixelUm} min={10} max={100} step={1} onChange={set('pixelUm')} />µm</label>
      </div>
    </Card>
  );
}
