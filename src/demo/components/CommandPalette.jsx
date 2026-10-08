/* Ctrl/⌘ K 命令面板：Arc 的 command-palette 块（搜索、分组、键盘导航、高亮跟随）。
   外层只用 Radix Dialog 提供焦点圈定 / Esc 关闭 / 焦点归还，遮罩复用 Arc Dialog 的样式；
   不套 Arc DialogContent——那会在面板外再包一层带标题的卡片，形成卡中卡。 */
import React, { useMemo } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { CommandPalette as ArcCommandPalette } from '@/components/arc/command-palette/command-palette';
import dialogStyles from '@/components/arc/dialog/dialog.module.css';
import { buildCommands } from '../commands.js';
import { useBusLatest, useParams } from '../bridge.js';
import { useUI } from '../ui.js';
import { useTheme } from '../theme.js';

export default function CommandPalette({ open, onOpenChange }) {
  const [, setParam] = useParams();
  const heatOn = useBusLatest('heat', false);
  const { sidebarOpen } = useUI();
  const theme = useTheme();

  const commands = useMemo(
    () => buildCommands({ setParam, heatOn, sidebarOpen, theme }),
    [setParam, heatOn, sidebarOpen, theme],
  );
  const items = useMemo(() => commands.map(c => ({
    id: c.id, label: c.title, description: c.hint, group: c.group, keywords: c.keywords, icon: c.icon,
  })), [commands]);

  const run = item => {
    const cmd = commands.find(c => c.id === item.id);
    onOpenChange(false);
    // 等对话框收起、焦点归还后再执行，避免文件选择框等被焦点圈定拦住
    if (cmd) setTimeout(() => cmd.run(), 0);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={`${dialogStyles.overlay} ${dialogStyles.keyframes}`} />
        <DialogPrimitive.Content className="cpShell" aria-describedby={undefined}>
          <DialogPrimitive.Title className="srOnly">命令面板</DialogPrimitive.Title>
          <ArcCommandPalette
            items={items}
            autoFocus
            label="搜索命令"
            placeholder="搜索命令、步骤或设置…"
            onSelect={run}
            onClose={() => onOpenChange(false)}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
