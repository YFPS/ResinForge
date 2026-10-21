import React from 'react';
import {
  Boxes, ChevronRight, Clock3, Folder, FolderKanban, Grid2X2, Layers3,
  MoreHorizontal, MousePointer2, PackageOpen, Plus, Printer, Rows3, Settings2,
  Star, Upload,
} from 'lucide-react';
import Button from '@/components/arc/button/button';
import { Card } from '@/components/arc/card/card';
import { Badge } from '@/components/arc/badge/badge';
import SegmentedControl from '@/components/arc/segmented-control/segmented-control';
import { ScrollArea } from '@/components/arc/scroll-area/scroll-area';
import { EmptyState } from '@/components/arc/empty-state/empty-state';
import Progress from '@/components/arc/progress/progress';
import Tooltip from '@/components/arc/tooltip/tooltip';
import { Input } from '@/components/arc/input/input';
import { Brand, DemoSwitch, Thumb } from './ui.jsx';
import {
  FOLDERS, LIBRARY_FOLDERS, MACHINES, MATERIALS, SUPPORT_PRESETS,
  folderName, machineById, materialById, relativeTime,
} from './data.js';

const SECTIONS = [
  { id: 'projects', label: '工程', icon: FolderKanban },
  { id: 'parts', label: '零件库', icon: Boxes },
  { id: 'profiles', label: '机器与材料', icon: Printer },
];

const foldersFor = section => (section === 'parts' ? LIBRARY_FOLDERS : FOLDERS);
const countsFor = (ctx, section) => (section === 'parts' ? ctx.partCounts : ctx.projectCounts);

function RailButton({ active, icon: Icon, label, onClick }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={'arcRailBtn' + (active ? ' is-on' : '')}
      aria-pressed={active}
      onClick={onClick}
    >
      <Icon size={17} strokeWidth={1.7} />
      <span className="arcRailLabel">{label}</span>
    </Button>
  );
}

function FolderSegments({ ctx }) {
  const folders = foldersFor(ctx.section);
  const counts = countsFor(ctx, ctx.section);
  const options = folders.map(f => ({
    value: f.id,
    label: f.name,
    accessory: counts?.[f.id] != null ? <span className="arcSegCount">{counts[f.id]}</span> : null,
  }));
  return <SegmentedControl options={options} value={ctx.folder} onValueChange={ctx.setFolder} label="文件夹" className="arcFolderSeg" />;
}

function ViewSegments({ ctx }) {
  return (
    <SegmentedControl
      options={[
        { value: 'list', label: <span className="arcViewSeg"><Rows3 size={13} />列表</span> },
        { value: 'grid', label: <span className="arcViewSeg"><Grid2X2 size={13} />网格</span> },
      ]}
      value={ctx.view}
      onValueChange={ctx.setView}
      label="视图"
      className="arcViewSegControl"
    />
  );
}

function StatusBadge({ item, part = false }) {
  if (part) return <Badge tone="neutral" size="sm">{folderName(item.folder, LIBRARY_FOLDERS)}</Badge>;
  return <Badge tone={item.status === 'sliced' ? 'success' : 'neutral'} size="sm">{item.status === 'sliced' ? '已切片' : '待打印'}</Badge>;
}

function ProjectRow({ item, ctx }) {
  const machine = machineById(item.machineId);
  const material = materialById(item.materialId);
  return (
    <div
      className={'arcRow' + (ctx.selectedId === item.id ? ' is-on' : '')}
      role="button"
      tabIndex={0}
      onClick={() => ctx.setSelectedId(item.id)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.setSelectedId(item.id); } }}
    >
      <Thumb url={ctx.thumbs[item.keys.join('+')] || ctx.thumbs[item.keys[0]]} className="arcRowThumb" />
      <div className="arcRowMain">
        <b>{item.name}</b>
        <span>{folderName(item.folder)} · {item.parts} 件 · {item.faces.toLocaleString()} 面</span>
      </div>
      <div className="arcRowStack">
        <b>{machine.model}</b>
        <span>{material.name} · {item.layerUm} µm</span>
      </div>
      <div className="arcRowStat">
        <StatusBadge item={item} />
        <span><Layers3 size={11} />{item.supports} 支撑</span>
      </div>
      <span className="arcRowTime"><Clock3 size={11} />{relativeTime(item.updatedAt)}</span>
      <span className="arcRowActions">
        {item.starred ? <Star size={13} fill="currentColor" className="ldStarOn" /> : null}
        <Button variant="ghost" size="sm" className="arcRowMore" aria-label={`${item.name} 更多操作`} onClick={e => { e.stopPropagation(); ctx.onAction('copy', item); }}>
          <MoreHorizontal size={15} />
        </Button>
      </span>
    </div>
  );
}

