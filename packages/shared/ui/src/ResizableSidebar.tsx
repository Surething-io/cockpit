'use client';

import { useCallback, useRef, useState, type PointerEvent, type ReactNode } from 'react';

/** A file sidebar that can expand by up to 50% of its default width. */
export function ResizableSidebar({ children, defaultWidth = 288 }: { children: ReactNode; defaultWidth?: number }) {
  const [width, setWidth] = useState(defaultWidth);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number; maxWidth: number } | null>(null);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    // Touch drags belong to the three-panel swipe gesture.
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const sidebar = event.currentTarget.previousElementSibling;
    const container = event.currentTarget.parentElement;
    if (!sidebar || !container) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: sidebar.getBoundingClientRect().width,
      maxWidth: Math.min(defaultWidth * 1.5, container.getBoundingClientRect().width / 2),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [defaultWidth]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = drag.startWidth + event.clientX - drag.startX;
    setWidth(Math.min(drag.maxWidth, Math.max(defaultWidth, next)));
  }, [defaultWidth]);

  const onPointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <>
      <div className="flex-shrink-0 overflow-y-auto overflow-x-hidden" style={{ width, maxWidth: '50%' }}>
        {children}
      </div>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        className="w-[5px] flex-shrink-0 relative cursor-col-resize group"
      >
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border group-hover:bg-brand transition-colors" />
      </div>
    </>
  );
}
