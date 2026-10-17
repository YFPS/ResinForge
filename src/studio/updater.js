/* 桌面版在线更新。浏览器里什么都不做。
   启动时悄悄查一次，只有发现新版本才弹窗。命令面板里的「检查更新」会把「已是最新」也说出来。 */
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

/** manual 为真时，没有更新或失败也会提示。 */
export async function runUpdateCheck({ manual = false } = {}) {
  if (!IN_TAURI) {
    if (manual) say('仅桌面版可以检查更新');
    return;
  }
  if (running) return;
  running = true;
  try {
    const found = await lookForUpdate();
    if (found.unsupported) return;
    if (found.update) {
      if (pending) pending(found.update);
      else say('发现新版本', found.update.version);
      return;
    }
    if (manual) say('已是最新版本');
  } catch (err) {
    if (manual) say('检查更新失败', err && err.message ? err.message : '请稍后再试');
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
