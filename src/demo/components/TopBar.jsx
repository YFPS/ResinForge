/* 顶栏：左 = 侧栏开合 · 品牌 / 当前模型；中 = 五步流程导航（Arc Tabs）；右 = 打印机 · 命令搜索 · 主题。
   顶栏与侧栏同底色、不加分隔线，和视口的圆角画布组成「L 形外框 + 画布」。 */
import React from 'react';
import { Box, Check, FolderOpen, FolderPlus, PanelLeftClose, PanelLeftOpen, Search, Shapes } from 'lucide-react';
import Button from '@/components/arc/button/button';
import { DropdownMenu } from '@/components/arc/dropdown-menu/dropdown-menu';
import { TabsList, TabsTrigger } from '@/components/arc/tabs/tabs';
import { ThemeSwitch } from '@/components/arc/theme-switch/theme-switch';
import Tooltip from '@/components/arc/tooltip/tooltip';
import { useBusLatest } from '../bridge.js';
import { DEMOS, doLoadDemo, pickSTL, splitModelName } from '../actions.js';
import { STEPS, runTask, toggleSidebar, useDone, useUI } from '../ui.js';
import { switchThemeWithTransition, useTheme } from '../theme.js';
import MachinePicker from './MachinePicker.jsx';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const PALETTE_KEY = IS_MAC ? '⌘ K' : 'Ctrl K';

export function BrandMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1.2" y="1.2" width="29.6" height="29.6" rx="9" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M9 23V16.2C9 11.2 12.2 8 16 8s7 3.2 7 8.2V23" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M12.2 23v-6.2c0-2.4 1.6-4 3.8-4s3.8 1.6 3.8 4V23" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

/** 当前模型：名字即菜单，换演示模型 / 打开 STL、OBJ、3MF */
function ModelMenu() {
  const info = useBusLatest('modelInfo', null);
  const { name, demo } = splitModelName(info && info.name);
  /* 是否演示模型在菜单里（打勾的那一项）和侧栏的模型卡片上都看得到，顶栏不再重复挂标记 */
  return (
    <div className="modelMenu">
      <DropdownMenu
        label={name || '未载入模型'}
        icon={<Box size={15} strokeWidth={1.75} />}
        items={[
          { label: '打开模型文件…', icon: <FolderOpen size={16} strokeWidth={1.75} />, onSelect: () => pickSTL(false) },
          { label: '追加模型文件…', icon: <FolderPlus size={16} strokeWidth={1.75} />, onSelect: () => pickSTL(true) },
          ...DEMOS.map((d, i) => ({
            label: `演示：${d.label}`,
            icon: demo && d.label === name ? <Check size={16} strokeWidth={1.75} /> : <Shapes size={16} strokeWidth={1.75} />,
            separatorBefore: i === 0,
            onSelect: () => runTask('demo', () => doLoadDemo(d.kind)),
          })),
        ]}
      />
    </div>
  );
}

/** 流程导航：Arc Tabs 的触发器，序号在完成后变成勾 */
function StepNav() {
  const done = useDone();
  return (
    <TabsList className="stepNav" aria-label="流程步骤">
      {STEPS.map((s, i) => (
        <TabsTrigger key={s.id} value={s.id} className="stepTab">
          <span className="stepTabInner">
            <span className="stepMark" data-done={done[s.id] || undefined} data-n={i + 1} aria-hidden="true">
              {done[s.id] ? <Check size={11} strokeWidth={2.5} /> : i + 1}
            </span>
            <span className="stepLabel">{s.label}</span>
            {done[s.id] ? <span className="srOnly">（已完成）</span> : null}
          </span>
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

function ThemeToggle() {
  const { resolved } = useTheme();
  return (
    <ThemeSwitch
      theme={resolved}
      variant="rise"
      iconOnly
      label={resolved === 'dark' ? '切换到浅色外观' : '切换到深色外观'}
      onThemeChange={next => switchThemeWithTransition(next)}
    />
  );
}

export default function TopBar({ onOpenPalette }) {
  const { sidebarOpen } = useUI();
  return (
    <header className="topbar">
      <div className="tbLeft">
        <Tooltip content={sidebarOpen ? '收起侧栏' : '展开侧栏'} side="bottom">
          <Button
            variant="ghost"
            size="sm"
            className="iconBtn"
            aria-label={sidebarOpen ? '收起侧栏' : '展开侧栏'}
            aria-expanded={sidebarOpen}
            onClick={toggleSidebar}
          >
            {sidebarOpen
              ? <PanelLeftClose size={18} strokeWidth={1.75} aria-hidden="true" />
              : <PanelLeftOpen size={18} strokeWidth={1.75} aria-hidden="true" />}
          </Button>
        </Tooltip>
        <div className="brand">
          <BrandMark />
          <span className="brandName">ResinForge</span>
        </div>
        <span className="crumbSep" aria-hidden="true" />
        <ModelMenu />
      </div>

      <StepNav />

      <div className="tbRight">
        <MachinePicker />
        <Button variant="secondary" size="sm" className="searchBtn" onClick={onOpenPalette} aria-keyshortcuts={IS_MAC ? 'Meta+K' : 'Control+K'}>
          <Search size={15} strokeWidth={1.75} aria-hidden="true" />
          <span className="searchText">搜索命令</span>
          <kbd className="kbd">{PALETTE_KEY}</kbd>
        </Button>
        <ThemeToggle />
      </div>
    </header>
  );
}
