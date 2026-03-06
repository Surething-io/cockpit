'use client';

import React, { memo, useCallback, useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { CodeComment } from '@/hooks/useComments';
import type { BlameLine } from './fileBrowser/types';

/** 相对时间格式化（中文） */
function formatRelativeTime(unixTimestamp: number): string {
  const now = Date.now();
  const diff = now - unixTimestamp * 1000;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月前`;
  const years = Math.floor(months / 12);
  return `${years}年前`;
}

// ============================================
// Inline blame annotation with custom tooltip
// ============================================

function InlineBlameAnnotation({ blame, onClick }: { blame: BlameLine; onClick?: (blame: BlameLine) => void }) {
  const [showTip, setShowTip] = useState(false);
  const spanRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const closeTip = useCallback(() => {
    setShowTip(false);
  }, []);

  // 点击外部关闭（唯一的关闭方式）
  // 区分点击和框选：mousedown 记录位置，mouseup 判断是否移动过（框选不关闭）
  useEffect(() => {
    if (!showTip) return;
    let downX = 0, downY = 0;
    const handleDown = (e: MouseEvent) => { downX = e.clientX; downY = e.clientY; };
    const handleUp = (e: MouseEvent) => {
      // 移动超过 5px 视为框选，不关闭
      if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5) return;
      const target = e.target as Node;
      if (tipRef.current?.contains(target)) return;
      if (spanRef.current?.contains(target)) return;
      closeTip();
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [showTip, closeTip]);

  const clampTip = useCallback(() => {
    const tip = tipRef.current;
    const anchor = spanRef.current;
    if (!tip || !anchor) return;

    const anchorRect = anchor.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let x = anchorRect.left;
    if (x + tipRect.width > vw - 8) x = vw - tipRect.width - 8;
    if (x < 8) x = 8;

    let y: number;
    if (anchorRect.top - tipRect.height - 4 < 0) {
      y = anchorRect.bottom + 4;
    } else {
      y = anchorRect.top - tipRect.height - 4;
    }
    if (y + tipRect.height > vh - 8) y = vh - tipRect.height - 8;

    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }, []);

  // hover 延迟显示，移走取消；显示后只能点击外部关闭
  const enterTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleEnter = useCallback(() => {
    if (showTip) return;
    clearTimeout(enterTimer.current);
    enterTimer.current = setTimeout(() => {
      setShowTip(true);
      requestAnimationFrame(() => requestAnimationFrame(clampTip));
    }, 500);
  }, [showTip, clampTip]);

  const handleLeave = useCallback(() => {
    // 只取消未触发的延迟，已显示的 tip 不关闭
    clearTimeout(enterTimer.current);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClick?.(blame);
  }, [blame, onClick]);

  // 计算初始位置：基于 anchor rect，避免首帧出现在 (0,0)
  const getInitialPos = useCallback(() => {
    const anchor = spanRef.current;
    if (!anchor) return { left: -9999, top: -9999 };
    const r = anchor.getBoundingClientRect();
    return { left: r.left, top: Math.max(0, r.top - 120) }; // 粗估 tooltip 高度 ~120px
  }, []);

  const dateStr = new Date(blame.time * 1000).toLocaleString();
  const firstLine = blame.message.split('\n')[0] || '';
  const body = blame.message.split('\n').slice(1).join('\n').trim();

  return (
    <span
      ref={spanRef}
      className="select-none text-xs text-muted-foreground/50 ml-6 cursor-pointer hover:text-muted-foreground/80"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onClick={handleClick}
    >
      {blame.author.split(' ')[0]}, {formatRelativeTime(blame.time)} · {firstLine}
      {showTip && createPortal(
        <div
          ref={tipRef}
          className="fixed z-[9999] bg-card border border-border rounded-lg shadow-xl p-3 text-xs text-foreground whitespace-pre-wrap max-w-md select-text"
          style={{ ...getInitialPos(), minWidth: 280, cursor: 'text' }}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span className="font-mono text-brand">{blame.hash}</span>
            <span className="text-muted-foreground">{blame.author}</span>
            <span className="text-muted-foreground/60">{dateStr}</span>
          </div>
          <div className="font-medium">{firstLine}</div>
          {body && <div className="mt-1 text-muted-foreground">{body}</div>}
        </div>,
        document.body,
      )}
    </span>
  );
}

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
  // ---- Inline blame annotation ----
  inlineBlameData?: BlameLine | null;
  onInlineBlameClick?: (blame: BlameLine) => void;
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
  inlineBlameData,
  onInlineBlameClick,
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
        className="flex-1 px-3 whitespace-pre overflow-x-auto select-text"
        onClick={handleCodeClick}
        onMouseOver={handleCodeMouseOver}
        onMouseLeave={onTokenHoverLeave}
      >
        <span dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
        {inlineBlameData && (
          <InlineBlameAnnotation blame={inlineBlameData} onClick={onInlineBlameClick} />
        )}
      </span>
    </div>
  );
});
