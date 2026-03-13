'use client';

import { useRef, useCallback, useState, useMemo, useEffect, MutableRefObject } from 'react';
import { MarkdownRenderer } from '@/components/shared/MarkdownRenderer';
import { TocSidebar } from '@/components/shared/TocSidebar';
import { useTheme } from '@/components/shared/ThemeProvider';
import { rehypeSourceLines } from '@/lib/rehypeSourceLines';
import { AddCommentPopup } from './AddCommentPopup';
import { HighlightOverlayLayer } from './HighlightOverlayLayer';
import { useReviewHighlights } from '@/hooks/useReviewHighlights';
import { ReviewComment } from '@/lib/review-utils';

const REHYPE_PLUGINS = [rehypeSourceLines];

interface Props {
  content: string;
  comments: ReviewComment[];
  activeCommentId: string | null;
  isActive: boolean;
  onAddComment: (content: string, anchor: { startOffset: number; endOffset: number; selectedText: string }) => void;
  onHighlightClick: (commentId: string) => void;
  scrollToHighlightRef: MutableRefObject<((commentId: string) => void) | undefined>;
}

/**
 * Compute global text offset for a Range within a container.
 * Walks all text nodes in DOM order, summing character lengths.
 */
function computeTextOffsets(
  container: HTMLElement,
  range: Range
): { startOffset: number; endOffset: number; selectedText: string } | null {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let charCount = 0;
  let startOffset = -1;
  let endOffset = -1;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const nodeLen = node.textContent?.length || 0;

    if (node === range.startContainer) {
      startOffset = charCount + range.startOffset;
    }
    if (node === range.endContainer) {
      endOffset = charCount + range.endOffset;
      break;
    }
    charCount += nodeLen;
  }

  if (startOffset === -1 || endOffset === -1 || startOffset >= endOffset) return null;

  const selectedText = container.textContent?.slice(startOffset, endOffset) || '';
  if (!selectedText.trim()) return null;

  return { startOffset, endOffset, selectedText };
}

export function ReviewMarkdownPanel({
  content,
  comments,
  activeCommentId,
  isActive,
  onAddComment,
  onHighlightClick,
  scrollToHighlightRef,
}: Props) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [popupState, setPopupState] = useState<{
    anchor: { startOffset: number; endOffset: number; selectedText: string };
    position: { top: number; left: number };
  } | null>(null);

  // Include pending selection as a temporary highlight
  const highlightComments = useMemo(() => {
    if (!popupState) return comments;
    return [...comments, {
      id: '__pending__',
      author: '',
      authorId: '',
      content: '',
      anchor: popupState.anchor,
      createdAt: 0,
      replies: [],
    } as ReviewComment];
  }, [comments, popupState]);

  // Compute highlight overlay rects (no DOM mutation)
  const { rects, scrollToHighlight } = useReviewHighlights(
    containerRef,
    scrollRef,
    highlightComments,
    activeCommentId,
  );

  // Wire up scrollToHighlightRef for cross-panel scrolling
  useEffect(() => {
    scrollToHighlightRef.current = scrollToHighlight;
  }, [scrollToHighlight, scrollToHighlightRef]);

  // Stable ref for rects so click handler always sees latest
  const rectsRef = useRef(rects);
  useEffect(() => { rectsRef.current = rects; }, [rects]);

  // Handle text selection + highlight click (via coordinate hit-test)
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const selection = window.getSelection();
    const hasSelection = selection && !selection.isCollapsed;

    // If user selected text → show add-comment popup
    if (hasSelection && isActive && containerRef.current) {
      const range = selection.getRangeAt(0);
      if (containerRef.current.contains(range.startContainer) &&
          containerRef.current.contains(range.endContainer)) {
        const offsets = computeTextOffsets(containerRef.current, range);
        if (offsets) {
          const scrollContainer = scrollRef.current ?? containerRef.current.parentElement!;
          const scrollRect = scrollContainer.getBoundingClientRect();
          setPopupState({
            anchor: offsets,
            position: {
              top: e.clientY - scrollRect.top + scrollContainer.scrollTop + 8,
              left: e.clientX - scrollRect.left,
            },
          });
          selection.removeAllRanges();
          return;
        }
      }
    }

    // No text selected → check if click hits a highlight overlay (coordinate hit-test)
    if (!hasSelection && !popupState) {
      const scrollContainer = scrollRef.current;
      if (!scrollContainer) return;
      const scrollRect = scrollContainer.getBoundingClientRect();
      const x = e.clientX - scrollRect.left + scrollContainer.scrollLeft;
      const y = e.clientY - scrollRect.top + scrollContainer.scrollTop;

      for (const rect of rectsRef.current) {
        if (rect.commentId === '__pending__') continue;
        if (x >= rect.left && x <= rect.left + rect.width &&
            y >= rect.top && y <= rect.top + rect.height) {
          onHighlightClick(rect.commentId);
          return;
        }
      }
    }
  }, [isActive, popupState, onHighlightClick]);

  const handleAddComment = useCallback((commentContent: string) => {
    if (!popupState) return;
    onAddComment(commentContent, popupState.anchor);
    setPopupState(null);
    window.getSelection()?.removeAllRanges();
  }, [popupState, onAddComment]);

  const handleCancelPopup = useCallback(() => {
    setPopupState(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  return (
    <div className="h-full flex bg-card">
      <TocSidebar content={content} containerRef={scrollRef} />
      <div ref={scrollRef} className="flex-1 overflow-auto relative" onMouseUp={handleMouseUp}>
        <div ref={containerRef} className="p-6 review-markdown-container">
          <MarkdownRenderer content={content} rehypePlugins={REHYPE_PLUGINS} />
        </div>

        {/* Highlight overlay — pointer-events:none, purely visual */}
        <HighlightOverlayLayer
          rects={rects}
          activeCommentId={activeCommentId}
          pendingCommentId={popupState ? '__pending__' : null}
          isDark={isDark}
        />

        {popupState && (
          <AddCommentPopup
            selectedText={popupState.anchor.selectedText}
            position={popupState.position}
            onSubmit={handleAddComment}
            onCancel={handleCancelPopup}
          />
        )}
      </div>
    </div>
  );
}
