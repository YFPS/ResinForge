import React from 'react';
import { Button, Checkbox, InputNumber, Select } from '@arco-design/web-react';
import Card from './Card.jsx';
import { useParams } from './useParams.js';
import { state } from '../store.js';
import { handleRaftOnChange, handleRaftMarginChange, updateRaft } from '../core/model.js';
import { rebuildStructure } from '../core/support.js';
import { exportSTL } from '../core/stl.js';

/* 导出：底板类型（无 / 实心筏层 / 网格底板[e-Stage 风格]，变更即提示重新生成支撑）+ 边距/网格参数 + 两个导出按钮 */
export default function ExportCard() {
  const [params, setParam] = useParams();
  const baseType = params.gridRaftOn ? 'grid' : (params.raftOn ? 'raft' : 'none');
  const setBaseType = v => {
    setParam('raftOn', v === 'raft');
    setParam('gridRaftOn', v === 'grid');
    handleRaftOnChange();
  };
  const gridParam = (k) => (v) => { setParam(k, v); if (params.gridRaftOn) updateRaft(); };
  return (
    <Card step={6} title="导出">
      <div className="row" style={{ alignItems: 'center' }}>
        <label className="f" style={{ flex: 1, marginBottom: 0 }}><span>底板类型</span>
          <Select value={baseType} onChange={setBaseType} style={{ width: '100%' }}>
            <Select.Option value="none">无底板（落平台）</Select.Option>
            <Select.Option value="raft">实心筏层（厚 1.2mm）</Select.Option>
            <Select.Option value="grid">网格底板（e-Stage 风格多孔）</Select.Option>
          </Select>
        </label>
        <label className="f" style={{ flex: 1, marginBottom: 0 }}><span>边距</span><InputNumber value={params.raftMargin} min={1} max={10} step={0.5} onChange={v => { setParam('raftMargin', v); handleRaftMarginChange(); }} />mm</label>
      </div>
      <div className="row" style={{ alignItems: 'center' }}>
        <Checkbox checked={!!params.baseJoin} onChange={v => { setParam('baseJoin', v); if ((state.supportPoints || []).length) rebuildStructure(); }}>连接底板（底部锯齿收成一条立板）</Checkbox>
        <Checkbox checked={!!params.baseChamfer} disabled={!params.baseJoin} onChange={v => { setParam('baseChamfer', v); if ((state.supportPoints || []).length) rebuildStructure(); }}>栅角（底角斜切一小截）</Checkbox>
        <Checkbox checked={!!params.baseFlush} disabled={!params.baseJoin} onChange={v => { setParam('baseFlush', v); if ((state.supportPoints || []).length) rebuildStructure(); }}>去掉外伸（外沿收齐）</Checkbox>
        <Checkbox checked={!!params.baseHole} disabled={!params.baseJoin} onChange={v => { setParam('baseHole', v); if ((state.supportPoints || []).length) rebuildStructure(); }}>底板开孔（菱形孔省料）</Checkbox>
      </div>
      {params.gridRaftOn && (
        <div className="row">
          <label className="f"><span>板厚</span><InputNumber value={params.gridT} min={0.4} max={2} step={0.1} onChange={gridParam('gridT')} />mm</label>
          <label className="f"><span>梁宽</span><InputNumber value={params.gridBar} min={0.3} max={2} step={0.1} onChange={gridParam('gridBar')} />mm</label>
          <label className="f"><span>孔距</span><InputNumber value={params.gridStep} min={1.5} max={8} step={0.5} onChange={gridParam('gridStep')} />mm</label>
        </div>
      )}
      <div className="row">
        <Button type="primary" style={{ flex: 1 }} onClick={() => exportSTL(true, true, 'model_with_supports.stl')}>导出 模型+支撑 STL</Button>
        <Button onClick={() => exportSTL(false, true, 'supports_only.stl')}>仅支撑 STL</Button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>导出后导入 CHITUBOX / Lychee 排版切片即可打印（已按 STL 惯例回转换为 Z-up）。绿色=落板支撑（落在底板顶面），琥珀色=锚定模型表面的短小支撑。</div>
    </Card>
  );
}
