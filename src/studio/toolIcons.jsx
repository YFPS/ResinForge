/* 视口工具栏图标。做法对齐 Arc icon-morph：同一枚图标在两态之间弹簧变形
   （线条滑动、轮廓插值、偶发一次的小动作），而不是换成另一套符号，也不另画三角。
   图标只是装饰，名字在按钮上。live 为假时跳过入场，避免首帧自己转一下。 */
import { useState, useSyncExternalStore } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { motionTokens } from '@/components/arc/motion-tokens';

const { spring } = motionTokens;
const instant = { duration: 0 };
const subscribe = () => () => {};

function useReducedFlag() {
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  return !!useReducedMotion() && hydrated;
}

/** state 每次从关到开记一次，用来重放一次性动作（星光、瞄准脉冲）。 */
function useTurnOns(state) {
  const [previous, setPrevious] = useState(state);
  const [count, setCount] = useState(0);
  if (previous !== state) {
    setPrevious(state);
    if (state) setCount(value => value + 1);
  }
  return count;
}

function Frame({ size = 18, strokeWidth = 1.75, style, children }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', overflow: 'visible', ...style }}
    >
      {children}
    </svg>
  );
}

function morph(reduced) {
  return reduced ? instant : spring.morph;
}

/* ---------- 旋转视角：整枚轴线转一个角度，笔画不变 ---------- */
const ORBIT = ['M5 3 L5 19 L21 19', 'M5 19 L11 13', 'M2 6 L5 3 L8 6', 'M18 16 L21 19 L18 22'];

export function OrbitIcon({ state = false, size, strokeWidth }) {
  const reduced = useReducedFlag();
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      <motion.g
        style={{ transformBox: 'view-box', transformOrigin: '12px 12px' }}
        initial={false}
        animate={{ rotate: state ? -28 : 0 }}
        transition={morph(reduced)}
      >
        {ORBIT.map(d => <path key={d} d={d} />)}
      </motion.g>
    </Frame>
  );
}

/* ---------- 保护面：笔杆倾斜，星光拉长，点亮时爆一下 ---------- */
const WAND = 'm21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72';
const SPARKS = [
  ['M5 6 L5 10', 'M5 5 L5 11'],
  ['M3 8 L7 8', 'M2 8 L8 8'],
  ['M19 14 L19 18', 'M19 13 L19 19'],
  ['M17 16 L21 16', 'M16 16 L22 16'],
  ['M10 2 L10 4', 'M10 1 L10 5'],
  ['M9 3 L11 3', 'M8 3 L12 3'],
];
const BURST = [
  { x: -8, y: -6 },
  { x: 7, y: -7 },
  { x: 9, y: 2 },
  { x: -6, y: 7 },
  { x: 2, y: -9 },
];

export function WandIcon({ state = false, live = false, size, strokeWidth }) {
  const reduced = useReducedFlag();
  const t = morph(reduced);
  const intro = live && !reduced;
  const flashes = useTurnOns(state);
  const burst = flashes > 0 && state && !reduced;
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      <motion.g
        style={{ transformBox: 'view-box', transformOrigin: '12px 12px' }}
        initial={intro ? { rotate: 0 } : false}
        animate={{ rotate: state ? -16 : 0 }}
        transition={t}
      >
        <path d={WAND} />
        <path d="M14 7 L17 10" />
      </motion.g>
      {SPARKS.map(([rest, on], index) => (
        <motion.path
          key={index}
          d={rest}
          initial={intro ? { d: rest } : false}
          animate={{ d: state ? on : rest }}
          transition={t}
        />
      ))}
      {burst && BURST.map((spark, index) => (
        <motion.circle
          key={`${flashes}-${index}`}
          cx={12}
          cy={12}
          r={1.1}
          fill="currentColor"
          stroke="none"
          initial={{ x: spark.x * 0.3, y: spark.y * 0.3, opacity: 1, scale: 1 }}
          animate={{ x: spark.x, y: spark.y, opacity: 0, scale: 0.3 }}
          transition={{ duration: 0.5, ease: [...motionTokens.ease.enter] }}
        />
      ))}
    </Frame>
  );
}

