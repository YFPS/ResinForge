/* 第 2 步 · 朝向：采样数与保护面 → 开始优化 → 候选缩略图直接在这里点选应用。
   保护面的「涂画」开关与视口左上角的模式切换是同一个状态（core 的 mode）。 */
import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Compass } from 'lucide-react';
import Badge from '@/components/arc/badge/badge';
import Button from '@/components/arc/button/button';
import { motionTokens } from '@/components/arc/motion-tokens';
import { state } from '../../../store.js';
import { setMode, clearProtectedFaces } from '../../../core/scene.js';
import { useBusLatest, useBusValue, useParams } from '../../bridge.js';
import { splitModelName } from '../../actions.js';
import { doApplyCandidate, doOrient } from '../../actions.js';
import { STEPS, runTask, useDone, useUI } from '../../ui.js';
import { Choice, Grid, Num, Section, SwitchRow } from '../fields.jsx';
import { NextButton, StepPanel } from '../StepPanel.jsx';

const STEP = STEPS[1];

const QUALITY = [
  { value: '32', label: '快速', accessory: <span className="segMeta">32</span> },
  { value: '64', label: '标准', accessory: <span className="segMeta">64</span> },
  { value: '128', label: '精细', accessory: <span className="segMeta">128</span> },
];

const LAY_DIRS = [
  { value: 'down', label: '面朝下' },
  { value: 'up', label: '面朝上' },
];

/* hideQuality：Studio 把采样数这一节收起来了（沿用默认的 64），面板只留候选、保护面与主操作。
   protectInToolbar：Studio 把「涂画保护面」开关与笔刷参数搬进视口工具坞（保护面按钮上方的浮层），面板只留计数与清除。 */
export default function OrientStep({ hideQuality = false, protectInToolbar = false }) {
  const [params, setParam] = useParams();
  const cands = useBusLatest('orientResults', null);
  const info = useBusLatest('modelInfo', null);
  const mode = useBusLatest('mode', 'orbit');
  const protCount = useBusValue(['protectedChanged', 'modelInfo'], () => state.protectedFaces.size);
  const done = useDone();
  const { busy } = useUI();
  const reduced = useReducedMotion();
  const running = busy === 'orient';
  const hasCands = !!cands && cands.length > 0;

  return (
    <StepPanel
      step={STEP}
      footer={(
        <>
          <Button
            variant="primary"
            size="md"
            loading={running}
            disabled={!!busy && !running}
            onClick={() => runTask('orient', doOrient)}
          >
            <Compass size={16} strokeWidth={1.75} aria-hidden="true" />
            {done.orient || hasCands ? '重新优化' : '开始朝向优化'}
          </Button>
          <NextButton from={STEP.id} emphasized={done.orient} />
        </>
      )}
    >
      <AnimatePresence initial={false}>
        {hasCands && (
          <motion.div
            key="cands"
            className="candWrap"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0, transition: { duration: motionTokens.duration.exit, ease: [...motionTokens.ease.exit] } }}
            transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}
          >
            <Section title="候选朝向" aside={<span className="secMeta">点选即换上</span>}>
              <div className="candGrid">
                {cands.map(c => (
                  <button
                    key={c.idx}
                    type="button"
                    className={'cand' + (c.isBest ? ' best' : '') + (c.applied ? ' on' : '')}
                    disabled={!!busy}
                    aria-pressed={!!c.applied}
                    onClick={() => runTask('orient-apply', () => doApplyCandidate(c.idx))}
                    aria-label={`应用评分 ${Math.round(c.score)} 的朝向`}
                    title={`支撑体积 ${c.supportVol?.toFixed?.(1)} mm³ · 陡峭悬空 ${c.steepArea?.toFixed?.(1)} mm²`}
                  >
                    <img src={c.img} alt="" />
                    <span className="candFoot">
                      <span className="candScore tnum">{Math.round(c.score)}</span>
                      {c.isBest ? <Badge tone="info" size="sm">最佳</Badge> : null}
                    </span>
                  </button>
                ))}
              </div>
            </Section>
          </motion.div>
        )}
      </AnimatePresence>

      {!hideQuality && (
        <Section
          title="优化"
          help={info && info.parts && info.parts.length > 1
            ? `只优化当前模型「${splitModelName(info.parts.find(p => p.id === info.activeId) || info.parts[0]).name}」。采样越多越慢。`
            : '采样越多越可能找到好朝向，也越慢。'}
        >
          <Choice
            label="采样数"
            options={QUALITY}
            value={String(params.orientQuality)}
            onChange={v => setParam('orientQuality', Number(v))}
          />
        </Section>
      )}

      <Section title="保护面" aside={<Badge size="sm">{protCount.toLocaleString('zh-CN')} 面</Badge>}>
        {!protectInToolbar && (
          <>
            <SwitchRow
              label="涂画保护面"
              help="在模型上按住拖动。涂过的面不长支撑，朝向评分也会避开它。"
              checked={mode === 'paint'}
              onChange={on => setMode(on ? 'paint' : 'orbit')}
            />
            <Grid>
              <Num k="brushR" label="笔刷半径" min={0.5} max={12} step={0.5} unit="mm" />
              <Num k="protW" label="评分权重" min={0} max={30} step={1} unit="×" />
            </Grid>
          </>
        )}
        <div className="rowStart">
          <Button variant="secondary" size="sm" disabled={!protCount} onClick={clearProtectedFaces}>清除保护面</Button>
        </div>
      </Section>

      <Section title="按面放置" help="点模型上朝向你的一个面，这个面转到所选方向，整件模型的最低点落到平台，位置不动。只动点中的这一件；它已有支撑时会先问你。快捷键 F。">
        <Choice
          label="方向"
          options={LAY_DIRS}
          value={params.layFace === 'up' ? 'up' : 'down'}
          onChange={v => setParam('layFace', v)}
        />
        <div className="rowStart">
          <Button
            variant={mode === 'lay' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setMode(mode === 'lay' ? 'orbit' : 'lay')}
          >
            {mode === 'lay' ? '正在按面放置' : '按面放置'}
          </Button>
        </div>
      </Section>
    </StepPanel>
  );
}
