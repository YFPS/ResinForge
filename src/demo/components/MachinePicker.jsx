/* 顶栏的打印机入口。点开后进设备页选机型和材料，选中按「应用」才写入板面。 */
import React from 'react';
import { ChevronDown, Printer } from 'lucide-react';
import Button from '@/components/arc/button/button';
import Tooltip from '@/components/arc/tooltip/tooltip';
import { currentMachine, useMachine } from '../machines.js';

export default function MachinePicker() {
  const machine = useMachine();
  const current = currentMachine(machine);
  const chipText = current ? (current.name || current.model) : '自定义机型';
  return (
    <Tooltip content="打印机与材料" side="bottom">
      <Button
        variant="secondary"
        size="sm"
        className="chipBtn"
        aria-label={`打印机：${chipText}`}
        onClick={() => window.dispatchEvent(new Event('resinforge:open-machine'))}
      >
        <Printer size={15} strokeWidth={1.75} aria-hidden="true" />
        <span className="chipText">{chipText}</span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className="chipChevron" />
      </Button>
    </Tooltip>
  );
}
