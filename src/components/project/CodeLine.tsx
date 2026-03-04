'use client';

import React, { memo, useCallback } from 'react';
import type { CodeComment } from '@/hooks/useComments';
import type { BlameLine } from './fileBrowser/types';

// ============================================
// Author color palette for blame view
// ============================================

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
  /** Cmd+Click 跳转定义 */
  onCmdClick?: (line: number, column: number) => void;
  /** 悬浮 token 事件 */
  onTokenHover?: (line: number, column: number, rect: { x: number; y: number }) => void;
  onTokenHoverLeave?: () => void;
  /** 闪烁高亮的行号 */
  flashLine?: number | null;
  // ---- Blame 相关 ----
  blameLine?: BlameLine;
  /** 是否显示 blame 信息（同 commit 分组中只有首行显示） */
  showBlameInfo?: boolean;
  blameAuthorColor?: { bg: string; border: string };
  isBlameHovered?: boolean;
  onBlameClick?: (line: BlameLine) => void;
  onBlameMouseEnter?: (line: BlameLine, e: React.MouseEvent) => void;
  onBlameMouseLeave?: () => void;
}

/**
 * 从点击位置计算 column
 * 遍历代码行内的 span 元素，累加前面 span 的文本长度
 */
function getColumnFromClick(e: React.MouseEvent, codeSpan: HTMLElement): number {
  const target = e.target as HTMLElement;
  if (target === codeSpan) return 1; // 点在空白区

  // 获取代码区内所有文本节点相关的 span
  const walker = document.createTreeWalker(codeSpan, NodeFilter.SHOW_TEXT);
  let column = 1;
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    const parentSpan = node.parentElement;
    if (parentSpan === target || parentSpan?.contains(target) || target.contains(parentSpan!)) {
      // 找到目标 span，加上点击在当前节点内的偏移
      const sel = window.getSelection();
      if (sel && sel.focusNode === node) {
        column += sel.focusOffset;
      } else {
        // 近似取 span 中间位置
        column += Math.floor((node.textContent?.length || 0) / 2);
      }
      return column;
    }
    column += node.textContent?.length || 0;
  }

  return column;
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
  onCmdClick,
  onTokenHover,
  onTokenHoverLeave,
  flashLine,
  blameLine,
  showBlameInfo,
  blameAuthorColor,
  isBlameHovered,
  onBlameClick,
  onBlameMouseEnter,
  onBlameMouseLeave,
}: CodeLineProps) {
  const handleCodeClick = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
    if (!e.metaKey || !onCmdClick) return;
    e.preventDefault();
    e.stopPropagation();

    const codeSpan = e.currentTarget;
    const column = getColumnFromClick(e, codeSpan);
    onCmdClick(lineNum, column);
  }, [lineNum, onCmdClick]);

  const handleCodeMouseOver = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
    if (!onTokenHover) return;
    // 鼠标按下拖选文本时，跳过 hover 逻辑，避免触发状态更新导致 selection 丢失
    if (e.buttons !== 0) return;

    const target = e.target as HTMLElement;
    // 只处理 span 内的 token（有 style 属性的 span）
    if (target.tagName !== 'SPAN' || !target.style.color) return;

    const codeSpan = e.currentTarget;
    const column = getColumnFromClick(e, codeSpan);
    const rect = target.getBoundingClientRect();

    onTokenHover(lineNum, column, { x: rect.left, y: rect.bottom + 4 });
  }, [lineNum, onTokenHover]);

  const handleBlameClick = useCallback(() => {
    if (blameLine && onBlameClick) onBlameClick(blameLine);
  }, [blameLine, onBlameClick]);

  const handleBlameEnter = useCallback((e: React.MouseEvent) => {
    if (blameLine && onBlameMouseEnter) onBlameMouseEnter(blameLine, e);
  }, [blameLine, onBlameMouseEnter]);

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
        backgroundColor: isBlameHovered && blameAuthorColor ? blameAuthorColor.bg : undefined,
      }}
      className={`flex ${flashLine === lineNum ? 'flash-line' : ''} ${isInRange ? 'bg-blue-9/20' : hasComments ? 'bg-amber-9/10' : 'hover:bg-accent/50'}`}
    >
      {/* ---- Blame 列 ---- */}
      {blameLine && blameAuthorColor && (
        <>
          <div
            className="w-1 flex-shrink-0"
            style={{ backgroundColor: blameAuthorColor.border }}
          />
          <div
            className="w-48 flex-shrink-0 px-2 flex items-center gap-2 border-r border-border text-muted-foreground cursor-pointer hover:bg-accent/50"
            onMouseEnter={handleBlameEnter}
            onMouseLeave={onBlameMouseLeave}
            onClick={handleBlameClick}
            title="点击查看 commit 详情"
          >
            {showBlameInfo ? (
              <>
                <span className="font-medium" style={{ color: blameAuthorColor.border }}>{blameLine.hash}</span>
                <span className="truncate flex-1">{blameLine.author.split(' ')[0]}</span>
              </>
            ) : null}
          </div>
        </>
      )}
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
        onClick={handleCodeClick}
        onMouseOver={handleCodeMouseOver}
        onMouseLeave={onTokenHoverLeave}
      />
    </div>
  );
});
