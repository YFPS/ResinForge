import React, { useEffect, useMemo, useState } from 'react';
import { Check, Folder, FolderPlus, History, RotateCcw } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog';
import Button from '@/components/arc/button/button';
import { Input } from '@/components/arc/input/input';
import { Select } from '@/components/arc/select/select';
import { Switch } from '@/components/arc/switch/switch';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { MACHINES, MATERIALS, TEMPLATES, machineName, materialById } from '../catalog.js';
import { Swatch, Thumb, relativeTime, templateName } from './common.jsx';

/* 对话框（Arc Dialog）。文案只说要做的事和后果，按钮用动词。 */

function Actions({ children }) {
  return <div className="pdDlgActions">{children}</div>;
}

/** 关闭有未保存修改的工程：保存 / 不保存 / 取消（BPS 同款三选一） */
export function ConfirmCloseDialog({ open, name, changes = [], onSave, onDiscard, onCancel }) {
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title="保存对这个工程的修改？" description={`「${name}」有 ${changes.length || 1} 处修改还没保存，不保存的话这些修改会丢掉。`}>
        {changes.length ? <ul className="pdDlgList">{changes.slice(-5).map((c, i) => <li key={i}>{c}</li>)}</ul> : null}
        <Actions>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="secondary" size="sm" onClick={onDiscard}>不保存</Button>
          <Button variant="primary" size="sm" onClick={onSave}>保存</Button>
        </Actions>
      </DialogContent>
    </Dialog>
  );
}

function FolderList({ folders, value, onChange, onAdd }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const taken = name.trim() && folders.some(f => f.name === name.trim());
  return (
    <div className="pdFolderPick" role="radiogroup" aria-label="文件夹">
      {folders.map(f => (
        <button key={f.id} type="button" role="radio" aria-checked={value === f.id} className={value === f.id ? 'is-on' : ''} onClick={() => onChange(f.id)}>
          <Folder size={15} strokeWidth={1.8} />{f.name}{value === f.id ? <Check size={14} className="pdFolderCheck" /> : null}
        </button>
      ))}
      {adding ? (
        <div className="pdFolderNew">
          <Input label="新文件夹" value={name} autoFocus onChange={e => setName(e.target.value)} error={taken ? '已经有这个名字的文件夹了' : undefined}
            onKeyDown={e => { if (e.key === 'Enter' && name.trim() && !taken) { onChange(onAdd(name.trim())); setAdding(false); setName(''); } }} />
          <Button variant="secondary" size="sm" disabled={!name.trim() || !!taken} onClick={() => { onChange(onAdd(name.trim())); setAdding(false); setName(''); }}>添加</Button>
        </div>
      ) : (
        <button type="button" className="pdFolderAdd" onClick={() => setAdding(true)}><FolderPlus size={15} strokeWidth={1.8} />新建文件夹</button>
      )}
    </div>
  );
}

/** 从工程加入零件库：名字、文件夹、是否连同支撑 */
export function AddToLibraryDialog({ open, part, folders, onAddFolder, onConfirm, onCancel }) {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState(folders[0]?.id);
  const [withSup, setWithSup] = useState(true);
  useEffect(() => { if (open && part) { setName(part.name); setWithSup(part.points > 0); } }, [open, part]);
  if (!part) return null;
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title="加入零件库" description="零件库存的是副本：之后改这个工程，不会改到库里的零件。">
        <div className="pdDlgStack">
          <Input label="名称" value={name} onChange={e => setName(e.target.value)} />
          <div className="pdSwitchRow">
            <span><b>连同支撑一起存</b><small>{part.points ? `${part.points} 个支撑点；放进别的工程时支撑跟着走` : '这个零件还没有支撑'}</small></span>
            <Switch checked={withSup && part.points > 0} disabled={!part.points} onCheckedChange={setWithSup} aria-label="连同支撑一起存" />
          </div>
          <span className="pdFieldLabel">文件夹</span>
          <FolderList folders={folders} value={folder} onChange={setFolder} onAdd={onAddFolder} />
        </div>
        <Actions>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="primary" size="sm" disabled={!name.trim()} onClick={() => onConfirm({ name: name.trim(), folder, withSupports: withSup && part.points > 0 })}>加入零件库</Button>
        </Actions>
      </DialogContent>
    </Dialog>
  );
}

export function RenameDialog({ open, title, initial, onConfirm, onCancel }) {
  const [v, setV] = useState(initial || '');
  useEffect(() => { if (open) setV(initial || ''); }, [open, initial]);
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title={title}>
        <Input label="名称" value={v} autoFocus onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && v.trim()) onConfirm(v.trim()); }} />
        <Actions>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="primary" size="sm" disabled={!v.trim()} onClick={() => onConfirm(v.trim())}>重命名</Button>
        </Actions>
      </DialogContent>
    </Dialog>
  );
}

