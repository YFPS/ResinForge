import React from 'react';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { useBusState } from '../bridge.js';
import { setMode } from '../../core/scene.js';

const MODES = [
  { value: 'orbit', label: '旋转' },
  { value: 'paint', label: '保护面' },
  { value: 'add', label: '加支撑' },
  { value: 'del', label: '删支撑' },
];

/* 视口模式：core 的 setMode 广播 'mode'，这里只做受控显示 */
export default function ModeBar() {
  const mode = useBusState('mode', 'orbit');
  return (
    <div className="modeBar">
      <SegmentedControl options={MODES} value={mode} onValueChange={setMode} label="视口模式" />
    </div>
  );
}
