'use client';

import React, { useRef, useState, useEffect } from 'react';

// ============================================
// Diff Minimap Component
// ============================================

interface DiffMinimapProps {
  lines: Array<{ type: 'unchanged' | 'removed' | 'added' }>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function DiffMinimap({ lines, containerRef }: DiffMinimapProps) {
  const minimapRef = useRef<HTMLDivElement>(null);
  const [viewportInfo, setViewportInfo] = useState({ top: 0, height: 0 });

  // Update viewport indicator position
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateViewport = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const minimapHeight = minimapRef.current?.clientHeight || 0;

      if (scrollHeight <= clientHeight) {
        // Content doesn't overflow, viewport covers entire minimap
        setViewportInfo({ top: 0, height: minimapHeight });
      } else {
        const ratio = minimapHeight / scrollHeight;
        setViewportInfo({
          top: scrollTop * ratio,
          height: clientHeight * ratio,
        });
      }
    };

    updateViewport();
    container.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);

    return () => {
      container.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
    };
  }, [containerRef]);

  // Click to jump
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    const minimap = minimapRef.current;
    if (!container || !minimap) return;

    const rect = minimap.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const ratio = clickY / rect.height;

    const targetScroll = ratio * container.scrollHeight - container.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
  };

  if (lines.length === 0) return null;

  // Calculate line height percentage for minimap
  const lineHeight = 100 / lines.length;

  return (
    <div
      ref={minimapRef}
      className="w-4 flex-shrink-0 bg-secondary border-l border-border relative cursor-pointer"
      onClick={handleClick}
    >
      {/* Change markers with percentage positioning */}
      {lines.map((line, idx) => (
        line.type !== 'unchanged' && (
          <div
            key={idx}
            className={`absolute left-0 right-0 ${
              line.type === 'removed' ? 'bg-red-9' : 'bg-green-9'
            }`}
            style={{
              top: `${idx * lineHeight}%`,
              height: `${Math.max(lineHeight, 0.5)}%`,
              minHeight: '2px',
            }}
          />
        )
      ))}
      {/* Viewport indicator */}
      <div
        className="absolute left-0 right-0 bg-muted/60 border-y border-border"
        style={{
          top: `${viewportInfo.top}px`,
          height: `${Math.max(viewportInfo.height, 10)}px`,
        }}
      />
    </div>
  );
}
