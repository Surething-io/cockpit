'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * TooltipProvider — single global handler for every `data-tooltip` attribute
 * across the app.
 *
 * Mounted once at the root (above all panels) so the rendered popover lives
 * in `document.body` and `position: fixed` stays viewport-relative regardless
 * of any panel `transform: translateX(...)`.
 *
 * Components opt in two ways — both routes hit this single render path:
 *
 *   1. Add `data-tooltip="..."` directly to any element.
 *      (Cheap — no React state, no per-element listeners. Use this in
 *      large lists/trees where allocating a wrapper per row matters.)
 *
 *   2. Use `<Tooltip content="..."><Child/></Tooltip>` — the wrapper
 *      forwards `data-tooltip` to its child via `cloneElement`. Same
 *      ergonomics as before, no behavior change at call sites.
 *
 * Visual: brand-bordered popover with mono font. Single source of truth —
 * change once, the whole app updates.
 */

const SHOW_DELAY_MS = 300;

interface TooltipState {
  text: string;
  x: number;
  y: number;
}

function findTooltipText(target: EventTarget | null): string | null {
  let el = target as HTMLElement | null;
  while (el) {
    const t = el.dataset?.tooltip;
    if (t) return t;
    el = el.parentElement;
  }
  return null;
}

export function TooltipProvider() {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const tipRef = useRef<TooltipState | null>(null);
  tipRef.current = tip;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — Portal target (document.body) only exists client-side.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const cancelTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const onOver = (e: MouseEvent) => {
      const text = findTooltipText(e.target);
      if (!text) {
        cancelTimer();
        if (tipRef.current) setTip(null);
        return;
      }
      // Already showing the same text — just track cursor.
      if (tipRef.current && tipRef.current.text === text) {
        setTip({ text, x: e.clientX, y: e.clientY });
        return;
      }
      // New target — schedule the show.
      cancelTimer();
      const x = e.clientX;
      const y = e.clientY;
      timerRef.current = setTimeout(() => {
        setTip({ text, x, y });
        timerRef.current = null;
      }, SHOW_DELAY_MS);
    };

    const onMove = (e: MouseEvent) => {
      // Skip the parent walk on every pixel move when no tip is showing —
      // mouseover already handles target changes.
      if (!tipRef.current) return;
      const text = findTooltipText(e.target);
      if (!text) {
        cancelTimer();
        setTip(null);
        return;
      }
      setTip({ text, x: e.clientX, y: e.clientY });
    };

    const onLeave = () => {
      cancelTimer();
      if (tipRef.current) setTip(null);
    };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onLeave);
    // Hide immediately on any click — the user is acting, not reading.
    document.addEventListener('mousedown', onLeave);

    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('mousedown', onLeave);
      cancelTimer();
    };
  }, []);

  // After render, measure the popover and clamp to viewport.
  useLayoutEffect(() => {
    if (!tip || !popoverRef.current) return;
    const rect = popoverRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = tip.x + 12;
    let top = tip.y + 16;
    if (left + rect.width > vw - 8) left = vw - rect.width - 8;
    if (left < 8) left = 8;
    // If we'd overflow the bottom, flip above the cursor instead.
    if (top + rect.height > vh - 8) top = tip.y - rect.height - 8;
    setPos({ left, top });
  }, [tip]);

  if (!mounted || !tip) return null;

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-[9999] px-2 py-1 bg-popover text-popover-foreground text-xs font-mono rounded shadow-lg border border-brand whitespace-nowrap pointer-events-none max-w-[80vw] overflow-hidden text-ellipsis"
      style={{ left: pos.left, top: pos.top }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
