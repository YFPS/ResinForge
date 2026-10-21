import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Boxes, Check, ChevronRight, Copy, Download, FileJson, Gauge,
  HelpCircle, Layers3, Plus, Printer, Search, Sparkles, Star, Tag, Upload, X,
} from 'lucide-react';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/arc/popover/popover';
import { MoreMenu } from './menu.jsx';
import { projectFiles } from './projectFile.js';
import {
  LIBRARY_FOLDERS, MACHINES, MATERIALS, SUPPORT_PRESETS, folderName, machineById, materialById,
  presetName, relativeTime, thumbKeyOfProject,
} from './data.js';

export const projThumb = (p, thumbs) => thumbs[thumbKeyOfProject(p)] || null;

export function Thumb({ url, className = '', children }) {
  return (
    <div className={'ldThumb ' + className}>
      {url ? <img src={url} alt="" draggable="false" /> : <span className="ldThumbShimmer" aria-hidden="true" />}
      {children}
    </div>
  );
}

export function StatusPill({ children, tone = 'neutral' }) {
  return <span className={'ldPill ldPill--' + tone}>{children}</span>;
}

export function StarMark({ on }) {
  return <Star size={13} strokeWidth={2} className={on ? 'ldStarOn' : 'ldStarOff'} fill={on ? 'currentColor' : 'none'} />;
}

const statusText = p => (p.status === 'sliced' ? '已切片' : p.status === 'new' ? '新建' : p.supports ? '已加支撑' : '待加支撑');
const statusTone = p => (p.status === 'sliced' ? 'success' : p.supports ? 'neutral' : 'warning');

/* 多选勾：有选中项时常显，否则悬停才出现 */
function CheckMark({ on, onToggle, label }) {
  return (
    <span role="checkbox" aria-checked={on} aria-label={label} tabIndex={0} className={'ldCheck' + (on ? ' is-on' : '')}
      onClick={e => { e.stopPropagation(); onToggle(); }}
      onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onToggle(); } }}>
      {on ? <Check size={11} strokeWidth={3} /> : null}
    </span>
  );
}

export function ProjectCard({ item, thumbs, selected, onSelect, onOpen, menu, checked, onCheck, selecting, variant = 'a' }) {
  const machine = machineById(item.machineId);
  const material = materialById(item.materialId);
  return (
    <div role="button" tabIndex={0}
      className={`ldProjCard ldProjCard--${variant} ${selected ? 'is-on' : ''} ${checked ? 'is-checked' : ''} ${selecting ? 'is-selecting' : ''}`}
      onClick={() => (selecting ? onCheck?.() : onSelect(item.id))}
      onDoubleClick={() => onOpen?.(item)}
      onKeyDown={e => { if (e.key === 'Enter') onOpen?.(item); }}>
      <Thumb url={projThumb(item, thumbs)} className="ldProjThumb">
        <span className="ldProjStatus">{statusText(item)}</span>
        {item.starred ? <span className="ldProjStar"><StarMark on /></span> : null}
        {onCheck ? <CheckMark on={!!checked} onToggle={onCheck} label={`选择${item.name}`} /> : null}
      </Thumb>
      <div className="ldProjBody">
        <div className="ldProjTitleRow">
          <span className="ldProjName">{item.name}</span>
          {menu ? <MoreMenu items={menu} label={`${item.name} 的操作`} /> : null}
        </div>
        <div className="ldProjMeta">
          <Printer size={12} strokeWidth={1.8} />
          <span>{machine.model}</span>
          <span className="ldDot" />
          <i className="ldMiniDot" style={{ background: material.color }} />
          <span>{material.name}</span>
        </div>
        <div className="ldProjFoot">
          <span><Layers3 size={12} strokeWidth={1.8} />{item.supports ? `${item.supports} 支撑点` : '还没有支撑'}</span>
          <span>{item.parts} 件 · {relativeTime(item.updatedAt)}</span>
        </div>
      </div>
    </div>
  );
}