export function MoveDialog({ open, count, folders, initial, onAddFolder, onConfirm, onCancel }) {
  const [folder, setFolder] = useState(initial || folders[0]?.id);
  useEffect(() => { if (open) setFolder(initial || folders[0]?.id); }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title={count > 1 ? `移动 ${count} 项` : '移动到文件夹'}>
        <FolderList folders={folders} value={folder} onChange={setFolder} onAdd={onAddFolder} />
        <Actions>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="primary" size="sm" onClick={() => onConfirm(folder)}>移动</Button>
        </Actions>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({ open, title, description, confirmText = '删除', onConfirm, onCancel }) {
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title={title} description={description}>
        <Actions>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>{confirmText}</Button>
        </Actions>
      </DialogContent>
    </Dialog>
  );
}

/** 新建工程：机器、材料、层厚、支撑模板一屏选完（BPS 是五步向导），默认带出上次的配置 */
export function NewProjectForm({ initial, onCreate, onCancel, parts = [], submitText = '新建工程' }) {
  const [cfg, setCfg] = useState(initial);
  const material = materialById(cfg.materialId);
  useEffect(() => { setCfg(initial); }, [initial]);
  const set = patch => setCfg(c => {
    const next = { ...c, ...patch };
    if (patch.materialId) {
      const m = materialById(patch.materialId);
      if (!m.layers.includes(next.layerUm)) next.layerUm = m.layers[0];
      next.templateId = m.template || next.templateId;
    }
    return next;
  });
  return (
    <div className="pdNewForm">
      <Select label="机器" value={cfg.machineId} onValueChange={v => set({ machineId: v })}
        options={MACHINES.map(m => ({ value: m.id, label: machineName(m) }))} />
      <div className="pdNewMaterial">
        <Select label="材料" value={cfg.materialId} onValueChange={v => set({ materialId: v })}
          options={MATERIALS.map(m => ({ value: m.id, label: m.name }))} />
        <Swatch material={material} size={20} />
      </div>
      <div className="pdNewRow">
        <span className="pdFieldLabel">层厚</span>
        <SegmentedControl label="层厚" value={String(cfg.layerUm)} onValueChange={v => set({ layerUm: +v })}
          options={material.layers.map(u => ({ value: String(u), label: `${u} µm` }))} />
      </div>
      <div className="pdNewRow">
        <span className="pdFieldLabel">支撑模板</span>
        <SegmentedControl label="支撑模板" value={cfg.templateId} onValueChange={v => set({ templateId: v })}
          options={TEMPLATES.map(t => ({ value: t.id, label: t.name }))} />
      </div>
      {parts.length ? <p className="pdNewNote">带入 {parts.length} 个零件：{parts.map(p => p.name).join('、')}</p> : null}
      <Actions>
        {onCancel ? <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button> : null}
        <Button variant="primary" size="sm" onClick={() => onCreate(cfg)}>{submitText}</Button>
      </Actions>
    </div>
  );
}

export function NewProjectDialog({ open, initial, parts, onCreate, onCancel }) {
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title="新建工程" description="机器决定板面和像素，材料带出层厚和支撑模板。工程里存的是这些参数的快照。">
        <NewProjectForm initial={initial} parts={parts} onCreate={onCreate} onCancel={onCancel} />
      </DialogContent>
    </Dialog>
  );
}

/** 零件放进哪个工程（打开那个工程并放进去） */
export function ProjectPickDialog({ open, part, projects, onConfirm, onNew, onCancel }) {
  const [value, setValue] = useState(null);
  useEffect(() => { if (open) setValue(projects[0]?.id || null); }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title="放进工程" description={part ? `把「${part.name}」${part.sup ? '连同支撑' : ''}放进哪个工程？会打开那个工程。` : ''}>
        <div className="pdFolderPick pdProjectPick" role="radiogroup" aria-label="工程">
          {projects.slice(0, 6).map(p => (
            <button key={p.id} type="button" role="radio" aria-checked={value === p.id} className={value === p.id ? 'is-on' : ''} onClick={() => setValue(p.id)}>
              <Thumb src={p.thumb} className="pdPickThumb" />
              <span className="pdPickMain"><b>{p.name}</b><small>{p.stats?.parts ?? 0} 件 · {p.stats?.points ?? 0} 个支撑点</small></span>
              {value === p.id ? <Check size={14} className="pdFolderCheck" /> : null}
            </button>
          ))}
        </div>
        <Actions>
          <Button variant="ghost" size="sm" onClick={onNew}>用它新建工程</Button>
          <span className="pdDlgSpacer" />
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="primary" size="sm" disabled={!value} onClick={() => onConfirm(value)}>放进去</Button>
        </Actions>
      </DialogContent>
    </Dialog>
  );
}

/** 历史版本：每次保存一份（只存工程描述，模型文件共用），可以回到任一版本 */
export function VersionsDialog({ open, name, versions, onRestore, onCancel }) {
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title="历史版本" description={`「${name}」最近 ${versions.length} 次保存。恢复后是未保存状态，保存才会覆盖当前版本。`} className="pdVersionsDlg">
        <div className="pdVersions">
          {versions.length ? versions.map((v, i) => (
            <div key={v.ts} className="pdVersion">
              <Thumb src={v.thumb} className="pdVersionThumb" />
              <span className="pdVersionMain">
                <b>{new Date(v.ts).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</b>
                <small>{v.label} · {v.stats?.parts ?? v.desc.parts.length} 件 · {v.stats?.points ?? v.desc.points.length} 个支撑点</small>
              </span>
              {i === 0 ? <span className="pdVersionNow">当前</span> : (
                <Button variant="secondary" size="sm" onClick={() => onRestore(v.ts)}><RotateCcw size={14} />恢复</Button>
              )}
            </div>
          )) : <p className="pdMuted"><History size={14} />还没有保存过</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { relativeTime, templateName };
