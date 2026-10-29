/* 屏幕中央的两个对话框：问题反馈，以及检查更新（版本 + 最近更新日志）。 */
import React, { useEffect, useState } from 'react';
import Button from '@/components/arc/button/button';
import { IN_TAURI } from '../demo/components/TitleBar.jsx';
import { runUpdateCheck } from './updater.js';
import { APP_VERSION, recentReleases } from './releaseNotes.js';

const ISSUE_NEW = 'https://github.com/YFPS/ResinForge/issues/new';
const NOTES = recentReleases(2);

function issueUrl(title, report) {
  const url = new URL(ISSUE_NEW);
  url.searchParams.set('title', title);
  url.searchParams.set('body', report);
  const href = url.toString();
  return href.length > 5500 ? ISSUE_NEW : href;
}

async function openExternal(url) {
  if (!url.startsWith('https://github.com/YFPS/ResinForge/')) return false;
  if (IN_TAURI) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_external', { url });
      return true;
    } catch { /* 桌面壳没放行时退回浏览器打开 */ }
  }
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  return !!opened;
}

function ReleaseBody({ items }) {
  const blocks = [];
  let list = [];
  const flush = () => {
    if (!list.length) return;
    const rows = list;
    list = [];
    blocks.push(<ul key={'ul-' + blocks.length}>{rows}</ul>);
  };
  items.forEach((item, i) => {
    if (item.kind === 'li') { list.push(<li key={i}>{item.text}</li>); return; }
    flush();
    if (item.kind === 'h') blocks.push(<h4 key={i}>{item.text}</h4>);
    else blocks.push(<p key={i}>{item.text}</p>);
  });
  flush();
  return blocks;
}

function Shade({ titleId, title, onClose, children }) {
  return (
    <div className="updShade updShade--help" role="presentation" onMouseDown={onClose}>
      <section
        className="upd updHelp"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={e => e.stopPropagation()}
      >
        <h2 id={titleId} className="updTitle">{title}</h2>
        {children}
      </section>
    </div>
  );
}

function FeedbackDialog({ onClose }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const body = text.trim();
    if (!body) { setNote('先写一下遇到的问题'); return; }
    setBusy(true);
    const report = [
      `版本：${APP_VERSION}`,
      `环境：${IN_TAURI ? '桌面版' : '浏览器版'}`,
      '',
      body,
    ].join('\n');
    let copied = false;
    try {
      await navigator.clipboard.writeText(report);
      copied = true;
    } catch { /* 剪贴板不可用时仍给出链接 */ }
    const title = body.split('\n').map(line => line.trim()).find(Boolean) || '问题反馈';
    const url = issueUrl(title.slice(0, 72), report);
    const opened = await openExternal(url);
    setLink(url);
    setNote(opened
      ? (copied ? '已复制，并打开议题页。' : '已打开议题页。')
      : (copied ? '已复制。议题页没有自动打开，用下面的链接。' : '没有打开议题页，请复制下面的链接。'));
    setBusy(false);
  };

  return (
    <Shade titleId="feedback-title" title="问题反馈" onClose={onClose}>
      <p className="updNotes">写下现象和操作步骤。提交后打开议题页，模型不会上传。</p>
      <textarea
        className="updField"
        value={text}
        autoFocus
        placeholder="例如：生成支撑之后点一下模型，支撑消失了。"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
      />
      {note ? <p className="updStatus">{note}</p> : null}
      {link ? <a className="updLink" href={link} target="_blank" rel="noreferrer">打开议题页</a> : null}
      <div className="updActs">
        <Button variant="secondary" size="sm" onClick={onClose}>取消</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={submit}>提交</Button>
      </div>
    </Shade>
  );
}

function AboutDialog({ onClose }) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const check = async () => {
    if (busy) return;
    setBusy(true);
    setStatus('正在检查…');
    const result = await runUpdateCheck({ manual: true, quiet: true });
    if (result.status === 'available') {
      onClose();
      return;
    }
    if (result.status === 'latest') setStatus('已是最新版本');
    else if (result.status === 'unsupported') setStatus('浏览器版不能在线更新。当前就是这个版本。');
    else if (result.status === 'busy') setStatus('正在检查，请稍等。');
    else setStatus(result.message ? `检查更新失败。${result.message}` : '检查更新失败，请稍后再试。');
    setBusy(false);
  };

  return (
    <Shade titleId="about-title" title="检查更新" onClose={onClose}>
      <p className="updVer">当前版本 <span className="tnum">{APP_VERSION}</span></p>
      <div className="updLog">
        {NOTES.map(rel => (
          <article key={rel.heading} className="updRel">
            <h3>{rel.heading}</h3>
            <ReleaseBody items={rel.items} />
          </article>
        ))}
      </div>
      {status ? <p className="updStatus">{status}</p> : null}
      <div className="updActs">
        <Button variant="secondary" size="sm" onClick={onClose}>关闭</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={check}>检查更新</Button>
      </div>
    </Shade>
  );
}

export default function HelpHost() {
  const [which, setWhich] = useState(null);

  useEffect(() => {
    const onFeedback = () => setWhich('feedback');
    const onAbout = () => setWhich('about');
    window.addEventListener('studio:open-feedback', onFeedback);
    window.addEventListener('studio:open-about', onAbout);
    return () => {
      window.removeEventListener('studio:open-feedback', onFeedback);
      window.removeEventListener('studio:open-about', onAbout);
    };
  }, []);

  useEffect(() => {
    if (!which) return undefined;
    const onKey = e => { if (e.key === 'Escape') setWhich(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [which]);

  if (which === 'feedback') return <FeedbackDialog onClose={() => setWhich(null)} />;
  if (which === 'about') return <AboutDialog onClose={() => setWhich(null)} />;
  return null;
}
