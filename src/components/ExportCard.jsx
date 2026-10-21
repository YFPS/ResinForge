import React from 'react';
import { Button, Checkbox, Select } from '@arco-design/web-react';
import Card from './Card.jsx';
import { useParams } from './useParams.js';
import { state } from '../store.js';
import { rebuildStructure, syncModelLift } from '../core/support.js';
import { exportSTL } from '../core/stl.js';

/* 导出：底板类型二选一（连接底板 / 自动底板；自动底板的尺寸参数在新界面里调）+ 两个导出按钮 */
export default function ExportCard() {
  const [params, setParam] = useParams();
  const baseType = params.autoPlateOn ? 'auto' : 'join';
  const setBaseType = v => {
    const join = v === 'join';
    setParam('baseJoin', join);
    setParam('autoPlateOn', !join);
    if ((state.supportPoints || []).length) rebuildStructure();
    else syncModelLift();
  };
  return (
    <Card step={6} title="导出">
      <div className="row" style={{ alignItems: 'center' }}>
        <label className="f" style={{ flex: 1, marginBottom: 0 }}><span>底板类型</span>
          <Select value={baseType} onChange={setBaseType} style={{ width: '100%' }}>
            <Select.Option value="join">连接底板（塔底连接条，模型随板抬高）</Select.Option>
            <Select.Option value="auto">自动底板（按支撑投影：栅角 + 蜂窝孔）</Select.Option>
          </Select>
        </label>
      </div>
      <div className="row" style={{ alignItems: 'center' }}>
        <Checkbox checked={!!params.baseChamfer} disabled={!params.baseJoin} onChange={v => { setParam('baseChamfer', v); if ((state.supportPoints || []).length) rebuildStructure(); }}>栅角（底角斜切一小截）</Checkbox>
        <Checkbox checked={!!params.baseFlush} disabled={!params.baseJoin} onChange={v => { setParam('baseFlush', v); if ((state.supportPoints || []).length) rebuildStructure(); }}>去掉外伸（外沿收齐）</Checkbox>
        <Checkbox checked={!!params.baseHole} disabled={!params.baseJoin} onChange={v => { setParam('baseHole', v); if ((state.supportPoints || []).length) rebuildStructure(); }}>底板开孔（菱形孔省料）</Checkbox>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <Checkbox checked={!!params.unionExport} onChange={v => setParam('unionExport', v)}>
          熔合成单一实体（导出前布尔并成一张水密外壳，可能要几秒）
        </Checkbox>
      </div>
      <div className="row">
        <Button type="primary" style={{ flex: 1 }} onClick={() => exportSTL(true, true, 'model_with_supports.stl')}>导出 模型+支撑 STL</Button>
        <Button onClick={() => exportSTL(false, true, 'supports_only.stl')}>仅支撑 STL</Button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>导出后导入 CHITUBOX / Lychee 排版切片即可打印（已按 STL 惯例回转换为 Z-up）。黑灰=落板支撑（落在底板顶面），红色=锚定模型表面的短小支撑。</div>
    </Card>
  );
}
