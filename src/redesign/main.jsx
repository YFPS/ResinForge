import React from 'react';
import { createRoot } from 'react-dom/client';
import '@/components/arc/foundation.css';
import './fonts.css';
import './redesign.css';
import * as THREE from 'three';
import { state, params } from '../store.js';
import { initMachine } from '../demo/machines.js';
import { scene, prevScene, modelMat, updateBuildVolume, setBuildVolumeTheme, camera, getControls, setMode, framePart } from '../core/scene.js';
import { syncHeatMaterial } from '../core/heat.js';
import { syncPartTint } from '../core/model.js';
import { loadDemo, loadSTLBuffer, loadSTLBuffers, setActivePart, setSelection, partBounds, clampPartsAboveZ, plateAxisOrigin, scalePartTo, scalePartAxis, simplifySelection } from '../core/model.js';
import { setPointsOnly } from '../core/support.js';
import { rasterizeSection, analyze, buildLDI, sampleLDILayer, compareLDI, ldiColumnCrossings } from '../core/slicer.js';
import '../demo/actions.js';        // 注册 enterSupport / leaveSupport / enterAddSupport 等流程副作用
import RedesignApp from './RedesignApp.jsx';

/* 这套界面固定浅色（framed-sheet），不读 localStorage 的主题；
   Arc 令牌在 redesign.css 里接成石材框 + 白纸。 */
document.documentElement.setAttribute('data-theme', 'light');
document.documentElement.setAttribute('data-accent', 'neutral');

initMachine(params);

/* three.js 不读 CSS 变量：视口底色 = 画布凹面的色值，模型压成石墨灰。
   updateBuildVolume 读 data-theme 决定板面网格与坐标轴的颜色，所以必须在设完 light 之后跑。 */
const WELL = 0xe8e9e4;
scene.background.set(WELL);
if (scene.fog) scene.fog.color.set(WELL);
prevScene.background.set(0xe4e5e0);
modelMat.color.set(0x5f6468);
updateBuildVolume();
setBuildVolumeTheme('light');
syncHeatMaterial();
syncPartTint();

/* 与 Studio 同构的调试口（.ref 下的 harness 依赖这些） */
window.state = state;
window.THREE = THREE;
window.__dbg = { loadDemo, loadSTLBuffer, loadSTLBuffers, setActivePart, setSelection, setMode, partBounds, clampPartsAboveZ, plateAxisOrigin, framePart, setPointsOnly, simplifySelection, rasterizeSection, analyze, buildLDI, sampleLDILayer, compareLDI, ldiColumnCrossings, camera, getControls, scalePartTo, scalePartAxis };

createRoot(document.getElementById('root')).render(<RedesignApp />);
