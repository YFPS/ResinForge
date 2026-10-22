/* 侧栏参数面板的公共积木：分区、两列数值栅格、开关行、分段选择。
   控件全部是 Arc 组件，这里只负责排布，让五个步骤面板长得一模一样。 */
import React, { useId } from 'react';
import { CircleHelp } from 'lucide-react';
import { NumberField } from '@/components/arc/number-field/number-field';
import { Switch } from '@/components/arc/switch/switch';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { Tooltip } from '@/components/arc/tooltip/tooltip';
import { useParams } from '../bridge.js';

/** 圆圈问号。说明先藏起来，停在图标上才展开。 */
export function HelpTip({ text, label }) {
  if (!text) return null;
  return (
    <Tooltip content={text} side="top">
      <button type="button" className="helpTip" aria-label={`${label || '这项'}的说明`}>
        <CircleHelp size={13} strokeWidth={1.75} />
      </button>
    </Tooltip>
  );
}

/** 一个分区：标题（可带右侧附注）+ 可选说明 + 内容。分区之间由发丝线分隔。
    help 把说明收进标题旁的问号，不再占一行正文。 */
export function Section({ title, aside, desc, help, children }) {
  const id = useId();
  return (
    <section className="sec" aria-labelledby={id}>
      <div className="secHead">
        <h3 id={id} className="secTitle">
          {title}
          {help ? <HelpTip text={help} label={title} /> : null}
        </h3>
        {aside ? <div className="secAside">{aside}</div> : null}
      </div>
      {desc ? <p className="secDesc">{desc}</p> : null}
      <div className="secBody">{children}</div>
    </section>
  );
}

/** 两列栅格：数值框成对排布。stack 时改成一列竖排，三个一组时用这个，避免第三项单独折到下一行。 */
export function Grid({ children, stack = false }) {
  return <div className={stack ? 'fieldStack' : 'fieldGrid'}>{children}</div>;
}

const limitHint = (edge, limit) => (edge === 'max' ? `最大 ${limit}` : `最小 ${limit}`);

/** 绑定到 params 的数值框。标签可左右拖动微调（scrub）；onChange 用于有副作用的参数（如抬高要重新摆模型）。 */
export function Num({ k, label, min, max, step, unit = '', onChange }) {
  const [params, setParam] = useParams();
  return (
    <NumberField
      size="sm"
      scrub
      label={label}
      value={params[k]}
      min={min}
      max={max}
      step={step}
      suffix={unit}
      limitHint={limitHint}
      onValueChange={v => { setParam(k, v); onChange?.(v); }}
    />
  );
}

/** 设置行：左侧标题与说明，右侧开关（开关即时生效）。help 把说明收进问号。 */
export function SwitchRow({ label, desc, help, checked, onChange, disabled }) {
  const id = useId();
  return (
    <div className="setRow">
      <div className="setText">
        <span id={`${id}-l`} className="setLabel">
          {label}
          {help ? <HelpTip text={help} label={label} /> : null}
        </span>
        {desc ? <span id={`${id}-d`} className="setDesc">{desc}</span> : null}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-labelledby={`${id}-l`}
        aria-describedby={desc ? `${id}-d` : undefined}
      />
    </div>
  );
}

/** 分段选择：小标题 + 撑满整行的 Arc SegmentedControl，2~4 个选项。
    分区标题已经说明用途时可省略可见标题，只给 ariaLabel。 */
export function Choice({ label, ariaLabel, options, value, onChange }) {
  return (
    <div className="choice">
      {label ? <span className="choiceLabel" aria-hidden="true">{label}</span> : null}
      <SegmentedControl className="fullSeg" label={label || ariaLabel} options={options} value={value} onValueChange={onChange} />
    </div>
  );
}
