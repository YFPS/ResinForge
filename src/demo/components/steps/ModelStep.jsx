/* 第 1 步 · 模型：当前模型概况（面数、尺寸、能否放进当前打印机）+ 演示模型。
   拖放由 core 在整个窗口上处理，这里只给「打开文件」按钮和提示。 */
import React from 'react';
import { CircleCheck, FolderOpen, TriangleAlert } from 'lucide-react';
import Badge from '@/components/arc/badge/badge';
import Button from '@/components/arc/button/button';
import { RadioCards } from '@/components/arc/radio-cards/radio-cards';
import { state } from '../../../store.js';
import { useBusLatest, useBusValue } from '../../bridge.js';
import { DEMOS, doLoadDemo, pickSTL, splitModelName } from '../../actions.js';
import { currentMachine, useMachine } from '../../machines.js';
import { STEPS, runTask, useDone, useUI } from '../../ui.js';
import { Section } from '../fields.jsx';
import { NextButton, StepPanel } from '../StepPanel.jsx';

const STEP = STEPS[0];
const fmt = n => (Math.round(n * 10) / 10).toString();

/* 包围盒尺寸：换模型（modelInfo）和应用朝向（orientResults 清空）都会改变几何 */
function readSize() {
  const bb = state.mesh && state.mesh.geometry.boundingBox;
  if (!bb) return '';
  return [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].map(fmt).join('|');
}

export default function ModelStep() {
  const info = useBusLatest('modelInfo', null);
  const sizeKey = useBusValue(['modelInfo', 'orientResults'], readSize);
  const machine = useMachine();
  const done = useDone();
  const { busy } = useUI();

  const { name, demo } = splitModelName(info && info.name);
  const demoKind = demo ? (DEMOS.find(d => d.label === name) || {}).kind : null;
  const [sx, sy, sz] = sizeKey ? sizeKey.split('|').map(Number) : [0, 0, 0];
  const fitsX = sx <= machine.plateX, fitsZ = sz <= machine.plateZ;
  const m = currentMachine(machine);
  const plateName = m ? (m.name || m.model) : '当前机型';

  return (
    <StepPanel
      step={STEP}
      footer={(
        <>
          <Button variant="primary" size="md" onClick={pickSTL}>
            <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />
            打开 STL 文件
          </Button>
          <NextButton from={STEP.id} emphasized={done.model && !demo} />
        </>
      )}
    >
      <Section title="当前模型">
        {info ? (
          <div className="modelCard">
            <div className="mcTop">
              <span className="mcName" title={name}>{name}</span>
              {demo ? <Badge size="sm">演示</Badge> : null}
            </div>
            <div className="mcMeta tnum">
              {Math.round(info.nf).toLocaleString('zh-CN')} 个三角面 · {fmt(sx)} × {fmt(sy)} × {fmt(sz)} mm
            </div>
            <div className={'mcFit' + (fitsX && fitsZ ? '' : ' warn')}>
              {fitsX && fitsZ ? (
                <>
                  <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />
                  <span className="mcFitText">放得进 {plateName}</span>
                  <span className="mcFitDim tnum">{machine.plateX} × {machine.plateZ} mm</span>
                </>
              ) : (
                <>
                  <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
                  <span className="mcFitText">
                    超出 {plateName} 的板面：
                    {!fitsX ? `X 多 ${fmt(sx - machine.plateX)} mm` : ''}
                    {!fitsX && !fitsZ ? '，' : ''}
                    {!fitsZ ? `Z 多 ${fmt(sz - machine.plateZ)} mm` : ''}
                  </span>
                </>
              )}
            </div>
          </div>
        ) : (
          <p className="secDesc">还没有模型。</p>
        )}
        <p className="hint">也可以把 .stl 直接拖进视口。文件只在本机处理，不会上传。</p>
      </Section>

      <Section title="演示模型" desc="各自代表一类典型的支撑难点。">
        <RadioCards
          aria-label="演示模型"
          layout="grid"
          minColumnWidth={128}
          value={demoKind}
          disabled={!!busy}
          onValueChange={kind => runTask('demo', () => doLoadDemo(kind))}
          options={DEMOS.map(d => ({ value: d.kind, label: d.label, description: d.hint }))}
        />
      </Section>
    </StepPanel>
  );
}