/* ---------- 笔刷：整枚随半径微微放大，点亮时笔杆立起来 ---------- */
const BRUSH = [
  'M18.37 2.63 14 7l-1.59-1.59a2 2 0 0 0-2.82 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.82L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3Z',
  'M9 8c-2 3-4 3.5-7 4l8 10c2-1 6-5 6-7',
  'M14.5 17.5 4.5 15',
];

export function BrushIcon({ state = false, size, strokeWidth }) {
  const reduced = useReducedFlag();
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      <motion.g
        style={{ transformBox: 'view-box', transformOrigin: '12px 12px' }}
        initial={false}
        animate={{ rotate: state ? -12 : 0, scale: state ? 1.06 : 1 }}
        transition={morph(reduced)}
      >
        {BRUSH.map(d => <path key={d} d={d} />)}
      </motion.g>
    </Frame>
  );
}

/* ---------- 支撑柱：上框接触端，下框主干，都是实心。
   手动支撑两段都用工具栏墨色。选中时接触端落下、主干向下长，像把支撑放上去。
   删支撑只把接触端填红。选中时红头抬起并略倾斜，主干从顶端缩短，像把接触端拔掉。 ---------- */
const SUPPORT_RED = '#fb3838';
const PILLAR = { x: 9, w: 6, capH: 5.4 };

function SupportMark({ state = false, live = false, size, strokeWidth, cap, pose }) {
  const reduced = useReducedFlag();
  const t = morph(reduced);
  const intro = live && !reduced;
  const to = state ? pose.on : pose.rest;
  // motion 的 y 是 CSS 像素，要按图标尺寸从 viewBox 换算，否则两截会离得很开
  const unit = (size || 18) / 24;
  const capAt = (poseRow) => ({ y: poseRow.capY * unit, scale: poseRow.scale, rotate: poseRow.rotate });
  const shaftAt = (poseRow) => ({ y: poseRow.shaftY * unit, height: poseRow.shaftH });
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      <motion.rect
        x={PILLAR.x}
        width={PILLAR.w}
        height={PILLAR.capH}
        fill={cap}
        stroke="none"
        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        initial={intro ? capAt(pose.rest) : false}
        animate={capAt(to)}
        transition={t}
      />
      <motion.rect
        x={PILLAR.x}
        width={PILLAR.w}
        fill="currentColor"
        stroke="none"
        initial={intro ? shaftAt(pose.rest) : false}
        animate={shaftAt(to)}
        transition={t}
      />
    </Frame>
  );
}

export function AddIcon(props) {
  return (
    <SupportMark
      {...props}
      cap="currentColor"
      pose={{
        rest: { capY: 1.0, scale: 1, rotate: 0, shaftY: 9.0, shaftH: 13.2 },
        on: { capY: 3.0, scale: 1, rotate: 0, shaftY: 9.2, shaftH: 14.6 },
      }}
    />
  );
}

export function DelIcon(props) {
  return (
    <SupportMark
      {...props}
      cap={SUPPORT_RED}
      pose={{
        rest: { capY: 1.0, scale: 1, rotate: 0, shaftY: 9.0, shaftH: 13.2 },
        on: { capY: -2.8, scale: 0.76, rotate: -14, shaftY: 11.6, shaftH: 10.6 },
      }}
    />
  );
}

/* ---------- 显示：三只盒子分开；曲线画出；圆点胀开 ---------- */
const BOX_LEFT = [
  'M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z',
  'm7 16.5-4.74-2.85',
  'm7 16.5 5-3',
  'M7 16.5v5.17',
];
const BOX_RIGHT = [
  'M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z',
  'm17 16.5-5-3',
  'm17 16.5 4.74-2.85',
  'M17 16.5v5.17',
];
const BOX_TOP = [
  'M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z',
  'M12 8 7.26 5.15',
  'm12 8 4.74-2.85',
  'M12 13.5V8',
];

function BoxGroup({ paths, x, y, intro, t }) {
  return (
    <motion.g initial={intro ? { x: 0, y: 0 } : false} animate={{ x, y }} transition={t}>
      {paths.map(d => <path key={d} d={d} />)}
    </motion.g>
  );
}

