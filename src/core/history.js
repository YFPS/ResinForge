/* ================================================================
   模型编辑的撤回 / 重做。
   只记用户对模型的改动：移动、旋转、缩放、删除、应用朝向、简化。
   载入或换模型会清空，避免快照写回已经拆掉的几何。
   输入框打字时的 Ctrl+Z 不进这里，留给文字本身。
   命令自己带着 undo / redo。重放时不再入栈。
================================================================ */
import { bus, log, toast } from '../store.js';

const LIMIT = 40;
const undoStack = [];
const redoStack = [];
let replaying = false;

export function historyReplaying() {
  return replaying;
}

function counts() {
  return { undo: undoStack.length, redo: redoStack.length };
}

export function pushHistory(cmd) {
  if (replaying || !cmd) return;
  undoStack.push(cmd);
  while (undoStack.length > LIMIT) {
    const dropped = undoStack.shift();
    if (dropped.dispose) dropped.dispose();
  }
  for (const old of redoStack) if (old.dispose) old.dispose();
  redoStack.length = 0;
  bus.emit('history', counts());
}

export function clearHistory() {
  for (const cmd of undoStack) if (cmd.dispose) cmd.dispose();
  for (const cmd of redoStack) if (cmd.dispose) cmd.dispose();
  undoStack.length = 0;
  redoStack.length = 0;
  bus.emit('history', counts());
}

function run(cmd, dir) {
  replaying = true;
  try {
    cmd[dir]();
  } catch (err) {
    replaying = false;
    throw err;
  }
  replaying = false;
}

export function undo() {
  if (replaying) return false;
  const cmd = undoStack.pop();
  if (!cmd) {
    toast('没有可撤回的操作');
    return false;
  }
  try {
    run(cmd, 'undo');
  } catch (err) {
    undoStack.push(cmd);
    log(`撤回失败：${err && err.message ? err.message : err}`, 'warn');
    toast('撤回失败');
    return false;
  }
  redoStack.push(cmd);
  bus.emit('history', counts());
  log(`已撤回：${cmd.label}`, 'ok');
  toast(`已撤回：${cmd.label}`);
  return true;
}

export function redo() {
  if (replaying) return false;
  const cmd = redoStack.pop();
  if (!cmd) {
    toast('没有可重做的操作');
    return false;
  }
  try {
    run(cmd, 'redo');
  } catch (err) {
    redoStack.push(cmd);
    log(`重做失败：${err && err.message ? err.message : err}`, 'warn');
    toast('重做失败');
    return false;
  }
  undoStack.push(cmd);
  bus.emit('history', counts());
  log(`已重做：${cmd.label}`, 'ok');
  toast(`已重做：${cmd.label}`);
  return true;
}
