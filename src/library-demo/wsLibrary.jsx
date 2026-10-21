import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Boxes, ChevronDown, CornerDownLeft, Plus, Search, Star } from 'lucide-react';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import Button from '@/components/arc/button/button';
import dialogStyles from '@/components/arc/dialog/dialog.module.css';
import { Thumb } from './ui.jsx';
import { LIBRARY_FOLDERS, folderName } from './data.js';

/* 工作区里取用零件库的三种方式（三套方案各一种）：
   A · 左卡页签（BPS 的 Object / Library 双页签原样）
   B · 底部货架（横向一排，拖进视口放到指定位置）
   C · 插入面板（⌘K / Ctrl K 搜索，键盘选中回车插入）
   三种都支持把零件磁贴拖进视口：dataTransfer 里带零件 id，视口按落点放到板面上。 */

export const DRAG_MIME = 'application/x-rf-part';

function filterParts(parts, folder, q) {
  let list = parts;
  if (folder === 'fav') list = list.filter(p => p.fav);
  else if (folder === 'used') list = [...list].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 8);
  else if (folder !== 'all') list = list.filter(p => p.folder === folder);
  const s = q.trim().toLowerCase();
  if (s) list = list.filter(p => `${p.name} ${p.tags.join(' ')} ${folderName(p.folder, LIBRARY_FOLDERS)}`.toLowerCase().includes(s));
  return list;
}

function dragProps(part) {
  return {
    draggable: true,
    onDragStart: e => {
      e.dataTransfer.setData(DRAG_MIME, part.id);
      e.dataTransfer.effectAllowed = 'copy';
    },
  };
}

function FolderChips({ value, onChange, compact = false }) {
  return (
    <div className={'wsChips' + (compact ? ' is-compact' : '')} role="tablist" aria-label="零件文件夹">
      {LIBRARY_FOLDERS.map(f => (
        <button key={f.id} type="button" role="tab" aria-selected={value === f.id}
          className={value === f.id ? 'is-on' : ''} onClick={() => onChange(f.id)}>{f.name}</button>
      ))}
    </div>
  );
}

/* ---------- A：左卡页签 ---------- */

export function LibraryTab({ parts, thumbs, onInsert, onManage }) {
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('all');
  const list = useMemo(() => filterParts(parts, folder, q), [parts, folder, q]);
  return (
    <div className="wsLib">
      <label className="wsSearch">
        <Search size={14} strokeWidth={1.8} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索零件、标签" />
      </label>
      <FolderChips value={folder} onChange={setFolder} compact />
      <ScrollArea className="wsLibScroll" fade={16}>
        {list.length ? (
          <div className="wsLibGrid">
            {list.map(p => (
              <button key={p.id} type="button" className="wsTile" title={`${p.name}：点击插入，或拖到视口`} onClick={() => onInsert(p)} {...dragProps(p)}>
                <Thumb url={thumbs[p.key]} className="wsTileThumb">
                  {p.fav ? <span className="wsTileFav"><Star size={10} fill="currentColor" /></span> : null}
                  <span className="wsTileAdd"><Plus size={14} strokeWidth={2.2} /></span>
                </Thumb>
                <span className="wsTileName">{p.name}</span>
              </button>
            ))}
          </div>
        ) : <p className="wsEmpty">没有匹配的零件</p>}
      </ScrollArea>
      <div className="wsLibFoot">
        <span>{list.length} 个 · 点击插入或拖到视口</span>
        <button type="button" className="wsLink" onClick={onManage}>管理零件库</button>
      </div>
    </div>
  );
}

/* ---------- B：底部货架 ---------- */

export function Shelf({ parts, thumbs, onInsert, open, onToggle }) {
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('all');
  const list = useMemo(() => filterParts(parts, folder, q), [parts, folder, q]);
  if (!open) {
    return (
      <button type="button" className="wsShelfPill" onClick={onToggle}>
        <Boxes size={15} strokeWidth={1.8} />零件货架<span>{parts.length}</span>
      </button>
    );
  }
  return (
    <section className="wsShelf" aria-label="零件货架">
      <div className="wsShelfHead">
        <b>零件货架</b>
        <FolderChips value={folder} onChange={setFolder} />
        <label className="wsSearch wsShelfSearch">
          <Search size={14} strokeWidth={1.8} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索" />
        </label>
        <button type="button" className="wsIconBtn" onClick={onToggle} aria-label="收起货架"><ChevronDown size={16} /></button>
      </div>
      <ScrollArea orientation="horizontal" className="wsShelfScroll" fade={28}>
        <div className="wsShelfRow">
          {list.map(p => (
            <div key={p.id} className="wsShelfItem" {...dragProps(p)} title="拖到视口，放到指定位置">
              <Thumb url={thumbs[p.key]} className="wsShelfThumb" />
              <span className="wsShelfName">{p.name}</span>
              <button type="button" className="wsShelfAdd" onClick={() => onInsert(p)} aria-label={`插入${p.name}`}><Plus size={13} strokeWidth={2.2} /></button>
            </div>
          ))}
          {!list.length ? <p className="wsEmpty">没有匹配的零件</p> : null}
        </div>
      </ScrollArea>
    </section>
  );
}

