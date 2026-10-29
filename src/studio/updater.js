/* 桌面版在线更新。浏览器里什么都不做。
   启动时悄悄查一次，只有发现新版本才弹窗。
   「检查更新」对话框自己显示结果时传 quiet，避免再弹一条提示。 */
import { IN_TAURI } from '../demo/components/TitleBar.jsx';
import { pushToast } from '../demo/bridge.js';

let pending = null;
let running = false;

function say(title, description) {
  pushToast(title, description || '');
}

/** 向更新服务器查一次。有新版本时返回更新对象，没有则返回 null。 */
export async function lookForUpdate() {
  if (!IN_TAURI) return { unsupported: true };
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check({ timeout: 20000 });
  return { update };
}

export function subscribeUpdate(listener) {
  pending = listener;
  return () => { if (pending === listener) pending = null; };
}

/** manual 为真时，没有更新或失败也会提示。quiet 为真时不弹提示，由调用方自己显示。 */
export async function runUpdateCheck({ manual = false, quiet = false } = {}) {
  const notify = (title, description) => { if (manual && !quiet) say(title, description); };
  if (!IN_TAURI) {
    notify('仅桌面版可以检查更新');
    return { status: 'unsupported' };
  }
  if (running) return { status: 'busy' };
  running = true;
  try {
    const found = await lookForUpdate();
    if (found.unsupported) return { status: 'unsupported' };
    if (found.update) {
      if (pending) pending(found.update);
      else notify('发现新版本', found.update.version);
      return { status: 'available', version: found.update.version };
    }
    notify('已是最新版本');
    return { status: 'latest' };
  } catch (err) {
    const message = err && err.message ? err.message : '请稍后再试';
    notify('检查更新失败', message);
    return { status: 'failed', message };
  } finally {
    running = false;
  }
}

/** 下载并安装。Windows 上安装程序启动后当前进程会退出。 */
export async function installUpdate(update, onProgress) {
  await update.downloadAndInstall(event => {
    if (onProgress) onProgress(event);
  });
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch { /* Windows 安装程序会自己结束当前进程 */ }
}
