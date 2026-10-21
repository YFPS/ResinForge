import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/inter';
import '@/components/arc/foundation.css';
import '../demo/demo.css';      // Studio 复用的参数积木与浮层样式
import '../studio/studio.css';  // Studio 的浮动卡片 / 顶栏 / 工具坞
import './projects.css';
import * as THREE from 'three';
import { state, params } from '../store.js';
import { initMachine } from '../demo/machines.js';
import { initTheme } from '../demo/theme.js';
import App from './App.jsx';
import './seedgen.js';

/* 工程与零件库方案 Demo：直接跑在真实的 Studio 引擎上（core 场景、模型、支撑算法都是产品代码），
   只另写外壳。产品代码一行不改。 */

initTheme();
initMachine(params);

window.state = state;
window.THREE = THREE;

createRoot(document.getElementById('root')).render(<App />);
