/* 第 1 步 · 模型：当前模型概况（面数、尺寸、能否放进当前打印机）+ 简化 + 演示模型。
   拖放由 core 在整个窗口上处理，这里只给「打开文件」按钮和提示。 */
import { CircleCheck, Crosshair, FolderOpen, FolderPlus, TriangleAlert } from 'lucide-react';
import Badge from '@/components/arc/badge/badge';
import Button from '@/components/arc/button/button';
import { RadioCards } from '@/components/arc/radio-cards/radio-cards';
import { state, params } from '../../../store.js';
import { useBusLatest, useBusValue } from '../../bridge.js';
import { DEMOS, doLoadDemo, focusModel, pickSTL, splitModelName } from '../../actions.js';
import { currentMachine, useMachine } from '../../machines.js';
import { STEPS, runTask, useDone, useUI } from '../../ui.js';
import { Section } from '../fields.jsx';
import Simplifier from '../Simplifier.jsx';
import { NextButton, StepPanel } from '../StepPanel.jsx';

const STEP = STEPS[0];
const fmt = n => (Math.round(n * 10) / 10).toString();

/* 包围盒尺寸：换模型（modelInfo）和应用朝向（orientResults 清空）都会改变几何 */
function readSize() {
  const bb = state.mesh && state.mesh.geometry.boundingBox;
  if (!bb) return '';
  return [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].map(fmt).join('|');
}

export default function ModelStep({ hideCurrentModel = false, hideSimplify = false }) {
  const info = useBusLatest('modelInfo', null);
  const sizeKey = useBusValue(['modelInfo', 'orientResults'], readSize);
  const machine = useMachine();
  const done = useDone();
  const { busy } = useUI();
  const { name, demo } = splitModelName(info && info.name);
  const demoKind = demo ? (DEMOS.find(d => d.label === name) || {}).kind : null;
  const [sx, sy, sz] = sizeKey ? sizeKey.split('|').map(Number) : [0, 0, 0];
  const fitsX = sx <= machine.plateX + 0.6, fitsZ = sz <= machine.plateZ + 0.6;
  const fitsY = sy + (params.raiseH || 0) <= (machine.plateY || 175) + 0.6;
  const many = info && info.parts && info.parts.length > 1;
  const m = currentMachine(machine);
  const plateName = m ? (m.name || m.model) : '当前机型';

  return (
    <StepPanel
      step={STEP}
      footer={(
        <>
          <Button variant="primary" size="md" onClick={() => pickSTL(false)}>
            <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />
            打开模型文件
          </Button>
          <NextButton from={STEP.id} emphasized={done.model && !demo} />
        </>
      )}
    >
      {!hideCurrentModel ? (
        <Section title="当前模型">
          {info ? (
            <div className="modelCard">
              <div className="mcTop">
                <span className="mcName" title={name}>{name}</span>
                {demo ? <Badge size="sm">演示</Badge> : null}
              </div>
              <div className="mcMeta tnum">
                {Math.round(info.nf).toLocaleString('zh-CN')} 个三角面
                {info.nfFull > info.nf ? `（原 ${Math.round(info.nfFull).toLocaleString('zh-CN')}）` : ''}
                {' '}· {fmt(sx)} × {fmt(sz)} × {fmt(sy)} mm
              </div>
              <div className={'mcFit' + (fitsX && fitsZ && fitsY ? '' : ' warn')}>
                {fitsX && fitsZ && fitsY ? (
                  <>
                    <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span className="mcFitText">放得进 {plateName}</span>
                    <span className="mcFitDim tnum">{fmt(machine.plateX)} × {fmt(machine.plateZ)} × {fmt(machine.plateY)}</span>
                  </>
                ) : (
                  <>
                    <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
                    <span className="mcFitText">
                      超出 {plateName}：
                      {!fitsX ? `X 多 ${fmt(sx - machine.plateX)} mm` : ''}
                      {!fitsX && !fitsZ ? '，' : ''}
                      {!fitsZ ? `Y 多 ${fmt(sz - machine.plateZ)} mm` : ''}
                      {(!fitsX || !fitsZ) && !fitsY ? '，' : ''}
                      {!fitsY ? `Z 多 ${fmt(sy + (params.raiseH || 0) - machine.plateY)} mm` : ''}
                    </span>
                  </>
                )}
              </div>
            </div>
          ) : (
            <p className="secDesc">还没有模型。</p>
          )}
          {many ? (
            <div className="partList" role="list" aria-label="已载入的模型">
              {info.parts.map(p => (
                <button
                  key={p.id}
                  type="button"
                  role="listitem"
                  className={'partRow' + ((info.selectedIds && info.selectedIds.length ? info.selectedIds.includes(p.id) : info.activeId === p.id) ? ' active' : '')}
                  onClick={() => focusModel(p.id)}
                >
                  <Crosshair size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span className="partName" title={p.name}>{splitModelName(p.name).name}</span>
                  <span className="partMeta tnum">{fmt(p.sx)} × {fmt(p.sz)}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="rowStart">
            <Button variant="secondary" size="sm" onClick={() => pickSTL(true)}>
              <FolderPlus size={15} strokeWidth={1.75} aria-hidden="true" />
              追加模型
            </Button>
          </div>
        </Section>
      ) : null}

      {!hideSimplify ? (
        <Section title="简化" desc="去掉多余的三角面，文件更小，转动和移动也更顺。细节可能会少一些。">
          <Simplifier />
        </Section>
      ) : null}

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
