import React from 'react';
import * as DM from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import styles from '@/components/arc/dropdown-menu/dropdown-menu.module.css';

/* 卡片 / 行上的「…」菜单：Arc 的 DropdownMenu 只有带文字的触发器，这里用同一个 Radix 原语 + Arc 菜单的样式模块，
   外观与 Arc 菜单一致；条目悬停底色用 Radix 的 data-highlighted（Arc 原版靠 JS 定位的高亮条，这里不需要滑动动画）。
   items: [{ label, icon, onSelect, destructive, separatorBefore, disabled }] */
export function MoreMenu({ items, label = '更多操作', className = '', icon = null, align = 'end' }) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>
        <button
          type="button"
          className={'ldMoreBtn ' + className}
          aria-label={label}
          onClick={e => e.stopPropagation()}
          onPointerDown={e => e.stopPropagation()}
        >
          {icon || <MoreHorizontal size={15} strokeWidth={1.8} />}
        </button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content className={styles.menu + ' ldMenu'} sideOffset={6} align={align} collisionPadding={12} loop onClick={e => e.stopPropagation()}>
          {items.filter(Boolean).map((it, i) => (
            <React.Fragment key={it.label}>
              {it.separatorBefore ? <DM.Separator className={styles.separator} /> : null}
              <DM.Item
                className={[styles.item, it.destructive ? styles.destructive : ''].filter(Boolean).join(' ')}
                style={{ '--i': i }}
                disabled={it.disabled}
                onSelect={() => it.onSelect?.()}
              >
                {it.icon ? <span className={styles.icon} aria-hidden="true">{it.icon}</span> : null}
                {it.label}
              </DM.Item>
            </React.Fragment>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
