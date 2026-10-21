import React, { useCallback, useEffect, useState } from 'react';
import CommandPalette from '../demo/components/CommandPalette.jsx';
import ToastHost from '../demo/components/ToastHost.jsx';
import TitleBar, { IN_TAURI } from '../demo/components/TitleBar.jsx';
import { useBus } from '../demo/bridge.js';
import { goStep, useUI } from '../demo/ui.js';
import { setSupportHotkeys } from '../core/scene.js';
import StageCanvas from './StageCanvas.jsx';
import ShellC from './shells/ShellC.jsx';
import SimplifyProto from './simplifyProto.jsx';
import BedProto from './bedProto.jsx';
import UpdateHost from './UpdateHost.jsx';

export default function StudioApp() {
  const { step } = useUI();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

  /* 支撑步骤才吃 V / N 这类单键快捷键，别的步骤里要让输入框正常打字 */
  useEffect(() => { setSupportHotkeys(step === 'support'); }, [step]);

  /* 右键不弹出浏览器 / WebView 菜单（返回、刷新、另存为、打印）。输入框仍留给复制粘贴。
     画布上的右键旋转不受影响。 */
  useEffect(() => {
    const onContext = e => {
      const el = e.target;
      if (el && el.closest && el.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
    };
    window.addEventListener('contextmenu', onContext, true);
    return () => window.removeEventListener('contextmenu', onContext, true);
  }, []);

  useEffect(() => {
    const onKey = e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* 朝向候选到达就把阶段摆到「朝向」（无论从哪儿触发的优化） */
  useBus('orientResults', r => { if (r && r.length) goStep('orient'); });

  return (
    <div className={'stu' + (IN_TAURI ? ' stu--desktop' : '')}>
      {/* 桌面版（Tauri 无边框窗口）自绘标题栏：拖动 + 最小化 / 最大化 / 关闭；浏览器里返回 null */}
      <TitleBar />
      <h1 className="srOnly">ResinForge 光固化自动支撑 · Studio</h1>
      <ShellC stage={step} onOpenPalette={openPalette} />
      <StageCanvas />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ToastHost />
      <UpdateHost />
      <SimplifyProto />
      <BedProto />
    </div>
  );
}
