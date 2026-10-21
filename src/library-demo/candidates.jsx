import React from 'react';
import {
  ArrowRight, Boxes, ChevronRight, Clock3, Download, FileBox, Folder, FolderKanban,
  Gauge, Grid2X2, HardDrive, Layers3, LayoutGrid, MoreHorizontal, PackageOpen, Plus,
  Printer, Rows3, Search, Settings2, Sparkles, Star, Upload,
} from 'lucide-react';
import {
  Brand, DemoSwitch, Inspector, MachineCard, MaterialCard, PartCard, ProjectCard,
  SearchBox, StatusPill, Thumb,
} from './ui.jsx';
import {
  FOLDERS, LIBRARY_FOLDERS, MACHINES, MATERIALS, SUPPORT_PRESETS, folderName, machineById,
  materialById, relativeTime,
} from './data.js';

const SECTIONS = [
  { id: 'projects', label: '工程', icon: FolderKanban },
  { id: 'parts', label: '零件库', icon: Boxes },
  { id: 'profiles', label: '机器与材料', icon: Printer },
];

const folderIcon = (icon, size = 15) => {
  if (icon === 'star') return <Star size={size} strokeWidth={1.8} />;
  if (icon === 'clock') return <Clock3 size={size} strokeWidth={1.8} />;
  if (icon === 'grid') return <Grid2X2 size={size} strokeWidth={1.8} />;
  return <Folder size={size} strokeWidth={1.8} />;
};

function TopNav({ ctx, dark = false }) {
  return (
    <nav className={'ldTopNav ' + (dark ? 'is-dark' : '')}>
      {SECTIONS.map(s => {
        const Icon = s.icon;
        return (
          <button key={s.id} className={ctx.section === s.id ? 'is-on' : ''} onClick={() => ctx.setSection(s.id)}>
            <Icon size={15} strokeWidth={1.8} />{s.label}
          </button>
        );
      })}
    </nav>
  );
}

function FolderList({ ctx, folders, counts }) {
  return (
    <nav className="ldFolderList">
      {folders.map(f => (
        <button key={f.id} className={ctx.folder === f.id ? 'is-on' : ''} onClick={() => ctx.setFolder(f.id)}>
          <span className="ldFolderIcon">{folderIcon(f.icon)}</span>
          <span className="ldFolderName">{f.name}</span>
          {counts && counts[f.id] != null ? <span className="ldFolderCount">{counts[f.id]}</span> : null}
        </button>
      ))}
    </nav>
  );
}

function Storage({ compact = false }) {
  return (
    <div className={'ldStorage ' + (compact ? 'is-compact' : '')}>
      <div className="ldStorageTop">
        <span><HardDrive size={14} strokeWidth={1.8} />本地存储</span>
        <b>62%</b>
      </div>
      <div className="ldStorageBar"><i style={{ width: '62%' }} /></div>
      <span className="ldStorageText">12.4 GB / 20 GB · 128 个零件</span>
    </div>
  );
}

function EmptyState({ text = '没有匹配的结果', sub = '换个关键词或文件夹试试。' }) {
  return (
    <div className="ldEmpty">
      <div className="ldEmptyArt"><Search size={26} strokeWidth={1.4} /></div>
      <p className="ldEmptyTitle">{text}</p>
      <p className="ldEmptyText">{sub}</p>
    </div>
  );
}

function ProfileSections({ ctx, variant }) {
  const q = (ctx.query || '').trim().toLowerCase();
  const machines = q ? MACHINES.filter(m => `${m.brand} ${m.model} ${m.type}`.toLowerCase().includes(q)) : MACHINES;
  const materials = q ? MATERIALS.filter(m => `${m.name} ${m.family} ${m.note}`.toLowerCase().includes(q)) : MATERIALS;
  return (
    <div className={'ldProfileWrap ldProfileWrap--' + variant}>
      <section className="ldProfileSection">
        <div className="ldSectionTitle">
          <span><Printer size={16} strokeWidth={1.8} />机器档案</span>
          <small>{machines.length} 台</small>
        </div>
        <div className="ldProfileGrid">
          {machines.map(m => (
            <MachineCard key={m.id} item={m}
              selected={ctx.profileTab === 'machine' && ctx.machineId === m.id}
              onSelect={id => { ctx.setProfileTab('machine'); ctx.setMachineId(id); ctx.setDrawerOpen?.(true); }} />
          ))}
        </div>
      </section>
      <section className="ldProfileSection">
        <div className="ldSectionTitle">
          <span><PackageOpen size={16} strokeWidth={1.8} />材料档案</span>
          <small>{materials.length} 种</small>
        </div>
        <div className="ldProfileGrid">
          {materials.map(m => (
            <MaterialCard key={m.id} item={m}
              selected={ctx.profileTab === 'material' && ctx.materialId === m.id}
              onSelect={id => { ctx.setProfileTab('material'); ctx.setMaterialId(id); ctx.setDrawerOpen?.(true); }} />
          ))}
        </div>
      </section>
    </div>
  );
}

