/* PROTOTYPE — 简化浮层套用缩放对话框的玻璃、字号和按钮。
   问的是外观，不改简化算法。打开 /studio.html?proto=simplify ，左右方向键换方案。
   看完删本文件，并撤掉 StudioApp / pieces.jsx 里的挂载。 */
import { useEffect, useState } from 'react';
import { Rabbit, Snail } from 'lucide-react';
import { ElasticSlider } from '@/components/arc/elastic-slider/elastic-slider';
import { useBusLatest } from '../demo/bridge.js';

const VARIANTS = [
  { id: 'card', name: '竖卡' },
  { id: 'bar', name: '横条' },
  { id: 'spin', name: '数值行' },
];
const FIDELITY_MARKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(value =>
  value === 1 || value === 5 || value === 10 ? { value, label: String(value) } : value,
);
const RATIO_MARKS = [25, 50, 75].map(value => ({ value, label: String(value) }));

function readVariant() {
  const id = new URLSearchParams(location.search).get('variant');
  return VARIANTS.some(v => v.id === id) ? id : 'card';
}

export default function SimplifyProto() {
  const params = new URLSearchParams(location.search);
  if (!import.meta.env.DEV || params.get('proto') !== 'simplify') return null;
  return <SimplifyProtoLive initial={readVariant()} />;
}

function SimplifyProtoLive({ initial }) {
  const info = useBusLatest('modelInfo', null);
  const [variant, setVariant] = useState(initial);
  const [mode, setMode] = useState('fidelity');
  const [fidelity, setFidelity] = useState(5);
  const [ratioPct, setRatioPct] = useState(50);
  const [note, setNote] = useState('还没点简化');
  const fidelityMode = mode === 'fidelity';
  const ids = info
    ? ((info.selectedIds && info.selectedIds.length) ? info.selectedIds : (info.activeId ? [info.activeId] : []))
    : [];
  const beforeNf = info && info.parts
    ? info.parts.filter(p => ids.includes(p.id)).reduce((s, p) => s + (p.nf || 0), 0)
    : 0;
  const afterNf = Math.round(beforeNf * ratioPct / 100);
  const face = n => Math.round(n).toLocaleString('zh-CN');
  const stat = !info ? '还没有模型' : (fidelityMode ? `${face(beforeNf)} 面` : `${face(beforeNf)} 到 ${face(afterNf)}`);

  useEffect(() => {
    document.documentElement.dataset.simpProto = '1';
    return () => { delete document.documentElement.dataset.simpProto; };
  }, []);

  const pick = (dir) => {
    const i = VARIANTS.findIndex(v => v.id === variant);
    const next = VARIANTS[(i + dir + VARIANTS.length) % VARIANTS.length].id;
    const url = new URL(location.href);
    url.searchParams.set('proto', 'simplify');
    url.searchParams.set('variant', next);
    history.replaceState(null, '', url);
    setVariant(next);
  };

  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); pick(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); pick(1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [variant]);

  const value = fidelityMode ? fidelity : ratioPct;
  const setValue = fidelityMode ? setFidelity : setRatioPct;
  const stepBy = (dir) => {
    if (fidelityMode) setFidelity(v => Math.min(10, Math.max(1, Math.round((v + dir) * 100) / 100)));
    else setRatioPct(v => Math.min(99.99, Math.max(1, Math.round((v + dir * 10) * 100) / 100)));
  };

  const current = VARIANTS.find(v => v.id === variant);

  return (
    <>
      <div className="simpProto" data-layout={variant} role="dialog" aria-label="简化演示">
        <b className="simpProtoBrand">简化</b>
        <div className="simpProtoModes" role="group" aria-label="简化方式">
          <button type="button" aria-pressed={fidelityMode} onClick={() => setMode('fidelity')}>保真度</button>
          <button type="button" aria-pressed={!fidelityMode} onClick={() => setMode('ratio')}>面数比</button>
        </div>
        {variant === 'spin' ? (
          <label className="simpProtoField">
            <span>{fidelityMode ? '保真度' : '保留'}</span>
            <input
              inputMode="decimal"
              value={fidelityMode ? fidelity.toFixed(2) : ratioPct.toFixed(2)}
              aria-label={fidelityMode ? '保真度' : '保留比例'}
              onChange={e => {
                const n = Number(e.target.value);
                if (!Number.isFinite(n)) return;
                setValue(fidelityMode ? Math.min(10, Math.max(1, n)) : Math.min(99.99, Math.max(1, n)));
              }}
            />
            <em>{fidelityMode ? '' : '%'}</em>
            <span className="simpProtoSteps">
              <button type="button" aria-label="增大" onClick={() => stepBy(1)}>▴</button>
              <button type="button" aria-label="减小" onClick={() => stepBy(-1)}>▾</button>
            </span>
          </label>
        ) : null}
        <div className="simpProtoBody">
          <ElasticSlider
            key={mode + (variant === 'spin' ? '-bare' : '')}
            className={variant === 'spin' ? 'simpProtoBare' : undefined}
            label={fidelityMode ? '保真度' : '保留比例'}
            showValue={variant !== 'spin'}
            min={1}
            max={fidelityMode ? 10 : 99.99}
            step={0.01}
            largeStep={fidelityMode ? 1 : 10}
            value={value}
            format={fidelityMode ? (v => v.toFixed(2)) : (v => `${v.toFixed(2)}%`)}
            marks={fidelityMode ? FIDELITY_MARKS : RATIO_MARKS}
            startIcon={<Snail size={20} strokeWidth={1.75} aria-label="简化多" />}
            endIcon={<Rabbit size={20} strokeWidth={1.75} aria-label="简化少" />}
            onValueChange={setValue}
          />
        </div>
        <span className="simpProtoStat tnum">{stat}</span>
        <button
          type="button"
          className="simpProtoGo"
          onClick={() => setNote(`${fidelityMode ? '保真度' : '面数比'} ${fidelityMode ? fidelity.toFixed(2) : ratioPct.toFixed(2) + '%'}，演示不真正简化`)}
        >
          简化
        </button>
      </div>
      <div className="simpProtoSwitch" role="toolbar" aria-label="演示方案">
        <button type="button" onClick={() => pick(-1)} aria-label="上一个方案">‹</button>
        <span>{current.name}<small>{note}</small></span>
        <button type="button" onClick={() => pick(1)} aria-label="下一个方案">›</button>
      </div>
    </>
  );
}
