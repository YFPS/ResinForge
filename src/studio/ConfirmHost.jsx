/* 屏幕中央的确认框。core 经 confirm.js 的 confirmAction 请求，这里把它画出来，再把回答还回去。
   样式与问题反馈 / 检查更新同一套（.updShade / .upd）。 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@/components/arc/button/button';
import { setConfirmHandler } from '../core/confirm.js';

/* 确认框开着时键盘只归它：Esc 取消，Tab 只在两个按钮之间转，其余按键不让底下的快捷键收到。
   监听在模块加载时就挂在 window 的捕获阶段，早于各处的快捷键监听，才拦得住它们。
   只吞事件、不 preventDefault，按钮上的回车 / 空格仍会触发点击。 */
const gate = { open: false, cancel: null, root: null };
window.addEventListener('keydown', e => {
  if (!gate.open) return;
  e.stopImmediatePropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    if (gate.cancel) gate.cancel();
    return;
  }
  if (e.key === 'Tab' && gate.root) {
    const btns = [...gate.root.querySelectorAll('button')];
    if (!btns.length) return;
    e.preventDefault();
    const at = btns.indexOf(document.activeElement);
    const next = e.shiftKey ? (at <= 0 ? btns.length - 1 : at - 1) : (at + 1) % btns.length;
    btns[next].focus();
  }
}, true);

export default function ConfirmHost() {
  const [req, setReq] = useState(null);
  const reqRef = useRef(null);
  const rootRef = useRef(null);

  const settle = useCallback(ok => {
    const r = reqRef.current;
    if (!r) return;
    reqRef.current = null;
    setReq(null);
    r.resolve(ok);
  }, []);

  useEffect(() => {
    setConfirmHandler(opts => new Promise(resolve => {
      // 上一个还没答完又来新的：旧的当作取消
      if (reqRef.current) reqRef.current.resolve(false);
      const next = { opts: opts || {}, resolve };
      reqRef.current = next;
      setReq(next);
    }));
    return () => {
      setConfirmHandler(null);
      if (reqRef.current) {
        reqRef.current.resolve(false);
        reqRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!req) return undefined;
    const back = document.activeElement;
    gate.open = true;
    gate.cancel = () => settle(false);
    gate.root = rootRef.current;
    // 默认停在「取消」上：误敲回车不会删掉支撑
    const first = rootRef.current && rootRef.current.querySelector('button');
    if (first) first.focus();
    return () => {
      gate.open = false;
      gate.cancel = null;
      gate.root = null;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, [req, settle]);

  if (!req) return null;
  const { title = '提醒', text = '', okText = '确定', cancelText = '取消' } = req.opts;
  return (
    <div className="updShade updShade--help" role="presentation" onMouseDown={() => settle(false)}>
      <section
        ref={rootRef}
        className="upd updConfirm"
        role="dialog"
        aria-modal="true"
        data-state="open"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-text"
        onMouseDown={e => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="updTitle">{title}</h2>
        <p id="confirm-text" className="updNotes">{text}</p>
        <div className="updActs">
          <Button variant="secondary" size="sm" onClick={() => settle(false)}>{cancelText}</Button>
          <Button variant="primary" size="sm" onClick={() => settle(true)}>{okText}</Button>
        </div>
      </section>
    </div>
  );
}