export function PartCard({ item, thumbs, selected, onSelect, menu, checked, onCheck, selecting, usage, variant = 'a' }) {
  const facesLabel = item.faces >= 10000 ? `${Math.round(item.faces / 1000)}k 面`
    : item.faces >= 1000 ? `${(item.faces / 1000).toFixed(1)}k 面` : `${item.faces} 面`;
  const n = usage ? usage(item.id) : 0;
  return (
    <div role="button" tabIndex={0}
      className={`ldPartCard ldPartCard--${variant} ${selected ? 'is-on' : ''} ${checked ? 'is-checked' : ''} ${selecting ? 'is-selecting' : ''}`}
      onClick={() => (selecting ? onCheck?.() : onSelect(item.id))}
      onKeyDown={e => { if (e.key === 'Enter') onSelect(item.id); }}>
      <Thumb url={thumbs[item.key]} className="ldPartThumb">
        {item.fav ? <span className="ldPartFav"><StarMark on /></span> : null}
        <span className="ldPartFaces">{facesLabel}</span>
        {item.source === 'import' ? <span className="ldPartNew">导入</span> : null}
        {onCheck ? <CheckMark on={!!checked} onToggle={onCheck} label={`选择${item.name}`} /> : null}
      </Thumb>
      <div className="ldPartBody">
        <div className="ldProjTitleRow">
          <span className="ldPartName">{item.name}</span>
          {menu ? <MoreMenu items={menu} label={`${item.name} 的操作`} /> : null}
        </div>
        <span className="ldPartMeta">{item.size.x} × {item.size.z} × {item.size.y} mm{n ? ` · ${n} 个工程` : ''}</span>
        <div className="ldPartTags">
          {item.tags.slice(0, 2).map(t => <span key={t}>{t}</span>)}
        </div>
      </div>
    </div>
  );
}

export function MachineCard({ item, selected, onSelect, compact = false }) {
  return (
    <button type="button" className={`ldMachine ${compact ? 'is-compact' : ''} ${selected ? 'is-on' : ''}`} onClick={() => onSelect(item.id)}>
      <div className="ldMachineTop">
        <span className="ldMachineIcon"><Printer size={18} strokeWidth={1.7} /></span>
        <span className="ldMachineBrand">{item.brand}</span>
        {selected ? <span className="ldSelectedMark"><Check size={12} strokeWidth={2.6} /></span> : null}
      </div>
      <span className="ldMachineName">{item.model}</span>
      <span className="ldMachineSpec">{item.plateX} × {item.plateZ} mm · 高 {item.plateY} mm</span>
      <div className="ldSpecRow">
        <span><Gauge size={12} />{item.pixelUm} µm</span>
        <span>{item.type}</span>
      </div>
    </button>
  );
}

export function MaterialCard({ item, selected, onSelect, compact = false }) {
  return (
    <button type="button" className={`ldMaterial ${compact ? 'is-compact' : ''} ${selected ? 'is-on' : ''}`} onClick={() => onSelect(item.id)}>
      <div className="ldMaterialTop">
        <span className="ldColorDot" style={{ background: item.color }} />
        <span className="ldMaterialFamily">{item.family}</span>
        {selected ? <span className="ldSelectedMark"><Check size={12} strokeWidth={2.6} /></span> : null}
      </div>
      <span className="ldMaterialName">{item.name}</span>
      <span className="ldMaterialNote">{item.note}</span>
      <div className="ldSpecRow">
        <span>{item.layers.map(u => `${u}µm`).join(' / ')}</span>
        <span>{presetName(item.preset)}支撑</span>
      </div>
    </button>
  );
}

function DetailRow({ label, children }) {
  return <div className="ldDetailRow"><span>{label}</span><b>{children}</b></div>;
}

