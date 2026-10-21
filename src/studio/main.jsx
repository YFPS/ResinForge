import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/inter';
import '@/components/arc/foundation.css';
import '../demo/demo.css';        // 复用参数积木（.sec / .fieldGrid / .setRow …）与浮层样式；布局类名不使用
import './studio.css';
import * as THREE from 'three';
import { state, params } from '../store.js';
import { initMachine } from '../demo/machines.js';
import { loadDemo, loadSTLBuffer, loadSTLBuffers, setActivePart, setSelection, partBounds, clampPartsAboveZ, plateAxisOrigin, scalePartTo, scalePartAxis, simplifySelection } from '../core/model.js';
import { setPointsOnly } from '../core/support.js';
import { rasterizeSection, analyze, buildLDI, sampleLDILayer, compareLDI, ldiColumnCrossings } from '../core/slicer.js';
import { camera, getControls, framePart, setMode } from '../core/scene.js';
import { initTheme } from '../demo/theme.js';
import StudioApp from './StudioApp.jsx';

initTheme();
initMachine(params);

/* 调试 / 无头验证口（与 demo 同构，.ref 下的 harness 依赖这些） */
window.state = state;
window.THREE = THREE;
window.__dbg = { loadDemo, loadSTLBuffer, loadSTLBuffers, setActivePart, setSelection, setMode, partBounds, clampPartsAboveZ, plateAxisOrigin, framePart, setPointsOnly, simplifySelection, rasterizeSection, analyze, buildLDI, sampleLDILayer, compareLDI, ldiColumnCrossings, camera, getControls, scalePartTo, scalePartAxis };

createRoot(document.getElementById('root')).render(<StudioApp />);
