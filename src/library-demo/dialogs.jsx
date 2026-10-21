import React, { useEffect, useState } from 'react';
import { Check, Folder, FolderPlus } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/arc/dialog/dialog';
import Button from '@/components/arc/button/button';
import { Input } from '@/components/arc/input/input';

/* Demo 共用对话框（Arc Dialog）：未保存退出 / 选文件夹 / 重命名 / 删除确认 */

/** 关闭未保存的工程：保存 / 不保存 / 取消（BPS 同款三选一） */
export function ConfirmCloseDialog({ open, name, changes = [], onSave, onDiscard, onCancel }) {
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title="工程有未保存的修改" description={`「${name}」有 ${changes.length} 处修改还没保存。`}>
        {changes.length ? (
          <ul className="ldDlgList">
            {changes.slice(-5).map((c, i) => <li key={i}>{c}</li>)}
            {changes.length > 5 ? <li className="is-muted">…另有 {changes.length - 5} 处</li> : null}
          </ul>
        ) : null}
        <div className="ldDlgActions">
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="secondary" size="sm" onClick={onDiscard}>不保存</Button>
          <Button variant="primary" size="sm" onClick={onSave}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 选目标文件夹（加入零件库 / 移动）；可在对话框里新建文件夹 */
export function FolderPickerDialog({ open, title, description, folders, initial, confirmText = '确定', note, onConfirm, onCancel }) {
  const real = folders.filter(f => !f.smart);
  const [value, setValue] = useState(initial || real[0]?.id);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!open) return;
    setValue(initial || real[0]?.id);
    setNewName('');
    setAdding(false);
  }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  const exists = newName.trim() && folders.some(f => f.name === newName.trim());
  const submit = () => {
    if (adding) {
      if (!newName.trim() || exists) return;
      onConfirm({ newFolder: newName.trim() });
    } else onConfirm({ folderId: value });
  };
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title={title} description={description}>
        <div className="ldFolderPick" role="radiogroup" aria-label="文件夹">
          {real.map(f => (
            <button key={f.id} type="button" role="radio" aria-checked={!adding && value === f.id}
              className={!adding && value === f.id ? 'is-on' : ''} onClick={() => { setAdding(false); setValue(f.id); }}>
              <Folder size={15} strokeWidth={1.8} />{f.name}
              {!adding && value === f.id ? <Check size={14} className="ldFolderPickCheck" /> : null}
            </button>
          ))}
          {adding ? (
            <div className="ldFolderPickNew">
              <Input label="新文件夹名称" value={newName} autoFocus onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                error={exists ? '这个名字已经有了，换一个吧' : undefined} />
            </div>
          ) : (
            <button type="button" className="ldFolderPickAdd" onClick={() => setAdding(true)}><FolderPlus size={15} strokeWidth={1.8} />新建文件夹</button>
          )}
        </div>
        {note ? <p className="ldDlgNote">{note}</p> : null}
        <div className="ldDlgActions">
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={adding && (!newName.trim() || !!exists)}>{confirmText}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 选一个工程（把零件放进哪个工程）；也可以新建 */
export function ProjectPickDialog({ open, part, projects, onConfirm, onNew, onCancel }) {
  const [value, setValue] = useState(projects[0]?.id);
  useEffect(() => { if (open) setValue(projects[0]?.id); }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title="放进工程" description={part ? `把「${part.name}」的副本放进哪个工程？放进去后会打开那个工程。` : ''}>
        <div className="ldFolderPick ldProjectPick" role="radiogroup" aria-label="工程">
          {projects.slice(0, 6).map(p => (
            <button key={p.id} type="button" role="radio" aria-checked={value === p.id} className={value === p.id ? 'is-on' : ''} onClick={() => setValue(p.id)}>
              <span className="ldPickMain"><b>{p.name}</b><small>{p.parts} 件 · {p.supports} 个支撑点</small></span>
              {value === p.id ? <Check size={14} className="ldFolderPickCheck" /> : null}
            </button>
          ))}
        </div>
        <div className="ldDlgActions">
          <Button variant="ghost" size="sm" onClick={onNew}>用它新建工程</Button>
          <span className="ldDlgSpacer" />
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="primary" size="sm" disabled={!value} onClick={() => onConfirm(value)}>放进并打开</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 工程文件预览：按设计文档的格式，把这个工程会写出的 manifest.json 摆出来看 */
export function ManifestDialog({ open, title, files, json, onCancel }) {
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title={title} description="工程是一个目录：manifest 存工程本身，supports 存支撑点，模型文件按内容哈希放在共享仓库里（零件库和各工程共用一份）。" className="ldManifestDlg">
        <ul className="ldFileList">
          {files.map(f => <li key={f.name}><code>{f.name}</code><span>{f.desc}</span><b>{f.size}</b></li>)}
        </ul>
        <pre className="ldJson">{json}</pre>
        <div className="ldDlgActions">
          <Button variant="primary" size="sm" onClick={onCancel}>关闭</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 单行文本（重命名 / 加标签） */
export function PromptDialog({ open, title, description, label, initial = '', confirmText = '确定', onConfirm, onCancel }) {
  const [value, setValue] = useState(initial);
  useEffect(() => { if (open) setValue(initial); }, [open, initial]);
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title={title} description={description}>
        <Input label={label} value={value} autoFocus onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && value.trim()) onConfirm(value.trim()); }} />
        <div className="ldDlgActions">
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="primary" size="sm" disabled={!value.trim()} onClick={() => onConfirm(value.trim())}>{confirmText}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 删除确认 */
export function ConfirmDialog({ open, title, description, confirmText = '删除', danger = true, onConfirm, onCancel, children }) {
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent title={title} description={description}>
        {children}
        <div className="ldDlgActions">
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant={danger ? 'danger' : 'primary'} size="sm" onClick={onConfirm}>{confirmText}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