/* ============================================================
   A：文件管理器（最接近 BPS）
   ============================================================ */

export function CandidateA({ ctx }) {
  const folders = ctx.section === 'parts' ? LIBRARY_FOLDERS : FOLDERS;
  const title = ctx.section === 'projects'
    ? folderName(ctx.folder)
    : ctx.section === 'parts' ? folderName(ctx.folder, LIBRARY_FOLDERS) : '机器与材料';
  const counts = ctx.section === 'parts' ? ctx.partCounts : ctx.projectCounts;
  const selected = ctx.section === 'projects' ? ctx.selectedProject
    : ctx.section === 'parts' ? ctx.selectedPart
      : ctx.profileTab === 'machine' ? ctx.selectedMachine : ctx.selectedMaterial;
  const kind = ctx.section === 'projects' ? 'project' : ctx.section === 'parts' ? 'part' : ctx.profileTab;

  return (
    <div className="ldPage ldA">
      <header className="ldTopbar">
        <div className="ldTopLeft">
          <Brand />
          <span className="ldTopSep" />
          <TopNav ctx={ctx} />
        </div>
        <div className="ldTopRight">
          <SearchBox value={ctx.query} onChange={ctx.setQuery} compact />
          <button className="ldBtn ldBtn--primary" onClick={ctx.onNew}><Plus size={15} /> 新建工程</button>
          <DemoSwitch value={ctx.candidate} onChange={ctx.setCandidate} />
        </div>
      </header>

      <div className="ldABody">
        <aside className="ldASide">
          <div className="ldSideHead">
            <span>{ctx.section === 'profiles' ? '档案' : '资源库'}</span>
            <small>{ctx.section === 'projects' ? ctx.projects.length + ' 个工程' : ctx.section === 'parts' ? ctx.parts.length + ' 个零件' : '12 项'}</small>
          </div>
          {ctx.section === 'profiles' ? (
            <div className="ldProfileNav">
              <button className={ctx.profileTab === 'machine' ? 'is-on' : ''} onClick={() => ctx.setProfileTab('machine')}><Printer size={15} />机器档案<small>{MACHINES.length}</small></button>
              <button className={ctx.profileTab === 'material' ? 'is-on' : ''} onClick={() => ctx.setProfileTab('material')}><PackageOpen size={15} />材料档案<small>{MATERIALS.length}</small></button>
            </div>
          ) : (
            <>
              <FolderList ctx={ctx} folders={folders.filter(f => f.smart)} counts={counts} />
              <div className="ldSideDivider" />
              <div className="ldSideLabel">文件夹</div>
              <FolderList ctx={ctx} folders={folders.filter(f => !f.smart)} counts={counts} />
            </>
          )}
          <div className="ldSideSpacer" />
          <Storage />
        </aside>

        <main className="ldAMain">
          <div className="ldMainHead">
            <div>
              <span className="ldKicker">{ctx.section === 'projects' ? '工程' : ctx.section === 'parts' ? '零件库' : '设置'}</span>
              <h1>{title}</h1>
              <p>
                {ctx.section === 'projects' ? `${ctx.projectList.length} 个工程 · ${ctx.projects.filter(p => p.starred).length} 个星标`
                  : ctx.section === 'parts' ? `${ctx.partList.length} 个零件 · 共 ${ctx.parts.length} 个`
                    : '机器与材料是环境配置，随工程保存快照'}
              </p>
            </div>
            <div className="ldMainTools">
              <span className="ldSort">最近修改 <ChevronRight size={12} /></span>
              <span className="ldViewToggle"><Grid2X2 size={15} className="is-on" /><Rows3 size={15} /></span>
            </div>
          </div>

          {ctx.section === 'projects' ? (
            ctx.projectList.length ? (
              <div className="ldAGrid">
                {ctx.projectList.map(p => (
                  <ProjectCard key={p.id} item={p} thumbs={ctx.thumbs} selected={ctx.selectedId === p.id} onSelect={ctx.setSelectedId} />
                ))}
              </div>
            ) : <EmptyState />
          ) : null}

          {ctx.section === 'parts' ? (
            ctx.partList.length ? (
              <div className="ldAGrid ldAGrid--parts">
                {ctx.partList.map(p => (
                  <PartCard key={p.id} item={p} thumbs={ctx.thumbs} selected={ctx.selectedId === p.id} onSelect={ctx.setSelectedId} />
                ))}
              </div>
            ) : <EmptyState />
          ) : null}

          {ctx.section === 'profiles' ? <ProfileSections ctx={ctx} variant="a" /> : null}
        </main>

        <Inspector kind={kind} item={selected} thumbs={ctx.thumbs} onAction={ctx.onAction} />
      </div>
    </div>
  );
}

