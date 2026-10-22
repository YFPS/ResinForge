import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Sparkles, Upload } from 'lucide-react';
import { Button } from '@/components/arc/button/button';
import { SplitButton } from '@/components/arc/split-button/split-button';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import { state, params } from '../store.js';
import { setSupportHotkeys, setMode } from '../core/scene.js';
import { setHeat, isHeatOn } from '../core/heat.js';
import { useBusLatest, useParams } from '../demo/bridge.js';
import { getUI, goStep, runTask, useDone, useUI } from '../demo/ui.js';
import {
  doAnalyze, doBuildFrame, doClearSupports, doExport, doExportFrame, doGenSupports, doLoadDemo, doOrient,
  doRebuild, pickSTL, splitModelName,
} from '../demo/actions.js';
import {
  MobileMenu, NextButton, RedesignToasts, Sidebar, Stage, StatusBar, TopBar,
} from './parts.jsx';
import { STEP_COPY, fmt1, fmt2, fmtInt } from './copy.jsx';
import { AnalyzePanel, ExportPanel, FramePanel, ModelPanel, OrientPanel, SupportPanel } from './panels.jsx';

const PANELS = { model: ModelPanel, orient: OrientPanel, analyze: AnalyzePanel, support: SupportPanel, frame: FramePanel, export: ExportPanel };

