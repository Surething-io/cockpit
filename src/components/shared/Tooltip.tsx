'use client';

import { useState, useRef, useEffect, ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  content: string;
  children: ReactNode;
  delay?: number; // 悬停多久后显示，默认 300ms
  className?: string;
}

export function Tooltip({ content, children, delay = 300, className = '' }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mouseRef = useRef({ x: 0, y: 0 });
  const tooltipRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: React.MouseEvent) => {
    mouseRef.current = { x: e.clientX, y: e.clientY };
  };

  const showTooltip = () => {
    timeoutRef.current = setTimeout(() => {
      const { x, y } = mouseRef.current;
      setPosition({ top: y + 12, left: x });
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

  // 显示后调整位置，防止超出屏幕
  useEffect(() => {
    if (isVisible && tooltipRef.current) {
      const rect = tooltipRef.current.getBoundingClientRect();

      let newLeft = position.left;
      let newTop = position.top;

      // 防止右边超出屏幕
      if (rect.right > window.innerWidth - 8) {
        newLeft = window.innerWidth - rect.width - 8;
      }
      // 防止左边超出屏幕
      if (rect.left < 8) {
        newLeft = 8;
      }
      // 防止底部超出屏幕，改为显示在鼠标上方
      if (rect.bottom > window.innerHeight - 8) {
        newTop = mouseRef.current.y - rect.height - 8;
      }

      if (newLeft !== position.left || newTop !== position.top) {
        setPosition({ top: newTop, left: newLeft });
      }
    }
  }, [isVisible, position.left, position.top]);

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
      {isVisible && createPortal(
        <div
          ref={tooltipRef}
          className="fixed z-[9999] px-2 py-1 text-xs text-foreground bg-accent rounded shadow-lg max-w-md break-words pointer-events-none"
          style={{
            top: position.top,
            left: position.left,
          }}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
