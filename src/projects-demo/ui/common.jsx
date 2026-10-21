import React from 'react';
import * as DM from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import menuStyles from '@/components/arc/dropdown-menu/dropdown-menu.module.css';
import { MACHINES, TEMPLATES } from '../catalog.js';

/* 共用小件：缩略图、树脂色块、按比例的成型平台、时间 / 数字格式、「…」菜单、空态 */

export function Thumb({ src, className = '', alt = '' }) {
  return (
    <span className={'pdThumb ' + className}>
      {src ? <img src={src} alt={alt} draggable="false" /> : <span className="pdThumbEmpty" aria-hidden="true" />}
    </span>
  );
}

/** 树脂色块：高光 + 底色；透明树脂加一层通透感 */
export function Swatch({ material, size = 18 }) {
  return (
    <span
      className={'pdSwatch' + (material.clear ? ' is-clear' : '')}
      style={{ '--sw': material.color, width: size, height: size }}
      aria-hidden="true"
    />
  );
}

const MAX_X = Math.max(...MACHINES.map(m => m.plateX));
const MAX_Z = Math.max(...MACHINES.map(m => m.plateZ));

/**
 * 成型平台按真实比例画（所有机型同一比例尺），fp 为零件占地（以板面中心为原点）。
 * box：图形外框尺寸（px）
 */
export function PlateGlyph({ machine, fp = null, box = 40, over = false }) {
  if (!machine) return null;
  const s = box / Math.max(MAX_X, MAX_Z * 1.25);
  const w = machine.plateX * s, d = machine.plateZ * s;
  const h = Math.max(...MACHINES.map(m => m.plateZ)) * s;
  return (
    <svg className={'pdPlate' + (over ? ' is-over' : '')} width={box} height={Math.ceil(h) + 2} viewBox={`0 0 ${box} ${Math.ceil(h) + 2}`} aria-hidden="true">
      <rect x={(box - w) / 2} y={(h - d) / 2 + 1} width={w} height={d} rx={Math.min(3, d / 6)} className="pdPlateBed" />
      {fp ? (
        <rect
          x={box / 2 + fp.x0 * s} y={h / 2 + 1 + fp.z0 * s}
          width={Math.max(1.5, fp.w * s)} height={Math.max(1.5, fp.d * s)}
          rx="1" className="pdPlateFoot"
        />
      ) : null}
    </svg>
  );
}

export const templateName = id => TEMPLATES.find(t => t.id === id)?.name || '自定义';

export function relativeTime(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  if (mins < 1440) return `${Math.round(mins / 60)} 小时前`;
  if (mins < 10080) return `${Math.round(mins / 1440)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export const fmtInt = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('zh-CN') : '');
export const fmtMm = n => (Number.isFinite(n) ? `${+n.toFixed(1)}` : '');
export const fmtBytes = n => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/* 「…」菜单：Arc 的 DropdownMenu 只有带文字的触发器；这里用同一个 Radix 原语 + Arc 菜单的样式模块，
   悬停底色用 Radix 的 data-highlighted（见 projects.css） */
export function MoreMenu({ items, label = '更多操作', align = 'end', className = '' }) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>
        <button type="button" className={'pdMore ' + className} aria-label={label}
          onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
          <MoreHorizontal size={16} strokeWidth={1.8} />
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content className={menuStyles.menu + ' pdMenu'} sideOffset={6} align={align} collisionPadding={12} loop onClick={e => e.stopPropagation()}>
          {items.filter(Boolean).map((it, i) => (
            <React.Fragment key={it.label}>
              {it.separatorBefore ? <DM.Separator className={menuStyles.separator} /> : null}
              <DM.Item
                className={[menuStyles.item, it.destructive ? menuStyles.destructive : ''].filter(Boolean).join(' ')}
                style={{ '--i': i }} disabled={it.disabled} onSelect={() => it.onSelect?.()}
              >
                {it.icon ? <span className={menuStyles.icon} aria-hidden="true">{it.icon}</span> : null}
                {it.label}
              </DM.Item>
            </React.Fragment>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

export function Empty({ icon, title, children }) {
  return (
    <div className="pdEmpty">
      {icon ? <span className="pdEmptyIcon">{icon}</span> : null}
      <b>{title}</b>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

/** 拖拽：零件库条目拖进视口 */
export const DRAG_PART = 'application/x-resinforge-part';
export const dragPart = entry => ({
  draggable: true,
  onDragStart: e => { e.dataTransfer.setData(DRAG_PART, entry.id); e.dataTransfer.effectAllowed = 'copy'; },
});