export function BoxesIcon({ state = false, live = false, size, strokeWidth }) {
  const reduced = useReducedFlag();
  const t = morph(reduced);
  const intro = live && !reduced;
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      <BoxGroup paths={BOX_LEFT} x={state ? -5 : 0} y={state ? 4 : 0} intro={intro} t={t} />
      <BoxGroup paths={BOX_RIGHT} x={state ? 5 : 0} y={state ? 4 : 0} intro={intro} t={t} />
      <BoxGroup paths={BOX_TOP} x={0} y={state ? -5 : 0} intro={intro} t={t} />
    </Frame>
  );
}

export function SplineIcon({ state = false, live = false, size, strokeWidth }) {
  const reduced = useReducedFlag();
  const t = morph(reduced);
  const intro = live && !reduced;
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      <motion.circle
        cx={19}
        cy={5}
        r={2}
        initial={intro ? { scale: 0.2 } : false}
        animate={{ scale: state ? 1.45 : 1 }}
        style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
        transition={t}
      />
      <motion.circle
        cx={5}
        cy={19}
        r={2}
        initial={intro ? { scale: 0.2 } : false}
        animate={{ scale: state ? 1.45 : 1 }}
        style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
        transition={t}
      />
      <motion.path
        d="M5 17A12 12 0 0 1 17 5"
        initial={intro ? { pathLength: 0 } : false}
        animate={{ pathLength: 1 }}
        transition={t}
      />
    </Frame>
  );
}

/** 多线段：折线。选中时折角再拉开一点。 */
export function PolyIcon({ state = false, live = false, size, strokeWidth }) {
  const reduced = useReducedFlag();
  const t = morph(reduced);
  const intro = live && !reduced;
  const rest = 'M4 16 L9 8 L15 16 L20 8';
  const on = 'M3 18 L9 5 L15 18 L21 5';
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      <motion.path d={rest} initial={intro ? { d: rest } : false} animate={{ d: state ? on : rest }} transition={t} />
    </Frame>
  );
}

export function DotIcon({ state = false, live = false, size, strokeWidth }) {
  const reduced = useReducedFlag();
  const t = morph(reduced);
  const intro = live && !reduced;
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      <motion.circle cx={12} cy={12} r={10} initial={intro ? { r: 10 } : false} animate={{ r: state ? 7.2 : 10 }} transition={t} />
      <motion.circle cx={12} cy={12} r={1} initial={intro ? { r: 1 } : false} animate={{ r: state ? 3.6 : 1 }} transition={t} />
    </Frame>
  );
}

/* ---------- 变换：移动箭头外扩；旋转箭头绕到对面；缩放角拉开 ---------- */
const MOVE_REST = ['M12 2 L12 22', 'M15 19 L12 22 L9 19', 'M19 9 L22 12 L19 15', 'M2 12 L22 12', 'M5 9 L2 12 L5 15', 'M9 5 L12 2 L15 5'];
const MOVE_ON = ['M12 -2 L12 26', 'M16 22 L12 27 L8 22', 'M21 7 L27 12 L21 17', 'M-2 12 L26 12', 'M3 7 L-3 12 L3 17', 'M8 2 L12 -3 L16 2'];

export function MoveIcon({ state = false, live = false, size, strokeWidth }) {
  const reduced = useReducedFlag();
  const t = morph(reduced);
  const intro = live && !reduced;
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      {MOVE_REST.map((d, index) => (
        <motion.path key={index} d={d} initial={intro ? { d } : false} animate={{ d: state ? MOVE_ON[index] : d }} transition={t} />
      ))}
    </Frame>
  );
}

const ROTATE = [
  'm15.194 13.707 3.814 1.86-1.86 3.814',
  'M16.47214 7.52786 A 5 10 0 1 0 13 21.79796',
  'M21.79796 11 A 10 5 0 1 0 19 15.57071',
];

export function RotateIcon({ state = false, live = false, size, strokeWidth }) {
  const reduced = useReducedFlag();
  const intro = live && !reduced;
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      <motion.g
        style={{ transformBox: 'view-box', transformOrigin: '12px 12px' }}
        initial={intro ? { rotate: 0 } : false}
        animate={{ rotate: state ? 32 : 0 }}
        transition={morph(reduced)}
      >
        {ROTATE.map(d => <path key={d} d={d} />)}
      </motion.g>
    </Frame>
  );
}

