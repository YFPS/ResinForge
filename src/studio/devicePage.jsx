/* 机型 / 材料 / 层厚的选择页，两个入口共用：
   侧栏「新建项目」（mode='create'）选完按「创建项目」，建一个空工程进编辑；
   顶栏机型按钮（mode='device'）选完按「应用」，只把配置写到当前这一盘。
   这一页固定浅色，产品图本身是白底，深色主题里也能看清瓶子和机器。 */
import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, Printer, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/arc/popover/popover';
import { params, toast } from '../store.js';
import { setParam } from '../demo/bridge.js';
import {
  BUILTIN_MACHINES, CUSTOM_ID, currentMachine, deleteMachine, machineLabel,
  saveCustomMachine, selectMachine, setMachineParam, useMachine,
} from '../demo/machines.js';
import {
  RESINS, readLastDevice, readResinId, resinLabel, writeLastDevice, writeResinId,
} from '../demo/resins.js';
import { openBlankProject } from './desk.jsx';

const LAYERS = [0.05, 0.1];

function num(n) {
  const v = Math.round(Number(n) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/* 层厚要留到 0.05。用上面的一位小数会把 0.05 收成 0.1，下拉里两条看起来一样。 */
function layerMm(h) {
  const v = Math.round(Number(h) * 100) / 100;
  return Number.isFinite(v) ? String(v) : '';
}

/* 层厚不用原生 select：弹出层跟这一页的白底工具条同一套，不露出系统菜单。 */
function LayerPick({ value, choices, onChange }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="stuDevLayer" aria-label="层厚">
        <span>{layerMm(value)} mm</span>
        <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="stuDevMenu" align="start" sideOffset={6}>
        {choices.map(h => {
          const on = Number(h) === Number(value);
          return (
            <button
              key={h}
              type="button"
              className={on ? 'on' : undefined}
              aria-current={on ? 'true' : undefined}
              onClick={() => { onChange(Number(h)); setOpen(false); }}
            >
              <span>{layerMm(h)} mm</span>
              {on ? <Check size={14} strokeWidth={1.75} aria-hidden="true" /> : <span />}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

function specOf(m) {
  return `${num(m.plateX)} × ${num(m.plateZ)} × ${num(m.plateY)} mm / ±${num(m.pixelUm)} µm`;
}

function Shot({ folder, id, kind }) {
  const [step, setStep] = useState(0);
  const exts = ['png', 'webp', 'jpg'];
  if (!id || step >= exts.length) {
    return (
      <span className="stuDevPhoto stuDevPhoto--empty" aria-hidden="true">
        <Printer size={26} strokeWidth={1.5} />
      </span>
    );
  }
  return (
    <span className={'stuDevPhoto' + (kind === 'resin' ? ' stuDevPhoto--resin' : '')}>
      <img src={`/catalog/${folder}/${id}.${exts[step]}`} alt="" onError={() => setStep(n => n + 1)} />
    </span>
  );
}

function PickCard({ on, title, sub, folder, id, kind, onPick }) {
  return (
    <button type="button" className={'stuDevCard' + (on ? ' on' : '')} aria-pressed={on} onClick={onPick}>
      <Shot folder={folder} id={id} kind={kind} />
      <span className="stuDevCopy">
        <span className="stuDevName">{title}</span>
        <span className="stuDevSub">{sub}</span>
      </span>
      {on ? (
        <span className="stuDevCheck" aria-hidden="true">
          <Check size={12} strokeWidth={3} />
        </span>
      ) : null}
    </button>
  );
}

export default function DevicePage({ mode = 'device', onClose }) {
  const creating = mode === 'create';
  const machine = useMachine();
  const current = currentMachine(machine);
  const [machineId, setMachineId] = useState(current ? current.id : CUSTOM_ID);
  const [dims, setDims] = useState({
    plateX: machine.plateX,
    plateY: machine.plateY,
    plateZ: machine.plateZ,
    pixelUm: machine.pixelUm,
  });
  const [resinId, setResinId] = useState(readResinId);
  const [layerH, setLayerH] = useState(() => {
    const h = Number(params.layerH);
    return LAYERS.includes(h) ? h : h;
  });
  const [saveName, setSaveName] = useState('');
  const [busy, setBusy] = useState(false);
  const [last] = useState(readLastDevice);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const all = [...BUILTIN_MACHINES, ...machine.saved];
  const picked = all.find(m => m.id === machineId) || null;
  const custom = !picked;
  const resin = RESINS.find(r => r.id === resinId) || null;
  const savedOne = custom ? null : machine.saved.find(m => m.id === machineId) || null;
  const layerChoices = LAYERS.includes(Number(layerH)) ? LAYERS : [Number(layerH), ...LAYERS];

  const pickMachine = (id) => {
    if (id === CUSTOM_ID) {
      const prev = all.find(m => m.id === machineId);
      if (prev) {
        setDims({ plateX: prev.plateX, plateY: prev.plateY, plateZ: prev.plateZ, pixelUm: prev.pixelUm });
      }
    }
    setMachineId(id);
  };

  const setDim = (key, raw) => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    setDims(d => ({ ...d, [key]: v }));
  };

  const useLast = () => {
    if (!last) return;
    const hit = all.find(m => m.id === last.machineId);
    setMachineId(hit ? hit.id : CUSTOM_ID);
    if (Number.isFinite(last.plateX)) {
      setDims({
        plateX: last.plateX,
        plateY: last.plateY,
        plateZ: last.plateZ,
        pixelUm: last.pixelUm,
      });
    }
    setResinId(RESINS.some(r => r.id === last.resinId) ? last.resinId : null);
    if (Number.isFinite(last.layerH)) setLayerH(last.layerH);
  };

  /* 把选中的机型 / 材料 / 层厚写进参数并记成「上一次配置」 */
  const commit = () => {
    if (picked) selectMachine(picked.id);
    else {
      setMachineParam('plateX', dims.plateX);
      setMachineParam('plateZ', dims.plateZ);
      setMachineParam('plateY', dims.plateY);
      setMachineParam('pixelUm', dims.pixelUm);
      selectMachine(CUSTOM_ID);
    }
    writeResinId(resin ? resin.id : null);
    setParam('layerH', Number(layerH));
    const live = picked || { id: CUSTOM_ID, ...dims };
    writeLastDevice({
      machineId: live.id,
      plateX: live.plateX,
      plateY: live.plateY,
      plateZ: live.plateZ,
      pixelUm: live.pixelUm,
      resinId: resin ? resin.id : null,
      layerH: Number(layerH),
    });
  };

  const apply = () => {
    commit();
    toast(picked ? `已换上 ${machineLabel(picked)}` : '已换上自定义机型');
    onClose();
  };

  /* 新建项目：带上这套配置建一个空工程，回到编辑。当前这一盘会先自动存进工程；
     建好再关页面，避免先露出旧板面又被清空。 */
  const create = async () => {
    if (busy) return;
    setBusy(true);
    commit();
    try {
      await openBlankProject();
      toast('已新建项目，可以导入模型了');
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const commitSave = () => {
    const name = saveName.trim();
    if (!name) return;
    setMachineParam('plateX', dims.plateX);
    setMachineParam('plateZ', dims.plateZ);
    setMachineParam('plateY', dims.plateY);
    setMachineParam('pixelUm', dims.pixelUm);
    const entry = saveCustomMachine(name);
    setMachineId(entry.id);
    setSaveName('');
  };

  return (
    <section className="stuDevice" aria-label={creating ? '新建项目' : '设备与材料'}>
      <div className="stuDeviceMain">
        <div className="stuDevBar">
          <h2 className="stuDevSec">请选择设备型号</h2>
          <div className="stuDevTools">
            <div className="stuDevInline">
              <span>层厚</span>
              <LayerPick value={layerH} choices={layerChoices} onChange={setLayerH} />
            </div>
            <button type="button" className="stuDevLast" disabled={!last} onClick={useLast}>使用上一次配置</button>
            <button type="button" className="stuDevApply" disabled={creating && busy} onClick={creating ? create : apply}>
              {creating ? '创建项目' : '应用'}
            </button>
            <button type="button" className="stuDevClose" aria-label="关闭" onClick={onClose}>
              <X size={16} strokeWidth={1.75} />
            </button>
          </div>
        </div>
        <div className="stuDevGrid">
          {BUILTIN_MACHINES.map(m => (
            <PickCard
              key={m.id}
              on={machineId === m.id}
              title={machineLabel(m)}
              sub={specOf(m)}
              folder="machines"
              id={m.id}
              onPick={() => pickMachine(m.id)}
            />
          ))}
          {machine.saved.map(m => (
            <PickCard
              key={m.id}
              on={machineId === m.id}
              title={machineLabel(m)}
              sub={specOf(m)}
              onPick={() => pickMachine(m.id)}
            />
          ))}
          <PickCard
            on={custom}
            title="自定义"
            sub="手填板面与像素"
            onPick={() => pickMachine(CUSTOM_ID)}
          />
        </div>

        {custom ? (
          <div className="stuDevCustom">
            <label className="stuDevNum">板面 X
              <input type="number" min="50" max="400" step="0.1" value={dims.plateX} onChange={e => setDim('plateX', e.target.value)} />
              <span>mm</span>
            </label>
            <label className="stuDevNum">板面 Y
              <input type="number" min="50" max="400" step="0.1" value={dims.plateZ} onChange={e => setDim('plateZ', e.target.value)} />
              <span>mm</span>
            </label>
            <label className="stuDevNum">高度 Z
              <input type="number" min="30" max="400" step="0.1" value={dims.plateY} onChange={e => setDim('plateY', e.target.value)} />
              <span>mm</span>
            </label>
            <label className="stuDevNum">XY 像素
              <input type="number" min="10" max="100" step="0.1" value={dims.pixelUm} onChange={e => setDim('pixelUm', e.target.value)} />
              <span>µm</span>
            </label>
            <div className="stuDevSave">
              <input
                placeholder="如：车间 3 号机"
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') commitSave(); }}
              />
              <button type="button" disabled={!saveName.trim()} onClick={commitSave}>保存为机型</button>
            </div>
          </div>
        ) : null}

        {savedOne ? (
          <div className="stuDevCustom">
            <button type="button" className="stuDevDanger" onClick={() => { deleteMachine(savedOne.id); setMachineId(CUSTOM_ID); }}>
              删除这个机型
            </button>
          </div>
        ) : null}

        <h2 className="stuDevSec">请选择材料</h2>
        <div className="stuDevGrid">
          {RESINS.map(r => (
            <PickCard
              key={r.id}
              kind="resin"
              on={resinId === r.id}
              title={resinLabel(r)}
              sub={r.kind}
              folder="resins"
              id={r.id}
              onPick={() => setResinId(resinId === r.id ? null : r.id)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
