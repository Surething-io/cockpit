'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useMenuContainer } from './FileContextMenu';
import { ToolbarRenderer, type ToolbarData } from './FloatingToolbar';
import { AddCommentInput, SendToAIInput } from './CodeInputCards';
import { ViewCommentCard } from './ViewCommentCard';
import { useComments } from '@/hooks/useComments';
import { useChatContextOptional } from './ChatContext';
import { fetchAllCommentsWithCode, clearAllComments, buildAIMessage, type CodeReference } from '@/hooks/useAllComments';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { rehypeSourceLines } from '@/lib/rehypeSourceLines';
import type { CodeComment } from '@/hooks/useComments';
import { TocSidebar } from '../shared/TocSidebar';
import { ShareReviewToggle } from '../shared/ShareReviewToggle';

// ============================================
// InteractiveMarkdownPreview
// Markdown preview + selection comments + send to AI
// All interactions map back to original MD source line ranges
// ============================================

interface InteractiveMarkdownPreviewProps {
  content: string;       // Raw markdown source
  filePath: string;      // File path (comment data binding + AI reference)
  cwd: string;           // useComments + fetchAllCommentsWithCode
  onClose: () => void;
  /** Relative path for review sourceFile matching. Derived from filePath + cwd if not provided */
  sourceFile?: string;
}

interface InputCardData {
  x: number;
  y: number;
  range: { start: number; end: number };
  codeContent: string;
}

interface ViewingCommentData {
  comment: CodeComment;
  x: number;
  y: number;
}

// Walk up from a DOM node to find data-source-start/end attributes
function getSourceRange(node: Node): { start: number; end: number } | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
  if (!el || !('closest' in el)) return null;
  const block = (el as HTMLElement).closest('[data-source-start]') as HTMLElement | null;
  if (!block) return null;
  const start = block.getAttribute('data-source-start');
  const end = block.getAttribute('data-source-end');
  if (!start || !end) return null;
  return { start: parseInt(start, 10), end: parseInt(end, 10) };
}

// Keep rehypePlugins array reference stable to avoid ReactMarkdown re-renders
const REHYPE_PLUGINS = [rehypeSourceLines];

