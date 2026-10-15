import React, { useState } from 'react';
import { Box, ChevronDown, Eye, EyeOff } from 'lucide-react';
import Button from '@/components/arc/button/button';
import Tooltip from '@/components/arc/tooltip/tooltip';
import MachinePicker from '../../demo/components/MachinePicker.jsx';
import { BrandMark } from '../../demo/components/TopBar.jsx';
import { useBusLatest } from '../../demo/bridge.js';
import { goStep } from '../../demo/ui.js';
import BedPlate from '../bedPlate.jsx';
import ParamPanel from '../ParamPanel.jsx';
import PerfHud from '../PerfHud.jsx';
import {
  BottomProgress, ModelMenu, OpenModelButton, PartsCardBody, SearchBtn, StageNext, StagePill, ThemeBtn, ViewportDock,
} from '../pieces.jsx';

function FloatCard({ title, icon, meta, open, onToggle, className = '', children }) {
  return (
    <div className={'stuCard ' + className} data-open={open ? '1' : '0'}>
      <button type="button" className="stuCardHead" aria-expanded={open} onClick={onToggle}>
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
  const toggle = k => setOpen(o => ({ ...o, [k]: !o[k] }));
  const allOpen = open.model && open.panel;
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

      <div className="stuFloatLeft">
        <FloatCard
          title="模型"
          icon={<Box size={14} strokeWidth={1.8} />}
          meta={partCount ? `${partCount} 件` : ''}
          open={open.model}
          onToggle={() => toggle('model')}
          className="stuCard--model"
        >
          <PartsCardBody />
        </FloatCard>
      </div>

      <div className="stuFloatRight">
        <FloatCard title="参数" open={open.panel} onToggle={() => toggle('panel')} className="stuCard--panel">
          <ParamPanel stage={stage} />
        </FloatCard>
      </div>

      <div className="stuToolsRow">
        <BedPlate />
        <div className="stuDockSlot">
          <ViewportDock />
          <BottomProgress />
        </div>
        <StageNext stage={stage} />
      </div>
    </div>
  );
}
