import React from 'react';
import { createRoot } from 'react-dom/client';
import '@arco-design/web-react/dist/css/arco.css';
import './styles.css';
import * as THREE from 'three';
import App from './App.jsx';
import { state } from './store.js';
import { loadDemo, loadSTLBuffer, loadSTLBuffers, setActivePart, setSelection, partBounds, clampPartsAboveZ, plateAxisOrigin, scalePartTo, scalePartAxis } from './core/model.js';
import { setPointsOnly } from './core/support.js';
import { rasterizeSection, analyze, buildLDI, sampleLDILayer, compareLDI, ldiColumnCrossings } from './core/slicer.js';
import { camera, getControls, framePart, setMode } from './core/scene.js';
import './demo/actions.js';

document.body.setAttribute('arco-theme', 'dark');

/* 调试/自动化访问口（同旧 main.js；camera/controls 供无头验证驱动视角） */
window.state = state;
window.THREE = THREE;
window.__dbg = { loadDemo, loadSTLBuffer, loadSTLBuffers, setActivePart, setSelection, setMode, partBounds, clampPartsAboveZ, plateAxisOrigin, framePart, setPointsOnly, rasterizeSection, analyze, buildLDI, sampleLDILayer, compareLDI, ldiColumnCrossings, camera, getControls, scalePartTo, scalePartAxis };

/* 不用 StrictMode：避免 three 场景双初始化 */
createRoot(document.getElementById('root')).render(<App />);