export function InteractiveMarkdownPreview({
  content,
  filePath,
  cwd,
  onClose,
  sourceFile: sourceFileProp,
}: InteractiveMarkdownPreviewProps) {
  // Derive sourceFile (relative path)
  const sourceFile = sourceFileProp
    || (cwd && filePath.startsWith(cwd) ? filePath.slice(cwd.endsWith('/') ? cwd.length : cwd.length + 1) : filePath);
  const { t } = useTranslation();
  // === Refs ===
  const containerRef = useRef<HTMLDivElement>(null);
  const floatingToolbarRef = useRef<ToolbarData | null>(null);
  const bumpToolbarRef = useRef<() => void>(() => {});

  // === Hooks ===
  const menuContainer = useMenuContainer();
  const chatContext = useChatContextOptional();
  const { comments, addComment, updateComment, deleteComment, refresh: refreshComments } = useComments({ cwd, filePath });
  const [isMounted, setIsMounted] = useState(false);

  // === Floating UI state ===
  const [addCommentInput, setAddCommentInput] = useState<InputCardData | null>(null);
  const [sendToAIInput, setSendToAIInput] = useState<InputCardData | null>(null);
  const [viewingComment, setViewingComment] = useState<ViewingCommentData | null>(null);

  // === Source lines for extracting original content ===
  const sourceLines = useMemo(() => content.split('\n'), [content]);

  useEffect(() => { queueMicrotask(() => setIsMounted(true)); }, []);

  // ============================================
  // Selection detection → FloatingToolbar
  // Same ref pattern as useCodeViewerLogic
  // ============================================
  useEffect(() => {
    const area = containerRef.current;
    if (!area) return;
    let isDragging = false;
    let downX = 0, downY = 0;

    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      downX = e.clientX;
      downY = e.clientY;
      // Clear previous toolbar
      if (floatingToolbarRef.current) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      isDragging = false;

      // Ignore clicks on the toolbar/input card itself
      const target = e.target as HTMLElement;
      if (target.closest?.('.floating-toolbar') || target.closest?.('[data-comment-card]')) return;

      const moved = Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
        return;
      }

      const selectedText = selection.toString();
      if (!selectedText.trim() || !moved) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
        return;
      }

      const range = selection.getRangeAt(0);
      if (!area.contains(range.commonAncestorContainer)) return;

      // Find data-source-* attributes from both ends of the selection
      const startRange = getSourceRange(range.startContainer);
      const endRange = getSourceRange(range.endContainer);

      if (startRange && endRange) {
        const minStart = Math.min(startRange.start, endRange.start);
        const maxEnd = Math.max(startRange.end, endRange.end);
        floatingToolbarRef.current = {
          x: e.clientX,
          y: e.clientY,
          range: { start: minStart, end: maxEnd },
          selectedText,
        };
        bumpToolbarRef.current();
      }
    };

    const handleSelectionChange = () => {
      if (isDragging) return;
      if (!floatingToolbarRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
      }
    };

    area.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      area.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, []);

  // ============================================
  // Toolbar action handlers
  // ============================================

  const handleToolbarAddComment = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    setAddCommentInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      codeContent: toolbar.selectedText,
    });
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
  }, []);

  const handleToolbarSendToAI = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    setSendToAIInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      codeContent: toolbar.selectedText,
    });
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
  }, []);

  // Submit comment
  const handleCommentSubmit = useCallback(async (commentContent: string) => {
    if (!addCommentInput) return;
    await addComment(addCommentInput.range.start, addCommentInput.range.end, commentContent);
    setAddCommentInput(null);
  }, [addCommentInput, addComment]);

  // Submit to AI — same logic as useCodeViewerLogic
  const handleSendToAISubmit = useCallback(async (question: string) => {
    if (!sendToAIInput || !chatContext) return;

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

      // Current selection: extract corresponding lines from the raw Markdown source
      const startIdx = Math.max(0, sendToAIInput.range.start - 1);
      const endIdx = Math.min(sourceLines.length, sendToAIInput.range.end);
      const selectedSourceContent = sourceLines.slice(startIdx, endIdx).join('\n');

      references.push({
        filePath,
        startLine: sendToAIInput.range.start,
        endLine: sendToAIInput.range.end,
        codeContent: selectedSourceContent,
      });

      const message = buildAIMessage(references, question);
      chatContext.sendMessage(message);

      await clearAllComments(cwd);
      refreshComments();
      setSendToAIInput(null);
    } catch (err) {
      console.error('Failed to send to AI:', err);
    }
  }, [sendToAIInput, chatContext, filePath, cwd, sourceLines, refreshComments]);

  // ============================================
  // Existing comment indicator positioning
  // ============================================

  // Group comments by line range
  const commentGroups = useMemo(() => {
    if (comments.length === 0) return [];
    // Use startLine-endLine as the grouping key
    const map = new Map<string, CodeComment[]>();
    for (const c of comments) {
      const key = `${c.startLine}-${c.endLine}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return Array.from(map.entries()).map(([key, group]) => ({
      key,
      startLine: group[0].startLine,
      endLine: group[0].endLine,
      comments: group,
    }));
  }, [comments]);

  const [commentPositions, setCommentPositions] = useState<
    Array<{ key: string; top: number; comments: CodeComment[] }>
  >([]);

  useEffect(() => {
    if (commentGroups.length === 0 || !containerRef.current) {
      queueMicrotask(() => setCommentPositions([]));
      return;
    }
    // Wait briefly for MarkdownRenderer to finish rendering
    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;
      const positions: typeof commentPositions = [];
      const allAnnotated = container.querySelectorAll('[data-source-start]');

      for (const group of commentGroups) {
        // Find the smallest DOM element that contains the comment line range
        let bestEl: HTMLElement | null = null;
        let bestSize = Infinity;
        for (const el of allAnnotated) {
          const s = parseInt(el.getAttribute('data-source-start')!, 10);
          const e = parseInt(el.getAttribute('data-source-end')!, 10);
          if (s <= group.startLine && e >= group.endLine) {
            const size = e - s;
            if (size < bestSize) {
              bestSize = size;
              bestEl = el as HTMLElement;
            }
          }
        }
        if (bestEl) {
          const containerRect = container.getBoundingClientRect();
          const elRect = bestEl.getBoundingClientRect();
          positions.push({
            key: group.key,
            top: elRect.top - containerRect.top + container.scrollTop,
            comments: group.comments,
          });
        }
      }
      setCommentPositions(positions);
    }, 100);
    return () => clearTimeout(timer);
  }, [commentGroups, content]);

  // ============================================
  // ESC key layered dismissal
  // ============================================
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (sendToAIInput) { setSendToAIInput(null); e.stopPropagation(); return; }
      if (addCommentInput) { setAddCommentInput(null); e.stopPropagation(); return; }
      if (floatingToolbarRef.current) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
        e.stopPropagation();
        return;
      }
      if (viewingComment) { setViewingComment(null); e.stopPropagation(); return; }
      onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [sendToAIInput, addCommentInput, viewingComment, onClose]);

  // ============================================
  // Render
  // ============================================
  return (
    <>
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
        <span className="text-sm font-medium text-foreground truncate">{filePath}</span>
        <div className="flex items-center gap-3">
          <ShareReviewToggle content={content} sourceFile={sourceFile} />
          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            title={t('common.close')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body: TOC sidebar + content */}
      <div className="flex-1 flex overflow-hidden">
        <TocSidebar content={content} containerRef={containerRef} />

        {/* Scrollable content */}
        <div className="flex-1 overflow-auto relative" ref={containerRef}>
          <div className="p-6">
            <MarkdownRenderer
              content={content}
              rehypePlugins={REHYPE_PLUGINS}
            />
          </div>

          {/* Comment indicators */}
          {commentPositions.map(({ key, top, comments: lineComments }) => (
            <div
              key={key}
              className="absolute right-3 cursor-pointer z-10"
              style={{ top }}
              onClick={(e) => {
                e.stopPropagation();
                setViewingComment({
                  comment: lineComments[0],
                  x: e.clientX,
                  y: e.clientY,
                });
              }}
            >
              <div className="w-5 h-5 rounded-full bg-amber-500/80 text-white text-xs flex items-center justify-center shadow-sm hover:bg-amber-500 transition-colors">
                {lineComments.length}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Floating UI via Portal */}
      {isMounted && menuContainer && createPortal(
        <>
          <ToolbarRenderer
            floatingToolbarRef={floatingToolbarRef}
            bumpRef={bumpToolbarRef}
            container={menuContainer}
            onAddComment={handleToolbarAddComment}
            onSendToAI={handleToolbarSendToAI}
            isChatLoading={chatContext?.isLoading}
          />
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
              filePath={filePath}
              codeContent={sendToAIInput.codeContent}
              container={menuContainer}
              onSubmit={handleSendToAISubmit}
              onClose={() => setSendToAIInput(null)}
              isChatLoading={chatContext?.isLoading}
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
        menuContainer,
      )}
    </>
  );
}