export function Inspector({ kind, item, thumbs, onClose, onAction, usage, compact = false }) {
  if (!item) {
    return (
      <aside className={'ldInspector ldInspector--empty ' + (compact ? 'is-compact' : '')}>
        <div className="ldEmptyArt"><Boxes size={34} strokeWidth={1.2} /></div>
        <p className="ldEmptyTitle">选择一个项目查看详情</p>
        <p className="ldEmptyText">工程、零件与机型信息会显示在这里。</p>
      </aside>
    );
  }

  if (kind === 'project') {
    const machine = machineById(item.machineId);
    const material = materialById(item.materialId);
    const files = projectFiles(item).files;
    return (
      <aside className={'ldInspector ' + (compact ? 'is-compact' : '')}>
        <div className="ldInspectorHead">
          <span className="ldInspectorLabel">工程详情</span>
          {onClose ? <button className="ldIconBtn" onClick={onClose} aria-label="关闭"><X size={15} /></button> : null}
        </div>
        <Thumb url={projThumb(item, thumbs)} className="ldInspectorThumb" />
        <h2 className="ldInspectorTitle">{item.name}</h2>
        <div className="ldInspectorTags">
          <StatusPill tone={statusTone(item)}>{statusText(item)}</StatusPill>
          <StatusPill tone="neutral">{folderName(item.folder)}</StatusPill>
          {item.starred ? <StatusPill tone="warning">星标</StatusPill> : null}
        </div>
        <div className="ldDetailList">
          <DetailRow label="机器">{machine.brand} {machine.model}</DetailRow>
          <DetailRow label="材料"><i className="ldMiniDot" style={{ background: material.color }} />{material.name}</DetailRow>
          <DetailRow label="层厚 · 支撑模板">{item.layerUm} µm · {presetName(item.preset)}</DetailRow>
          <DetailRow label="零件">{item.parts} 件 · {item.faces.toLocaleString()} 面</DetailRow>
          <DetailRow label="支撑">{item.supports ? `${item.supports} 个点` : '还没有'}</DetailRow>
          <DetailRow label="修改">{relativeTime(item.updatedAt)}</DetailRow>
        </div>
        <div className="ldFiles">
          <span className="ldInspectorLabel">工程文件</span>
          {files.map(f => (
            <div key={f.name} className="ldFileRow" title={f.desc}><code>{f.name}</code><b>{f.size}</b></div>
          ))}
        </div>
        <div className="ldInspectorActions">
          <button className="ldBtn ldBtn--primary" onClick={() => onAction('open', item)}>打开工程 <ChevronRight size={14} /></button>
          <div className="ldBtnRow">
            <button className="ldBtn" onClick={() => onAction('copy', item)}><Copy size={14} /> 复制</button>
            <button className="ldBtn" onClick={() => onAction('export', item)}><FileJson size={14} /> 工程文件</button>
          </div>
        </div>
      </aside>
    );
  }

  if (kind === 'part') {
    const n = usage ? usage(item.id) : 0;
    return (
      <aside className={'ldInspector ' + (compact ? 'is-compact' : '')}>
        <div className="ldInspectorHead">
          <span className="ldInspectorLabel">零件详情</span>
          {onClose ? <button className="ldIconBtn" onClick={onClose} aria-label="关闭"><X size={15} /></button> : null}
        </div>
        <Thumb url={thumbs[item.key]} className="ldInspectorThumb" />
        <h2 className="ldInspectorTitle">{item.name}</h2>
        <div className="ldInspectorTags">
          <StatusPill tone="neutral">{folderName(item.folder, LIBRARY_FOLDERS)}</StatusPill>
          {item.tags.map(t => <StatusPill key={t} tone="neutral">{t}</StatusPill>)}
        </div>
        <div className="ldDetailList">
          <DetailRow label="尺寸">{item.size.x} × {item.size.z} × {item.size.y} mm</DetailRow>
          <DetailRow label="面数">{item.faces.toLocaleString()}</DetailRow>
          <DetailRow label="被引用">{n ? `${n} 个工程` : '还没有工程用到'}</DetailRow>
          <DetailRow label="来源">{item.source === 'import' ? '导入文件' : '内置'}</DetailRow>
          <DetailRow label="更新">{relativeTime(item.updatedAt)}</DetailRow>
        </div>
        {item.note ? <p className="ldNote">{item.note}</p> : null}
        <div className="ldInspectorActions">
          <button className="ldBtn ldBtn--primary" onClick={() => onAction('insert', item)}><Plus size={14} /> 放进工程…</button>
          <div className="ldBtnRow">
            <button className="ldBtn" onClick={() => onAction('newWithPart', item)}><Sparkles size={14} /> 新建工程</button>
            <button className="ldBtn" onClick={() => onAction('renamePart', item)}><Tag size={14} /> 标签</button>
          </div>
        </div>
      </aside>
    );
  }

  if (kind === 'machine') {
    return (
      <aside className={'ldInspector ' + (compact ? 'is-compact' : '')}>
        <div className="ldInspectorHead"><span className="ldInspectorLabel">机器档案</span></div>
        <div className="ldProfileArt"><Printer size={44} strokeWidth={1.2} /></div>
        <h2 className="ldInspectorTitle">{item.brand} {item.model}</h2>
        <div className="ldInspectorTags"><StatusPill tone="neutral">{item.type}</StatusPill><StatusPill tone="neutral">内置</StatusPill></div>
        <div className="ldDetailList">
          <DetailRow label="板面">{item.plateX} × {item.plateZ} mm</DetailRow>
          <DetailRow label="打印高度">{item.plateY} mm</DetailRow>
          <DetailRow label="XY 像素">{item.pixelUm} µm</DetailRow>
        </div>
        <p className="ldNote">机器档案只决定板面、像素与越界检查，不要求设备在线。工程里存的是这些数值的快照。</p>
      </aside>
    );
  }

  return (
    <aside className={'ldInspector ' + (compact ? 'is-compact' : '')}>
      <div className="ldInspectorHead"><span className="ldInspectorLabel">材料档案</span></div>
      <div className="ldProfileArt" style={{ color: item.color }}><span className="ldBigDot" style={{ background: item.color }} /></div>
      <h2 className="ldInspectorTitle">{item.name}</h2>
      <div className="ldInspectorTags"><StatusPill tone="neutral">{item.family}</StatusPill><StatusPill tone="neutral">{item.brand}</StatusPill></div>
      <div className="ldDetailList">
        <DetailRow label="密度">{item.density} g/cm³</DetailRow>
        <DetailRow label="成本">¥{item.cost}/kg</DetailRow>
        <DetailRow label="层厚">{item.layers.map(u => `${u}µm`).join(' / ')}</DetailRow>
        <DetailRow label="默认支撑">{presetName(item.preset)}</DetailRow>
      </div>
      <p className="ldNote">{item.note}。选材料会带出默认层厚和支撑模板，工程里存快照。</p>
    </aside>
  );
}

