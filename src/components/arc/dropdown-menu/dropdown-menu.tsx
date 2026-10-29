"use client";

import { Fragment, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown } from "lucide-react";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./dropdown-menu.module.css";

export interface DropdownItem { label: string; onSelect?: () => void; disabled?: boolean; icon?: ReactNode; destructive?: boolean; separatorBefore?: boolean; }
export interface DropdownMenuProps {
  label: string;
  items: DropdownItem[];
  icon?: ReactNode;
  /** 溢出菜单只留图标，文字留给读屏。 */
  hideLabel?: boolean;
  hideChevron?: boolean;
  side?: "top" | "right" | "bottom" | "left";
}

/** A new trigger label rises in while the old one leaves, and the trigger width springs to the measured text instead of snapping. */
function TriggerLabel({ text }: { text: string }) {
  const reduced = useReducedMotion();
  const measure = useRef<HTMLSpanElement>(null);
  const measured = useRef<string | null>(null);
  const [size, setSize] = useState<{ width: number | "auto"; animate: boolean }>({ width: "auto", animate: false });
  useLayoutEffect(() => {
    const node = measure.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const current = node.textContent;
      // Only a text change morphs; the first measure and font swaps settle instantly.
      const animate = measured.current !== null && measured.current !== current;
      measured.current = current;
      setSize({ width: Math.ceil(entry.borderBoxSize?.[0]?.inlineSize ?? node.offsetWidth), animate });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <motion.span className={styles.label} initial={false} animate={{ width: size.width }} transition={size.animate && !reduced ? motionTokens.spring.morph : { duration: 0 }}>
    <span ref={measure} className={styles.labelMeasure} aria-hidden="true">{text}</span>
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span key={text} className={styles.labelText} initial={reduced ? false : { opacity: 0, y: "0.3em", filter: `blur(${motionTokens.blur.soft}px)` }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: "-0.3em", filter: `blur(${motionTokens.blur.subtle}px)`, transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } }} transition={{ duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] }}>{text}</motion.span>
    </AnimatePresence>
  </motion.span>;
}

export function DropdownMenu({ label, items, icon, hideLabel = false, hideChevron = false, side = "bottom" }: DropdownMenuProps) {
  return <DropdownPrimitive.Root>
    <DropdownPrimitive.Trigger className={styles.trigger} type="button" aria-label={hideLabel ? label : undefined}>
      {icon && <span className={styles.triggerIcon} aria-hidden="true">{icon}</span>}
      {hideLabel ? null : <TriggerLabel text={label}/>}
      {hideChevron ? null : <ChevronDown className={styles.chevron} size={15} strokeWidth={1.8} aria-hidden="true"/>}
    </DropdownPrimitive.Trigger>
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content className={styles.menu} side={side} sideOffset={4} align="end" collisionPadding={8} loop>
        {items.map((item) => <Fragment key={item.label}>
          {item.separatorBefore && <DropdownPrimitive.Separator className={styles.separator}/>}
          <DropdownPrimitive.Item className={[styles.item, item.destructive ? styles.destructive : ""].filter(Boolean).join(" ")} disabled={item.disabled} onSelect={item.onSelect}>
            {item.icon && <span className={styles.icon} aria-hidden="true">{item.icon}</span>}
            {item.label}
          </DropdownPrimitive.Item>
        </Fragment>)}
      </DropdownPrimitive.Content>
    </DropdownPrimitive.Portal>
  </DropdownPrimitive.Root>;
}

export default DropdownMenu;
