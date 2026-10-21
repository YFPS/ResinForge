import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Boxes, Check, Command, Info, Layers3, PackagePlus,
  Pencil, Plus, Printer, RefreshCw, Save, Sparkles, Trash2,
} from 'lucide-react';
import Button from '@/components/arc/button/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/arc/popover/popover';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import Progress from '@/components/arc/progress/progress';
import { createWorkspaceScene } from './wsScene.js';
import {
  LIBRARY_FOLDERS, MACHINES, MATERIALS, SUPPORT_PRESETS, keyInfo, layoutItems, makeItem,
  machineById, materialById, presetName, relativeTime, summarize,
} from './data.js';
import { supportCount } from './supportsMock.js';
import { DRAG_MIME, InsertPalette, LibraryTab, Shelf } from './wsLibrary.jsx';
import { MoreMenu } from './menu.jsx';
import { ConfirmCloseDialog, FolderPickerDialog } from './dialogs.jsx';
import { Thumb } from './ui.jsx';

/* 工程工作区（Demo）：照 Studio 的「全屏 3D + 浮动卡片」做。
   打开工程时按设计文档的恢复顺序走一遍（读工程 → 载入零件 → 逐层分析 → 重建支撑结构），耗时比例取自
   .ref/proj-roundtrip 实测（环面结：分析 0.49 s、重建 1.6 s）；支撑是示意几何，不是产品算法。
   三套方案共用这个工作区，只是取用零件库的方式不同：A 左卡页签 / B 底部货架 / C 插入面板。 */

const STEPS = ['模型', '朝向', '分析', '支撑', '导出'];
const RESTORE = [
  { label: '读取工程文件', ms: 160 },
  { label: '载入零件', ms: 280 },
  { label: '逐层分析', ms: 520 },
  { label: '重建支撑结构', ms: 900 },
];

const cloneProject = p => ({
  ...p,
  items: p.items.map(it => ({ ...it, pos: it.pos ? { ...it.pos } : null })),
  builtPreset: p.preset,
  builtLayer: p.layerUm,
});

