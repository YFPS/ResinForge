/* 桌面版更新提示。浏览器里不渲染。 */
import React, { useEffect, useRef, useState } from 'react';
import Button from '@/components/arc/button/button';
import { IN_TAURI } from '../demo/components/TitleBar.jsx';
import { installUpdate, runUpdateCheck, subscribeUpdate } from './updater.js';

export default function UpdateHost() {
  const [view, setView] = useState(null);
  const updateRef = useRef(null);
  const bytes = useRef(0);
  const total = useRef(0);

  useEffect(() => {
    if (!IN_TAURI) return undefined;
    const off = subscribeUpdate(update => {
      updateRef.current = update;
      bytes.current = 0;
      total.current = 0;
      setView({ phase: 'prompt', version: update.version, notes: update.body || '' });
    });
    const onAsk = () => { runUpdateCheck({ manual: true }); };
    window.addEventListener('studio:check-update', onAsk);
    const later = window.setTimeout(() => { runUpdateCheck(); }, 2500);
    return () => {
      off();
      window.removeEventListener('studio:check-update', onAsk);
      window.clearTimeout(later);
    };
  }, []);

  if (!IN_TAURI || !view) return null;

  const close = async () => {
    const update = updateRef.current;
    updateRef.current = null;
    setView(null);
    if (update && view.phase === 'prompt') {
      try { await update.close(); } catch { /* 放弃这次更新即可 */ }
    }
  };

  const start = async () => {
    const update = updateRef.current;
    if (!update) return;
    setView(v => ({ ...v, phase: 'downloading', progress: 0 }));
    try {
      await installUpdate(update, event => {
        if (event.event === 'Started' && event.data.contentLength) total.current = event.data.contentLength;
        if (event.event === 'Progress') {
          bytes.current += event.data.chunkLength;
          const progress = total.current ? Math.min(100, Math.round(bytes.current / total.current * 100)) : null;
          setView(v => (v ? { ...v, phase: 'downloading', progress } : v));
        }
        if (event.event === 'Finished') setView(v => (v ? { ...v, phase: 'installing' } : v));
      });
    } catch (err) {
      setView(v => (v ? { ...v, phase: 'error', error: err && err.message ? err.message : '下载或安装失败' } : v));
    }
  };

  const progress = view.progress;
  return (
    <div className="updShade" role="presentation">
      <section className="upd" role="dialog" aria-labelledby="upd-title">
        <h2 id="upd-title" className="updTitle">
          {view.phase === 'error' ? '更新没有完成' : `发现新版本 ${view.version}`}
        </h2>
        {view.phase === 'prompt' && view.notes ? <p className="updNotes">{view.notes}</p> : null}
        {view.phase === 'downloading' ? (
          <p className="updNotes">{progress == null ? '正在下载更新…' : `正在下载更新 ${progress}%`}</p>
        ) : null}
        {view.phase === 'installing' ? <p className="updNotes">正在安装，完成后会重新打开。</p> : null}
        {view.phase === 'error' ? <p className="updNotes">{view.error}</p> : null}
        <div className="updActs">
          {view.phase === 'prompt' ? (
            <>
              <Button variant="secondary" size="sm" onClick={close}>稍后</Button>
              <Button variant="primary" size="sm" onClick={start}>下载并安装</Button>
            </>
          ) : null}
          {view.phase === 'error' ? <Button variant="primary" size="sm" onClick={close}>知道了</Button> : null}
        </div>
      </section>
    </div>
  );
}
