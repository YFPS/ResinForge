import React from 'react';
import { Button, Checkbox, InputNumber } from '@arco-design/web-react';
import Card from './Card.jsx';
import { useParams } from './useParams.js';
import { handleRaftOnChange, handleRaftMarginChange } from '../core/model.js';
import { exportSTL } from '../core/stl.js';

/* 导出：筏层开关（变更即提示重新生成支撑，复刻旧监听）+ 边距 + 两个导出按钮 */
export default function ExportCard() {
  const [params, setParam] = useParams();
  return (
    <Card step={6} title="导出">
      <div className="row" style={{ alignItems: 'center' }}>
        <Checkbox
          checked={params.raftOn}
          onChange={v => { setParam('raftOn', v); handleRaftOnChange(); }}
        >筏层（厚 1.2mm，默认关闭）</Checkbox>
        <label className="f" style={{ flex: 1, marginBottom: 0 }}><span>边距</span><InputNumber value={params.raftMargin} min={1} max={10} step={0.5} onChange={v => { setParam('raftMargin', v); handleRaftMarginChange(); }} />mm</label>
      </div>
      <div className="row">
        <Button type="primary" style={{ flex: 1 }} onClick={() => exportSTL(true, true, 'model_with_supports.stl')}>导出 模型+支撑 STL</Button>
        <Button onClick={() => exportSTL(false, true, 'supports_only.stl')}>仅支撑 STL</Button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>导出后导入 CHITUBOX / Lychee 排版切片即可打印（已按 STL 惯例回转换为 Z-up）。绿色=落板支撑（落在筏层顶面），琥珀色=锚定模型表面的短小支撑。</div>
    </Card>
  );
}