export function Toast({ message }) {
  if (!message) return null;
  return <div className="ldToast" role="status"><Check size={14} strokeWidth={2.4} />{message}</div>;
}

export function Brand({ small = false }) {
  return (
    <span className={'ldBrand ' + (small ? 'is-small' : '')}>
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect x="1.2" y="1.2" width="29.6" height="29.6" rx="9" fill="none" stroke="currentColor" strokeWidth="2.4" />
        <path d="M9 23V16.2C9 11.2 12.2 8 16 8s7 3.2 7 8.2V23" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M12.2 23v-6.2c0-2.4 1.6-4 3.8-4s3.8 1.6 3.8 4V23" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      <b>ResinForge</b>
    </span>
  );
}

export function SearchBox({ value, onChange, placeholder = '搜索工程、零件…', compact = false }) {
  return (
    <label className={'ldSearch ' + (compact ? 'is-compact' : '')}>
      <Search size={15} strokeWidth={1.8} />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
    </label>
  );
}

const SCHEME_INFO = [
  { id: 'a', name: 'A 文件管理器', home: '文件夹树 + 卡片网格 + 右侧详情', ws: '左卡「对象 / 零件库」双页签', fit: '最接近 BPS，零件与工程多、按文件夹管' },
  { id: 'b', name: 'B 工作台', home: '继续上次 + 最近工程 + 零件货架', ws: '底部零件货架，拖进视口放到指定位置', fit: '个人 / 小团队，常在几个工程之间切换' },
  { id: 'c', name: 'C 专业库', home: '图标栏 + 高密度列表 + 检查器', ws: 'Ctrl K 插入面板，键盘搜索回车插入', fit: '零件很多、熟练用户、要快速扫读' },
];

