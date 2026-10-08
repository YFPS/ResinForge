/* 顶栏的打印机选择：Popover 里选机型（选中即写入板面 X / Z 与像素），或切到「自定义」手填。
   自定义参数可命名保存到浏览器本地；保存走 Popover 内联输入，不再弹二层对话框。
   选「自定义…」不改变当前参数，方便以现有机器为模板微调。 */
import React, { useState } from 'react';
import { ChevronDown, Printer } from 'lucide-react';
import Button from '@/components/arc/button/button';
import { Input } from '@/components/arc/input/input';
import { NumberField } from '@/components/arc/number-field/number-field';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/arc/popover/popover';
import { Select } from '@/components/arc/select/select';
import Tooltip from '@/components/arc/tooltip/tooltip';
import {
  BUILTIN_MACHINES, CUSTOM_ID, currentMachine, deleteMachine, machineLabel,
  saveCustomMachine, selectMachine, setMachineParam, useMachine,
} from '../machines.js';

const limitHint = (edge, limit) => (edge === 'max' ? `最大 ${limit}` : `最小 ${limit}`);
/* 步长取整数便于点按，但显示保留一位小数：厂商规格多为 218.9 / 34.4 这类数，按步长精度会被显示成 219 */
const ONE_DECIMAL = { maximumFractionDigits: 1 };

export default function MachinePicker() {
  const machine = useMachine();
  const [name, setName] = useState('');
  const current = currentMachine(machine);
  const custom = !current;
  const isSaved = !!current && machine.saved.some(m => m.id === current.id);
  const chipText = current ? (current.name || current.model) : '自定义机型';

  const num = (key, label, min, max, step, unit) => (
    <NumberField
      size="sm"
      scrub
      label={label}
      value={machine[key]}
      min={min}
      max={max}
      step={step}
      suffix={unit}
      limitHint={limitHint}
      formatOptions={ONE_DECIMAL}
      onValueChange={v => setMachineParam(key, v)}
    />
  );

  const commitSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // 结果原地可见：下拉框切到新机型（带 ★），顶栏标签同步变成它的名字
    saveCustomMachine(trimmed);
    setName('');
  };

  return (
    <Popover>
      <Tooltip content="打印机与板面" side="bottom">
        <PopoverTrigger asChild>
          <Button variant="secondary" size="sm" className="chipBtn" aria-label={`打印机：${chipText}`}>
            <Printer size={15} strokeWidth={1.75} aria-hidden="true" />
            <span className="chipText">{chipText}</span>
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="chipChevron" />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="machinePanel">
        <div className="mpHead">
          <span className="mpTitle">打印机</span>
          <span className="mpSpec tnum">{machine.plateX} × {machine.plateZ} mm · {machine.pixelUm} µm</span>
        </div>
        <Select
          label="机型"
          value={current ? current.id : CUSTOM_ID}
          onValueChange={selectMachine}
          options={[
            ...BUILTIN_MACHINES.map(m => ({ value: m.id, label: machineLabel(m) })),
            ...machine.saved.map(m => ({ value: m.id, label: `★ ${machineLabel(m)}` })),
            { value: CUSTOM_ID, label: '自定义…' },
          ]}
        />
        {custom ? (
          <>
            <div className="fieldGrid">
              {num('plateX', '板面 X', 50, 400, 1, 'mm')}
              {num('plateZ', '板面 Z', 50, 400, 1, 'mm')}
              {num('pixelUm', 'XY 像素', 10, 100, 1, 'µm')}
            </div>
            <div className="mpSave">
              <Input
                label="保存为机型"
                placeholder="如：车间 3 号机"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') commitSave(); }}
              />
              <Button variant="secondary" size="md" disabled={!name.trim()} onClick={commitSave}>保存</Button>
            </div>
            <p className="hint">保存在这个浏览器里，换设备或清除缓存后会丢失。</p>
          </>
        ) : (
          <p className="hint">板面尺寸用于越界检查，像素用于分析精度提示。</p>
        )}
        {isSaved ? (
          <div className="mpRow">
            <Button
              variant="danger"
              size="sm"
              onClick={() => deleteMachine(current.id)}
            >
              删除这个机型
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
