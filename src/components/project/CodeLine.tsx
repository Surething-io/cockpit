'use client';

import React, { memo, useCallback, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { CodeComment } from '@/hooks/useComments';
import type { BlameLine } from './fileBrowser/types';

/** Format relative time */
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
  const spanRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  // Track all state with refs, zero useState → showing/hiding tooltip triggers no re-render
  const showingRef = useRef(false);
  const onCardRef = useRef(false);
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickCtxRef = useRef<{ down: (e: MouseEvent) => void; up: (e: MouseEvent) => void } | null>(null);
  const blameRef = useRef(blame);
  blameRef.current = blame;
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  const positionTip = useCallback(() => {
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

  // Imperative hide (no setState)
  const hideTip = useCallback(() => {
    if (enterTimerRef.current) { clearTimeout(enterTimerRef.current); enterTimerRef.current = null; }
    if (leaveTimerRef.current) { clearTimeout(leaveTimerRef.current); leaveTimerRef.current = null; }
    showingRef.current = false;
    onCardRef.current = false;
    if (tipRef.current) tipRef.current.style.display = 'none';
    // Remove outside click listener
    if (clickCtxRef.current) {
      document.removeEventListener('mousedown', clickCtxRef.current.down);
      document.removeEventListener('mouseup', clickCtxRef.current.up);
      clickCtxRef.current = null;
    }
  }, []);

  // Imperative show (no setState)
  const showTip = useCallback(() => {
    const tip = tipRef.current;
    if (!tip || showingRef.current) return;
    showingRef.current = true;
    // Show off-screen first, then position after next frame measurement
    tip.style.left = '-9999px';
    tip.style.top = '-9999px';
    tip.style.display = 'block';
    requestAnimationFrame(() => requestAnimationFrame(positionTip));
    // Add outside click to close (distinguish click from drag-select)
    let downX = 0, downY = 0;
    const isInside = (target: Node) =>
      !!(tipRef.current?.contains(target) || spanRef.current?.contains(target));
    const handleDown = (e: MouseEvent) => { downX = e.clientX; downY = e.clientY; };
    const handleUp = (e: MouseEvent) => {
      if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5) return;
      if (!isInside(e.target as Node)) hideTip();
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('mouseup', handleUp);
    clickCtxRef.current = { down: handleDown, up: handleUp };
  }, [positionTip, hideTip]);

  // span mouseenter → delayed show (skip if selection exists to avoid interfering with drag-select)
  const handleEnter = useCallback(() => {
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
    if (leaveTimerRef.current) { clearTimeout(leaveTimerRef.current); leaveTimerRef.current = null; }
    if (showingRef.current) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    enterTimerRef.current = setTimeout(showTip, 500);
  }, [showTip]);

  // span mouseleave → delayed close, giving user time to move to the card
  const handleLeave = useCallback(() => {
    if (enterTimerRef.current) { clearTimeout(enterTimerRef.current); enterTimerRef.current = null; }
    if (!showingRef.current) return;
    leaveTimerRef.current = setTimeout(() => {
      if (!onCardRef.current) hideTip();
    }, 200);
  }, [hideTip]);

  // Card enter → cancel close
  const handleCardEnter = useCallback(() => {
    onCardRef.current = true;
    if (leaveTimerRef.current) { clearTimeout(leaveTimerRef.current); leaveTimerRef.current = null; }
  }, []);

  // Card leave → close immediately
  const handleCardLeave = useCallback(() => {
    onCardRef.current = false;
    hideTip();
  }, [hideTip]);

  // Click card to open blame details (does not trigger when text is selected within tooltip)
  const handleTipClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const sel = window.getSelection();
    // Only check selection within tooltip to avoid interference from external selections
    if (sel && sel.toString().length > 0 && tipRef.current?.contains(sel.anchorNode)) return;
    onClickRef.current?.(blameRef.current);
    hideTip();
  }, [hideTip]);

  // Clean up on component unmount
  useEffect(() => () => hideTip(), [hideTip]);

  const dateStr = new Date(blame.time * 1000).toLocaleString();
  const firstLine = blame.message.split('\n')[0] || '';
  const body = blame.message.split('\n').slice(1).join('\n').trim();

  // Tooltip always rendered (display:none), show/hide toggled imperatively via ref, no re-render
  // Portal is outside span (Fragment) to avoid React Portal event bubbling interfering with span's onMouseLeave
  return (
    <>
      <span
        ref={spanRef}
        className="select-none text-xs text-muted-foreground/50 ml-6 cursor-default hover:text-muted-foreground/80"
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        {blame.author.split(' ')[0]}, {formatRelativeTime(blame.time)} · {firstLine}
      </span>
      {createPortal(
        <div
          ref={tipRef}
          className="fixed z-[9999] bg-card border border-border rounded-lg shadow-xl p-3 text-xs text-foreground whitespace-pre-wrap max-w-md select-text"
          style={{ display: 'none', minWidth: 280, cursor: 'text' }}
          data-inline-blame-tip=""
          onMouseEnter={handleCardEnter}
          onMouseLeave={handleCardLeave}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span className="font-mono text-brand">{blame.hash}</span>
            <span className="text-muted-foreground">{blame.author}</span>
            <span className="text-muted-foreground/60">{new Date(blame.time * 1000).toLocaleString()}</span>
          </div>
          <div className="font-medium">{firstLine}</div>
          {body && <div className="mt-1 text-muted-foreground">{body}</div>}
          <div className="mt-2 text-[11px] text-brand border-t border-border pt-2 cursor-pointer hover:underline" onClick={handleTipClick}>点击查看详情</div>
        </div>,
        document.body,
      )}
    </>
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
// Memoized Code Line Component - avoid re-renders triggered by floatingToolbar state changes
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
  /** Minimum characters for line number (e.g. 4 means up to 9999 lines), for consistent width */
  lineNumChars: number;
  commentsEnabled: boolean;
  virtualItemSize: number;
  virtualItemStart: number;
  onCommentBubbleClick: (comment: CodeComment, e: React.MouseEvent) => void;
  /** Cmd+Click to jump to definition */
  onCmdClick?: (line: number, column: number) => void;
  /** Token hover events */
  onTokenHover?: (line: number, column: number, rect: { x: number; y: number }) => void;
  onTokenHoverLeave?: () => void;
  /** Line number to flash-highlight */
  flashLine?: number | null;
  // ---- Blame-related ----
  blameLine?: BlameLine;
  /** Whether to show blame info (only first line of each commit group shows it) */
  showBlameInfo?: boolean;
  blameAuthorColor?: { bg: string; border: string };
  isBlameHovered?: boolean;
  onBlameClick?: (line: BlameLine) => void;
  onBlameMouseEnter?: (line: BlameLine, e: React.MouseEvent) => void;
  onBlameMouseLeave?: () => void;
  // ---- Inline blame annotation ----
  inlineBlameData?: BlameLine | null;
  onInlineBlameClick?: (blame: BlameLine) => void;
  // ---- Vi mode ----
  /** Vi-mode: whether this is the cursor line */
  isCursorLine?: boolean;
  /** Vi-mode: cursor column (0-based), only valid when isCursorLine is true */
  cursorCol?: number;
}

/**
 * Calculate column from click position
 * Uses caretRangeFromPoint to precisely locate the text offset at the click position,
 * then walks text nodes to accumulate the column
 */
function getColumnFromClick(e: React.MouseEvent, codeSpan: HTMLElement): number {
  // Use browser API to precisely get the text node and offset at the click position
  const range = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!range || !codeSpan.contains(range.startContainer)) {
    return 1;
  }

  const targetNode = range.startContainer;
  const targetOffset = range.startOffset;

  // Walk all text nodes in the code line to accumulate column up to the target node
  const walker = document.createTreeWalker(codeSpan, NodeFilter.SHOW_TEXT);
  let column = 1;
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    if (node === targetNode) {
      column += targetOffset;
      return column;
    }
    column += node.textContent?.length || 0;
  }

  return column;
}