export default function RedesignApp() {
  const { step, busy } = useUI();
  const done = useDone();
  const paramsBag = useParams();       // 参数改动让整页跟上（面板用同一份）
  const infoRaw = useBusLatest('modelInfo', null);
  const slice = useBusLatest('sliceStats', null);
  useBusLatest('supStats', null);     // 只用来让页面跟结构统计一起重绘
  const frame = useBusLatest('frame', state.frame);
  const orient = useBusLatest('orientResults', null) || [];
  const heat = useBusLatest('heat', false);
  const mode = useBusLatest('mode', 'orbit');
  const progress = useBusLatest('progress', null);
  const [menuOpen, setMenuOpen] = useState(false);
  const bootRef = useRef(false);
  void paramsBag;

  /* 顶部与状态条共用的一份模型摘要 */
  const info = useMemo(() => {
    if (!infoRaw) return null;
    const one = infoRaw.parts && infoRaw.parts.length === 1 ? splitModelName(infoRaw.parts[0].name) : null;
    const title = one ? one.name : infoRaw.name;
    return {
      title,
      meta: `${one && one.demo ? '演示模型 · ' : ''}${infoRaw.sizeText} · ${fmtInt(infoRaw.nf)} 面`,
      metaSize: infoRaw.sizeText,
      count: infoRaw.parts ? infoRaw.parts.length : 1,
      nf: infoRaw.nf,
    };
  }, [infoRaw]);

  /* 支撑步骤才吃 V / N 这类单键快捷键；离开视口编辑模式时回到浏览 */
  useEffect(() => {
    setSupportHotkeys(step === 'support');
    if (mode === 'protect' && step !== 'orient' && step !== 'support') setMode('orbit');
    if ((mode === 'add' || mode === 'del') && step !== 'support') setMode('orbit');
  }, [step, mode]);

  /* 设计决定：热力图是「分析」步骤的读图工具；进支撑默认看素模与结构，需要时再点亮视口的火焰按钮。 */
  useEffect(() => {
    if (step !== 'support') return undefined;
    const t = setTimeout(() => { if (isHeatOn()) setHeat(false); }, 30);
    return () => clearTimeout(t);
  }, [step]);

  /* 演示默认把环面结转成一次分析：首屏就有真实的层数、孤岛与高度梯。 */
  useEffect(() => {
    let alive = true;
    let tries = 0;
    const tick = () => {
      if (!alive || bootRef.current) return;
      if (getUI().busy) { bootRef.current = true; return; }
      if (state.mesh && !state.analysis) {
        bootRef.current = true;
        runTask('analyze', doAnalyze);
        return;
      }
      if (++tries < 24) setTimeout(tick, 250);
    };
    const timer = setTimeout(tick, 500);
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  const points = (state.supportPoints || []).length;
  const stats = state.supportStats;
  const openIslands = stats ? (stats.islOpen || 0) + (stats.islFail || 0) : (slice ? slice.islandCount : null);

  const status = (() => {
    if (!infoRaw) return { label: '空盘', tone: '' };
    if (done.export) return { label: '已导出', tone: 'good' };
    if (done.support) return openIslands ? { label: '待补孤岛', tone: 'bad' } : { label: '可导出', tone: 'good' };
    if (slice) return openIslands ? { label: '待生成支撑', tone: 'bad' } : { label: '无孤岛', tone: 'good' };
    return { label: '待分析', tone: 'live' };
  })();

  /* 顶栏右侧：这一盘最要紧的一句话 + 直接可点的动作 */
  let finding;
  if (busy) {
    finding = { text: progress && progress.text ? progress.text : '处理中…', action: null };
  } else if (!infoRaw) {
    finding = {
      text: '还没有模型，先用演示模型看一遍流程。',
      action: { label: '载入环面结', run: () => runTask('model', () => doLoadDemo('knot')) },
    };
  } else if (!slice) {
    finding = {
      text: '还没有逐层分析，支撑点无从落起。',
      action: { label: '开始分析', run: () => runTask('analyze', doAnalyze) },
    };
  } else if (!done.support) {
    finding = slice.islandCount > 0
      ? {
        text: <><strong data-tone="bad">{slice.islandCount} 处孤岛</strong>，合计 {fmt1(slice.totIslandArea)} mm² 尚未支撑</>,
        action: { label: '生成支撑', run: () => runTask('sup-auto', () => doGenSupports()) },
      }
      : {
        text: '没有孤岛；支撑只为陡峭悬空服务。',
        action: { label: '生成支撑', run: () => runTask('sup-auto', () => doGenSupports()) },
      };
  } else if (openIslands) {
    finding = {
      text: <><strong data-tone="bad">{openIslands} 处孤岛</strong>仍然悬空</>,
      action: { label: '补孤岛支撑', run: () => runTask('sup-isl', () => doGenSupports({ islandsOnly: true })) },
    };
  } else {
    finding = {
      text: <><strong data-tone="good">支撑已覆盖全部孤岛</strong>，可以导出</>,
      action: { label: '去导出', run: () => goStep('export') },
    };
  }

  const summary = (() => {
    if (step === 'model') {
      return info ? `${info.count} 件 · ${fmtInt(info.nf)} 面。全部计算在本机完成。` : STEP_COPY.model.help;
    }
    if (step === 'orient') {
      return orient.length ? `${orient.length} 个候选，最佳评分 ${orient[0].score}；缩略图直接点选套用。` : STEP_COPY.orient.help;
    }
    if (step === 'analyze') {
      return slice
        ? `${fmtInt(slice.layers)} 层 · ${slice.islandCount} 处孤岛 · 最大截面 ${fmt1(slice.maxFill)} mm²。`
        : STEP_COPY.analyze.help;
    }
    if (step === 'support') {
      return done.support
        ? `${fmtInt(points)} 个支撑点 · ${stats ? fmtInt(stats.nodes) : '—'} 个格架节点 · ${openIslands || 0} 处孤岛仍悬空。`
        : STEP_COPY.support.help;
    }
    if (step === 'frame') {
      return frame
        ? `边框 ${frame.sizeText} · ${fmtInt(frame.triangles)} 面 · ${frame.pillars} 根立柱。`
        : STEP_COPY.frame.help;
    }
    return `底板：${params.autoPlateOn ? '自动底板' : '连接底板'} · ${params.unionExport ? '导出前布尔并' : '交给切片软件并集'} · ${fmt2(params.layerH)} mm 层厚`;
  })();

  const Panel = PANELS[step] || ModelPanel;
  const busyElsewhere = key => !!busy && busy !== key;

  const primary = (() => {
    if (step === 'model') {
      return (
        <Button variant="primary" onClick={() => pickSTL(false)} disabled={!!busy}>
          <Upload size={15} strokeWidth={1.9} aria-hidden="true" />
          打开 STL…
        </Button>
      );
    }
    if (step === 'orient') {
      return (
        <Button
          variant="primary"
          loading={busy === 'orient'}
          disabled={busyElsewhere('orient')}
          onClick={() => runTask('orient', doOrient)}
        >
          {orient.length ? '重新计算朝向' : '计算朝向'}
        </Button>
      );
    }
    if (step === 'analyze') {
      return (
        <Button
          variant="primary"
          loading={busy === 'analyze'}
          disabled={busyElsewhere('analyze')}
          onClick={() => runTask('analyze', doAnalyze)}
        >
          {slice ? '重新分析' : '运行逐层分析'}
        </Button>
      );
    }
    if (step === 'frame') {
      return (
        <div className="rf-split">
          <SplitButton
            label={busy === 'frame' ? '正在生成…' : done.frame ? '重新生成边框' : '生成边框'}
            disabled={!!busy}
            onClick={() => runTask('frame', doBuildFrame)}
            actions={[
              { label: '仅导出边框', disabled: !done.frame, onSelect: () => runTask('export-frame', doExportFrame) },
            ]}
          />
        </div>
      );
    }
    if (step === 'support') {
      const label = busy === 'sup-auto' ? '正在生成…' : done.support ? '重新生成' : '生成支撑';
      return (
        <div className="rf-split">
          <SplitButton
            label={label}
            icon={done.support && busy !== 'sup-auto' ? <RefreshCw size={15} strokeWidth={1.8} /> : <Sparkles size={15} strokeWidth={1.8} />}
            disabled={!!busy}
            onClick={() => runTask('sup-auto', () => doGenSupports())}
            actions={[
              { label: '只补孤岛支撑', onSelect: () => runTask('sup-isl', () => doGenSupports({ islandsOnly: true })) },
              { label: '按当前参数重建结构', disabled: !points, onSelect: () => runTask('sup-rebuild', doRebuild) },
              { label: '清空支撑', destructive: true, disabled: !points, onSelect: doClearSupports },
            ]}
          />
        </div>
      );
    }
    return (
      <div className="rf-split">
        <SplitButton
          label={busy === 'export' ? '正在导出…' : done.export ? '再次导出' : '导出模型 + 支撑'}
          disabled={!!busy}
          onClick={() => runTask('export', () => doExport(true))}
          actions={[
            { label: '仅导出支撑', onSelect: () => runTask('export-support', () => doExport(false)) },
          ]}
        />
      </div>
    );
  })();

  const progressPct = progress && progress.p != null ? Math.max(0, Math.min(100, Math.round(progress.p * 100))) : null;

  return (
    <div className="rf">
      <Sidebar />
      <div className="rf-main">
        <TopBar
          info={info}
          status={status}
          finding={finding}
          onOpenFile={() => pickSTL(false)}
          onMenu={() => setMenuOpen(true)}
        />
        <div className="rf-sheet">
          {progressPct != null ? <div className="rf-progress" style={{ width: `${progressPct}%` }} aria-hidden="true" /> : null}
          <Stage mode={mode} heat={heat} onToggleHeat={() => setHeat(!heat)} />
          <section className="rf-insp" aria-labelledby="insp-title">
            <div className="rf-inspHead">
              <h2 id="insp-title">{STEP_COPY[step].title}</h2>
              <p>{summary}</p>
            </div>
            <ScrollArea className="rf-scroll" fade={34} label={`${STEP_COPY[step].title}参数`}>
              <div className="rf-scrollBody">
                <Panel />
              </div>
            </ScrollArea>
            <div className="rf-inspFoot">
              <div className="rf-footMain">{primary}</div>
              {step !== 'export' ? <NextButton /> : null}
            </div>
          </section>
          <StatusBar info={info} slice={slice} progress={progress} />
        </div>
      </div>
      <MobileMenu open={menuOpen} onOpenChange={setMenuOpen} />
      <RedesignToasts />
    </div>
  );
}
