"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { animate, AnimatePresence, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from "motion/react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./dock.module.css";

export interface DockItem {
  id: string;
  label: string;
  icon: ReactNode;
  /** 只显示，不负责监听按键 */
  shortcut?: string;
  /** 角标。变成 0 时退场 */
  badge?: number;
  /** 有成员时这一格变成分组，托盘从坞里长出来 */
  items?: DockItem[];
  /**
   * 分组当前采用的成员。设置后，格子图标和托盘里的选中跟它走，不占用工具栏的 value。
   * 用来放「显示方式」这种和当前工具并存的分组。
   */
  active?: string;
}

export interface DockProps {
  items: DockItem[];
  value?: string | null;
  onValueChange?: (id: string) => void;
  /** 传入后才允许拖动排序，以及 Alt 加左右方向键 */
  onItemsChange?: (items: DockItem[], change: { type: "move"; id: string; index: number }) => void;
  /** 自己展开面板、不走托盘的那一格（如简化）。展开期间保持选中底色。 */
  expandedId?: string | null;
  /** 上面的设置条打开时，把已经长出来的二级托盘立刻收掉 */
  trayClosed?: boolean;
  /** Tab 落在分组上时，直接把这一组的二级菜单展开 */
  revealTray?: string | null;
  /** 托盘打开或收起。打开时 id 为分组，收起时为 null。 */
  onOpenChange?: (id: string | null) => void;
  /** 排在最后一位、不进工具循环的内容（如「下一步」），跟着坞一起被同一条轮廓兜住 */
  trailing?: ReactNode;
  label?: string;
  className?: string;
}

const { spring, duration, blur } = motionTokens;
/** 按下略缩，松开带回弹。官方说明是快弹簧、松手带一点过冲。 */
const pressSpring = { type: "spring" as const, visualDuration: 0.22, bounce: 0.28 };

/** 坞和托盘合成一条轮廓：接口处用内凹圆角，看起来是从栏里长出来的一块。 */
function dockOutline(bar, tray) {
  const n = v => (Math.round(v * 100) / 100);
  const R = Math.min(18, bar.h / 2 - 1, bar.w / 2 - 1);
  const left = bar.x, right = bar.x + bar.w, top = bar.y, bot = bar.y + bar.h;
  /* 外圆角顺时针（sweep 1）。托盘和栏相接是凹角，要反方向绕，弧才贴着拐角向内收；顺时针会鼓出一块耳朵。 */
  const corner = (r, x, y, sweep = 1) => `A ${n(r)} ${n(r)} 0 0 ${sweep} ${n(x)} ${n(y)}`;
  const plain = () => `M ${n(left + R)} ${n(top)} H ${n(right - R)} ${corner(R, right, top + R)} V ${n(bot - R)} ${corner(R, right - R, bot)} H ${n(left + R)} ${corner(R, left, bot - R)} V ${n(top + R)} ${corner(R, left + R, top)} Z`;
  if (!tray) return plain();
  const gapL = tray.x - (left + R);
  const gapR = (right - R) - (tray.x + tray.w);
  const rise = top - tray.y;
  /* 内凹圆角 F 和托盘顶圆角 Rt 必须一起放进探出的高度里。
     探出不够时按比例缩小；硬保一个最小半径会让竖边折回去，轮廓打结。 */
  let F = Math.min(14, gapL, gapR);
  let Rt = Math.min(16, tray.w / 2 - 1, tray.h / 2);
  if (!(rise > 2) || !(F > 1) || !(Rt > 1)) return plain();
  if (F + Rt > rise) {
    const s = rise / (F + Rt);
    F *= s;
    Rt *= s;
  }
  const tx = tray.x, tw = tray.w, ty = tray.y;
  return [
    `M ${n(left + R)} ${n(top)}`,
    `H ${n(tx - F)}`,
    corner(F, tx, top - F, 0),
    `V ${n(ty + Rt)}`,
    corner(Rt, tx + Rt, ty),
    `H ${n(tx + tw - Rt)}`,
    corner(Rt, tx + tw, ty + Rt),
    `V ${n(top - F)}`,
    corner(F, tx + tw + F, top, 0),
    `H ${n(right - R)}`,
    corner(R, right, top + R),
    `V ${n(bot - R)}`,
    corner(R, right - R, bot),
    `H ${n(left + R)}`,
    corner(R, left, bot - R),
    `V ${n(top + R)}`,
    corner(R, left + R, top),
    "Z",
  ].join(" ");
}