/**
 * Insert vi block cursor into highlighted HTML.
 * Walk HTML text nodes, find the col-th character and wrap it with <span class="vi-char-cursor">.
 * Correctly handles HTML entities (&lt; etc.) and multi-width characters (CJK 2ch).
 */
function insertCursorIntoHtml(html: string, col: number): string {
  let textIdx = 0;
  let i = 0;

  while (i < html.length) {
    // Skip HTML tags
    if (html[i] === '<') {
      const closeIdx = html.indexOf('>', i);
      if (closeIdx !== -1) {
        i = closeIdx + 1;
        continue;
      }
    }

    // Reached target character position
    if (textIdx === col) {
      let charEnd: number;
      if (html[i] === '&') {
        // HTML entities (&lt; &gt; &amp; etc.) count as a single character
        const semiIdx = html.indexOf(';', i);
        charEnd = (semiIdx !== -1 && semiIdx - i < 10) ? semiIdx + 1 : i + 1;
      } else {
        charEnd = i + 1;
      }
      const charHtml = html.substring(i, charEnd);
      return (
        html.substring(0, i) +
        '<span class="vi-char-cursor">' + charHtml + '</span>' +
        html.substring(charEnd)
      );
    }

    // Advance to next character
    if (html[i] === '&') {
      const semiIdx = html.indexOf(';', i);
      i = (semiIdx !== -1 && semiIdx - i < 10) ? semiIdx + 1 : i + 1;
    } else {
      i++;
    }
    textIdx++;
  }

  // Cursor at end of line (empty line or overflow) — show a space-wide cursor block
  return html + '<span class="vi-char-cursor"> </span>';
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
  isCursorLine,
  cursorCol,
}: CodeLineProps) {
  // Inline vi block cursor into highlighted HTML (correctly handles CJK and other multi-width characters)
  const finalHtml = useMemo(() => {
    if (!isCursorLine || cursorCol == null) return highlightedHtml;
    return insertCursorIntoHtml(highlightedHtml, cursorCol);
  }, [highlightedHtml, isCursorLine, cursorCol]);

  const handleCodeClick = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
    if (!e.metaKey || !onCmdClick) return;
    e.preventDefault();
    e.stopPropagation();

    const codeSpan = e.currentTarget;
    const column = getColumnFromClick(e, codeSpan);

    // Clear text selection that Cmd+Click may produce, to avoid interfering with subsequent interactions
    window.getSelection()?.removeAllRanges();

    onCmdClick(lineNum, column);
  }, [lineNum, onCmdClick]);

  const handleCodeMouseOver = useCallback((e: React.MouseEvent<HTMLSpanElement>) => {
    if (!onTokenHover) return;
    // Skip hover logic when mouse button is held (drag-selecting), to avoid state updates losing selection
    if (e.buttons !== 0) return;
    // Skip when there is a selection, to avoid interfering with selection interaction
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;

    const target = e.target as HTMLElement;
    // Only handle tokens inside span (spans with style attribute)
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
      className={`flex ${flashLine === lineNum ? 'flash-line' : ''} ${isCursorLine ? 'vi-cursor-line' : ''} ${isInRange ? 'bg-blue-9/20' : hasComments ? 'bg-amber-9/10' : 'hover:bg-accent/50'}`}
    >
      {/* ---- Sticky: Blame + line number (pinned to left on horizontal scroll) ---- */}
      <div
        className="flex shrink-0 sticky left-0 z-[2] bg-secondary"
        style={{ backgroundColor: isBlameHovered && blameAuthorColor ? blameAuthorColor.bg : undefined }}
      >
        {/* ---- Blame column ---- */}
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
      </div>
      <span
        className="flex-1 px-3 whitespace-pre select-text"
        onClick={handleCodeClick}
        onMouseOver={handleCodeMouseOver}
        onMouseLeave={onTokenHoverLeave}
        data-code-content
      >
        <span dangerouslySetInnerHTML={{ __html: finalHtml }} />
        {inlineBlameData && (
          <InlineBlameAnnotation blame={inlineBlameData} onClick={onInlineBlameClick} />
        )}
      </span>
    </div>
  );
});
