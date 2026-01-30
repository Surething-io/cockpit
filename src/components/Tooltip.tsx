'use client';

import { useState, useRef, useEffect, ReactNode } from 'react';

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
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const showTooltip = () => {
    timeoutRef.current = setTimeout(() => {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        let left = rect.left + rect.width / 2;
        const top = rect.bottom + 4;

        // 预估 tooltip 宽度（最大 384px = max-w-md）
        const estimatedWidth = Math.min(content.length * 7, 384);
        const halfWidth = estimatedWidth / 2;

        // 防止左边超出屏幕
        if (left - halfWidth < 8) {
          left = halfWidth + 8;
        }
        // 防止右边超出屏幕
        if (left + halfWidth > window.innerWidth - 8) {
          left = window.innerWidth - halfWidth - 8;
        }

        setPosition({ top, left });
      }
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
      const tooltip = tooltipRef.current;
      const rect = tooltip.getBoundingClientRect();

      let newLeft = position.left;

      // 防止左边超出屏幕
      if (rect.left < 8) {
        newLeft = position.left + (8 - rect.left);
      }
      // 防止右边超出屏幕
      if (rect.right > window.innerWidth - 8) {
        newLeft = position.left - (rect.right - window.innerWidth + 8);
      }

      if (newLeft !== position.left) {
        setPosition((prev) => ({ ...prev, left: newLeft }));
      }
    }
  }, [isVisible, position.left]);

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
        ref={triggerRef}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        className={className}
      >
        {children}
      </div>
      {isVisible && (
        <div
          ref={tooltipRef}
          className="fixed z-50 px-2 py-1 text-xs text-gray-100 bg-gray-700 dark:bg-gray-600 rounded shadow-lg max-w-md break-words pointer-events-none"
          style={{
            top: position.top,
            left: position.left,
            transform: 'translateX(-50%)',
          }}
        >
          {content}
        </div>
      )}
    </>
  );
}
