import React, { useEffect, useRef, useState } from 'react';
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
   免得拖完顺手把卡片折叠了。位置用 transform 平移，卡片仍占着容器原来的位置。
   拖动收尾不能只等卡片上的 pointerup——指针在窗口外松手时它到不了，capture 会一直挂着，
   之后不按键只挪鼠标卡片也跟着跑；所以窗口级的 up / cancel / blur 与「按键已松开」都要收尾。 */
function useDragCard() {
  const [off, setOff] = useState(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef(null);
  const swallow = useRef(false);
  const geom = useRef(null);
  const offRef = useRef(null);
  offRef.current = off;

  /* 摆到指针位置：四边各留 8px，整张卡片都留在视口里，拖到边上也不会只剩一角 */
  const place = (base, mx, my, w, h) => {
    const maxL = Math.max(8, window.innerWidth - w - 8);
    const maxT = Math.max(8, window.innerHeight - h - 8);
    const left = Math.min(Math.max(8, base.left + mx), maxL);
    const top = Math.min(Math.max(8, base.top + my), maxT);
    return { x: left - base.left, y: top - base.top };
  };

  useEffect(() => {
    /* 窗口尺寸变化后重新摆回可见范围：容器随断点挪位置时基准也跟着更新 */
    const onResize = () => {
      const o = offRef.current;
      const el = geom.current && geom.current.el;
      if (!o || !el || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      const base = { left: r.left - o.x, top: r.top - o.y };
      geom.current = { el, base };
      setOff(place(base, o.x, o.y, r.width, r.height));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const headProps = {
    onPointerDown: e => {
      if (e.button !== 0) return;
      const el = e.currentTarget.closest('.stuCard');
      const r = el.getBoundingClientRect();
      const dx = off ? off.x : 0, dy = off ? off.y : 0;
      const base = { left: r.left - dx, top: r.top - dy };
      const d = { x: e.clientX, y: e.clientY, base, w: r.width, h: r.height, moved: false, el, pid: e.pointerId };
      const finish = () => {
        /* 先摘监听：上一次没收尾的拖动留下的 finish 也会走到这里，不能让它继续挂着 */
        window.removeEventListener('pointerup', finish, true);
        window.removeEventListener('pointercancel', finish, true);
        window.removeEventListener('blur', finish, true);
        if (drag.current !== d) return;
        drag.current = null;
        setDragging(false);
        if (d.moved) swallow.current = true;
        try { e.currentTarget.releasePointerCapture(d.pid); } catch { /* 指针已经松开 */ }
      };
      d.finish = finish;
      /* 上一次拖动可能没收尾（指针在窗口外松手时 up 到不了），先把它结束掉；
         新的一次按下就是新的一次交互，它留下的「吞点击」标记一并清掉 */
      if (drag.current && drag.current.finish) drag.current.finish();
      swallow.current = false;
      drag.current = d;
      geom.current = { el, base };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真实指针 */ }
      /* 指针在窗口外松手、触摸被系统打断、窗口失焦，这几种都要收尾 */
      window.addEventListener('pointerup', finish, true);
      window.addEventListener('pointercancel', finish, true);
      window.addEventListener('blur', finish, true);
    },
    onPointerMove: e => {
      const d = drag.current;
      if (!d) return;
      /* 左键已经松开（pointerup 在窗口外丢了）就直接收尾，别让卡片继续跟着指针跑 */
      if (!(e.buttons & 1)) { d.finish(); return; }
      const mx = e.clientX - d.x, my = e.clientY - d.y;
      if (!d.moved && Math.abs(mx) + Math.abs(my) < 4) return;
      if (!d.moved) { d.moved = true; setDragging(true); }
      setOff(place(d.base, mx, my, d.w, d.h));
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
