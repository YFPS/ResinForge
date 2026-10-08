import React, { useCallback, useEffect, useState } from 'react';
import { Tabs } from '@/components/arc/tabs/tabs';
import TopBar from './components/TopBar.jsx';
import Sidebar from './components/Sidebar.jsx';
import ViewportStage from './components/ViewportStage.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import ToastHost from './components/ToastHost.jsx';
import { useBus } from './bridge.js';
import { goStep, useUI } from './ui.js';
import { setSupportHotkeys } from '../core/scene.js';

/* 骨架：Arc Tabs 的根包住整个应用——流程导航（TabsList）在顶栏，五个步骤面板（TabsContent）在侧栏，
   导航与面板之间的 aria-controls / 键盘行为都由 Tabs 负责。 */
export default function DemoApp() {
  const { step } = useUI();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => { setSupportHotkeys(step === 'support'); }, [step]);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

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

  /* 朝向候选在侧栏「朝向」面板里点选；无论从哪里触发的优化，结果到达就把那一步摆到眼前 */
  useBus('orientResults', r => { if (r && r.length) goStep('orient'); });

  return (
    <Tabs value={step} onValueChange={goStep} className="app">
      <h1 className="srOnly">ResinForge 光固化自动支撑</h1>
      <TopBar onOpenPalette={openPalette} />
      <main className="workbench">
        <Sidebar />
        <ViewportStage />
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ToastHost />
    </Tabs>
  );
}
