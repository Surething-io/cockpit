'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useMenuContainer } from '@cockpit/shared-ui';
import { ToolbarRenderer } from '@cockpit/shared-ui';
import { AddCommentInput, SendToAIInput } from '@cockpit/shared-ui';
import { ViewCommentCard } from './index';
import { useComments } from '@cockpit/feature-comments';
import { useAIBridge } from '@cockpit/shared-ui';
import { fetchAllCommentsWithCode, clearAllComments, buildAIMessage, type CodeReference } from '@cockpit/feature-comments';
import { MarkdownRenderer } from '@cockpit/shared-ui';
import { rehypeSourceLines } from '@cockpit/shared-ui';
import type { CodeComment } from '@cockpit/feature-comments';
import { TocSidebar } from '@cockpit/shared-ui';
import { ShareReviewToggle } from '@cockpit/feature-review';
import { useSelectionToolbar } from './useSelectionToolbar';

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
  /** Literal user selection (rendered HTML text) — used as the
   *  `addComment(..., selectedText)` snapshot. */
  selectedText: string;
  /** Slice of the raw markdown SOURCE covering the selected
   *  data-source-line range — used by AI references (so the AI sees
   *  the original markdown, not the rendered DOM text) and by the
   *  preview block inside AddCommentInput / SendToAIInput. */
  lineSnapshot: string;
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
  // === Hooks ===
  const menuContainer = useMenuContainer();
  const aiBridge = useAIBridge();
  const { comments, addComment, updateComment, deleteComment, refresh: refreshComments } = useComments({ cwd, filePath });
  const [isMounted, setIsMounted] = useState(false);

  // === Floating UI state ===
  const [addCommentInput, setAddCommentInput] = useState<InputCardData | null>(null);
  const [sendToAIInput, setSendToAIInput] = useState<InputCardData | null>(null);
  const [viewingComment, setViewingComment] = useState<ViewingCommentData | null>(null);

  // === Source lines for extracting original content ===
  const sourceLines = useMemo(() => content.split('\n'), [content]);

  useEffect(() => { queueMicrotask(() => setIsMounted(true)); }, []);

  // === Floating toolbar / selection plumbing ===
  // Mirror containerRef into state so the shared hook's effect re-runs
  // when the element mounts (refs alone don't trigger re-renders).
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (containerRef.current !== containerEl) setContainerEl(containerRef.current);
  });
  const { toolbarRef: floatingToolbarRef, bumpRef: bumpToolbarRef, clearToolbar } = useSelectionToolbar({
    enabled: true,
    container: containerEl,
    // Each markdown block carries a `data-source-start`/`data-source-end`
    // range mapping back to the original markdown source (set by the
    // rehypeSourceLines plugin). A selection that spans paragraphs takes
    // the outer envelope, so a 2-paragraph selection still pulls in both
    // blocks' full source ranges.
    resolveLineRange: (node) => {
      const r = getSourceRange(node);
      return r ? { start: r.start, end: r.end } : null;
    },
    // Snapshot the RAW markdown source for the selected line range —
    // the rendered DOM text (= `selectedText`) is post-formatting and
    // would round-trip lossily through the AI. We want the AI to see
    // the original markdown.
    buildLineSnapshot: ({ start, end }) => {
      const startIdx = Math.max(0, start - 1);
      const endIdx = Math.min(sourceLines.length, end);
      return sourceLines.slice(startIdx, endIdx).join('\n');
    },
  });

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
      selectedText: toolbar.selectedText,
      lineSnapshot: toolbar.lineSnapshot,
    });
    clearToolbar();
  }, [clearToolbar, floatingToolbarRef]);

  const handleToolbarSendToAI = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    setSendToAIInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      selectedText: toolbar.selectedText,
      lineSnapshot: toolbar.lineSnapshot,
    });
    clearToolbar();
  }, [clearToolbar, floatingToolbarRef]);

  // Submit comment — pass `selectedText` so the DB snapshot equals what
  // the user actually highlighted.
  const handleCommentSubmit = useCallback(async (commentContent: string) => {
    if (!addCommentInput) return;
    await addComment(
      addCommentInput.range.start,
      addCommentInput.range.end,
      commentContent,
      addCommentInput.selectedText,
    );
    setAddCommentInput(null);
  }, [addCommentInput, addComment]);

  // Submit to AI — use the markdown SOURCE snapshot (lineSnapshot)
  // rather than the rendered selection so the AI sees the original
  // markdown syntax.
  const handleSendToAISubmit = useCallback(async (question: string) => {
    if (!sendToAIInput || !aiBridge) return;

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
        codeContent: sendToAIInput.lineSnapshot,
      });

      const message = buildAIMessage(references, question);
      aiBridge.sendMessage(message);

      await clearAllComments(cwd);
      refreshComments();
      setSendToAIInput(null);
    } catch (err) {
      console.error('Failed to send to AI:', err);
    }
  }, [sendToAIInput, aiBridge, filePath, cwd, refreshComments]);

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
            isChatLoading={aiBridge?.isLoading}
          />
          {addCommentInput && (
            <AddCommentInput
              x={addCommentInput.x}
              y={addCommentInput.y}
              range={addCommentInput.range}
              lineSnapshot={addCommentInput.lineSnapshot}
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
              lineSnapshot={sendToAIInput.lineSnapshot}
              container={menuContainer}
              onSubmit={handleSendToAISubmit}
              onClose={() => setSendToAIInput(null)}
              isChatLoading={aiBridge?.isLoading}
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
