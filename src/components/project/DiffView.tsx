'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useComments, type CodeComment } from '@/hooks/useComments';
import { fetchAllCommentsWithCode, clearAllComments, buildAIMessage, type CodeReference } from '@/hooks/useAllComments';
import { useMenuContainer } from './FileContextMenu';
import { useChatContextOptional } from './ChatContext';
import { AddCommentInput, SendToAIInput } from './CodeInputCards';
import { computeLineDiff } from './diffAlgorithm';
import { useLineHighlight, HighlightedContent } from './useLineHighlight';
import { DiffMinimap } from './DiffMinimap';
import { FloatingToolbar } from './FloatingToolbar';
import { ViewCommentCard } from './ViewCommentCard';

// Re-export for external consumers
export { computeLineDiff, type DiffLine } from './diffAlgorithm';

// ============================================
// Types
// ============================================

interface DiffViewProps {
  oldContent: string;
  newContent: string;
  filePath: string;
  isNew?: boolean;
  isDeleted?: boolean;
  // Comment support
  cwd?: string;
  enableComments?: boolean;
}

// ============================================
// Row height constant
// ============================================
const ROW_HEIGHT = 20;

// ============================================
// Main DiffView Component (Split View)
// ============================================

export function DiffView({ oldContent, newContent, filePath, isNew = false, isDeleted = false, cwd, enableComments = false }: DiffViewProps) {
  const diffLines = useMemo(() => computeLineDiff(oldContent, newContent), [oldContent, newContent]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const isSyncingHScrollRef = useRef(false);
  const [isMounted, setIsMounted] = useState(false);

  // Menu container for portal mounting (keeps floating elements within second screen)
  const menuContainer = useMenuContainer();

  // Chat context for "Send to AI" feature
  const chatContext = useChatContextOptional();

  // Comment state
  const commentsEnabled = enableComments && !!cwd;
  const { comments, addComment, updateComment, deleteComment, refresh: refreshComments } = useComments({
    cwd: cwd || '',
    filePath,
  });

  const [viewingComment, setViewingComment] = useState<{
    comment: CodeComment;
    x: number;
    y: number;
  } | null>(null);

  const [floatingToolbar, setFloatingToolbar] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
    codeContent: string;
  } | null>(null);

  const [addCommentInput, setAddCommentInput] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
    codeContent: string;
  } | null>(null);

  const [sendToAIInput, setSendToAIInput] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
    codeContent: string;
  } | null>(null);

  // Track mount state for Portal
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Lines with comments (based on new file line numbers)
  const linesWithComments = useMemo(() => {
    const set = new Set<number>();
    for (const comment of comments) {
      for (let i = comment.startLine; i <= comment.endLine; i++) {
        set.add(i);
      }
    }
    return set;
  }, [comments]);

  // Comments grouped by end line
  const commentsByEndLine = useMemo(() => {
    const map = new Map<number, CodeComment[]>();
    for (const comment of comments) {
      const line = comment.endLine;
      if (!map.has(line)) map.set(line, []);
      map.get(line)!.push(comment);
    }
    return map;
  }, [comments]);

  // Handle text selection in right panel
  useEffect(() => {
    if (!commentsEnabled) return;

    const handleMouseUp = (e: MouseEvent) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.toString().trim()) {
        setFloatingToolbar(null);
        return;
      }

      const range = selection.getRangeAt(0);
      const container = rightPanelRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) return;

      // Find line numbers from DOM
      const getLineFromNode = (node: Node): number | null => {
        if (!document.contains(node)) return null;
        let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
        while (el && el !== container) {
          const lineRow = el.closest('[data-new-line]');
          if (lineRow) {
            return parseInt(lineRow.getAttribute('data-new-line') || '0', 10);
          }
          el = el.parentElement;
        }
        return null;
      };

      const startLine = getLineFromNode(range.startContainer);
      const endLine = getLineFromNode(range.endContainer);

      if (startLine && endLine) {
        const minLine = Math.min(startLine, endLine);
        const maxLine = Math.max(startLine, endLine);

        // Extract code content from new file lines in diffLines
        const codeLines: string[] = [];
        let lineNum = 0;
        for (const dl of diffLines) {
          if (dl.type === 'unchanged' || dl.type === 'added') {
            lineNum++;
            if (lineNum >= minLine && lineNum <= maxLine) {
              codeLines.push(dl.content);
            }
          }
        }
        const codeContent = codeLines.join('\n');

        setFloatingToolbar({
          x: e.clientX,
          y: e.clientY,
          range: { start: minLine, end: maxLine },
          codeContent,
        });
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [commentsEnabled, diffLines]);

  const handleCommentBubbleClick = useCallback((comment: CodeComment, e: React.MouseEvent) => {
    e.stopPropagation();
    setViewingComment({ comment, x: e.clientX, y: e.clientY });
    setFloatingToolbar(null);
    setAddCommentInput(null);
    setSendToAIInput(null);
  }, []);

  const handleToolbarAddComment = useCallback(() => {
    if (!floatingToolbar) return;
    setAddCommentInput({
      x: floatingToolbar.x,
      y: floatingToolbar.y,
      range: floatingToolbar.range,
      codeContent: floatingToolbar.codeContent,
    });
    setFloatingToolbar(null);
  }, [floatingToolbar]);

  const handleToolbarSendToAI = useCallback(() => {
    if (!floatingToolbar) return;
    setSendToAIInput({
      x: floatingToolbar.x,
      y: floatingToolbar.y,
      range: floatingToolbar.range,
      codeContent: floatingToolbar.codeContent,
    });
    setFloatingToolbar(null);
  }, [floatingToolbar]);

  const handleSendToAISubmit = useCallback(async (question: string) => {
    if (!sendToAIInput || !chatContext || !cwd) return;

    try {
      const allComments = await fetchAllCommentsWithCode(cwd);
      const references: CodeReference[] = [];

      for (const comment of allComments) {
        references.push({
          filePath: comment.filePath,
          startLine: comment.startLine,
          endLine: comment.endLine,
          codeContent: comment.codeContent,
          note: comment.content || undefined,
        });
      }

      references.push({
        filePath,
        startLine: sendToAIInput.range.start,
        endLine: sendToAIInput.range.end,
        codeContent: sendToAIInput.codeContent,
      });

      const message = buildAIMessage(references, question);
      chatContext.sendMessage(message);

      await clearAllComments(cwd);
      refreshComments();
      setSendToAIInput(null);
    } catch (err) {
      console.error('Failed to send to AI:', err);
    }
  }, [sendToAIInput, chatContext, filePath, cwd, refreshComments]);

  const handleCommentSubmit = useCallback(async (content: string) => {
    if (!addCommentInput) return;
    await addComment(addCommentInput.range.start, addCommentInput.range.end, content);
    setAddCommentInput(null);
  }, [addCommentInput, addComment]);

  // Sync horizontal scroll between left and right panels
  useEffect(() => {
    const leftPanel = leftPanelRef.current;
    const rightPanel = rightPanelRef.current;
    if (!leftPanel || !rightPanel) return;

    const syncHScroll = (source: HTMLDivElement, target: HTMLDivElement) => {
      if (isSyncingHScrollRef.current) return;
      isSyncingHScrollRef.current = true;
      target.scrollLeft = source.scrollLeft;
      requestAnimationFrame(() => {
        isSyncingHScrollRef.current = false;
      });
    };

    const handleLeftScroll = () => syncHScroll(leftPanel, rightPanel);
    const handleRightScroll = () => syncHScroll(rightPanel, leftPanel);

    leftPanel.addEventListener('scroll', handleLeftScroll);
    rightPanel.addEventListener('scroll', handleRightScroll);

    return () => {
      leftPanel.removeEventListener('scroll', handleLeftScroll);
      rightPanel.removeEventListener('scroll', handleRightScroll);
    };
  }, []);

  // Split into left and right columns
  const { leftLines, rightLines } = useMemo(() => {
    const left: { lineNum: number; content: string; type: 'unchanged' | 'removed'; originalIdx: number }[] = [];
    const right: { lineNum: number; content: string; type: 'unchanged' | 'added'; originalIdx: number }[] = [];

    let leftIdx = 0;
    let rightIdx = 0;

    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i];
      if (line.type === 'unchanged') {
        // Align: pad with empty lines if needed
        while (left.length < right.length) {
          left.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
        }
        while (right.length < left.length) {
          right.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
        }
        leftIdx++;
        rightIdx++;
        left.push({ lineNum: leftIdx, content: line.content, type: 'unchanged', originalIdx: i });
        right.push({ lineNum: rightIdx, content: line.content, type: 'unchanged', originalIdx: i });
      } else if (line.type === 'removed') {
        leftIdx++;
        left.push({ lineNum: leftIdx, content: line.content, type: 'removed', originalIdx: i });
      } else if (line.type === 'added') {
        rightIdx++;
        right.push({ lineNum: rightIdx, content: line.content, type: 'added', originalIdx: i });
      }
    }

    // Final alignment
    while (left.length < right.length) {
      left.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
    }
    while (right.length < left.length) {
      right.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
    }

    return { leftLines: left, rightLines: right };
  }, [diffLines]);

  const allLines = useMemo(() => diffLines.map(line => line.content), [diffLines]);
  const highlightedLines = useLineHighlight(allLines, filePath);

  // Virtual scrolling
  const virtualizer = useVirtualizer({
    count: leftLines.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Adjust left/right width based on file status: new file 25%/75%, deleted 75%/25%, otherwise 50%/50%
  const leftWidth = isNew ? 'w-1/4' : isDeleted ? 'w-3/4' : 'w-1/2';
  const rightWidth = isNew ? 'w-3/4' : isDeleted ? 'w-1/4' : 'w-1/2';

  // Prepare minimap line types
  const minimapLines = useMemo(() => leftLines.map((leftLine, idx) => {
    const rightLine = rightLines[idx];
    if (leftLine.type === 'removed') return { type: 'removed' as const };
    if (rightLine?.type === 'added') return { type: 'added' as const };
    return { type: 'unchanged' as const };
  }), [leftLines, rightLines]);

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="font-mono flex flex-col h-full text-sm">
      {/* Header row - fixed */}
      <div className="flex flex-shrink-0 border-b border-border">
        <div className={`${leftWidth} min-w-0 px-2 py-1 bg-accent text-muted-foreground text-center text-xs font-medium border-r border-border`}>
          {isNew ? '(New File)' : isDeleted ? 'Deleted' : 'Old'}
        </div>
        <div className={`${rightWidth} min-w-0 px-2 py-1 bg-accent text-muted-foreground text-center text-xs font-medium`}>
          {isDeleted ? '(Deleted)' : 'New'}
        </div>
        <div className="w-4 flex-shrink-0 bg-accent" />
      </div>
      {/* Content row - flex-1 with min-h-0 to prevent flex stretch */}
      <div className="flex-1 min-h-0 flex">
        {/* Scroll wrapper - single vertical scroll container for virtualized rendering */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="flex" style={{ height: `${totalSize}px` }}>
            {/* Left Panel - Old (horizontal scroll only) */}
            <div
              ref={leftPanelRef}
              className={`${leftWidth} overflow-x-auto border-r border-border`}
            >
              <div className="min-w-max h-full" style={{ position: 'relative' }}>
                {virtualItems.map((virtualItem) => {
                  const line = leftLines[virtualItem.index];
                  return (
                    <div
                      key={virtualItem.key}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualItem.size}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                      className={`flex ${line.type === 'removed' ? 'bg-red-9/15 dark:bg-red-9/25' : ''}`}
                    >
                      <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
                        {line.lineNum || ''}
                      </span>
                      <HighlightedContent
                        content={line.content}
                        highlightedLine={line.originalIdx >= 0 ? highlightedLines.get(line.originalIdx) : undefined}
                        className="whitespace-pre pl-2"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Right Panel - New (horizontal scroll only) */}
            <div
              ref={rightPanelRef}
              className={`${rightWidth} overflow-x-auto`}
            >
              <div className="min-w-max h-full" style={{ position: 'relative' }}>
                {virtualItems.map((virtualItem) => {
                  const line = rightLines[virtualItem.index];
                  const lineNum = line?.lineNum || 0;
                  const hasComments = lineNum > 0 && linesWithComments.has(lineNum);
                  const lineComments = commentsByEndLine.get(lineNum);
                  const firstComment = lineComments?.[0];
                  const isInCommentRange = addCommentInput && lineNum >= addCommentInput.range.start && lineNum <= addCommentInput.range.end;
                  const isInAIRange = sendToAIInput && lineNum >= sendToAIInput.range.start && lineNum <= sendToAIInput.range.end;
                  const isInRange = isInCommentRange || isInAIRange;

                  return (
                    <div
                      key={virtualItem.key}
                      data-new-line={lineNum || undefined}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: `${virtualItem.size}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                      className={`flex ${
                        isInRange ? 'bg-blue-9/20' :
                        hasComments ? 'bg-amber-9/10' :
                        line?.type === 'added' ? 'bg-green-9/15 dark:bg-green-9/25' : ''
                      }`}
                    >
                      <span className={`flex-shrink-0 flex items-center gap-0.5 pr-1 text-slate-9 select-none border-r border-border ${
                        isInRange ? 'bg-blue-9/30' : ''
                      }`} style={{ width: commentsEnabled ? '52px' : '40px' }}>
                        {/* Comment bubble */}
                        {commentsEnabled && lineNum > 0 && hasComments && firstComment && (
                          <button
                            onClick={(e) => handleCommentBubbleClick(firstComment, e)}
                            className="w-4 h-4 flex items-center justify-center rounded hover:bg-accent text-amber-9"
                            title={`${lineComments?.length} 条评论`}
                          >
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
                            </svg>
                          </button>
                        )}
                        {commentsEnabled && lineNum > 0 && !hasComments && <span className="w-4" />}
                        <span className="flex-1 text-right pr-1">{lineNum || ''}</span>
                      </span>
                      <HighlightedContent
                        content={line?.content || ''}
                        highlightedLine={line?.originalIdx >= 0 ? highlightedLines.get(line.originalIdx) : undefined}
                        className="whitespace-pre pl-2"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        {/* Minimap - outside scroll container, fixed height */}
        <DiffMinimap
          lines={minimapLines}
          containerRef={scrollContainerRef}
        />
      </div>

      {/* Floating elements via Portal to menu container (keeps within second screen) */}
      {isMounted && menuContainer && createPortal(
        <>
          {floatingToolbar && (
            <FloatingToolbar
              x={floatingToolbar.x}
              y={floatingToolbar.y}
              container={menuContainer}
              onAddComment={handleToolbarAddComment}
              onSendToAI={handleToolbarSendToAI}
              isChatLoading={chatContext?.isLoading ?? false}
            />
          )}
          {addCommentInput && (
            <AddCommentInput
              x={addCommentInput.x}
              y={addCommentInput.y}
              range={addCommentInput.range}
              codeContent={addCommentInput.codeContent}
              container={menuContainer}
              onSubmit={handleCommentSubmit}
              onClose={() => setAddCommentInput(null)}
            />
          )}
          {sendToAIInput && (
            <SendToAIInput
              x={sendToAIInput.x}
              y={sendToAIInput.y}
              range={sendToAIInput.range}
              container={menuContainer}
              onSubmit={handleSendToAISubmit}
              onClose={() => setSendToAIInput(null)}
            />
          )}
          {viewingComment && (
            <ViewCommentCard
              x={viewingComment.x}
              y={viewingComment.y}
              comment={viewingComment.comment}
              container={menuContainer}
              onClose={() => setViewingComment(null)}
              onUpdateComment={updateComment}
              onDeleteComment={deleteComment}
            />
          )}
        </>,
        menuContainer
      )}
    </div>
  );
}

// ============================================
// Unified Diff View Component (with virtual scrolling)
// ============================================

export function DiffUnifiedView({ oldContent, newContent, filePath }: Omit<DiffViewProps, 'isNew' | 'isDeleted'>) {
  const diffLines = useMemo(() => computeLineDiff(oldContent, newContent), [oldContent, newContent]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const allLines = useMemo(() => diffLines.map(line => line.content), [diffLines]);
  const highlightedLines = useLineHighlight(allLines, filePath);

  const virtualizer = useVirtualizer({
    count: diffLines.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  return (
    <div ref={scrollContainerRef} className="font-mono text-sm overflow-auto h-full">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const line = diffLines[virtualItem.index];
          return (
            <div
              key={virtualItem.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
              className={`flex ${
                line.type === 'removed'
                  ? 'bg-red-9/15 dark:bg-red-9/25'
                  : line.type === 'added'
                  ? 'bg-green-9/15 dark:bg-green-9/25'
                  : ''
              }`}
            >
              {/* Line numbers */}
              <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
                {line.type !== 'added' ? line.oldLineNum : ''}
              </span>
              <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
                {line.type !== 'removed' ? line.newLineNum : ''}
              </span>
              {/* Symbol */}
              <span
                className={`w-6 flex-shrink-0 text-center select-none ${
                  line.type === 'removed'
                    ? 'text-red-11'
                    : line.type === 'added'
                    ? 'text-green-11'
                    : 'text-slate-9'
                }`}
              >
                {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
              </span>
              {/* Content with syntax highlighting */}
              <HighlightedContent
                content={line.content}
                highlightedLine={highlightedLines.get(virtualItem.index)}
                className="flex-1 whitespace-pre pl-1"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Default export is the split view
export default DiffView;
