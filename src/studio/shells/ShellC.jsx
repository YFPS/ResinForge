import React, { useRef, useState } from 'react';
import { Box, ChevronDown, Eye, EyeOff } from 'lucide-react';
import Button from '@/components/arc/button/button';
import Tooltip from '@/components/arc/tooltip/tooltip';
import MachinePicker from '../../demo/components/MachinePicker.jsx';
import { BrandMark } from '../../demo/components/TopBar.jsx';
import { useBusLatest } from '../../demo/bridge.js';
import { goStep } from '../../demo/ui.js';
import BedPlate from '../bedPlate.jsx';
import ParamPanel, { hasParamPanel } from '../ParamPanel.jsx';
import PerfHud from '../PerfHud.jsx';
import {
  BottomProgress, ModelMenu, OpenModelButton, PartsCardBody, SearchBtn, StageNext, StagePill, ThemeBtn, ViewportDock,
} from '../pieces.jsx';

/* 卡片拖到哪就待在哪：拖的是标题行，指针挪过 4px 才算拖动，松手时吞掉这一次点击，
   免得拖完顺手把卡片折叠了。位置用 transform 平移，卡片仍占着容器原来的位置。 */
function useDragCard() {
  const [off, setOff] = useState(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef(null);
  const swallow = useRef(false);
  const headProps = {
    onPointerDown: e => {
      if (e.button !== 0) return;
      const r = e.currentTarget.closest('.stuCard').getBoundingClientRect();
      const dx = off ? off.x : 0, dy = off ? off.y : 0;
      drag.current = { x: e.clientX, y: e.clientY, base: { left: r.left - dx, top: r.top - dy }, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: e => {
      const d = drag.current;
      if (!d) return;
      const mx = e.clientX - d.x, my = e.clientY - d.y;
      if (!d.moved && Math.abs(mx) + Math.abs(my) < 4) return;
      if (!d.moved) { d.moved = true; setDragging(true); }
      /* 至少留一角在视口里，拖出去也找得回来 */
      const left = Math.max(8, Math.min(window.innerWidth - 80, d.base.left + mx));
      const top = Math.max(8, Math.min(window.innerHeight - 48, d.base.top + my));
      setOff({ x: left - d.base.left, y: top - d.base.top });
    },
    onPointerUp: e => {
      const d = drag.current;
      drag.current = null;
      setDragging(false);
      if (d && d.moved) swallow.current = true;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 指针已经松开 */ }
    },
    onClickCapture: e => {
      if (!swallow.current) return;
      swallow.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  };
  return [off, headProps, dragging];
}

function FloatCard({ title, icon, meta, open, onToggle, className = '', headProps, style, children }) {
  return (
    <div className={'stuCard ' + className} data-open={open ? '1' : '0'} style={style}>
      <button type="button" className="stuCardHead" aria-expanded={open} onClick={onToggle} {...headProps}>
        {icon}
        <span className="stuCardTitle">{title}</span>
        {meta ? <span className="stuCardMeta tnum">{meta}</span> : null}
        <ChevronDown size={14} strokeWidth={1.9} className="stuCardChev" aria-hidden="true" />
      </button>
      {open ? <div className="stuCardBody">{children}</div> : null}
    </div>
  );
}

export default function ShellC({ stage, onOpenPalette }) {
  const [open, setOpen] = useState({ model: true, panel: true });
  const [modelOff, modelHead, modelDragging] = useDragCard();
  const toggle = k => setOpen(o => ({ ...o, [k]: !o[k] }));
  const hasPanel = hasParamPanel(stage);
  /* 没有右侧参数卡的步骤（模型）只看左侧卡片，「全部收起 / 展开」也只算它，免得点了画面没反应 */
  const allOpen = open.model && (open.panel || !hasPanel);
  const info = useBusLatest('modelInfo', null);
  const partCount = (info && info.parts && info.parts.length) || 0;

  return (
    <div className="stuShell">
      <PerfHud />
      <div className="stuFloatBar">
        <span className="stuBrand"><BrandMark /></span>
        <div className="stuModelMenu"><ModelMenu /></div>
        <StagePill stage={stage} onPick={goStep} />
        <span className="stuFloatSep" aria-hidden="true" />
        <MachinePicker />
        <OpenModelButton />
        <SearchBtn onOpenPalette={onOpenPalette} />
        <ThemeBtn />
        <Tooltip content={allOpen ? '全部收起，把画布让干净' : '展开全部浮层'} side="bottom">
          <Button
            variant="ghost"
            size="sm"
            className="stuIconBtn"
            aria-label={allOpen ? '全部收起' : '展开全部'}
            onClick={() => setOpen(allOpen
              ? { model: false, panel: false }
              : { model: true, panel: true })}
          >
            {allOpen ? <EyeOff size={16} strokeWidth={1.75} /> : <Eye size={16} strokeWidth={1.75} />}
          </Button>
        </Tooltip>
      </div>

      <div className="stuFloatLeft" data-dragging={modelDragging || undefined}>
        <FloatCard
          title="模型"
          icon={<Box size={14} strokeWidth={1.8} />}
          meta={partCount ? `${partCount} 件` : ''}
          open={open.model}
          onToggle={() => toggle('model')}
          className="stuCard--model"
          headProps={modelHead}
          style={modelOff ? { transform: `translate(${modelOff.x}px, ${modelOff.y}px)` } : undefined}
        >
          <PartsCardBody />
        </FloatCard>
      </div>

      {/* 参数栏不带标题行：这一步叫什么由面板自己的标题交代，折叠入口收在顶栏的眼睛按钮上 */}
      <div className="stuFloatRight">
        {open.panel && hasPanel ? (
          <div className="stuCard stuCard--panel">
            <div className="stuCardBody"><ParamPanel stage={stage} /></div>
          </div>
        ) : null}
      </div>

      <div className="stuToolsRow">
        <BedPlate />
        <div className="stuDockSlot">
          <ViewportDock trailing={<StageNext stage={stage} />} />
          <BottomProgress />
        </div>
      </div>
    </div>
  );
}
