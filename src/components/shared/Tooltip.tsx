'use client';

import { useState, useRef, useEffect, ReactNode } from 'react';
import { Portal, usePanelPortalTarget } from './Portal';

interface TooltipProps {
  content: string;
  children: ReactNode;
  delay?: number; // How long to hover before showing, default 300ms
  className?: string;
}

export function Tooltip({ content, children, delay = 300, className = '' }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mouseRef = useRef({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const panelTarget = usePanelPortalTarget();

  const handleMouseMove = (e: React.MouseEvent) => {
    mouseRef.current = { x: e.clientX, y: e.clientY };
  };

  const showTooltip = () => {
    timeoutRef.current = setTimeout(() => {
      const { x, y } = mouseRef.current;
      // Translate viewport mouse coords into portal-target-local coords so the
      // tooltip anchors correctly inside a panel (where `position: fixed` is
      // relative to the panel wrapper). With document.body fallback origin is
      // (0,0) and positions remain viewport-relative.
      const origin = panelTarget?.getBoundingClientRect();
      const ox = origin?.left ?? 0;
      const oy = origin?.top ?? 0;
      setPosition({ top: y + 12 - oy, left: x - ox });
      setIsVisible(true);
    }, delay);
  };

  const hideTooltip = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  };

  // Adjust position after showing to prevent overflow off screen
  useEffect(() => {
    if (isVisible && tooltipRef.current) {
      const rect = tooltipRef.current.getBoundingClientRect();
      const origin = panelTarget?.getBoundingClientRect();
      const ox = origin?.left ?? 0;
      const oy = origin?.top ?? 0;
      const ow = origin?.width ?? window.innerWidth;
      const oh = origin?.height ?? window.innerHeight;
      // tooltip rect is in viewport coords; convert to local for bound checks
      const localRight = rect.right - ox;
      const localLeft = rect.left - ox;
      const localBottom = rect.bottom - oy;

      let newLeft = position.left;
      let newTop = position.top;

      // Prevent overflowing right edge
      if (localRight > ow - 8) {
        newLeft = ow - rect.width - 8;
      }
      // Prevent overflowing left edge
      if (localLeft < 8) {
        newLeft = 8;
      }
      // Prevent overflowing bottom edge, show above cursor instead
      if (localBottom > oh - 8) {
        newTop = mouseRef.current.y - rect.height - 8 - oy;
      }

      if (newLeft !== position.left || newTop !== position.top) {
        queueMicrotask(() => setPosition({ top: newTop, left: newLeft }));
      }
    }
  }, [isVisible, position.left, position.top, panelTarget]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <>
      <div
        onMouseEnter={showTooltip}
        onMouseMove={handleMouseMove}
        onMouseLeave={hideTooltip}
        className={className}
      >
        {children}
      </div>
      {isVisible && (
        <Portal>
          <div
            ref={tooltipRef}
            className="fixed z-[9999] px-2 py-1 text-xs text-foreground bg-accent rounded shadow-lg max-w-md break-words pointer-events-none"
            style={{
              top: position.top,
              left: position.left,
            }}
          >
            {content}
          </div>
        </Portal>
      )}
    </>
  );
}
