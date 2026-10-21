import React, { useEffect, useRef, useState } from 'react';
import { Box, ChevronDown, Eye, EyeOff } from 'lucide-react';
import Button from '@/components/arc/button/button';
import Tooltip from '@/components/arc/tooltip/tooltip';
import MachinePicker from '../../demo/components/MachinePicker.jsx';
import { BrandMark } from '../../demo/components/TitleBar.jsx';
import { useBusLatest } from '../../demo/bridge.js';
import { goStep } from '../../demo/ui.js';
import BedPlate from '../bedPlate.jsx';
import ParamPanel, { hasParamPanel } from '../ParamPanel.jsx';
import PerfHud from '../PerfHud.jsx';
import ResinHud from '../ResinHud.jsx';
import {
  BottomProgress, ModelMenu, OpenModelButton, PartsCardBody, SearchBtn, StageNext, StagePill, ThemeBtn, ViewportDock,
} from '../pieces.jsx';

/* 卡片拖到哪就待在哪：拖的是标题行，指针挪过 4px 才算拖动，松手时吞掉这一次点击，
   免得拖完顺手把卡片折叠了。位置用 transform 平移，卡片仍占着容器原来的位置。
   平移量要在「按下时已经有的偏移」上再加这一次的指针位移。若只记这一次的位移，
   第二次拖就会把卡片甩回靠近原位的地方，列表跟着整张飞出去。
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

  /* 想把按下时的视口位置 anchor 挪到 desired。平移在按下时已有的 ox/oy 上累加，四边各留 8px。 */
  const place = (desiredL, desiredT, anchorL, anchorT, w, h, ox, oy) => {
    const maxL = Math.max(8, window.innerWidth - w - 8);
    const maxT = Math.max(8, window.innerHeight - h - 8);
    const x = Math.min(Math.max(8, desiredL), maxL);
    const y = Math.min(Math.max(8, desiredT), maxT);
    return { x: ox + (x - anchorL), y: oy + (y - anchorT) };
  };

  useEffect(() => {
    /* 窗口尺寸变化后重新摆回可见范围：按当前看到的位置收，不把已有平移清掉 */
    const onResize = () => {
      const o = offRef.current;
      const el = geom.current && geom.current.el;
      if (!o || !el || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      setOff(place(r.left, r.top, r.left, r.top, r.width, r.height, o.x, o.y));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const headProps = {
    onPointerDown: e => {
      if (e.button !== 0) return;
      const el = e.currentTarget.closest('.stuCard');
      const r = el.getBoundingClientRect();
      const origin = offRef.current || { x: 0, y: 0 };
      const d = {
        x: e.clientX, y: e.clientY, origin, left: r.left, top: r.top,
        w: r.width, h: r.height, moved: false, el, pid: e.pointerId,
      };
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
      geom.current = { el };
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
      setOff(place(d.left + mx, d.top + my, d.left, d.top, d.w, d.h, d.origin.x, d.origin.y));
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
      <ResinHud />
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