const SCALE_BOX = 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7';
const SCALE_REST = ['M14 15 H9 V10', 'M16 3 H21 V8', 'M21 3 L9 15'];
const SCALE_ON = ['M16 18 H6 V8', 'M15 1 H23 V7', 'M23 1 L6 18'];

export function ScaleIcon({ state = false, live = false, size, strokeWidth }) {
  const reduced = useReducedFlag();
  const t = morph(reduced);
  const intro = live && !reduced;
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      <path d={SCALE_BOX} />
      {SCALE_REST.map((d, index) => (
        <motion.path key={index} d={d} initial={intro ? { d } : false} animate={{ d: state ? SCALE_ON[index] : d }} transition={t} />
      ))}
    </Frame>
  );
}

/* ---------- 简化：四角往中心收 ---------- */
const SHRINK = [
  'm15 15 6 6m-6-6v4.8m0-4.8h4.8',
  'M9 19.8V15m0 0H4.2M9 15l-6 6',
  'M15 4.2V9m0 0h4.8M15 9l6-6',
  'M9 4.2V9m0 0H4.2M9 9 3 3',
];

export function ShrinkIcon({ state = false, size, strokeWidth }) {
  const reduced = useReducedFlag();
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      <motion.g
        style={{ transformBox: 'view-box', transformOrigin: '12px 12px' }}
        initial={false}
        animate={{ scale: state ? 0.72 : 1 }}
        transition={morph(reduced)}
      >
        {SHRINK.map(d => <path key={d} d={d} />)}
      </motion.g>
    </Frame>
  );
}

/* ---------- 热力图：指针从右上扫到左上，点亮后用强调色 ---------- */
export function GaugeIcon({ state = false, live = false, size, strokeWidth }) {
  const reduced = useReducedFlag();
  const t = morph(reduced);
  const intro = live && !reduced;
  const rest = 'M12 14 L16 10';
  const on = 'M12 14 L7 9';
  return (
    <Frame size={size} strokeWidth={strokeWidth} style={state ? { color: 'var(--accent)' } : undefined}>
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
      <motion.path d={rest} initial={intro ? { d: rest } : false} animate={{ d: state ? on : rest }} transition={t} />
    </Frame>
  );
}

/* ---------- 视角复位：圆从中心胀开，刻度向外弹一下 ---------- */
export function FrameIcon({ pulse = 0, size, strokeWidth }) {
  const reduced = useReducedFlag();
  const play = pulse > 0 && !reduced;
  const flick = { duration: 0.46, ease: [...motionTokens.ease.enter] };
  const ticks = [
    { x1: 12, x2: 12, y1: 6, y2: 2, axis: 'y', dir: -1 },
    { x1: 12, x2: 12, y1: 22, y2: 18, axis: 'y', dir: 1 },
    { x1: 6, x2: 2, y1: 12, y2: 12, axis: 'x', dir: -1 },
    { x1: 22, x2: 18, y1: 12, y2: 12, axis: 'x', dir: 1 },
  ];
  return (
    <Frame size={size} strokeWidth={strokeWidth}>
      <motion.circle
        key={`ring-${pulse}`}
        cx={12}
        cy={12}
        r={10}
        style={{ transformBox: 'fill-box', transformOrigin: '50% 50%' }}
        initial={play ? { scale: 0.45, opacity: 0.35 } : false}
        animate={{ scale: 1, opacity: 1 }}
        transition={play ? flick : instant}
      />
      {ticks.map(tick => (
        <motion.line
          key={`${tick.axis}${tick.dir}-${pulse}`}
          x1={tick.x1}
          x2={tick.x2}
          y1={tick.y1}
          y2={tick.y2}
          initial={play ? { [tick.axis]: 0 } : false}
          animate={play ? { [tick.axis]: [0, tick.dir * 5, 0] } : { [tick.axis]: 0 }}
          transition={play ? flick : instant}
        />
      ))}
    </Frame>
  );
}
