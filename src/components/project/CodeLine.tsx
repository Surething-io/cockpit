'use client';

import React, { memo } from 'react';
import type { CodeComment } from '@/hooks/useComments';

// ============================================
// Memoized Code Line Component - 避免 floatingToolbar 状态变化触发重渲染
// ============================================

export interface CodeLineProps {
  virtualKey: React.Key;
  lineNum: number;
  highlightedHtml: string;
  hasComments: boolean;
  firstComment?: CodeComment;
  lineCommentsCount?: number;
  isInRange: boolean;
  showLineNumbers: boolean;
  /** 行号最少字符数（如 4 表示最多9999行），用于统一宽度 */
  lineNumChars: number;
  commentsEnabled: boolean;
  virtualItemSize: number;
  virtualItemStart: number;
  onCommentBubbleClick: (comment: CodeComment, e: React.MouseEvent) => void;
}

export const CodeLine = memo(function CodeLine({
  virtualKey,
  lineNum,
  highlightedHtml,
  hasComments,
  firstComment,
  lineCommentsCount,
  isInRange,
  showLineNumbers,
  lineNumChars,
  commentsEnabled,
  virtualItemSize,
  virtualItemStart,
  onCommentBubbleClick,
}: CodeLineProps) {
  return (
    <div
      key={virtualKey}
      data-line={lineNum}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: `${virtualItemSize}px`,
        transform: `translateY(${virtualItemStart}px)`,
      }}
      className={`flex ${isInRange ? 'bg-blue-9/20' : hasComments ? 'bg-amber-9/10' : 'hover:bg-accent/50'}`}
    >
      {showLineNumbers && (
        <span
          className={`flex-shrink-0 flex items-center justify-end gap-0.5 pr-2 select-none border-r border-border font-variant-tabular ${
            isInRange ? 'bg-blue-9/30 text-blue-11' : 'bg-card/50 text-slate-9'
          }`}
        >
          {commentsEnabled && hasComments && firstComment && (
            <button
              onClick={(e) => onCommentBubbleClick(firstComment, e)}
              className="w-4 h-4 flex items-center justify-center rounded hover:bg-accent text-amber-9"
              title={`${lineCommentsCount} 条评论`}
            >
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
              </svg>
            </button>
          )}
          {commentsEnabled && !hasComments && <span className="w-4" />}
          <span className="text-right" style={{ minWidth: `${lineNumChars}ch` }}>{lineNum}</span>
        </span>
      )}
      <span
        className="flex-1 px-3 whitespace-pre overflow-x-auto"
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    </div>
  );
});
