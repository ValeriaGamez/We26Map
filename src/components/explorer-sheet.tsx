"use client";

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { PointerEvent, ReactNode } from "react";
import styles from "./floor-map.module.css";

const query = "(max-width: 639px)";
function subscribe(notify: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}
export function usePhoneLayout() { return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false); }

export default function ExplorerSheet({ expanded, onExpandedChange, children }: { expanded: boolean; onExpandedChange: (next: boolean) => void; children: ReactNode }) {
  const phone = usePhoneLayout();
  const panel = useRef<HTMLElement>(null);
  const controller = useRef<{ snap: (full: boolean, animate?: boolean) => void } | null>(null);
  const motion = useRef({ y: 0, velocity: 0, peek: 0, target: 0, frame: 0, previous: 0 });
  const gesture = useRef({ id: -1, startY: 0, initialY: 0, lastY: 0, time: 0, moved: false });
  const callbacks = useRef({ expanded, onExpandedChange });
  useLayoutEffect(() => { callbacks.current = { expanded, onExpandedChange }; }, [expanded, onExpandedChange]);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !phone) { element?.style.removeProperty("transform"); return; }
    const state = motion.current;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const paint = () => { element.style.transform = `translate3d(0, ${state.y}px, 0)`; };
    function tick(time: number) {
      state.frame = 0;
      const dt = Math.min(.032, Math.max(.001, (time - state.previous) / 1000)); state.previous = time;
      state.velocity += (360 * (state.target - state.y) - 38 * state.velocity) * dt;
      state.y += state.velocity * dt;
      if (Math.abs(state.target - state.y) < .5 && Math.abs(state.velocity) < 5) { state.y = state.target; state.velocity = 0; }
      else state.frame = window.requestAnimationFrame(tick);
      paint();
    }
    function snap(full: boolean, animate = true) {
      state.target = full ? 0 : state.peek;
      if (!animate || preference.matches) {
        window.cancelAnimationFrame(state.frame); state.frame = 0; state.y = state.target; state.velocity = 0; paint();
      } else if (!state.frame) { state.previous = performance.now(); state.frame = window.requestAnimationFrame(tick); }
    }
    function resize() {
      state.peek = Math.max(0, element!.offsetHeight - window.innerHeight * .4);
      snap(callbacks.current.expanded, false);
    }
    controller.current = { snap };
    const observer = new ResizeObserver(resize); observer.observe(element);
    window.addEventListener("resize", resize);
    resize();
    return () => { window.cancelAnimationFrame(state.frame); state.frame = 0; observer.disconnect(); window.removeEventListener("resize", resize); controller.current = null; element.style.removeProperty("transform"); };
  }, [phone]);
  useLayoutEffect(() => { controller.current?.snap(expanded); }, [expanded]);

  function down(event: PointerEvent<HTMLButtonElement>) {
    if (!phone || event.button !== 0) return;
    window.cancelAnimationFrame(motion.current.frame); motion.current.frame = 0;
    gesture.current = { id: event.pointerId, startY: event.clientY, initialY: motion.current.y, lastY: event.clientY, time: event.timeStamp, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const drag = gesture.current;
    if (drag.id !== event.pointerId) return;
    const state = motion.current;
    drag.moved ||= Math.abs(event.clientY - drag.startY) > 6;
    state.velocity = (event.clientY - drag.lastY) / Math.max(8, event.timeStamp - drag.time) * 1000;
    state.y = Math.max(0, Math.min(state.peek, drag.initialY + event.clientY - drag.startY));
    drag.lastY = event.clientY; drag.time = event.timeStamp;
    if (!state.frame) state.frame = window.requestAnimationFrame(() => { state.frame = 0; if (panel.current) panel.current.style.transform = `translate3d(0, ${state.y}px, 0)`; });
  }
  function end(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = gesture.current;
    if (drag.id !== event.pointerId) return;
    drag.id = -1;
    window.cancelAnimationFrame(motion.current.frame); motion.current.frame = 0;
    const full = cancelled || !drag.moved ? expanded : motion.current.y + motion.current.velocity * .18 < motion.current.peek / 2;
    onExpandedChange(full); controller.current?.snap(full);
  }
  return <aside ref={panel} className={styles.panel} data-expanded={expanded} aria-label="Company explorer">
    <button type="button" className={styles.sheetHandle} aria-label={expanded ? "Collapse panel" : "Expand panel"} aria-expanded={expanded} aria-controls="explorer-panel-content" onPointerDown={down} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onClick={event => { if (gesture.current.moved && event.detail !== 0) { gesture.current.moved = false; return; } onExpandedChange(!expanded); }}><span /></button>
    {children}
  </aside>;
}
