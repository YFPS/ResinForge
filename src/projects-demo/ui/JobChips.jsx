import React, { useState } from 'react';
import { AlertTriangle, Check, RefreshCw } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/arc/popover/popover';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import Button from '@/components/arc/button/button';
import { useBusLatest, useParams } from '../../demo/bridge.js';
import { state } from '../../store.js';
import { raiseH } from '../../core/model.js';
import { MACHINES, MATERIALS, TEMPLATES, machineById, materialById } from '../catalog.js';
import { fitOn, footprint } from '../engine.js';
import { currentJob, generate, setLayer, setMachine, setMaterial, setTemplate, useApp } from '../appStore.js';
import { PlateGlyph, Swatch, templateName } from './common.jsx';

/* 工作区顶栏上的「机器」「材料」两个选择器。改动直接作用到真实参数：
   换机器 = 板面 / 像素变（视口里的成型平台跟着变）；换材料 = 层厚与默认支撑模板；换模板 = 有支撑时按新参数重新生成 */

function useFootprint() {
  useBusLatest('modelInfo', null);   // 零件挪动 / 增删后重算
  return footprint(state.parts);
}

export function MachineChip() {
  const app = useApp();
  const fp = useFootprint();
  const job = app.job;
  const m = job ? machineById(job.machineId) : null;
  const fit = m ? fitOn(m, fp, raiseH()) : { ok: true };
  const [open, setOpen] = useState(false);
  if (!job) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className={'pdChip' + (fit.ok ? '' : ' is-warn')} aria-label="机器">
        <PlateGlyph machine={m} box={22} />
        <span className="pdChipText">{m ? m.model : '自定义'}</span>
        {fit.ok ? null : <AlertTriangle size={14} className="pdChipWarn" aria-label="零件超出板面" />}
      </PopoverTrigger>
      <PopoverContent align="end" className="pdPop pdPop--machine">
        <div className="pdPopHead">
          <b>机器</b>
          <span>板面按同一比例画，蓝框是当前零件的占地。换机器只改板面与像素，不动支撑。</span>
        </div>
        <div className="pdPopList" role="listbox" aria-label="机器">
          {MACHINES.map(x => {
            const f = fitOn(x, fp, raiseH());
            const on = x.id === job.machineId;
            return (
              <button key={x.id} type="button" role="option" aria-selected={on} className={on ? 'is-on' : ''}
                onClick={() => { setMachine(x.id); setOpen(false); }}>
                <PlateGlyph machine={x} fp={fp} box={46} over={!f.ok} />
                <span className="pdPopMain">
                  <b>{x.brand} {x.model}</b>
                  <small>{x.plateX} × {x.plateZ} mm · 高 {x.plateY} · {x.pixelUm} µm</small>
                </span>
                <span className={'pdFit' + (f.ok ? '' : ' is-over')}>{f.ok ? '放得下' : `超出 ${Math.ceil(f.over)} mm`}</span>
                {on ? <Check size={15} className="pdPopCheck" /> : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function MaterialChip() {
  const app = useApp();
  useParams();   // 层厚 / 模板在 params 里，参数变了重渲染
  const job = currentJob();
  const [open, setOpen] = useState(false);
  if (!job) return null;
  const m = materialById(job.materialId);
  const hasSup = (state.supportPoints || []).length > 0;
  const stale = hasSup && !state.analysis;   // 层厚改过、分析已作废：支撑还是按旧层厚出的
  const busy = app.busy === 'template' || app.busy === 'generate';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="pdChip" aria-label="材料与工艺">
        <Swatch material={m} size={16} />
        <span className="pdChipText">{m.name}</span>
        <span className="pdChipSub">{job.layerUm} µm · {templateName(job.templateId)}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="pdPop pdPop--material">
        <div className="pdPopHead">
          <b>材料与工艺</b>
          <span>工程保存的是参数快照，材料库以后改了也不影响这个工程。</span>
        </div>
        <div className="pdPopList" role="listbox" aria-label="材料">
          {MATERIALS.map(x => {
            const on = x.id === job.materialId;
            return (
              <button key={x.id} type="button" role="option" aria-selected={on} className={on ? 'is-on' : ''} onClick={() => setMaterial(x.id)}>
                <Swatch material={x} size={22} />
                <span className="pdPopMain">
                  <b>{x.name}</b>
                  <small>{x.note} · {x.layers.join(' / ')} µm · 默认{templateName(x.template)}</small>
                </span>
                {on ? <Check size={15} className="pdPopCheck" /> : null}
              </button>
            );
          })}
        </div>
        <div className="pdPopField">
          <span>层厚</span>
          <SegmentedControl label="层厚" value={String(job.layerUm)} onValueChange={v => setLayer(+v)}
            options={m.layers.map(u => ({ value: String(u), label: `${u} µm` }))} />
        </div>
        <div className="pdPopField">
          <span>支撑模板</span>
          <SegmentedControl label="支撑模板" value={job.templateId || 'custom'} onValueChange={v => { if (v !== 'custom') setTemplate(v); }}
            options={[...TEMPLATES.map(t => ({ value: t.id, label: t.name })), ...(job.templateId ? [] : [{ value: 'custom', label: '自定义' }])]} />
        </div>
        {busy ? <p className="pdPopNote"><RefreshCw size={13} className="pdSpin" />按新模板重新生成支撑…</p> : null}
        {stale && !busy ? (
          <div className="pdPopNotice">
            <span>层厚改了，现在的支撑还是按原来的层厚生成的。</span>
            <Button variant="secondary" size="sm" onClick={() => { generate(); setOpen(false); }}>重新生成</Button>
          </div>
        ) : null}
        {!busy && !stale && hasSup ? <p className="pdPopNote">换支撑模板会按新参数重新布点、生成结构；手动加的点保留。</p> : null}
      </PopoverContent>
    </Popover>
  );
}
