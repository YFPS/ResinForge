/* 第 1 步 · 模型：当前模型概况（面数、尺寸、能否放进当前打印机）+ 简化 + 演示模型。
   拖放由 core 在整个窗口上处理，这里只给「打开文件」按钮和提示。 */
import { useState } from 'react';
import { CircleCheck, Crosshair, FolderOpen, FolderPlus, TriangleAlert } from 'lucide-react';
import Badge from '@/components/arc/badge/badge';
import Button from '@/components/arc/button/button';
import { RadioCards } from '@/components/arc/radio-cards/radio-cards';
import { Slider } from '@/components/arc/slider/slider';
import { state, params } from '../../../store.js';
import { useBusLatest, useBusValue } from '../../bridge.js';
import { DEMOS, doLoadDemo, doSimplify, focusModel, pickSTL, splitModelName } from '../../actions.js';
import { currentMachine, useMachine } from '../../machines.js';
import { STEPS, runTask, useDone, useUI } from '../../ui.js';
import { Choice, Section } from '../fields.jsx';
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
  const fitsX = sx <= machine.plateX + 0.6, fitsZ = sz <= machine.plateZ + 0.6;
  const fitsY = sy + (params.raiseH || 0) <= (machine.plateY || 175) + 0.6;
  const many = info && info.parts && info.parts.length > 1;
  const [simpMode, setSimpMode] = useState('fidelity');
  const [fidelity, setFidelity] = useState(5);
  const [ratioPct, setRatioPct] = useState(50);
  const simpIds = info
    ? ((info.selectedIds && info.selectedIds.length) ? info.selectedIds : (info.activeId ? [info.activeId] : []))
    : [];
  const beforeNf = info && info.parts
    ? info.parts.filter(p => simpIds.includes(p.id)).reduce((s, p) => s + (p.nf || 0), 0)
    : 0;
  const afterNf = Math.round(beforeNf * ratioPct / 100);
  const m = currentMachine(machine);
  const plateName = m ? (m.name || m.model) : '当前机型';

  return (
    <StepPanel
      step={STEP}
      footer={(
        <>
          <Button variant="primary" size="md" onClick={() => pickSTL(false)}>
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
        <p className="hint">可以一次选多个 .stl，也可以拖进视口。多个模型会按底面积从大到小自动排到板上。点列表里的名字，摄影机就跳到那个模型。单击模型即可选中。已经选中的模型上按住左键拖动，是在板面上移动。从空白处按住左键拖动会出现框线，松开后选中框到的模型。按住 Ctrl 再框是追加选中。Ctrl+A 全选，Delete 删除选中的模型。Ctrl+Z 撤回，Ctrl+Shift+Z 或 Ctrl+Y 重做。中键拖动平移视角，右键拖动旋转视角。只选中一个时，右键点在模型上可以沿坐标轴移动、旋转或放大缩小。放大缩小的尺寸面板在视口左侧，X、Y 在板面上，Z 是高度。</p>
      </Section>

      <Section title="简化" desc="去掉多余的三角面，文件更小，转动和移动也更顺。细节可能会少一些。">
        {info ? (
          <p className="simpStat tnum">
            简化前面数：{Math.round(beforeNf).toLocaleString('zh-CN')}
            {simpIds.length > 1 ? ` · ${simpIds.length} 个模型` : ''}
          </p>
        ) : (
          <p className="secDesc">载入模型后可以简化。</p>
        )}
        <Choice
          ariaLabel="简化方式"
          value={simpMode}
          onChange={setSimpMode}
          options={[
            { value: 'fidelity', label: '按保真度' },
            { value: 'ratio', label: '按面数比' },
          ]}
        />
        {simpMode === 'fidelity' ? (
          <>
            <div className="simpEnds"><span>简化多</span><span>简化少</span></div>
            <Slider
              label="保真度"
              min={1}
              max={10}
              step={0.01}
              value={fidelity}
              format={v => v.toFixed(2)}
              onValueChange={setFidelity}
            />
          </>
        ) : (
          <>
            <div className="simpEnds"><span>简化多</span><span>简化少</span></div>
            <Slider
              label="保留比例"
              min={1}
              max={99.99}
              step={0.01}
              value={ratioPct}
              format={v => `${v.toFixed(2)}%`}
              onValueChange={setRatioPct}
            />
            <p className="simpStat tnum">简化后面数：约 {afterNf.toLocaleString('zh-CN')}</p>
          </>
        )}
        <p className="hint">数值越高，减得越少，表面越接近原来的样子。简化的是当前选中的模型；没有多选时，简化正在使用的这一件。简化后需要重新分析和生成支撑。</p>
        <div className="rowStart">
          <Button
            variant="primary"
            size="sm"
            loading={busy === 'simplify'}
            disabled={!info || beforeNf < 8 || (!!busy && busy !== 'simplify')}
            onClick={() => runTask('simplify', () => doSimplify(
              simpMode === 'fidelity'
                ? { mode: 'fidelity', fidelity }
                : { mode: 'ratio', ratio: ratioPct / 100 },
            ))}
          >
            简化
          </Button>
        </div>
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
