import React from 'react';
import Toast from '@/components/arc/toast/toast';
import { useBus, useToasts, pushToast, dismissToast } from '../bridge.js';

/* core 的 bus.emit('toast', msg) → Arc Toast；Toast 自己播放进出场，这里只维护队列 */
export default function ToastHost() {
  const toasts = useToasts();
  useBus('toast', msg => pushToast(msg));
  return (
    <div className="toastHost">
      {toasts.map(t => (
        <Toast
          key={t.id}
          title={t.title}
          description={t.description}
          tone={t.tone}
          duration={t.duration || (t.tone === 'danger' ? 6000 : 3000)}
          /* 先让 Toast 播完退场动画再摘除 */
          onOpenChange={open => { if (!open) setTimeout(() => dismissToast(t.id), 360); }}
        />
      ))}
    </div>
  );
}
