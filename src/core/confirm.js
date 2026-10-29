/* 确认对话框的注入点。core 不能 import React，界面（ConfirmHost）启动时把实现注册进来；
   没注册时退回 window.confirm，core 单独跑（脚本 / 测试）也能走通。 */
let handler = null;

/** fn({ title, text, okText, cancelText }) => Promise<boolean>。传 null 取消注册。 */
export function setConfirmHandler(fn) {
  handler = typeof fn === 'function' ? fn : null;
}

/** 弹一个确认框，用户点确认才得到 true。取消 / Esc / 点遮罩 / 界面出错都当 false，调用方不用再兜底。 */
export function confirmAction(opts = {}) {
  if (handler) {
    try {
      return Promise.resolve(handler(opts)).then(Boolean, () => false);
    } catch {
      return Promise.resolve(false);
    }
  }
  return Promise.resolve(window.confirm(`${opts.title || '提醒'}\n${opts.text || ''}`));
}