/* 成员跟着托盘长出来：托盘还矮时先别露图标，不然会被上沿切成一半。收起时透明度先掉，形状再缩回去。 */
function TrayMember({
  member, index, grow, reduced, selected, tabIndex, slotRef, onActivate, onKeyDown, onTip,
}: {
  member: DockItem;
  index: number;
  grow: ReturnType<typeof useMotionValue<number>>;
  reduced: boolean;
  selected: boolean;
  tabIndex: number;
  slotRef: (node: HTMLDivElement | null) => void;
  onActivate: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** 悬停或键盘焦点时显示这一格的名字，离开后收起 */
  onTip: (show: boolean, immediate: boolean) => void;
}) {
  /* 托盘差不多长够一格图标之后再依次淡入，避免长到一半时图标被上沿切掉 */
  const start = Math.min(0.9, 0.78 + index * 0.05);
  const end = Math.min(1, start + 0.14);
  const reveal = useTransform(grow, [start, end], [0, 1]);
  const rise = useTransform(grow, [start, end], [8, 0]);
  return <motion.div ref={slotRef} className={styles.slot} style={reduced ? undefined : { opacity: reveal, y: rise }}>
    {selected && <span className={styles.selection} />}
    <motion.button
      type="button"
      className={styles.item}
      aria-label={nameOf(member)}
      aria-pressed={selected}
      data-chosen={selected ? "" : undefined}
      tabIndex={tabIndex}
      whileTap={reduced ? undefined : { scale: 0.9 }}
      transition={reduced ? { duration: 0 } : pressSpring}
      onClick={onActivate}
      onKeyDown={onKeyDown}
      onPointerEnter={event => {
        if (event.pointerType === "touch") return;
        onTip(true, false);
      }}
      onPointerLeave={() => onTip(false, false)}
      onFocus={() => onTip(true, true)}
      onBlur={() => onTip(false, false)}
    >
      <span className={styles.icon}>{member.icon}</span>
    </motion.button>
  </motion.div>;
}

/* 分组名和当前这一项一样时不再重复，例如「手动支撑：手动支撑」。 */
function groupTip(item: DockItem, shown?: DockItem) {
  if (!item.items || !shown) return item.label;
  if (shown.label === item.label) return shown.label;
  return `${item.label}：${shown.label}`;
}

function nameOf(item: DockItem, shown?: DockItem) {
  const target = item.items ? shown : item;
  const title = item.items && shown
    ? (shown.label === item.label ? shown.label : `${item.label}: ${shown.label}`)
    : item.label;
  const parts = [title];
  if (target?.shortcut) parts.push(target.shortcut);
  if (item.badge) parts.push(String(item.badge));
  return parts.filter(Boolean).join(", ");
}

/**
 * 浮动工具坞。按 Arc Dock 的公开说明复刻（官方源码属 Pro，这里用同一套 token 实现）：
 * 标签在格子之间滑过去，选中底色用弹簧跟上，分组的托盘从坞的上沿长出来。
 * 底色同一时间只在一格上：展开托盘或面板时滑到那一格，收起后回到当前工具。
 */
