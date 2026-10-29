import React, { useEffect } from 'react';
import { Box, Plus, X } from 'lucide-react';
import { useBusLatest, useBusState } from '../demo/bridge.js';
import { closeOpenProject, ensureLiveTab, switchOpenProject } from './desk.jsx';

/* 打开的工程竖排在这一列。切到别的页面时这一列留着，点工程名就能回去。
   新建项目走最底下的「+」，先到新建项目页选机型 / 材料 / 层厚。 */

export default function ProjectSider({ page, onPage }) {
  const pack = useBusState('openTabs', { tabs: [], current: null });
  const info = useBusLatest('modelInfo', null);
  const tabs = pack.tabs || [];
  const current = pack.current;

  useEffect(() => {
    const name = info && info.name;
    if (name) ensureLiveTab(name);
  }, [info && info.name]);

  /* 点工程标签同样先离开当前页面，否则换了工程还停在别的页面上 */
  const openTab = id => {
    onPage(null);
    switchOpenProject(id).catch(() => {});
  };

  return (
    <aside className="stuSider" aria-label="打开的工程">
      <div className="stuSiderBar">
        <div className="stuSiderTabs">
          {tabs.map(tab => (
            <div key={tab.id} className={'stuSiderTab' + (tab.id === current && !page ? ' on' : '')}>
              <button type="button" className="stuSiderName" title={tab.name} onClick={() => openTab(tab.id)}>
                <Box size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{tab.name}</span>
              </button>
              <button
                type="button"
                className="stuSiderClose"
                aria-label={`关闭 ${tab.name}`}
                onClick={() => closeOpenProject(tab.id).catch(() => {})}
              >
                <X size={12} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className={'stuSiderAdd' + (page === 'new' ? ' on' : '')}
          aria-label="新建项目"
          aria-current={page === 'new' ? 'page' : undefined}
          onClick={() => onPage('new')}
        >
          <Plus size={15} strokeWidth={1.75} />
        </button>
      </div>
    </aside>
  );
}