function PartRow({ item, ctx }) {
  return (
    <div
      className={'arcRow arcRow--part' + (ctx.selectedId === item.id ? ' is-on' : '')}
      role="button"
      tabIndex={0}
      onClick={() => ctx.setSelectedId(item.id)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.setSelectedId(item.id); } }}
    >
      <Thumb url={ctx.thumbs[item.key]} className="arcRowThumb" />
      <div className="arcRowMain">
        <b>{item.name}</b>
        <span>{folderName(item.folder, LIBRARY_FOLDERS)} · {item.size.x} × {item.size.z} × {item.size.y} mm</span>
      </div>
      <div className="arcRowTags">
        {item.tags.map(t => <Badge key={t} tone="neutral" size="sm">{t}</Badge>)}
      </div>
      <div className="arcRowStack">
        <b>{item.faces.toLocaleString()} 面</b>
        <span>用于 {item.used} 个工程</span>
      </div>
      <span className="arcRowTime"><Clock3 size={11} />{relativeTime(item.updatedAt)}</span>
      <span className="arcRowActions">
        {item.fav ? <Star size={13} fill="currentColor" className="ldStarOn" /> : null}
        <Button variant="ghost" size="sm" className="arcRowMore" aria-label={`${item.name} 插入`} onClick={e => { e.stopPropagation(); ctx.onAction('insert', item); }}>
          <Plus size={15} />
        </Button>
      </span>
    </div>
  );
}

function ProjectGridCard({ item, ctx }) {
  const machine = machineById(item.machineId);
  const material = materialById(item.materialId);
  return (
    <Card
      className="arcGridCard"
      media={<Thumb url={ctx.thumbs[item.keys.join('+')] || ctx.thumbs[item.keys[0]]} className="arcCardThumb" />}
      title={item.name}
      description={`${machine.brand} ${machine.model} · ${material.name}`}
      meta={<StatusBadge item={item} />}
      status={`${item.supports} 支撑 · ${relativeTime(item.updatedAt)}`}
      onOpenChange={open => { if (open) ctx.setSelectedId(item.id); }}
      details={<div className="arcQuickDetails">
        <div><span>层厚</span><b>{item.layerUm} µm</b></div>
        <div><span>零件</span><b>{item.parts} 件</b></div>
        <div><span>面数</span><b>{item.faces.toLocaleString()}</b></div>
        <div><span>尺寸</span><b>{item.size.x} × {item.size.z} × {item.size.y} mm</b></div>
      </div>}
      action={<Button variant="secondary" size="sm" onClick={() => ctx.onAction('open', item)}>打开 <ChevronRight size={13} /></Button>}
    />
  );
}

function PartGridCard({ item, ctx }) {
  return (
    <Card
      className="arcGridCard"
      media={<Thumb url={ctx.thumbs[item.key]} className="arcCardThumb" />}
      title={item.name}
      description={`${item.size.x} × ${item.size.z} × ${item.size.y} mm · ${item.faces.toLocaleString()} 面`}
      meta={<Badge tone="neutral" size="sm">{folderName(item.folder, LIBRARY_FOLDERS)}</Badge>}
      status={`${item.used} 个工程使用 · ${relativeTime(item.updatedAt)}`}
      onOpenChange={open => { if (open) ctx.setSelectedId(item.id); }}
      details={<div className="arcQuickDetails">
        <div><span>标签</span><b>{item.tags.join(' / ')}</b></div>
        <div><span>面数</span><b>{item.faces.toLocaleString()}</b></div>
        <div><span>导入</span><b>{relativeTime(item.createdAt)}</b></div>
        <div><span>备注</span><b>{item.note || '—'}</b></div>
      </div>}
      action={<Button variant="secondary" size="sm" onClick={() => ctx.onAction('insert', item)}>插入 <Plus size={13} /></Button>}
    />
  );
}

