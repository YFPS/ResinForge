import React from 'react';
import { Button, InputNumber } from '@arco-design/web-react';
import Card from './Card.jsx';
import { useParams } from './useParams.js';
import { clearProtectedFaces } from '../core/scene.js';

/* 保护面（语义权重）：笔刷半径 + 清除按钮 */
export default function ProtectCard() {
  const [params, setParam] = useParams();
  return (
    <Card step={3} title="保护面（语义权重）">
      <div className="hint" style={{ marginBottom: 8 }}>用「涂保护面」笔刷在模型上标记不可有支撑的表面（脸、细节面）。保护面会同时影响朝向打分与支撑布点。红色 = 已保护。</div>
      <div className="row">
        <label className="f"><span>笔刷半径</span><InputNumber value={params.brushR} min={0.5} max={20} step={0.5} onChange={v => setParam('brushR', v)} />mm</label>
      </div>
      <div className="row">
        <Button onClick={clearProtectedFaces}>清除全部保护面</Button>
      </div>
    </Card>
  );
}
