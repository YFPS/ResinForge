/* 桌面版（Tauri）自定义标题栏：36px 独立一条，左 = 应用图标 + 名称，右 = 最小化 / 最大化 / 关闭。
   无边框窗口（tauri.conf.json 的 decorations: false）下代替系统标题栏；整条可按住拖动，
   双击最大化/还原由 Tauri 内置（drag region 的系统行为），窗口按钮走 @tauri-apps/api。
   data-tauri-drag-region 只对直接标记的元素生效——纯视觉子元素用 pointer-events: none 让点击落到容器上，
   按钮区不标记，天然可点。浏览器打开时本组件返回 null（Web 版零回归）。 */
import React, { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { BrandMark } from './TopBar.jsx';

export const IN_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/* Windows 惯例线型的小图标（10×10 线框），不用 lucide 的圆头粗线 */
const Glyph = ({ children }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">{children}</svg>
);
const IconMin = () => <Glyph><path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" /></Glyph>;
const IconMax = () => <Glyph><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></Glyph>;
const IconRestore = () => (
  <Glyph>
    <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
    <path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" strokeWidth="1" />
  </Glyph>
);
const IconClose = () => <Glyph><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" /></Glyph>;

export default function TitleBar() {
  const [maxed, setMaxed] = useState(false);
  // 最大化状态随窗口尺寸变化刷新（按钮图标在「最大化 / 还原」之间切换）
  useEffect(() => {
    if (!IN_TAURI) return;
    const win = getCurrentWindow();
    let alive = true;
    let un = null;
    const sync = () => { win.isMaximized().then(v => { if (alive) setMaxed(v); }); };
    sync();
    win.onResized(sync).then(f => { if (alive) un = f; else f(); });
    return () => { alive = false; if (un) un(); };
  }, []);
  if (!IN_TAURI) return null;
  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="tbApp" data-tauri-drag-region>
        <span className="tbAppMark"><BrandMark /></span>
        <span className="tbAppName">ResinForge</span>
      </div>
      <div className="tbWin">
        <button type="button" tabIndex={-1} className="tbwBtn" aria-label="最小化" onClick={() => getCurrentWindow().minimize()}>
          <IconMin />
        </button>
        <button
          type="button" tabIndex={-1} className="tbwBtn" aria-label={maxed ? '向下还原' : '最大化'}
          onClick={() => getCurrentWindow().toggleMaximize()}
        >
          {maxed ? <IconRestore /> : <IconMax />}
        </button>
        <button type="button" tabIndex={-1} className="tbwBtn tbwClose" aria-label="关闭" onClick={() => getCurrentWindow().close()}>
          <IconClose />
        </button>
      </div>
    </div>
  );
}
