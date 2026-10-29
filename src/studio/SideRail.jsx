/* 左侧图标栏：图标在上、文字在下。首页 / 项目 / 库 都是切页面，点当前那一项回到编辑。 */
import { useState } from 'react';
import { Box, FolderOpen, Home, MessageSquareWarning, RefreshCw } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/arc/popover/popover';
import { BrandMark } from '../demo/components/TitleBar.jsx';
import { ThemeBtn } from './pieces.jsx';

const ITEMS = [
  { id: 'home', label: '首页', icon: Home },
  { id: 'projects', label: '项目', icon: Box },
  { id: 'library', label: '库', icon: FolderOpen },
];

function openHelp(name) {
  window.dispatchEvent(new Event(name));
}

export default function SideRail({ page, onPage }) {
  const [helpOpen, setHelpOpen] = useState(false);
  const pickHelp = name => {
    setHelpOpen(false);
    openHelp(name);
  };
  return (
    <nav className="stuRail" aria-label="主导航">
      <span className="stuRailBrand" aria-hidden="true"><BrandMark spin /></span>
      <div className="stuRailNav">
        {ITEMS.map(item => {
          const Icon = item.icon;
          const active = page === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={'stuRailItem' + (active ? ' on' : '')}
              aria-current={active ? 'page' : undefined}
              onClick={() => onPage(page === item.id ? null : item.id)}
            >
              <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
      <div className="stuRailFoot">
        <span className="stuRailTheme"><ThemeBtn /></span>
        <Popover open={helpOpen} onOpenChange={setHelpOpen}>
          <PopoverTrigger className="stuRailFootBtn" aria-label="问题反馈" aria-haspopup="menu">
            <MessageSquareWarning size={16} strokeWidth={1.75} />
          </PopoverTrigger>
          <PopoverContent className="stuRailMenu" side="right" align="end" sideOffset={8}>
            <button type="button" onClick={() => pickHelp('studio:open-feedback')}>
              <MessageSquareWarning size={15} strokeWidth={1.75} aria-hidden="true" />
              问题反馈
            </button>
            <button type="button" onClick={() => pickHelp('studio:open-about')}>
              <RefreshCw size={15} strokeWidth={1.75} aria-hidden="true" />
              检查更新
            </button>
          </PopoverContent>
        </Popover>
      </div>
    </nav>
  );
}