export function Workspace({ scheme, project, parts, thumbs, usage, pendingInsert, onPendingDone, onSave, onClose, onAddToLibrary, onManageLibrary, notify }) {
  const [draft, setDraft] = useState(() => cloneProject(project));
  const [changes, setChanges] = useState([]);
  const [savedAt, setSavedAt] = useState(project.updatedAt);
  const [selected, setSelected] = useState(null);
  const [restore, setRestore] = useState({ i: 0 });
  const [busy, setBusy] = useState(null);
  const [tab, setTab] = useState('objects');
  const [shelfOpen, setShelfOpen] = useState(true);
  const [palette, setPalette] = useState(false);
  const [confirm, setConfirm] = useState(null);   // 'close' | 'manage'
  const [addTarget, setAddTarget] = useState(null);
  const [naming, setNaming] = useState(false);
  const [dropHint, setDropHint] = useState(false);
  const [machineOpen, setMachineOpen] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);

  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const sceneRef = useRef(null);
  const framed = useRef(false);

  const machine = machineById(draft.machineId);
  const material = materialById(draft.materialId);
  const positions = useMemo(() => layoutItems(draft.items), [draft.items]);
  const anySup = draft.items.some(it => it.sup);
  const restoring = !!restore;
  const supReady = !restoring || restore.i >= RESTORE.length;
  const outside = useMemo(() => {
    const out = new Set();
    for (const it of draft.items) {
      const p = positions.get(it.uid) || { x: 0, z: 0 };
      const s = keyInfo(it.key).size;
      if (Math.abs(p.x) + s.x / 2 > machine.plateX / 2 + 0.01 || Math.abs(p.z) + s.z / 2 > machine.plateZ / 2 + 0.01) out.add(it.uid);
    }
    return out;
  }, [draft.items, positions, machine]);
  const staleReasons = [];
  if (anySup && draft.builtPreset !== draft.preset) staleReasons.push(`支撑模板改为「${presetName(draft.preset)}」`);
  if (anySup && draft.builtLayer !== draft.layerUm) staleReasons.push(`层厚改为 ${draft.layerUm} µm`);
  const supPoints = draft.items.reduce((s, it) => s + (it.sup ? supportCount(it.key, draft.builtPreset) : 0), 0);
  const summary = summarize({ ...draft, preset: draft.builtPreset });
  const pending = draft.items.filter(it => !it.sup);
  const dirty = changes.length > 0;

  const change = useCallback((fn, label) => {
    setDraft(d => fn(d));
    setChanges(c => [...c, label]);
  }, []);

  /* ---------- 3D 场景 ---------- */
  useEffect(() => {
    const scene = createWorkspaceScene(canvasRef.current);
    sceneRef.current = scene;
    const ro = new ResizeObserver(() => scene.resize());
    ro.observe(stageRef.current);
    scene.resize();
    const mo = new MutationObserver(() => scene.setTheme());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { ro.disconnect(); mo.disconnect(); scene.dispose(); sceneRef.current = null; };
  }, []);

  useEffect(() => { sceneRef.current?.setPlate(machine); }, [machine]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const loaded = !restoring || restore.i >= 2;
    const items = loaded ? draft.items.map(it => ({ uid: it.uid, key: it.key, sup: it.sup && supReady })) : [];
    scene.setItems(items, positions, {
      color: material.color, preset: draft.builtPreset, lifted: anySup && loaded,
      selected, outside,
    });
    if (loaded && !framed.current && items.length) { framed.current = true; scene.frameAll(); }
  }, [draft.items, draft.builtPreset, positions, material, selected, outside, restoring, restore, supReady, anySup]);

  /* ---------- 打开工程：按恢复顺序走一遍 ---------- */
  useEffect(() => {
    const steps = project.items.some(it => it.sup) ? RESTORE : RESTORE.slice(0, 2);
    let cancelled = false;
    let i = 0;
    const t0 = performance.now();
    const tick = () => {
      if (cancelled) return;
      if (i >= steps.length) {
        setRestore(null);
        const pts = project.items.reduce((s, it) => s + (it.sup ? supportCount(it.key, project.preset) : 0), 0);
        notify(pts ? `已打开「${project.name}」：恢复 ${pts} 个支撑点，结构已重建（${((performance.now() - t0) / 1000).toFixed(1)} s）` : `已打开「${project.name}」`);
        return;
      }
      setRestore({ i, steps });
      setTimeout(() => { i++; tick(); }, steps[i].ms);
    };
    tick();
    return () => { cancelled = true; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- 操作 ---------- */
  const insertPart = useCallback((part, pos = null) => {
    const item = makeItem(part.key, part.name, part.id, false, part.source === 'import' ? 'import' : 'library');
    item.pos = pos;
    change(d => ({ ...d, items: [...d.items, item] }), `插入「${part.name}」`);
    setSelected(item.uid);
    notify(`已插入「${part.name}」（副本）${anySup ? '：还没有支撑，点「生成支撑」补上' : ''}`);
  }, [change, notify, anySup]);

  const generate = useCallback((label = '生成支撑') => {
    if (busy || restoring) return;
    setBusy({ label: `${label}：布点…`, p: 30 });
    setTimeout(() => setBusy({ label: `${label}：出结构…`, p: 72 }), 380);
    setTimeout(() => {
      setBusy(null);
      change(d => ({ ...d, items: d.items.map(it => ({ ...it, sup: true })), builtPreset: d.preset, builtLayer: d.layerUm }), label);
    }, 900);
  }, [busy, restoring, change]);

  /* 从资源库「放进工程…」过来：打开完再插入，插入算一处未保存的修改 */
  useEffect(() => {
    if (restoring || !pendingInsert) return;
    insertPart(pendingInsert);
    onPendingDone?.();
  }, [restoring, pendingInsert]);   // eslint-disable-line react-hooks/exhaustive-deps

  const removeItem = useCallback(uid => {
    const it = draft.items.find(x => x.uid === uid);
    if (!it) return;
    change(d => ({ ...d, items: d.items.filter(x => x.uid !== uid) }), `移除「${it.name}」`);
    if (selected === uid) setSelected(null);
  }, [draft.items, change, selected]);

  const setMachine = id => {
    if (id === draft.machineId) return;
    const m = machineById(id);
    change(d => ({ ...d, machineId: id }), `机器改为 ${m.model}`);
    setMachineOpen(false);
  };

  const setMaterial = id => {
    if (id === draft.materialId) return;
    const m = materialById(id);
    change(d => {
      const layerUm = m.layers.includes(d.layerUm) ? d.layerUm : m.layers[0];
      // 还没生成支撑时，支撑模板跟着材料的默认档走；已有支撑就不动（换不换由人决定）
      const hasSup = d.items.some(it => it.sup);
      return { ...d, materialId: id, layerUm, preset: hasSup ? d.preset : m.preset };
    }, `材料改为 ${m.name}`);
  };

  const setLayer = um => { if (um !== draft.layerUm) change(d => ({ ...d, layerUm: um }), `层厚改为 ${um} µm`); };
  const setPreset = id => { if (id !== draft.preset) change(d => ({ ...d, preset: id }), `支撑模板改为「${presetName(id)}」`); };

  const save = useCallback(() => {
    if (busy || restoring) return;
    // 结构还没按新参数重建时，保存的是支撑点 + 新参数；下次打开按新参数重建（与产品设计一致）
    const out = { ...draft, preset: draft.preset, layerUm: draft.layerUm };
    onSave(out);
    setChanges([]);
    setSavedAt(new Date().toISOString());
    notify(`已保存「${draft.name}」：${draft.items.length} 个零件、${supPoints} 个支撑点和参数快照`);
  }, [busy, restoring, draft, onSave, notify, supPoints]);

  const requestClose = (kind = 'close') => {
    if (dirty) setConfirm(kind);
    else (kind === 'manage' ? onManageLibrary : onClose)();
  };

  /* 快捷键：Ctrl S 保存、Ctrl K 插入零件、Delete 移除选中、Esc 取消选择 */
  useEffect(() => {
    const onKey = e => {
      const mod = e.ctrlKey || e.metaKey;
      const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (scheme === 'c') setPalette(true);
        else if (scheme === 'b') setShelfOpen(true);
        else setTab('library');
        return;
      }
      if (typing) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) { e.preventDefault(); removeItem(selected); }
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, scheme, selected, removeItem]);

  /* 视口：点选零件 / 拖入零件 */
  const down = useRef(null);
  const onPointerDown = e => { down.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = e => {
    const d = down.current;
    down.current = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.button !== 0) return;
    setSelected(sceneRef.current?.pickItem(e.clientX, e.clientY) || null);
  };
  const onDragOver = e => {
    if (![...e.dataTransfer.types].includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropHint(true);
  };
  const onDrop = e => {
    setDropHint(false);
    const id = e.dataTransfer.getData(DRAG_MIME);
    const part = parts.find(p => p.id === id);
    if (!part) return;
    e.preventDefault();
    const pos = sceneRef.current?.pickPlate(e.clientX, e.clientY);
    insertPart(part, pos || null);
  };

  /* ---------- 渲染 ---------- */
  const objectsList = (
    <ScrollArea className="wsObjScroll" fade={16}>
      <div className="wsObjList">
        {draft.items.map(it => {
          const n = it.sup ? supportCount(it.key, draft.builtPreset) : 0;
          const out = outside.has(it.uid);
          return (
            <div key={it.uid} className={'wsObj' + (selected === it.uid ? ' is-on' : '')} role="button" tabIndex={0}
              onClick={() => setSelected(it.uid)} onKeyDown={e => { if (e.key === 'Enter') setSelected(it.uid); }}>
              <Thumb url={thumbs[it.key]} className="wsObjThumb" />
              <span className="wsObjMain">
                <b>{it.name}</b>
                <small className={out ? 'is-warn' : !it.sup && anySup ? 'is-pending' : ''}>
                  {out ? '超出板面' : it.sup ? (supReady ? `支撑 ${n} 点` : '恢复支撑…') : '待生成支撑'}
                  <span className="wsOrigin">{it.origin === 'import' ? '导入' : '零件库'}</span>
                </small>
              </span>
              <MoreMenu label={`${it.name} 的操作`} items={[
                !it.sup ? { label: '生成支撑', icon: <Sparkles size={15} />, onSelect: () => generate() } : null,
                { label: '加入零件库…', icon: <PackagePlus size={15} />, onSelect: () => setAddTarget(it) },
                { label: '从工程移除', icon: <Trash2 size={15} />, destructive: true, separatorBefore: true, onSelect: () => removeItem(it.uid) },
              ]} />
            </div>
          );
        })}
        {!draft.items.length ? <p className="wsEmpty">工程里还没有零件{scheme === 'a' ? '，到「零件库」页签里添加' : scheme === 'b' ? '，从下方货架拖进来' : '，按 Ctrl K 插入'}</p> : null}
      </div>
    </ScrollArea>
  );

  const restoreCard = restoring ? (
    <div className="wsProgress" role="status">
      <div className="wsProgressHead">
        <b>打开工程</b>
        <span>{restore.steps ? restore.steps[restore.i]?.label : '读取工程文件'}…</span>
      </div>
      <ol className="wsProgressSteps">
        {(restore.steps || RESTORE).map((s, i) => (
          <li key={s.label} className={i < restore.i ? 'is-done' : i === restore.i ? 'is-on' : ''}>
            <span>{i < restore.i ? <Check size={11} strokeWidth={2.6} /> : i + 1}</span>{s.label}
          </li>
        ))}
      </ol>
      <Progress value={Math.round(((restore.i + 0.5) / (restore.steps || RESTORE).length) * 100)} label="打开进度" />
      <p>支撑结构不进工程文件：打开时按保存的支撑点和参数重建（实测环面结 191 点约 2 秒）。</p>
    </div>
  ) : busy ? (
    <div className="wsProgress wsProgress--slim" role="status">
      <div className="wsProgressHead"><b>{busy.label}</b></div>
      <Progress value={busy.p} label="支撑进度" />
    </div>
  ) : null;

  return (
    <div className={'ws ws--' + scheme}>
      <div ref={stageRef} className={'wsStage' + (dropHint ? ' is-drop' : '')}
        onPointerDown={onPointerDown} onPointerUp={onPointerUp}
        onDragOver={onDragOver} onDragLeave={() => setDropHint(false)} onDrop={onDrop}>
        <canvas ref={canvasRef} className="wsCanvas" />
        {dropHint ? <div className="wsDropHint">松开放到板面上</div> : null}
      </div>

      {/* 顶栏：返回 · 工程名 · 保存状态 · 流程 · 机器 · 材料 · 保存 */}
      <header className="wsBar">
        <Button variant="ghost" size="sm" className="wsBack" onClick={() => requestClose('close')}><ArrowLeft size={15} />资源库</Button>
        <span className="wsSep" />
        {naming ? (
          <input className="wsNameInput" autoFocus defaultValue={draft.name}
            onBlur={e => { const v = e.target.value.trim(); setNaming(false); if (v && v !== draft.name) change(d => ({ ...d, name: v }), `重命名为「${v}」`); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setNaming(false); }} />
        ) : (
          <button type="button" className="wsName" onClick={() => setNaming(true)} title="重命名工程">
            <span>{draft.name}</span><Pencil size={12} />
          </button>
        )}
        <span className={'wsSaveState' + (dirty ? ' is-dirty' : '')} title={dirty ? changes.join('\n') : `保存于 ${relativeTime(savedAt)}`}>
          <i />{dirty ? `未保存 · ${changes.length} 处修改` : '已保存'}
        </span>
        <span className="wsSep wsHideNarrow" />
        <nav className="wsSteps wsHideNarrow" aria-label="流程（沿用 Studio）">
          {STEPS.map((s, i) => (
            <span key={s} className={s === '支撑' ? 'is-on' : ''}>
              <b data-done={i < 3 ? '' : undefined}>{i < 3 ? <Check size={9} strokeWidth={3} /> : i + 1}</b>{s}
            </span>
          ))}
        </nav>
        <span className="wsSep" />
        <Popover open={machineOpen} onOpenChange={setMachineOpen}>
          <PopoverTrigger className="wsChip"><Printer size={14} strokeWidth={1.8} /><span>{machine.model}</span></PopoverTrigger>
          <PopoverContent align="end" className="wsPop">
            <div className="wsPopHead"><b>机器</b><span>决定板面、像素与越界检查；换机器不动支撑</span></div>
            <div className="wsPopList">
              {MACHINES.map(m => (
                <button key={m.id} type="button" className={m.id === draft.machineId ? 'is-on' : ''} onClick={() => setMachine(m.id)}>
                  <span><b>{m.brand} {m.model}</b><small>{m.plateX} × {m.plateZ} mm · {m.pixelUm} µm · {m.type}</small></span>
                  {m.id === draft.machineId ? <Check size={14} /> : null}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Popover open={materialOpen} onOpenChange={setMaterialOpen}>
          <PopoverTrigger className="wsChip"><i className="wsDot" style={{ background: material.color }} /><span>{material.name}</span><em>{draft.layerUm} µm</em></PopoverTrigger>
          <PopoverContent align="end" className="wsPop wsPop--material">
            <div className="wsPopHead"><b>材料与工艺</b><span>工程保存的是参数快照，材料库以后改了也不影响这个工程</span></div>
            <div className="wsPopList">
              {MATERIALS.map(m => (
                <button key={m.id} type="button" className={m.id === draft.materialId ? 'is-on' : ''} onClick={() => setMaterial(m.id)}>
                  <i className="wsDot" style={{ background: m.color }} />
                  <span><b>{m.name}</b><small>{m.note} · 默认{presetName(m.preset)}支撑</small></span>
                  {m.id === draft.materialId ? <Check size={14} /> : null}
                </button>
              ))}
            </div>
            <div className="wsPopField">
              <span>层厚</span>
              <div className="wsSeg">
                {material.layers.map(u => <button key={u} type="button" className={u === draft.layerUm ? 'is-on' : ''} onClick={() => setLayer(u)}>{u} µm</button>)}
              </div>
            </div>
            <div className="wsPopField">
              <span>支撑模板</span>
              <div className="wsSeg">
                {SUPPORT_PRESETS.map(p => <button key={p.id} type="button" className={p.id === draft.preset ? 'is-on' : ''} onClick={() => setPreset(p.id)}>{p.name}</button>)}
              </div>
            </div>
            {anySup ? <p className="wsPopNote"><Info size={13} />改层厚或支撑模板后，支撑点保留，结构要按新参数重建。</p> : null}
          </PopoverContent>
        </Popover>
        <Button variant="primary" size="sm" className="wsSave" onClick={save} disabled={restoring || !!busy}><Save size={14} />保存</Button>
      </header>

      {/* 左：对象（A 方案带「零件库」页签） */}
      <aside className="wsLeft">
        <section className="wsCard wsCard--objects">
          <div className="wsCardHead">
            {scheme === 'a' ? (
              <div className="wsTabs" role="tablist" aria-label="左侧面板">
                <button type="button" role="tab" aria-selected={tab === 'objects'} className={tab === 'objects' ? 'is-on' : ''} onClick={() => setTab('objects')}>
                  对象<span>{draft.items.length}</span>
                </button>
                <button type="button" role="tab" aria-selected={tab === 'library'} className={tab === 'library' ? 'is-on' : ''} onClick={() => setTab('library')}>
                  零件库<span>{parts.length}</span>
                </button>
              </div>
            ) : (
              <>
                <b className="wsCardTitle"><Boxes size={14} strokeWidth={1.8} />对象<span>{draft.items.length}</span></b>
                {scheme === 'c' ? (
                  <Button variant="ghost" size="sm" className="wsHeadBtn" onClick={() => setPalette(true)}><Plus size={14} />插入零件<kbd><Command size={10} />K</kbd></Button>
                ) : (
                  <Button variant="ghost" size="sm" className="wsHeadBtn" onClick={() => setShelfOpen(o => !o)}>{shelfOpen ? '收起货架' : '零件货架'}</Button>
                )}
              </>
            )}
          </div>
          {scheme === 'a' && tab === 'library'
            ? <LibraryTab parts={parts} thumbs={thumbs} onInsert={p => insertPart(p)} onManage={() => requestClose('manage')} />
            : objectsList}
        </section>
      </aside>

      {/* 右：工程（快照 + 失效提示 + 支撑操作） */}
      <aside className="wsRight">
        <section className="wsCard wsCard--project">
          <div className="wsCardHead"><b className="wsCardTitle">工程</b><span className="wsMuted">{dirty ? '未保存' : `保存于 ${relativeTime(savedAt)}`}</span></div>
          <div className="wsRows">
            <div><span>机器</span><b>{machine.model}</b></div>
            <div><span>板面</span><b>{machine.plateX} × {machine.plateZ} mm · {machine.pixelUm} µm</b></div>
            <div><span>材料</span><b><i className="wsDot" style={{ background: material.color }} />{material.name}</b></div>
            <div><span>层厚</span><b>{draft.layerUm} µm</b></div>
            <div><span>支撑模板</span><b>{presetName(draft.preset)}</b></div>
            <div><span>零件</span><b>{draft.items.length} 件</b></div>
            <div><span>支撑点</span><b>{supReady ? supPoints : '—'}</b></div>
            <div><span>层数 · 树脂</span><b>{summary.layers} 层 · ≈ {summary.resinG} g</b></div>
          </div>
          {outside.size ? (
            <div className="wsNotice is-warn"><AlertTriangle size={14} /><span>{outside.size} 件零件超出 {machine.model} 的板面，换机器或移除零件。</span></div>
          ) : null}
          {staleReasons.length && supReady ? (
            <div className="wsNotice">
              <RefreshCw size={14} />
              <span>{staleReasons.join('、')}：支撑点保留，结构需要按新参数重建。</span>
              <Button variant="secondary" size="sm" onClick={() => generate('重建支撑')}>重建</Button>
            </div>
          ) : null}
          {pending.length && supReady ? (
            <Button variant="secondary" size="sm" className="wsGen" onClick={() => generate()} disabled={!!busy}>
              <Sparkles size={14} />{anySup ? `给 ${pending.length} 件新零件生成支撑` : '生成支撑'}
            </Button>
          ) : null}
          <p className="wsFoot"><Layers3 size={13} />保存：零件引用、位置、保护面、支撑点和参数快照。支撑结构打开时重建，不进文件。</p>
        </section>
      </aside>

      {/* 底部：B 货架 / C 插入入口 / 进度 */}
      <div className="wsBottom">
        {restoreCard}
        {!restoreCard && scheme === 'b' ? <Shelf parts={parts} thumbs={thumbs} onInsert={p => insertPart(p)} open={shelfOpen} onToggle={() => setShelfOpen(o => !o)} /> : null}
        {!restoreCard && scheme === 'c' ? (
          <button type="button" className="wsShelfPill" onClick={() => setPalette(true)}><Plus size={15} />插入零件<kbd><Command size={10} />K</kbd></button>
        ) : null}
      </div>

      {scheme === 'c' ? <InsertPalette open={palette} onOpenChange={setPalette} parts={parts} thumbs={thumbs} usage={usage} onInsert={p => insertPart(p)} /> : null}

      <ConfirmCloseDialog
        open={!!confirm}
        name={draft.name}
        changes={changes}
        onCancel={() => setConfirm(null)}
        onDiscard={() => { const k = confirm; setConfirm(null); (k === 'manage' ? onManageLibrary : onClose)(); }}
        onSave={() => { const k = confirm; save(); setConfirm(null); (k === 'manage' ? onManageLibrary : onClose)(); }}
      />
      <FolderPickerDialog
        open={!!addTarget}
        title="加入零件库"
        description={addTarget ? `把「${addTarget.name}」复制一份放进零件库。` : ''}
        folders={LIBRARY_FOLDERS}
        note="加入的是副本：以后改这个工程，不会改到库里的零件；同一份模型文件只存一次。"
        confirmText="加入"
        onCancel={() => setAddTarget(null)}
        onConfirm={res => { onAddToLibrary(addTarget, res); setAddTarget(null); }}
      />
    </div>
  );
}