function ProfileCard({ item, kind, ctx }) {
  const selected = kind === 'machine' ? ctx.machineId === item.id : ctx.materialId === item.id;
  const isMachine = kind === 'machine';
  const title = isMachine ? `${item.brand} ${item.model}` : item.name;
  const description = isMachine
    ? `${item.plateX} × ${item.plateZ} × ${item.plateY} mm · ${item.pixelUm} µm`
    : item.note;
  const meta = isMachine
    ? <><Badge tone="neutral" size="sm">{item.type}</Badge><Badge tone="neutral" size="sm">{item.film}</Badge></>
    : <Badge tone="neutral" size="sm">{item.family}</Badge>;
  const status = isMachine
    ? `${item.resolution} · ${item.lightNm} nm`
    : `${item.layers.join('/')}µm · ¥${item.cost}/kg`;
  return (
    <div className={'arcProfileWrap' + (selected ? ' is-on' : '')}
      role="button" tabIndex={0}
      onClick={() => {
        if (isMachine) { ctx.setProfileTab('machine'); ctx.setMachineId(item.id); }
        else { ctx.setProfileTab('material'); ctx.setMaterialId(item.id); }
      }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') e.currentTarget.click(); }}
    >
      <Card
        className="arcProfileCard"
        media={isMachine
          ? <div className="arcProfileGlyph"><Printer size={36} strokeWidth={1.25} /></div>
          : <div className="arcProfileSwatch"><span style={{ background: item.color }} /></div>}
        title={title}
        description={description}
        meta={meta}
        status={status}
        action={<Button variant="secondary" size="sm" onClick={e => {
          e.stopPropagation();
          if (isMachine) { ctx.setProfileTab('machine'); ctx.setMachineId(item.id); }
          else { ctx.setProfileTab('material'); ctx.setMaterialId(item.id); }
        }}>{selected ? '当前' : '设为当前'}</Button>}
      />
    </div>
  );
}

function InspectorC({ ctx, item, kind }) {
  if (!item) {
    return (
      <EmptyState
        className="arcInspectorEmpty"
        title="选择一个项目查看详情"
        description="工程、零件与机型信息会显示在这里。"
        icon={<MousePointer2 size={24} strokeWidth={1.5} />}
      />
    );
  }

  if (kind === 'project') {
    const machine = machineById(item.machineId);
    const material = materialById(item.materialId);
    return (
      <Card
        className="arcDetailCard"
        media={<Thumb url={ctx.thumbs[item.keys.join('+')] || ctx.thumbs[item.keys[0]]} className="arcDetailThumb" />}
        title={item.name}
        description={`${machine.brand} ${machine.model} · ${material.name}`}
        meta={<StatusBadge item={item} />}
        status={`更新于 ${relativeTime(item.updatedAt)}`}
        action={<Button variant="primary" size="sm" onClick={() => ctx.onAction('open', item)}>打开工程 <ChevronRight size={13} /></Button>}
      >
        <div className="arcDetailRows">
          <div><span>层厚</span><b>{item.layerUm} µm</b></div>
          <div><span>零件</span><b>{item.parts} 件</b></div>
          <div><span>支撑</span><b>{item.supports} 个点</b></div>
          <div><span>面数</span><b>{item.faces.toLocaleString()}</b></div>
          <div><span>尺寸</span><b>{item.size.x} × {item.size.z} × {item.size.y} mm</b></div>
        </div>
        <div className="arcDetailActions">
          <Button variant="secondary" size="sm" onClick={() => ctx.onAction('copy', item)}>复制工程</Button>
          <Button variant="ghost" size="sm" onClick={() => ctx.onAction('export', item)}>导出 .rfproj</Button>
        </div>
      </Card>
    );
  }

  if (kind === 'part') {
    return (
      <Card
        className="arcDetailCard"
        media={<Thumb url={ctx.thumbs[item.key]} className="arcDetailThumb" />}
        title={item.name}
        description={`${folderName(item.folder, LIBRARY_FOLDERS)} · ${item.tags.join(' / ')}`}
        meta={<Badge tone="neutral" size="sm">{item.tags[0]}</Badge>}
        status={`用于 ${item.used} 个工程 · ${relativeTime(item.updatedAt)}`}
        action={<Button variant="primary" size="sm" onClick={() => ctx.onAction('insert', item)}><Plus size={13} />插入当前工程</Button>}
      >
        <div className="arcDetailRows">
          <div><span>尺寸</span><b>{item.size.x} × {item.size.z} × {item.size.y} mm</b></div>
          <div><span>面数</span><b>{item.faces.toLocaleString()}</b></div>
          <div><span>导入</span><b>{relativeTime(item.createdAt)}</b></div>
        </div>
        {item.note ? <p className="arcDetailNote">{item.note}</p> : null}
        <div className="arcDetailActions">
          <Button variant="secondary" size="sm" onClick={() => ctx.onAction('exportPart', item)}>导出原文件</Button>
          <Button variant="ghost" size="sm" onClick={() => ctx.onAction('renamePart', item)}>编辑标签</Button>
        </div>
      </Card>
    );
  }

  const isMachine = kind === 'machine';
  const preset = isMachine ? null : SUPPORT_PRESETS.find(p => p.id === item.preset);
  return (
    <Card
      className="arcDetailCard"
      media={isMachine
        ? <div className="arcProfileGlyph arcProfileGlyph--large"><Printer size={54} strokeWidth={1.1} /></div>
        : <div className="arcProfileSwatch arcProfileSwatch--large"><span style={{ background: item.color }} /></div>}
      title={isMachine ? `${item.brand} ${item.model}` : item.name}
      description={isMachine ? `${item.plateX} × ${item.plateZ} × ${item.plateY} mm · ${item.pixelUm} µm` : item.note}
      meta={isMachine ? <Badge tone="neutral" size="sm">{item.type}</Badge> : <Badge tone="neutral" size="sm">{item.family}</Badge>}
      status={isMachine ? `${item.resolution} · ${item.lightNm} nm` : `¥${item.cost}/kg · ${item.density} g/cm³`}
      action={<Button variant="primary" size="sm" onClick={() => ctx.setSection('projects')}>用于新建工程</Button>}
    >
      <div className="arcDetailRows">
        {isMachine ? (
          <>
            <div><span>成型尺寸</span><b>{item.plateX} × {item.plateZ} × {item.plateY} mm</b></div>
            <div><span>XY 像素</span><b>{item.pixelUm} µm</b></div>
            <div><span>离型膜</span><b>{item.film}</b></div>
          </>
        ) : (
          <>
            <div><span>层厚</span><b>{item.layers.map(u => `${u}µm`).join(' / ')}</b></div>
            <div><span>默认支撑</span><b>{preset ? `${preset.name} · 主干 ${preset.diameter}mm` : '—'}</b></div>
            <div><span>密度</span><b>{item.density} g/cm³</b></div>
          </>
        )}
      </div>
      <p className="arcDetailNote">{isMachine ? '机器档案只影响板面、像素与越界检查，不要求设备在线。' : '材料档案决定默认层厚与支撑预设；工程会保存快照。'}</p>
    </Card>
  );
}

export function CandidateCArc({ ctx }) {
  const q = (ctx.query || '').trim().toLowerCase();
  const machines = q ? MACHINES.filter(m => `${m.brand} ${m.model} ${m.type} ${m.resolution}`.toLowerCase().includes(q)) : MACHINES;
  const materials = q ? MATERIALS.filter(m => `${m.name} ${m.family} ${m.note}`.toLowerCase().includes(q)) : MATERIALS;
  const title = ctx.section === 'projects'
    ? (ctx.folder === 'all' ? '全部工程' : folderName(ctx.folder))
    : ctx.section === 'parts'
      ? (ctx.folder === 'all' ? '零件库' : folderName(ctx.folder, LIBRARY_FOLDERS))
      : '机器与材料';
  const subtitle = ctx.section === 'projects'
    ? `${ctx.projectList.length} 个工程 · ${ctx.projects.filter(p => p.starred).length} 个星标`
    : ctx.section === 'parts'
      ? `${ctx.partList.length} 个零件 · 共 ${ctx.parts.length} 个`
      : `${machines.length} 台机器 · ${materials.length} 种材料`;
  const selected = ctx.section === 'projects' ? ctx.selectedProject
    : ctx.section === 'parts' ? ctx.selectedPart
      : ctx.profileTab === 'machine' ? ctx.selectedMachine : ctx.selectedMaterial;
  const kind = ctx.section === 'projects' ? 'project' : ctx.section === 'parts' ? 'part' : ctx.profileTab;
  const isProfiles = ctx.section === 'profiles';

  return (
    <div className="ldPage arcC">
      <aside className="arcRail">
        <span className="arcRailBrand"><Brand small /></span>
        <div className="arcRailNav">
          {SECTIONS.map(s => {
            const Icon = s.icon;
            return <RailButton key={s.id} active={ctx.section === s.id} icon={Icon} label={s.label} onClick={() => ctx.setSection(s.id)} />;
          })}
        </div>
        <div className="arcRailFoot">
          <Tooltip content="资源库设置" side="right">
            <Button variant="ghost" size="sm" className="arcRailSettings" aria-label="资源库设置"><Settings2 size={17} strokeWidth={1.7} /></Button>
          </Tooltip>
          <Progress className="arcRailProgress" value={62} label="本地库" showValue />
        </div>
      </aside>

      <section className="arcShell">
        <header className="arcTop">
          <div className="arcTopTitle">
            <span className="arcKicker">资源库 / {ctx.section === 'projects' ? '工程' : ctx.section === 'parts' ? '零件' : '档案'}</span>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <div className="arcTopActions">
            <div className="arcSearch">
              <Input label="搜索" placeholder="搜索工程、零件、机器…" value={ctx.query} onChange={e => ctx.setQuery(e.target.value)} />
            </div>
            <Button variant="primary" size="md" onClick={ctx.onNew}><Plus size={15} />新建工程</Button>
            <DemoSwitch value={ctx.candidate} onChange={ctx.setCandidate} />
          </div>
        </header>

        <div className="arcToolbar">
          {isProfiles ? (
            <SegmentedControl
              options={[{ value: 'machine', label: '机器' }, { value: 'material', label: '材料' }]}
              value={ctx.profileTab}
              onValueChange={ctx.setProfileTab}
              label="档案类型"
            />
          ) : <FolderSegments ctx={ctx} />}
          <div className="arcToolbarRight">
            <span className="arcCount">{isProfiles ? `${MACHINES.length + MATERIALS.length} 项档案` : `${ctx.section === 'projects' ? ctx.projectList.length : ctx.partList.length} 项`}</span>
            {!isProfiles ? <ViewSegments ctx={ctx} /> : null}
          </div>
        </div>

        <div className="arcBody">
          <ScrollArea className="arcListWrap" fade={24}>
            {ctx.section === 'projects' ? (
              ctx.projectList.length ? (
                ctx.view === 'grid' ? (
                  <div className="arcGrid">
                    {ctx.projectList.map(p => <ProjectGridCard key={p.id} item={p} ctx={ctx} />)}
                  </div>
                ) : (
                  <div className="arcRows">
                    {ctx.projectList.map(p => <ProjectRow key={p.id} item={p} ctx={ctx} />)}
                  </div>
                )
              ) : <EmptyState title="没有匹配的工程" description="换个关键词或文件夹试试。" icon={<Folder size={24} strokeWidth={1.5} />} />
            ) : null}

            {ctx.section === 'parts' ? (
              ctx.partList.length ? (
                ctx.view === 'grid' ? (
                  <div className="arcGrid">
                    {ctx.partList.map(p => <PartGridCard key={p.id} item={p} ctx={ctx} />)}
                  </div>
                ) : (
                  <div className="arcRows">
                    {ctx.partList.map(p => <PartRow key={p.id} item={p} ctx={ctx} />)}
                  </div>
                )
              ) : <EmptyState title="没有匹配的零件" description="换个关键词或文件夹试试。" icon={<Boxes size={24} strokeWidth={1.5} />} />
            ) : null}

            {ctx.section === 'profiles' ? (
              <div className="arcProfiles">
                {ctx.profileTab === 'machine' ? (
                  machines.length ? (
                    <div className="arcGrid arcGrid--profiles">
                      {machines.map(m => <ProfileCard key={m.id} item={m} kind="machine" ctx={ctx} />)}
                    </div>
                  ) : <EmptyState title="没有匹配的机器" description="换个关键词试试。" icon={<Printer size={24} strokeWidth={1.5} />} />
                ) : (
                  materials.length ? (
                    <div className="arcGrid arcGrid--profiles">
                      {materials.map(m => <ProfileCard key={m.id} item={m} kind="material" ctx={ctx} />)}
                    </div>
                  ) : <EmptyState title="没有匹配的材料" description="换个关键词试试。" icon={<PackageOpen size={24} strokeWidth={1.5} />} />
                )}
              </div>
            ) : null}
          </ScrollArea>

          <aside className="arcInspector">
            <ScrollArea className="arcInspectorScroll" fade={20}>
              <div className="arcInspectorInner">
                <InspectorC ctx={ctx} item={selected} kind={kind} />
              </div>
            </ScrollArea>
          </aside>
        </div>
      </section>
    </div>
  );
}
