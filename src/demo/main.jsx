import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/inter';
import '@/components/arc/foundation.css';
import './demo.css';
import * as THREE from 'three';
import { state, params } from '../store.js';
import { initMachine } from './machines.js';
import { loadDemo, loadSTLBuffer } from '../core/model.js';
import { rasterizeSection, analyze, buildLDI, sampleLDILayer, compareLDI, ldiColumnCrossings } from '../core/slicer.js';
import { camera, getControls } from '../core/scene.js';
import { initTheme } from './theme.js';
import DemoApp from './DemoApp.jsx';

/* 外观：主题（含 3D 场景与材质配色）与强调色，都是持久化的环境配置 */
initTheme();

/* 机器是环境配置：恢复上次使用的机型参数（模型 / 保护面 / 支撑仍刷新即丢） */
initMachine(params);

/* 调试/自动化访问口（与旧 main.jsx 同构，无头验证工具依赖这些） */
window.state = state;
window.THREE = THREE;
window.__dbg = { loadDemo, loadSTLBuffer, rasterizeSection, analyze, buildLDI, sampleLDILayer, compareLDI, ldiColumnCrossings, camera, getControls };

createRoot(document.getElementById('root')).render(<DemoApp />);