/* ---------- C：插入面板 ---------- */

export function InsertPalette({ open, onOpenChange, parts, thumbs, usage, onInsert }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef(null);
  useEffect(() => { if (open) { setQ(''); setIdx(0); } }, [open]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [...parts].sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || new Date(b.updatedAt) - new Date(a.updatedAt));
    return parts
      .map(p => {
        const name = p.name.toLowerCase();
        const hay = `${name} ${p.tags.join(' ')} ${folderName(p.folder, LIBRARY_FOLDERS)}`.toLowerCase();
        const score = name.startsWith(s) ? 3 : name.includes(s) ? 2 : hay.includes(s) ? 1 : 0;
        return { p, score };
      })
      .filter(x => x.score)
      .sort((a, b) => b.score - a.score)
      .map(x => x.p);
  }, [parts, q]);
  const cur = list[Math.min(idx, list.length - 1)] || null;
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx, q]);
  const insert = (part, keepOpen) => {
    if (!part) return;
    onInsert(part);
    if (!keepOpen) onOpenChange(false);
  };
  const onKey = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(list.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); insert(cur, e.shiftKey); }
  };
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={`${dialogStyles.overlay} ${dialogStyles.keyframes}`} />
        <DialogPrimitive.Content className="wsPalette" aria-describedby={undefined} onKeyDown={onKey}>
          <DialogPrimitive.Title className="wsSrOnly">插入零件</DialogPrimitive.Title>
          <label className="wsPaletteSearch">
            <Search size={17} strokeWidth={1.8} />
            <input autoFocus value={q} onChange={e => { setQ(e.target.value); setIdx(0); }} placeholder="搜索零件库：名称、标签、文件夹" />
            <kbd>Esc</kbd>
          </label>
          <div className="wsPaletteBody">
            <ScrollArea className="wsPaletteList" fade={18}>
              <div ref={listRef} role="listbox" aria-label="零件">
                {!q.trim() ? <div className="wsPaletteGroup">收藏与最近使用</div> : null}
                {list.map((p, i) => (
                  <button key={p.id} type="button" role="option" aria-selected={p === cur} data-active={p === cur}
                    className={'wsPaletteRow' + (p === cur ? ' is-on' : '')}
                    onMouseMove={() => setIdx(i)} onClick={() => insert(p, false)} {...dragProps(p)}>
                    <Thumb url={thumbs[p.key]} className="wsPaletteThumb" />
                    <span className="wsPaletteMain">
                      <b>{p.name}</b>
                      <small>{folderName(p.folder, LIBRARY_FOLDERS)} · {p.tags.join(' / ')}</small>
                    </span>
                    {p.fav ? <Star size={12} fill="currentColor" className="ldStarOn" /> : null}
                    <span className="wsPaletteFaces">{p.faces.toLocaleString()} 面</span>
                  </button>
                ))}
                {!list.length ? <p className="wsEmpty">没有匹配的零件</p> : null}
              </div>
            </ScrollArea>
            {cur ? (
              <aside className="wsPalettePreview">
                <Thumb url={thumbs[cur.key]} className="wsPalettePreviewThumb" />
                <b>{cur.name}</b>
                <dl>
                  <div><dt>尺寸</dt><dd>{cur.size.x} × {cur.size.z} × {cur.size.y} mm</dd></div>
                  <div><dt>面数</dt><dd>{cur.faces.toLocaleString()}</dd></div>
                  <div><dt>文件夹</dt><dd>{folderName(cur.folder, LIBRARY_FOLDERS)}</dd></div>
                  <div><dt>被引用</dt><dd>{usage(cur.id)} 个工程</dd></div>
                </dl>
                {cur.note ? <p>{cur.note}</p> : null}
                <Button variant="primary" size="sm" onClick={() => insert(cur, false)}>插入<CornerDownLeft size={13} /></Button>
              </aside>
            ) : null}
          </div>
          <div className="wsPaletteFoot">
            <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
            <span><kbd>↵</kbd> 插入</span>
            <span><kbd>Shift</kbd><kbd>↵</kbd> 插入并继续</span>
            <span>插入的是副本，改工程不会改库里的零件</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
