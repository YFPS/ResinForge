/* demo 与 core 的桥接层：bus 事件订阅、toast 队列、参数绑定。
   core 只经 bus 发事件，React 侧在这里统一消费。 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { bus, params } from '../store.js';

/* ---------- bus 事件 ---------- */

/** 订阅 bus 事件；handler 经 ref 转发，避免闭包过期。 */
export function useBus(ev, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => bus.on(ev, (...args) => ref.current(...args)), [ev]);
}

/** 订阅并把最新 payload 当状态用（progress/layerLabel 这类）。 */
export function useBusState(ev, initial = null) {
  const [v, setV] = useState(initial);
  useBus(ev, setV);
  return v;
}

/* 侧栏的步骤面板按需挂载（切到哪一步才渲染哪一步），挂载晚于事件发生时 useBusState 会错过初值。
   这里在模块加载时（早于 core 的 initScene）就订阅这些事件并缓存最新 payload，组件随时挂载都能拿到。 */
const latest = new Map();
const latestSubs = new Map();
['modelInfo', 'sliceStats', 'supStats', 'orientResults', 'heat', 'mode', 'progress', 'pointsOnly'].forEach(ev => {
  latestSubs.set(ev, new Set());
  bus.on(ev, payload => {
    latest.set(ev, payload);
    latestSubs.get(ev).forEach(fn => fn());
  });
});

/** 读取某个事件最近一次的 payload（只支持上面登记过的事件） */
export function useBusLatest(ev, initial = null) {
  return useSyncExternalStore(
    fn => { latestSubs.get(ev).add(fn); return () => latestSubs.get(ev).delete(fn); },
    () => (latest.has(ev) ? latest.get(ev) : initial),
  );
}

/** 这些事件任一触发时重新读取 read()；read 须返回原始值（字符串 / 数字 / 布尔），供 React 比较 */
export function useBusValue(events, read) {
  const readRef = useRef(read);
  readRef.current = read;
  const key = events.join('|');
  const subscribe = useCallback(fn => {
    const offs = key.split('|').map(ev => bus.on(ev, fn));
    return () => offs.forEach(off => off());
  }, [key]);
  return useSyncExternalStore(subscribe, () => readRef.current());
}

/* ---------- toast 队列 ----------
   Arc 的 Toast 是单实例组件，这里维护一个模块级队列供 core 的 bus.emit('toast') 使用。 */

const toastStore = {
  items: [],
  subs: new Set(),
  seq: 0,
  push(ev) {
    const id = ++this.seq;
    const item = typeof ev === 'string' ? { id, title: ev } : { id, ...ev };
    this.items = [...this.items, item];
    this.emit();
  },
  dismiss(id) {
    const next = this.items.filter(t => t.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.emit();
  },
  emit() { this.subs.forEach(fn => fn()); },
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); },
};

export function pushToast(title, description) {
  toastStore.push(description ? { title, description } : title);
}

export function dismissToast(id) {
  toastStore.dismiss(id);
}

export function useToasts() {
  return useSyncExternalStore(
    fn => toastStore.subscribe(fn),
    () => toastStore.items,
  );
}

/* ---------- 参数绑定 ----------
   params 是模块级可变对象（core 直接读取）；setParam 写入后递增全局版本号，
   所有用 useParams 的组件一起重渲染——命令面板改了结构模式，侧栏里的分段控件也要跟着变。
   组件从 params 读值（每次渲染都取最新），只用 setParam 写。 */
const paramsVersion = { v: 0, subs: new Set() };
const subscribeParams = fn => { paramsVersion.subs.add(fn); return () => paramsVersion.subs.delete(fn); };

export function setParam(k, v) {
  params[k] = v;
  paramsVersion.v++;
  paramsVersion.subs.forEach(fn => fn());
}

export function useParams() {
  useSyncExternalStore(subscribeParams, () => paramsVersion.v);
  return [params, setParam];
}