export function Dock({ items, value = null, onValueChange, onItemsChange, expandedId = null, onOpenChange, trayClosed = false, revealTray = null, trailing, label = "工具", className }: DockProps) {
  const reduced = useReducedMotion() ?? false;
  const reactId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const slotRefs = useRef(new Map<string, HTMLDivElement>());
  const [focusId, setFocusId] = useState(items[0]?.id ?? "");
  const [openId, setOpenId] = useState<string | null>(null);
  const [tip, setTip] = useState<{ text: string; shortcut?: string; x: number } | null>(null);
  const trayRef = useRef<HTMLDivElement>(null);
  const plateRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const [trayX, setTrayX] = useState(0);
  /* 收起动画期间托盘还要留着，等轮廓缩回栏里再卸 */
  const [heldId, setHeldId] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [liftId, setLiftId] = useState<string | null>(null);
  const grow = useMotionValue(0);
  const warm = useRef(false);
  const tipTimer = useRef<number | undefined>(undefined);
  const drag = useRef<{ id: string; x: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const openIdRef = useRef(openId);
  const onOpenChangeRef = useRef(onOpenChange);
  const paintRef = useRef<(v: number) => void>(() => {});
  const geo = useRef<{ bar: { x: number; y: number; w: number; h: number }; tray: { x: number; y: number; w: number; h: number } | null } | null>(null);
  openIdRef.current = openId;
  onOpenChangeRef.current = onOpenChange;

  const flat = items;
  const groupOf = (id: string) => flat.find(item => item.items?.some(member => member.id === id));
  const memberShown = (item: DockItem) => {
    const list = item.items || [];
    if (item.active) return list.find(member => member.id === item.active) || list[0];
    return list.find(member => member.id === value) || list.find(member => member.id === shown[item.id]) || list[0];
  };
  const holds = (item: DockItem) => item.id === value || !!item.items?.some(member => member.id === value);

  useEffect(() => () => window.clearTimeout(tipTimer.current), []);

  useEffect(() => {
    if (!trayClosed) return;
    setOpenId(null);
    setHeldId(null);
    grow.set(0);
  }, [trayClosed, grow]);

  useEffect(() => {
    if (trayClosed || !revealTray) return;
    setOpenId(revealTray);
    setHeldId(revealTray);
    onOpenChangeRef.current?.(revealTray);
  }, [revealTray, trayClosed]);

  useEffect(() => {
    if (!openId) return;
    const onDown = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) setTrayOpen(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [openId]);

  /* 图标只跟着真正生效的工具走。点了但工具没切过去（比如还没选中模型）时，不把格子上的图标先改掉。 */
  useEffect(() => {
    if (!value) return;
    const group = items.find(item => item.items?.some(member => member.id === value));
    if (!group) return;
    setShown(prev => (prev[group.id] === value ? prev : { ...prev, [group.id]: value }));
  }, [value, items]);

  function placeTip(text: string, slot: HTMLElement, delay: boolean, shortcut?: string) {
    const run = () => {
      const root = rootRef.current?.getBoundingClientRect();
      const rect = slot.getBoundingClientRect();
      if (!root) return;
      setTip({ text, shortcut, x: rect.left - root.left + rect.width / 2 });
    };
    window.clearTimeout(tipTimer.current);
    if (!delay || warm.current) { warm.current = true; run(); return; }
    tipTimer.current = window.setTimeout(() => { warm.current = true; run(); }, 280);
  }
  function hideTip(soon = false) {
    window.clearTimeout(tipTimer.current);
    if (soon) { warm.current = false; setTip(null); return; }
    tipTimer.current = window.setTimeout(() => { warm.current = false; setTip(null); }, 160);
  }

  function choose(id: string) { onValueChange?.(id); }

  function setTrayOpen(next: string | null) {
    setOpenId(next);
    if (next) setHeldId(next);
    onOpenChangeRef.current?.(next);
  }

  function toggleTray(item: DockItem, focusMember: boolean) {
    const next = openId === item.id ? null : item.id;
    setTrayOpen(next);
    if (next && focusMember) {
      const member = memberShown(item);
      if (member) setFocusId(member.id);
    }
  }

  /* 按长出的比例把托盘轮廓从栏的上沿撑开。直接改 DOM，避免每一帧都让整条坞重渲染。 */
  paintRef.current = (v: number) => {
    const g = geo.current;
    const rootEl = rootRef.current;
    const plateEl = plateRef.current;
    const svg = lineRef.current;
    const pathEl = pathRef.current;
    if (!g || !rootEl || !plateEl || !svg || !pathEl) return;
    const { bar, tray: full } = g;
    let tray = null;
    let top = 0;
    if (full && v > 0.02) {
      const h = full.h * v;
      const y = full.y + full.h - h;
      /* 还没探出栏顶时不挖缺口，免得几个像素的圆角打结 */
      if (bar.y - y > 1.5) {
        tray = { x: full.x, y, w: full.w, h };
        top = Math.min(0, y);
        rootEl.style.setProperty("--tip-bottom", `${bar.h - y + 8}px`);
      }
    }
    if (!tray) rootEl.style.removeProperty("--tip-bottom");
    const shift = (y: number) => y - top;
    const d = dockOutline(
      { x: bar.x, y: shift(bar.y), w: bar.w, h: bar.h },
      tray && { x: tray.x, y: shift(tray.y), w: tray.w, h: tray.h },
    );
    const height = bar.h - top;
    plateEl.style.top = `${top}px`;
    plateEl.style.width = `${bar.w}px`;
    plateEl.style.height = `${height}px`;
    plateEl.style.clipPath = `path('${d}')`;
    svg.style.top = `${top}px`;
    svg.setAttribute("width", String(bar.w));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", `0 0 ${bar.w} ${height}`);
    pathEl.setAttribute("d", d);
    const host = trayRef.current;
    if (host && full) host.style.height = `${Math.max(0, full.h * v)}px`;
  };

  useMotionValueEvent(grow, "change", v => {
    paintRef.current(v);
    if (!openIdRef.current && v < 0.02) setHeldId(prev => (prev ? null : prev));
  });

  useEffect(() => {
    const ctrl = animate(grow, openId ? 1 : 0, reduced ? { duration: 0 } : spring.smooth);
    return () => ctrl.stop();
  }, [openId, reduced, grow]);

  useLayoutEffect(() => {
    const rootEl = rootRef.current, barEl = barRef.current;
    if (!rootEl || !barEl) return;
    const root = rootEl.getBoundingClientRect();
    const slotId = openId || heldId;
    const slot = slotId ? slotRefs.current.get(slotId) : null;
    if (slot) {
      const sr = slot.getBoundingClientRect();
      const nextX = sr.left - root.left + sr.width / 2;
      setTrayX(prev => Math.abs(prev - nextX) < 0.5 ? prev : nextX);
    }
    const bb = barEl.getBoundingClientRect();
    const bar = { x: bb.left - root.left, y: bb.top - root.top, w: bb.width, h: bb.height };
    const trayEl = trayRef.current;
    let tray = null;
    if (trayEl) {
      /* 先按内容高度量完整托盘，再交给 paint 收到当前长出的比例。bottom 锚在栏上，缩高度就是向上长。 */
      const prevH = trayEl.style.height;
      trayEl.style.height = "auto";
      const tb = trayEl.getBoundingClientRect();
      tray = { x: tb.left - root.left, y: tb.top - root.top, w: tb.width, h: tb.height };
      trayEl.style.height = prevH;
    }
    geo.current = { bar, tray };
    paintRef.current(grow.get());
    if (openId && focusId) {
      const button = slotRefs.current.get(focusId)?.querySelector("button");
      if (button && document.activeElement !== button) button.focus();
    }
  }, [openId, heldId, focusId, items, trayX, grow]);

  function moveFocus(id: string) {
    setFocusId(id);
    requestAnimationFrame(() => slotRefs.current.get(id)?.querySelector("button")?.focus());
  }

  function reorder(id: string, dir: number) {
    if (!onItemsChange) return;
    const index = flat.findIndex(item => item.id === id);
    const next = index + dir;
    if (index < 0 || next < 0 || next >= flat.length) return;
    const copy = flat.slice();
    const [item] = copy.splice(index, 1);
    copy.splice(next, 0, item);
    onItemsChange(copy, { type: "move", id, index: next });
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, item: DockItem, inTray: boolean) {
    const key = event.key;
    if (onItemsChange && event.altKey && (key === "ArrowLeft" || key === "ArrowRight") && !inTray) {
      event.preventDefault();
      reorder(item.id, key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (inTray) {
      const group = groupOf(item.id);
      const members = group?.items || [];
      const index = members.findIndex(member => member.id === item.id);
      if (key === "ArrowRight" || key === "ArrowLeft") {
        event.preventDefault();
        const dir = key === "ArrowRight" ? 1 : -1;
        const next = members[(index + dir + members.length) % members.length];
        if (next) moveFocus(next.id);
        return;
      }
      if (key === "ArrowDown" || key === "Escape") {
        event.preventDefault();
        setTrayOpen(null);
        if (group) moveFocus(group.id);
        return;
      }
      if (key === "Tab") { setTrayOpen(null); return; }
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        choose(item.id);
        setTrayOpen(null);
        if (group) moveFocus(group.id);
      }
      return;
    }
    const index = flat.findIndex(entry => entry.id === item.id);
    if (key === "ArrowRight" || key === "ArrowLeft") {
      event.preventDefault();
      const dir = key === "ArrowRight" ? 1 : -1;
      const next = flat[(index + dir + flat.length) % flat.length];
      if (next) moveFocus(next.id);
      return;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      const next = key === "Home" ? flat[0] : flat[flat.length - 1];
      if (next) moveFocus(next.id);
      return;
    }
    if (key === "ArrowUp" && item.items) {
      event.preventDefault();
      toggleTray(item, true);
      return;
    }
    if (key === "Escape" && openId) {
      event.preventDefault();
      setTrayOpen(null);
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (item.items) {
        const member = memberShown(item);
        if (member) choose(member.id);
        toggleTray(item, false);
        return;
      }
      choose(item.id);
    }
  }

  function onPointerDown(event: PointerEvent<HTMLButtonElement>, item: DockItem) {
    if (!onItemsChange || event.button !== 0) return;
    drag.current = { id: item.id, x: event.clientX, moved: false };
  }
  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const state = drag.current;
    if (!state || !onItemsChange || !barRef.current) return;
    if (!state.moved && Math.abs(event.clientX - state.x) < 6) return;
    state.moved = true;
    setLiftId(state.id);
    const slots = [...barRef.current.querySelectorAll<HTMLElement>("[data-slot]")];
    let index = slots.findIndex(slot => event.clientX < slot.getBoundingClientRect().left + slot.offsetWidth / 2);
    if (index < 0) index = slots.length - 1;
    const from = flat.findIndex(entry => entry.id === state.id);
    if (from < 0 || index === from) return;
    const copy = flat.slice();
    const [moved] = copy.splice(from, 1);
    copy.splice(index, 0, moved);
    onItemsChange(copy, { type: "move", id: state.id, index });
  }
  function onPointerUp() {
    if (drag.current?.moved) suppressClick.current = true;
    drag.current = null;
    setLiftId(null);
  }

  const openGroup = flat.find(item => item.id === (openId || heldId) && item.items);

  return <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(" ")}>
    <div ref={plateRef} className={styles.plate} />
    <svg ref={lineRef} className={styles.plateLine} width="0" height="0" aria-hidden="true">
      <path ref={pathRef} />
    </svg>
    <div
      ref={barRef}
      role="toolbar"
      aria-label={label}
      className={styles.bar}
      onPointerLeave={() => hideTip()}
      onPointerEnter={() => window.clearTimeout(tipTimer.current)}
    >
      {flat.map(item => {
        const selected = holds(item);
        const trayOpen = openId === item.id || heldId === item.id;
        const expanded = trayOpen || expandedId === item.id;
        /* 同一时间只亮一格。有托盘或弹出菜单时，底色跟着这一格走，原来那格让出来。 */
        const menuId = openId || heldId || expandedId || null;
        const chosen = menuId ? item.id === menuId : selected;
        const shownMember = item.items ? memberShown(item) : undefined;
        const accessible = nameOf(item, shownMember) + (chosen ? ", 已选中" : "");
        return <motion.div
          key={item.id}
          data-slot=""
          layout={onItemsChange ? "position" : false}
          ref={node => { if (node) slotRefs.current.set(item.id, node); else slotRefs.current.delete(item.id); }}
          className={styles.slot}
          transition={spring.smooth}
        >
          {chosen && <motion.span layoutId={`dock-sel-${reactId}`} className={styles.selection} style={{ borderRadius: 14 }} transition={reduced ? { duration: 0 } : spring.morph} />}
          <motion.button
            type="button"
            className={styles.item}
            aria-label={accessible}
            aria-pressed={chosen}
            data-chosen={chosen ? "" : undefined}
            aria-haspopup={item.items ? "true" : undefined}
            aria-expanded={item.items ? trayOpen : expandedId === item.id ? true : undefined}
            aria-controls={item.items ? `${reactId}-tray-${item.id}` : undefined}
            tabIndex={focusId === item.id || (!focusId && item === flat[0]) ? 0 : -1}
            whileTap={reduced ? undefined : { scale: 0.9 }}
            animate={liftId === item.id ? { scale: 1.12, y: -8 } : { scale: 1, y: 0 }}
            transition={reduced ? { duration: 0 } : pressSpring}
            onFocus={() => {
              setFocusId(item.id);
              const slot = slotRefs.current.get(item.id);
              if (slot) placeTip(groupTip(item, shownMember), slot, false);
            }}
            onBlur={() => hideTip(false)}
            onPointerEnter={event => {
              if (event.pointerType === "touch") return;
              const slot = slotRefs.current.get(item.id);
              if (slot) placeTip(groupTip(item, shownMember), slot, true);
            }}
            onPointerDown={event => onPointerDown(event, item)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onClick={() => {
              if (suppressClick.current) { suppressClick.current = false; return; }
              if (item.items) { toggleTray(item, false); return; }
              if (openId) setTrayOpen(null);
              choose(item.id);
            }}
            onKeyDown={event => onKeyDown(event, item, false)}
          >
            {/* 分组图标由调用方按当前成员换，变形发生在图标自己身上 */}
            <span className={styles.icon}>{item.icon}</span>
            <AnimatePresence>
              {!!item.badge && <motion.span key="badge" className={styles.badge} aria-hidden="true" initial={reduced ? false : { opacity: 0, scale: .6, filter: `blur(${blur.subtle}px)` }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} exit={reduced ? { opacity: 0 } : { opacity: 0, scale: .6 }} transition={{ duration: duration.fast }}>{item.badge}</motion.span>}
            </AnimatePresence>
          </motion.button>
        </motion.div>;
      })}
      {trailing}
    </div>
    <AnimatePresence>
      {tip && <motion.div key="tip" className={styles.tip} aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1, left: tip.x }} exit={{ opacity: 0 }} style={{ translateX: "-50%" }} transition={reduced ? { duration: duration.fast } : { left: spring.morph, opacity: { duration: duration.fast } }}>{tip.text}{tip.shortcut && <kbd className={styles.kbd}>{tip.shortcut}</kbd>}</motion.div>}
    </AnimatePresence>
    {openGroup && trayX > 0 && <div
      ref={trayRef}
      id={`${reactId}-tray-${openGroup.id}`}
      role="group"
      aria-label={openGroup.label}
      className={styles.tray}
      style={{ left: trayX, transform: "translateX(-50%)" }}
    >
      {openGroup.items!.map((member, index) => <TrayMember
          key={member.id}
          member={member}
          index={index}
          grow={grow}
          reduced={reduced}
          selected={openGroup.active ? member.id === openGroup.active : member.id === value}
          tabIndex={focusId === member.id ? 0 : -1}
          slotRef={node => { if (node) slotRefs.current.set(member.id, node); else slotRefs.current.delete(member.id); }}
          onActivate={() => { choose(member.id); setTrayOpen(null); moveFocus(openGroup.id); }}
          onKeyDown={event => onKeyDown(event, member, true)}
          onTip={(show, immediate) => {
            if (!show) { hideTip(); return; }
            const slot = slotRefs.current.get(member.id);
            if (slot) placeTip(member.label, slot, !immediate, member.shortcut);
          }}
        />)}
    </div>}
  </div>;
}

export default Dock;
