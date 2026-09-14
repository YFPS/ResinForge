import React from 'react';
import { createRoot } from 'react-dom/client';
import '@arco-design/web-react/dist/css/arco.css';
import './styles.css';
import * as THREE from 'three';
import App from './App.jsx';
import { state } from './store.js';
import { loadDemo, loadSTLBuffer } from './core/model.js';
import { rasterizeSection, analyze, buildLDI, sampleLDILayer, compareLDI, ldiColumnCrossings } from './core/slicer.js';

document.body.setAttribute('arco-theme', 'dark');

/* 调试/自动化访问口（同旧 main.js） */
window.state = state;
window.THREE = THREE;
window.__dbg = { loadDemo, loadSTLBuffer, rasterizeSection, analyze, buildLDI, sampleLDILayer, compareLDI, ldiColumnCrossings };

/* 不用 StrictMode：避免 three 场景双初始化 */
createRoot(document.getElementById('root')).render(<App />);
