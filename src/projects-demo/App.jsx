import React, { useEffect, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/arc/popover/popover';
import StageCanvas from '../studio/StageCanvas.jsx';
import ToastHost from '../demo/components/ToastHost.jsx';
import CommandPalette from '../demo/components/CommandPalette.jsx';
import { init, insertFiles, useApp } from './appStore.js';
import { TabsShell } from './shells/TabsShell.jsx';
import { DrawerShell } from './shells/DrawerShell.jsx';
import { ModuleShell } from './shells/ModuleShell.jsx';

/* 顶层：真实画布常驻（core 场景是单例，只初始化一次），三个方案的外壳围着它换。
   地址 #1 / #2 / #3 选方案。 */

const SCHEMES = [
  { id: '1', name: '标签页 + 主页', ws: '左卡「对象 / 零件库」双页签', home: '主页管理工程、零件库、机器、材料', file: '手动保存，关标签时确认', fit: '和 BPS 最接近；常同时开几个工程' },
  { id: '2', name: '单窗口 + 资源抽屉', ws: '左侧抽屉，拖进视口', home: '没有主页，一直停在 3D 视口里', file: '自动保存 + 历史版本', fit: '一次只做一个工程，不想离开视口' },
  { id: '3', name: '资源库 + 工作区', ws: '底部胶片条（资源库里正在看的那组零件）', home: '资源库：带实时 3D 预览的三栏浏览器', file: '手动保存', fit: '零件多、要成批整理和筛选' },
];

function readScheme() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  if (SCHEMES.some(s => s.id === h)) return h;
  try { const s = localStorage.getItem('resinforge:projects-demo.scheme'); if (SCHEMES.some(x => x.id === s)) return s; } catch { /* 忽略 */ }
  return '1';
}

/** 画布外包一层接拖放：零件库磁贴、STL 文件。stopPropagation 挡住 core 挂在 window 上的「拖进来就载入模型」 */
function StageWrap({ dropRef }) {
  const app = useApp();
  const [hint, setHint] = useState(null);
  const ok = () => dropRef.current?.enabled && app.active && !app.loading;
  return (
    <div className="pdStageWrap"
      onDragOver={e => {
        const types = [...e.dataTransfer.types];
        const part = types.includes('application/x-resinforge-part');
        if (!part && !types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        if (!ok()) { e.dataTransfer.dropEffect = 'none'; return; }
        e.dataTransfer.dropEffect = 'copy';
        setHint(part ? '松开，零件放到这里' : '松开，把文件放进当前工程');
      }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setHint(null); }}
      onDrop={e => {
        e.preventDefault();
        e.stopPropagation();
        setHint(null);
        if (!ok()) return;
        const id = e.dataTransfer.getData('application/x-resinforge-part');
        if (id) dropRef.current.onPart(id, e);
        else if (e.dataTransfer.files?.length) insertFiles(e.dataTransfer.files);
      }}>
      <StageCanvas />
      {hint ? <div className="pdDropHint"><span>{hint}</span></div> : null}
    </div>
  );
}

/* 演示用的方案切换：不属于产品界面，三个方案都放在窗口标题栏（方案一是标签条）的右端。
   说明弹层里另有「外观」切换：专业紧凑（默认，参照 BPS 实测的小圆角与实底浮层）/ 与 Studio 一致 */
function SchemeSwitch({ value, onChange, look, onLook }) {
  return (
    <div className="pdScheme">
      <div className="pdSchemeSeg" role="radiogroup" aria-label="演示方案">
        {SCHEMES.map(s => (
          <button key={s.id} type="button" role="radio" aria-checked={value === s.id} className={value === s.id ? 'is-on' : ''}
            title={s.name} onClick={() => onChange(s.id)}>方案{'一二三'[+s.id - 1]}</button>
        ))}
      </div>
      <Popover>
        <PopoverTrigger className="pdSchemeHelp" aria-label="三个方案的区别"><HelpCircle size={16} strokeWidth={1.8} /></PopoverTrigger>
        <PopoverContent align="end" className="pdSchemePop">
          <b>三个方案的区别</b>
          <p>三个方案用同一套数据和真实的 Studio 引擎：打开工程会用真实算法重建支撑，保存写进浏览器本地数据库，刷新后还在。区别在信息怎么组织。</p>
          <table>
            <thead><tr><th>方案</th><th>工程与资源</th><th>在工程里取零件</th><th>保存</th><th>适合</th></tr></thead>
            <tbody>
              {SCHEMES.map(s => (
                <tr key={s.id} className={s.id === value ? 'is-on' : ''}>
                  <td>{s.name}</td><td>{s.home}</td><td>{s.ws}</td><td>{s.file}</td><td>{s.fit}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pdLookRow">
            <span><b>外观</b><small>专业紧凑参照 BPS 实测：控件圆角 8、面板 12、浮层实底；另一档与现在的 Studio 一致</small></span>
            <div className="pdSchemeSeg" role="radiogroup" aria-label="外观">
              {[['pro', '专业紧凑'], ['standard', '与 Studio 一致']].map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={look === id} className={look === id ? 'is-on' : ''} onClick={() => onLook(id)}>{label}</button>
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default function App() {
  const app = useApp();
  const [scheme, setScheme] = useState(readScheme);
  const [look, setLook] = useState(() => { try { return localStorage.getItem('resinforge:projects-demo.look') || 'pro'; } catch { return 'pro'; } });
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    document.documentElement.setAttribute('data-pd-look', look);
    try { localStorage.setItem('resinforge:projects-demo.look', look); } catch { /* 忽略 */ }
  }, [look]);
  const stageDrop = useRef({ enabled: false, onPart: () => {} });

  useEffect(() => { init(); }, []);
  useEffect(() => {
    try { localStorage.setItem('resinforge:projects-demo.scheme', scheme); history.replaceState(null, '', '#' + scheme); } catch { /* 忽略 */ }
  }, [scheme]);
  useEffect(() => {
    const onHash = () => setScheme(readScheme());
    const onPalette = () => setPalette(true);
    const onKey = e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(o => !o); } };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('pd:palette', onPalette);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('pd:palette', onPalette); window.removeEventListener('keydown', onKey); };
  }, []);

  return (
    <div className="stu stu--desktop pdRoot" data-scheme={scheme} data-look={look}>
      <StageWrap dropRef={stageDrop} />
      {!app.ready ? (
        <div className="pdBoot" role="status">{app.error ? `演示数据载入失败：${app.error}` : '正在准备演示数据…'}</div>
      ) : scheme === '1' ? <TabsShell stageDrop={stageDrop} />
        : scheme === '2' ? <DrawerShell stageDrop={stageDrop} />
          : <ModuleShell stageDrop={stageDrop} />}
      <SchemeSwitch value={scheme} onChange={setScheme} look={look} onLook={setLook} />
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <ToastHost />
    </div>
  );
}
