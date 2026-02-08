'use client';

import React, { useState, useCallback, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type CommitInfo } from '../CommitDetailPanel';
import type { BlameLine } from './types';
import { formatRelativeTime } from './utils';

export const AUTHOR_COLORS = [
  { bg: 'rgba(59, 130, 246, 0.15)', border: 'rgb(59, 130, 246)' },
  { bg: 'rgba(16, 185, 129, 0.15)', border: 'rgb(16, 185, 129)' },
  { bg: 'rgba(245, 158, 11, 0.15)', border: 'rgb(245, 158, 11)' },
  { bg: 'rgba(239, 68, 68, 0.15)', border: 'rgb(239, 68, 68)' },
  { bg: 'rgba(168, 85, 247, 0.15)', border: 'rgb(168, 85, 247)' },
  { bg: 'rgba(236, 72, 153, 0.15)', border: 'rgb(236, 72, 153)' },
  { bg: 'rgba(20, 184, 166, 0.15)', border: 'rgb(20, 184, 166)' },
  { bg: 'rgba(249, 115, 22, 0.15)', border: 'rgb(249, 115, 22)' },
];

interface BlameViewProps {
  blameLines: BlameLine[];
  cwd: string;
  onSelectCommit?: (commit: CommitInfo) => void;
}

export function BlameView({ blameLines, cwd, onSelectCommit }: BlameViewProps) {
  const [hoveredAuthor, setHoveredAuthor] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ line: BlameLine; x: number; y: number } | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const authorColorMap = useMemo(() => {
    const authors = [...new Set(blameLines.map(l => l.author))];
    const map = new Map<string, typeof AUTHOR_COLORS[0]>();
    authors.forEach((author, index) => {
      map.set(author, AUTHOR_COLORS[index % AUTHOR_COLORS.length]);
    });
    return map;
  }, [blameLines]);

  const virtualizer = useVirtualizer({
    count: blameLines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 20,
  });

  const handleMouseEnter = useCallback((line: BlameLine, e: React.MouseEvent) => {
    setHoveredAuthor(line.author);
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ line, x: rect.right + 8, y: rect.top });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredAuthor(null);
    setTooltip(null);
  }, []);

  const handleClick = useCallback((line: BlameLine) => {
    const commitInfo: CommitInfo = {
      hash: line.hashFull,
      shortHash: line.hash,
      author: line.author,
      authorEmail: line.authorEmail,
      date: new Date(line.time * 1000).toISOString(),
      subject: line.message.split('\n')[0] || '',
      body: line.message.split('\n').slice(1).join('\n').trim(),
      time: line.time,
    };
    onSelectCommit?.(commitInfo);
    setTooltip(null);
  }, [onSelectCommit]);

  return (
    <div ref={parentRef} className="h-full overflow-auto font-mono text-sm relative">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const line = blameLines[virtualItem.index];
          const prevLine = virtualItem.index > 0 ? blameLines[virtualItem.index - 1] : null;
          const showBlameInfo = !prevLine || prevLine.hash !== line.hash;
          const authorColor = authorColorMap.get(line.author) || AUTHOR_COLORS[0];
          const isHovered = hoveredAuthor === line.author;

          return (
            <div
              key={virtualItem.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
                backgroundColor: isHovered ? authorColor.bg : undefined,
              }}
              className="flex hover:bg-accent/50"
            >
              <div
                className="w-1 flex-shrink-0"
                style={{ backgroundColor: authorColor.border }}
              />
              <div
                className="w-48 flex-shrink-0 px-2 flex items-center gap-2 border-r border-border text-muted-foreground cursor-pointer hover:bg-accent"
                onMouseEnter={(e) => handleMouseEnter(line, e)}
                onMouseLeave={handleMouseLeave}
                onClick={() => handleClick(line)}
                title="点击查看 commit 详情"
              >
                {showBlameInfo ? (
                  <>
                    <span className="font-medium" style={{ color: authorColor.border }}>{line.hash}</span>
                    <span className="truncate flex-1">{line.author.split(' ')[0]}</span>
                    <span className="text-slate-9">{formatRelativeTime(line.time)}</span>
                  </>
                ) : null}
              </div>
              <div className="w-10 flex-shrink-0 px-2 text-right text-slate-9 select-none">
                {line.line}
              </div>
              <pre className="flex-1 px-2 overflow-hidden whitespace-pre">
                <code className="text-foreground">{line.content}</code>
              </pre>
            </div>
          );
        })}
      </div>

      {tooltip && (
        <div
          className="fixed z-50 bg-card border border-border rounded-lg shadow-lg p-3 max-w-lg"
          style={{
            left: Math.min(tooltip.x, window.innerWidth - 450),
            top: Math.max(8, Math.min(tooltip.y, window.innerHeight - 200)),
          }}
        >
          <div className="flex items-start gap-3">
            <div
              className="px-2 py-0.5 rounded text-xs font-mono font-medium text-white flex-shrink-0"
              style={{ backgroundColor: authorColorMap.get(tooltip.line.author)?.border || '#666' }}
            >
              {tooltip.line.hash}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">
                {tooltip.line.author}
              </div>
              <div className="text-xs text-muted-foreground">
                {tooltip.line.authorEmail}
              </div>
            </div>
          </div>
          <div className="mt-2 text-sm text-foreground whitespace-pre-wrap max-h-48 overflow-y-auto">
            {tooltip.line.message}
          </div>
          <div className="mt-2 text-xs text-muted-foreground border-t border-border pt-2">
            {new Date(tooltip.line.time * 1000).toLocaleString()}
            <span className="ml-2 text-brand">点击查看详情</span>
          </div>
        </div>
      )}
    </div>
  );
}