export function DemoSwitch({ value, onChange }) {
  const options = SCHEME_INFO.map(s => ({ value: s.id, label: <span className="ldDemoOpt"><b>{s.id.toUpperCase()}</b><em>{s.name.slice(2)}</em></span> }));
  return (
    <div className="ldDemoSwitch">
      <SegmentedControl options={options} value={value} onValueChange={onChange} label="Demo 方案" />
      <Popover>
        <PopoverTrigger className="ldDemoHelp" aria-label="方案说明"><HelpCircle size={16} strokeWidth={1.8} /></PopoverTrigger>
        <PopoverContent align="end" className="ldSchemePop">
          <b className="ldSchemeTitle">三套方案的区别</b>
          <p className="ldSchemeText">数据与工作区共用；区别在资源库首页怎么组织，以及在工程里怎么取零件。打开任意工程即可体验。</p>
          <table className="ldSchemeTable">
            <thead><tr><th>方案</th><th>资源库首页</th><th>工程里取零件</th><th>适合</th></tr></thead>
            <tbody>
              {SCHEME_INFO.map(s => (
                <tr key={s.id} className={s.id === value ? 'is-on' : ''}><td>{s.name}</td><td>{s.home}</td><td>{s.ws}</td><td>{s.fit}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="ldSchemeText">数据只在本页内存里，刷新回到演示数据；支撑是示意几何，不是产品算法。</p>
        </PopoverContent>
      </Popover>
    </div>
  );
}


/* ---------- 新建工程向导（机器 → 材料与层厚 → 零件；右侧摘要栏同 BPS） ---------- */

export function Wizard({ open, onClose, onCreate, onImport, thumbs, parts, initialParts = [] }) {
  const [step, setStep] = useState(0);
  const [machineId, setMachineId] = useState('saturn4ultra');
  const [materialId, setMaterialId] = useState('std-grey');
  const [layerUm, setLayerUm] = useState(30);
  const [preset, setPreset] = useState('fine');
  const [picked, setPicked] = useState([]);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setPicked(initialParts.length ? initialParts : ['lib-knot']);
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps

  const material = materialById(materialId);
  useEffect(() => {
    if (!material.layers.includes(layerUm)) setLayerUm(material.layers[0]);
    setPreset(material.preset);
  }, [material]);   // eslint-disable-line react-hooks/exhaustive-deps

  const machine = machineById(machineId);
  const pickedParts = useMemo(() => picked.map(id => parts.find(p => p.id === id)).filter(Boolean), [picked, parts]);
  const width = pickedParts.reduce((s, p) => s + p.size.x, 0) + Math.max(0, pickedParts.length - 1) * 8;
  const fits = width <= machine.plateX && pickedParts.every(p => p.size.z <= machine.plateZ);

  if (!open) return null;
  const togglePart = id => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));

  return (
    <div className="ldWizardShade" role="dialog" aria-modal="true" aria-label="新建工程">
      <div className="ldWizard">
        <header className="ldWizardHead">
          <h2>新建工程</h2>
          <div className="ldWizardSteps">
            {['机器', '材料与层厚', '零件'].map((s, i) => (
              <button type="button" key={s} className={i === step ? 'is-on' : i < step ? 'is-done' : ''} onClick={() => setStep(i)}>
                <b>{i < step ? <Check size={11} /> : i + 1}</b>{s}
              </button>
            ))}
          </div>
          <button className="ldIconBtn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>

        <div className="ldWizardMain">
          <div className="ldWizardBody">
            {step === 0 ? (
              <section className="ldWizardSection">
                <div className="ldWizardSecHead"><h3>选择机器</h3><span>决定板面、像素与越界检查，不要求机器在线</span></div>
                <div className="ldWizardMachines">
                  {MACHINES.map(m => <MachineCard key={m.id} item={m} selected={machineId === m.id} onSelect={setMachineId} compact />)}
                </div>
              </section>
            ) : null}

            {step === 1 ? (
              <section className="ldWizardSection">
                <div className="ldWizardSecHead"><h3>材料与层厚</h3><span>材料带出默认层厚与支撑模板，可以改</span></div>
                <div className="ldWizardMaterials">
                  {MATERIALS.map(m => <MaterialCard key={m.id} item={m} selected={materialId === m.id} onSelect={setMaterialId} compact />)}
                </div>
                <div className="ldWizardRow">
                  <div>
                    <span className="ldFieldLabel">层厚</span>
                    <div className="ldSeg">
                      {material.layers.map(u => (
                        <button key={u} className={layerUm === u ? 'is-on' : ''} onClick={() => setLayerUm(u)}>{u} µm</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span className="ldFieldLabel">支撑模板</span>
                    <div className="ldSeg">
                      {SUPPORT_PRESETS.map(p => (
                        <button key={p.id} className={preset === p.id ? 'is-on' : ''} onClick={() => setPreset(p.id)}>{p.name}</button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {step === 2 ? (
              <section className="ldWizardSection">
                <div className="ldWizardSecHead">
                  <h3>添加零件</h3>
                  <span>从零件库选（放进去的是副本），或导入文件</span>
                  <button className="ldBtn ldBtn--small" onClick={onImport}><Upload size={13} /> 导入 STL</button>
                </div>
                <div className="ldWizardParts">
                  {parts.map(p => (
                    <button key={p.id} className={'ldWizardPart ' + (picked.includes(p.id) ? 'is-on' : '')} onClick={() => togglePart(p.id)}>
                      <Thumb url={thumbs[p.key]} />
                      <span>{p.name}</span>
                      {picked.includes(p.id) ? <b><Check size={11} /></b> : null}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <aside className="ldWizardAside" aria-label="当前选择">
            <span className="ldInspectorLabel">当前选择</span>
            <div className="ldWizardPickRow"><Printer size={14} /><span><b>{machine.model}</b><small>{machine.plateX} × {machine.plateZ} mm · {machine.pixelUm} µm</small></span></div>
            <div className="ldWizardPickRow"><i className="ldMiniDot" style={{ background: material.color }} /><span><b>{material.name}</b><small>{layerUm} µm · {presetName(preset)}支撑</small></span></div>
            <div className="ldWizardPickRow"><Boxes size={14} /><span><b>{pickedParts.length} 个零件</b><small>{pickedParts.length ? `排一行约 ${width.toFixed(0)} mm` : '可以先不选，进工程再加'}</small></span></div>
            {pickedParts.length ? (
              <div className="ldWizardChips">
                {pickedParts.map(p => <span key={p.id} className="ldChip">{p.name}<X size={11} onClick={() => togglePart(p.id)} /></span>)}
              </div>
            ) : null}
            {!fits && pickedParts.length ? <p className="ldWizardWarn">排一行放不下 {machine.model} 的板面，进工程后可以分两行摆或换机器。</p> : null}
            <p className="ldWizardHint">下次新建会默认带出这次的机器、材料和层厚。</p>
          </aside>
        </div>

        <footer className="ldWizardFoot">
          <span className="ldWizardSummary">{machine.model} · {material.name} · {layerUm} µm · {presetName(preset)}</span>
          <div className="ldWizardNav">
            <button className="ldBtn" disabled={step === 0} onClick={() => setStep(s => Math.max(0, s - 1))}><ArrowLeft size={14} /> 上一步</button>
            {step < 2
              ? <button className="ldBtn ldBtn--primary" onClick={() => setStep(s => s + 1)}>下一步 <ArrowRight size={14} /></button>
              : <button className="ldBtn ldBtn--primary" onClick={() => onCreate({ machineId, materialId, layerUm, preset, partIds: picked })}><Sparkles size={14} /> 创建并打开</button>}
          </div>
        </footer>
      </div>
    </div>
  );
}