/* ============================================================
   B：工作台（最近工程优先）
   ============================================================ */

export function CandidateB({ ctx }) {
  const featured = ctx.projects.find(p => p.starred) || ctx.projects[0];
  const recent = ctx.projects.slice(0, 4);
  const shelf = ctx.parts.slice(0, 6);
  const selected = ctx.section === 'projects' ? ctx.selectedProject
    : ctx.section === 'parts' ? ctx.selectedPart
      : ctx.profileTab === 'machine' ? ctx.selectedMachine : ctx.selectedMaterial;
  const kind = ctx.section === 'projects' ? 'project' : ctx.section === 'parts' ? 'part' : ctx.profileTab;

  return (
    <div className="ldPage ldB">
      <header className="ldTopbar ldBTop">
        <div className="ldTopLeft">
          <Brand />
          <TopNav ctx={ctx} />
        </div>
        <div className="ldTopRight">
          <SearchBox value={ctx.query} onChange={ctx.setQuery} compact />
          <button className="ldBtn ldBtn--primary" onClick={ctx.onNew}><Plus size={15} /> 新建工程</button>
          <DemoSwitch value={ctx.candidate} onChange={ctx.setCandidate} />
        </div>
      </header>

      <main className="ldBMain">
        {ctx.section === 'projects' ? (
          <>
            <section className="ldBHero">
              <div className="ldBHeroCopy">
                <span className="ldKicker">工作台</span>
                <h1>把支撑工程<br />收进一个地方。</h1>
                <p>工程、零件、机器与材料都在本地。打开最近工程，或者从模板开始。</p>
                <div className="ldBHeroActions">
                  <button className="ldBtn ldBtn--primary ldBtn--large" onClick={ctx.onNew}><Sparkles size={16} /> 新建工程</button>
                  <button className="ldBtn ldBtn--large" onClick={() => ctx.onAction('import')}><Upload size={16} /> 导入模型</button>
                </div>
                <div className="ldBHeroStats">
                  <span><b>{ctx.projects.length}</b> 个工程</span>
                  <span><b>{ctx.parts.length}</b> 个零件</span>
                  <span><b>{ctx.projects.reduce((s, p) => s + p.supports, 0).toLocaleString()}</b> 个支撑点</span>
                </div>
              </div>
              <button className="ldBFeature" onClick={() => ctx.setSelectedId(featured.id)}>
                <Thumb url={ctx.thumbs[featured.keys.join('+')] || ctx.thumbs[featured.keys[0]]} />
                <span className="ldBFeatureBadge">继续上次</span>
                <div className="ldBFeatureInfo">
                  <span className="ldKicker">最近工程</span>
                  <b>{featured.name}</b>
                  <span>{machineById(featured.machineId).model} · {materialById(featured.materialId).name}</span>
                </div>
                <span className="ldBFeatureGo"><ArrowRight size={16} /></span>
              </button>
            </section>

            <section className="ldBQuick">
              {[
                { icon: Sparkles, title: '新建工程', desc: '机器 → 材料 → 零件', onClick: ctx.onNew },
                { icon: Upload, title: '导入模型', desc: 'STL / OBJ / 3MF', onClick: () => ctx.onAction('import') },
                { icon: PackageOpen, title: '从零件库添加', desc: `${ctx.parts.length} 个可复用零件`, onClick: () => ctx.setSection('parts') },
                { icon: Printer, title: '机器与材料', desc: `${MACHINES.length} 台机器 · ${MATERIALS.length} 种材料`, onClick: () => ctx.setSection('profiles') },
              ].map(q => {
                const Icon = q.icon;
                return (
                  <button key={q.title} className="ldBQuickTile" onClick={q.onClick}>
                    <span className="ldBQuickIcon"><Icon size={18} strokeWidth={1.7} /></span>
                    <b>{q.title}</b>
                    <small>{q.desc}</small>
                    <ChevronRight size={15} className="ldBQuickGo" />
                  </button>
                );
              })}
            </section>

            <section className="ldBSection">
              <div className="ldSectionTitle">
                <span>最近工程</span>
                <small>{recent.length} 个</small>
                <button className="ldTextBtn" onClick={() => {}}>查看全部 <ChevronRight size={12} /></button>
              </div>
              <div className="ldBRecent">
                {recent.map(p => (
                  <ProjectCard key={p.id} item={p} thumbs={ctx.thumbs} variant="b"
                    selected={ctx.selectedId === p.id} onSelect={ctx.setSelectedId} />
                ))}
              </div>
            </section>

            <section className="ldBSection">
              <div className="ldSectionTitle">
                <span>零件库</span>
                <small>最近使用</small>
                <button className="ldTextBtn" onClick={() => ctx.setSection('parts')}>打开零件库 <ChevronRight size={12} /></button>
              </div>
              <div className="ldBShelf">
                {shelf.map(p => (
                  <button key={p.id} className="ldBShelfItem" onClick={() => { ctx.setSection('parts'); ctx.setSelectedId(p.id); }}>
                    <Thumb url={ctx.thumbs[p.key]} />
                    <span>{p.name}</span>
                    <small>{p.tags[0]}</small>
                  </button>
                ))}
              </div>
            </section>

            <section className="ldBSection">
              <div className="ldSectionTitle"><span>全部工程</span><small>{ctx.projectList.length} 个</small></div>
              <div className="ldBList">
                {ctx.projectList.map(p => (
                  <button key={p.id} className={'ldBRow ' + (ctx.selectedId === p.id ? 'is-on' : '')} onClick={() => ctx.setSelectedId(p.id)}>
                    <Thumb url={ctx.thumbs[p.keys.join('+')] || ctx.thumbs[p.keys[0]]} className="ldBRowThumb" />
                    <span className="ldBRowName">{p.name}</span>
                    <span className="ldBRowMeta">{machineById(p.machineId).model}</span>
                    <span className="ldBRowMeta">{materialById(p.materialId).name}</span>
                    <span className="ldBRowMeta"><Layers3 size={12} />{p.supports}</span>
                    <span className="ldBRowTime">{relativeTime(p.updatedAt)}</span>
                    {p.starred ? <Star size={13} fill="currentColor" className="ldStarOn" /> : <span />}
                  </button>
                ))}
              </div>
            </section>
          </>
        ) : null}

        {ctx.section === 'parts' ? (
          <>
            <section className="ldBHero ldBHero--slim">
              <div className="ldBHeroCopy">
                <span className="ldKicker">零件库</span>
                <h1>可复用的零件，<br />只存一份。</h1>
                <p>从工程加入库、从库插入工程；副本语义，互不污染。</p>
              </div>
              <div className="ldBHeroStats ldBHeroStats--card">
                <span><b>{ctx.parts.length}</b> 个零件</span>
                <span><b>6</b> 个文件夹</span>
                <span><b>12.4</b> GB 已用</span>
              </div>
            </section>
            <div className="ldBFolderChips">
              {LIBRARY_FOLDERS.map(f => (
                <button key={f.id} className={ctx.folder === f.id ? 'is-on' : ''} onClick={() => ctx.setFolder(f.id)}>
                  {folderIcon(f.icon, 13)}{f.name}
                </button>
              ))}
            </div>
            {ctx.partList.length ? (
              <div className="ldBPartGrid">
                {ctx.partList.map(p => (
                  <PartCard key={p.id} item={p} thumbs={ctx.thumbs} variant="b"
                    selected={ctx.selectedId === p.id} onSelect={ctx.setSelectedId} />
                ))}
              </div>
            ) : <EmptyState />}
          </>
        ) : null}

        {ctx.section === 'profiles' ? (
          <>
            <section className="ldBHero ldBHero--slim">
              <div className="ldBHeroCopy">
                <span className="ldKicker">机器与材料</span>
                <h1>参数档案，<br />工程里存快照。</h1>
                <p>机器决定板面与像素；材料决定层厚与默认支撑预设。</p>
              </div>
              <div className="ldBHeroStats ldBHeroStats--card">
                <span><b>{MACHINES.length}</b> 台机器</span>
                <span><b>{MATERIALS.length}</b> 种材料</span>
                <span><b>4</b> 档支撑预设</span>
              </div>
            </section>
            <ProfileSections ctx={ctx} variant="b" />
          </>
        ) : null}
      </main>

      {ctx.drawerOpen && (ctx.selectedId || ctx.section === 'profiles') ? (
        <div className="ldDrawer">
          <Inspector kind={kind} item={selected} thumbs={ctx.thumbs} compact onClose={() => ctx.setDrawerOpen(false)} onAction={ctx.onAction} />
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================
   C：专业库（图标栏 + 列表 + 检查器）
   ============================================================ */

export function CandidateC({ ctx }) {
  const selected = ctx.section === 'projects' ? ctx.selectedProject
    : ctx.section === 'parts' ? ctx.selectedPart
      : ctx.profileTab === 'machine' ? ctx.selectedMachine : ctx.selectedMaterial;
  const kind = ctx.section === 'projects' ? 'project' : ctx.section === 'parts' ? 'part' : ctx.profileTab;

  return (
    <div className="ldPage ldC">
      <aside className="ldCRail">
        <span className="ldCRailBrand"><Brand small /></span>
        <div className="ldCRailNav">
          {SECTIONS.map(s => {
            const Icon = s.icon;
            return (
              <button key={s.id} className={ctx.section === s.id ? 'is-on' : ''} onClick={() => ctx.setSection(s.id)} title={s.label}>
                <Icon size={19} strokeWidth={1.7} /><span>{s.label}</span>
              </button>
            );
          })}
        </div>
        <button className="ldCRailNew" onClick={ctx.onNew} title="新建工程"><Plus size={19} /></button>
        <span className="ldCRailFoot"><Settings2 size={18} strokeWidth={1.6} /></span>
      </aside>

      <div className="ldCShell">
        <header className="ldCTop">
          <div className="ldCTitle">
            <span className="ldKicker">资源库</span>
            <h1>{ctx.section === 'projects' ? (ctx.folder === 'all' ? '全部工程' : folderName(ctx.folder)) : ctx.section === 'parts' ? (ctx.folder === 'all' ? '零件库' : folderName(ctx.folder, LIBRARY_FOLDERS)) : '机器与材料'}</h1>
          </div>
          <SearchBox value={ctx.query} onChange={ctx.setQuery} compact />
          <button className="ldBtn ldBtn--primary" onClick={ctx.onNew}><Plus size={15} /> 新建工程</button>
          <DemoSwitch value={ctx.candidate} onChange={ctx.setCandidate} />
        </header>

        <div className="ldCBody">
          <div className="ldCMain">
            {ctx.section === 'profiles' ? null : (
              <div className="ldCFilters">
                <FolderList ctx={ctx} folders={(ctx.section === 'parts' ? LIBRARY_FOLDERS : FOLDERS)} counts={ctx.section === 'parts' ? ctx.partCounts : ctx.projectCounts} />
              </div>
            )}

            {ctx.section === 'projects' ? (
              <div className="ldCTable">
                <div className="ldCHead">
                  <span>工程</span><span>机器 / 材料</span><span>零件</span><span>支撑</span><span>修改</span><span />
                </div>
                {ctx.projectList.map(p => (
                  <button key={p.id} className={'ldCRow ' + (ctx.selectedId === p.id ? 'is-on' : '')} onClick={() => ctx.setSelectedId(p.id)}>
                    <span className="ldCRowMain">
                      <Thumb url={ctx.thumbs[p.keys.join('+')] || ctx.thumbs[p.keys[0]]} className="ldCRowThumb" />
                      <span>
                        <b>{p.name}</b>
                        <small>{folderName(p.folder)} · {p.parts} 件 · {p.faces.toLocaleString()} 面</small>
                      </span>
                    </span>
                    <span className="ldCRowStack">
                      <b>{machineById(p.machineId).model}</b>
                      <small>{materialById(p.materialId).name} · {p.layerUm}µm</small>
                    </span>
                    <span className="ldCNum">{p.parts}</span>
                    <span className="ldCNum">{p.supports}</span>
                    <span className="ldCRowTime">{relativeTime(p.updatedAt)}</span>
                    <span className="ldCRowEnd">{p.starred ? <Star size={13} fill="currentColor" className="ldStarOn" /> : null}<MoreHorizontal size={15} className="ldMutedIcon" /></span>
                  </button>
                ))}
                {!ctx.projectList.length ? <EmptyState /> : null}
              </div>
            ) : null}

            {ctx.section === 'parts' ? (
              ctx.partList.length ? (
                <div className="ldCPartGrid">
                  {ctx.partList.map(p => (
                    <PartCard key={p.id} item={p} thumbs={ctx.thumbs} variant="c"
                      selected={ctx.selectedId === p.id} onSelect={ctx.setSelectedId} />
                  ))}
                </div>
              ) : <EmptyState />
            ) : null}

            {ctx.section === 'profiles' ? <ProfileTables ctx={ctx} /> : null}
          </div>

          <Inspector kind={kind} item={selected} thumbs={ctx.thumbs} onAction={ctx.onAction} />
        </div>
      </div>
    </div>
  );
}

function ProfileTables({ ctx }) {
  const q = (ctx.query || '').trim().toLowerCase();
  const machines = q ? MACHINES.filter(m => `${m.brand} ${m.model} ${m.type}`.toLowerCase().includes(q)) : MACHINES;
  const materials = q ? MATERIALS.filter(m => `${m.name} ${m.family} ${m.note}`.toLowerCase().includes(q)) : MATERIALS;
  return (
    <div className="ldCTables">
      <section>
        <div className="ldSectionTitle"><span><Printer size={15} />机器</span><small>{machines.length}</small></div>
        <div className="ldCTable ldCTable--profile">
          <div className="ldCHead"><span>机器</span><span>成型尺寸</span><span>像素</span><span>类型</span><span /></div>
          {machines.map(m => (
            <button key={m.id} className={'ldCRow ' + (ctx.profileTab === 'machine' && ctx.machineId === m.id ? 'is-on' : '')}
              onClick={() => { ctx.setProfileTab('machine'); ctx.setMachineId(m.id); }}>
              <span className="ldCRowMain"><span className="ldCIcon"><Printer size={16} /></span><span><b>{m.brand} {m.model}</b><small>{m.resolution}</small></span></span>
              <span>{m.plateX} × {m.plateZ} × {m.plateY}</span>
              <span>{m.pixelUm} µm</span>
              <span>{m.type} · {m.lightNm}nm</span>
              <span className="ldCRowEnd"><MoreHorizontal size={15} className="ldMutedIcon" /></span>
            </button>
          ))}
        </div>
      </section>
      <section>
        <div className="ldSectionTitle"><span><PackageOpen size={15} />材料</span><small>{materials.length}</small></div>
        <div className="ldCTable ldCTable--profile">
          <div className="ldCHead"><span>材料</span><span>层厚</span><span>密度</span><span>默认支撑</span><span /></div>
          {materials.map(m => (
            <button key={m.id} className={'ldCRow ' + (ctx.profileTab === 'material' && ctx.materialId === m.id ? 'is-on' : '')}
              onClick={() => { ctx.setProfileTab('material'); ctx.setMaterialId(m.id); }}>
              <span className="ldCRowMain"><span className="ldColorDot" style={{ background: m.color }} /><span><b>{m.name}</b><small>{m.family} · ¥{m.cost}/kg</small></span></span>
              <span>{m.layers.map(u => `${u}µm`).join(' / ')}</span>
              <span>{m.density} g/cm³</span>
              <span>{SUPPORT_PRESETS.find(p => p.id === m.preset)?.name || m.preset}</span>
              <span className="ldCRowEnd"><MoreHorizontal size={15} className="ldMutedIcon" /></span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
