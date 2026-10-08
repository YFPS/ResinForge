import React from 'react';
import { InputNumber } from '@arco-design/web-react';
import Card from './Card.jsx';
import { useParams } from './useParams.js';
import { onPlateChanged } from '../core/model.js';

/* 机器配置按切片坐标：板面 X / 板面 Y / 高度 Z。改尺寸会重画视口里的打印体积网格 */
export default function MachineCard() {
  const [params, setParam] = useParams();
  const set = (k) => (v) => { setParam(k, v); onPlateChanged(); };
  return (
    <Card title="机器配置">
      <div className="row">
        <label className="f"><span>板面 X</span><InputNumber value={params.plateX} min={50} max={400} step={1} onChange={set('plateX')} />mm</label>
        <label className="f"><span>板面 Y</span><InputNumber value={params.plateZ} min={50} max={400} step={1} onChange={set('plateZ')} />mm</label>
        <label className="f"><span>高度 Z</span><InputNumber value={params.plateY} min={30} max={400} step={1} onChange={set('plateY')} />mm</label>
        <label className="f"><span>像素</span><InputNumber value={params.pixelUm} min={10} max={100} step={1} onChange={set('pixelUm')} />µm</label>
      </div>
    </Card>
  );
}
