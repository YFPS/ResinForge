import { useReducer, useCallback } from 'react';
import { params } from '../store.js';

/* params 是模块级可变对象（core 直接读取）；setParam 写入后强制重渲染让受控组件刷新 */
export function useParams() {
  const [, force] = useReducer(x => x + 1, 0);
  const setParam = useCallback((k, v) => { params[k] = v; force(); }, []);
  return [params, setParam];
}
