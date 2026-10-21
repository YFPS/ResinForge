import { params } from '../store.js';
import { getSupportTemplate, templateParams } from '../core/supportTemplates.js';
import { captureScene, openScene, generateSupports, renderThumb } from './engine.js';
import { LIBRARY_SEED, materialById } from './catalog.js';

/* 演示种子生成器（只在开发时手动跑一次）：用真实的 core 给演示零件和演示工程生成支撑，
   采集支撑点（零件局部系）、参数快照、统计和缩略图，输出成 public/projects-demo/seed.json。
   用法：在 projects.html 页面里执行 await window.__buildSeed()，把返回值存成文件。 */

const BASE = JSON.parse(JSON.stringify(params));

function paramsFor(templateId, layerUm) {
  const p = JSON.parse(JSON.stringify(BASE));
  const t = templateId ? getSupportTemplate(templateId) : null;
  if (t) Object.assign(p, templateParams(t));
  p.layerH = layerUm / 1000;
  return p;
}

/* 演示工程：零件引用零件库条目 */
const PROJECTS = [
  { id: 'prj-knot', name: '环面结 · 支撑验证', folder: 'test', starred: true, machineId: 'saturn4ultra', materialId: 'std-grey', layerUm: 50, templateId: 'fine', parts: ['lp-knot'], ago: 38 },
  { id: 'prj-rings', name: '戒指批量 4 件', folder: 'jewelry', starred: true, machineId: 'mars4ultra', materialId: 'cast-wax', layerUm: 25, templateId: 'fine', parts: ['lp-ring', 'lp-ring', 'lp-ring', 'lp-ring'], ago: 170 },
  { id: 'prj-base', name: '手办底座', folder: 'figure', machineId: 'saturn4ultra', materialId: 'wash-white', layerUm: 50, templateId: 'mid-coarse', parts: ['lp-figure-base'], ago: 520 },
  { id: 'prj-mech', name: '机械小件 齿轮与支架', folder: 'jobs', machineId: 'm5s', materialId: 'tough-black', layerUm: 50, templateId: 'mid-fine', parts: ['lp-gear', 'lp-bracket'], ago: 1460 },
  { id: 'prj-overhang', name: '悬垂测试 蘑菇与双层平台', folder: 'test', machineId: 'mighty8k', materialId: 'std-grey', layerUm: 50, templateId: 'fine', parts: ['lp-mushroom', 'lp-tier'], ago: 2900 },
  { id: 'prj-vase', name: '薄壁花瓶', folder: 'jobs', machineId: 'photonmono2', materialId: 'detail-ivory', layerUm: 25, templateId: 'fine', parts: ['lp-vase'], ago: 4380, noSupports: true },
];

const round = v => Math.round(v * 1e5) / 1e5;
const slimPoints = pts => pts.map(p => {
  const o = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'number') o[k] = round(v);
    else if (Array.isArray(v)) o[k] = v.map(x => (typeof x === 'number' ? round(x) : x));
    else o[k] = v;
  }
  return o;
});

async function build(log = console.log) {
  const out = { version: 1, generatedAt: new Date().toISOString(), library: [], projects: [] };
  const libById = new Map(LIBRARY_SEED.map(l => [l.id, l]));

  for (const entry of LIBRARY_SEED) {
    const t0 = performance.now();
    const desc = {
      machineId: 'saturn4ultra',
      params: paramsFor(entry.sup, 50),
      lift: { supportLiftOn: false, joinLift: 0 },
      parts: [{ uid: 'seed', name: entry.name, src: entry.src, libId: entry.id }],
      points: [],
    };
    await openScene(desc);
    if (entry.sup) await generateSupports();
    const cap = captureScene();
    const part = cap.parts[0];
    out.library.push({
      id: entry.id, name: entry.name, folder: entry.folder, tags: entry.tags, src: entry.src,
      faces: part.nf, size: part.size,
      sup: entry.sup ? { template: entry.sup, points: slimPoints(cap.points), stats: { points: cap.stats.points, ok: cap.stats.ok } } : null,
      thumb: renderThumb({ width: 480, height: 400, color: '#a3a9b2' }),
      ago: 600 + out.library.length * 911,
    });
    log(`零件 ${entry.name}：${part.nf} 面${entry.sup ? `，支撑 ${cap.stats.points} 点` : ''}，${Math.round(performance.now() - t0)} ms`);
  }

  for (const prj of PROJECTS) {
    const t0 = performance.now();
    const desc = {
      machineId: prj.machineId,
      params: paramsFor(prj.templateId, prj.layerUm),
      lift: { supportLiftOn: false, joinLift: 0 },
      parts: prj.parts.map((id, i) => ({ uid: `${prj.id}-${i}`, name: libById.get(id).name, src: libById.get(id).src, libId: id })),
      points: [],
    };
    await openScene(desc);
    if (!prj.noSupports) await generateSupports();
    const cap = captureScene();
    const { blobs: _blobs, stats, ...descOut } = cap;
    out.projects.push({
      id: prj.id, name: prj.name, folder: prj.folder, starred: !!prj.starred,
      machineId: prj.machineId, materialId: prj.materialId, layerUm: prj.layerUm, templateId: prj.templateId,
      desc: { machineId: prj.machineId, ...descOut, points: slimPoints(descOut.points) },
      stats,
      thumb: renderThumb({ color: materialById(prj.materialId).color }),
      ago: prj.ago,
    });
    log(`工程 ${prj.name}：${cap.stats.parts} 件、${cap.stats.points} 点（成功 ${cap.stats.ok}），${Math.round(performance.now() - t0)} ms`);
  }
  return out;
}

window.__buildSeed = build;
