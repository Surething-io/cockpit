'use client';

import { useRef, useCallback, useState, useMemo, MutableRefObject } from 'react';
import { MarkdownRenderer } from '@/components/shared/MarkdownRenderer';
import { TocSidebar } from '@/components/shared/TocSidebar';
import { rehypeSourceLines } from '@/lib/rehypeSourceLines';
import { AddCommentPopup } from './AddCommentPopup';
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

  // Apply highlights via DOM manipulation
  useReviewHighlights(containerRef, highlightComments, activeCommentId, onHighlightClick, scrollToHighlightRef);

  // Handle text selection
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!isActive) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !containerRef.current) {
      return;
    }

    const range = selection.getRangeAt(0);

    // Ensure selection is within our container
    if (!containerRef.current.contains(range.startContainer) ||
        !containerRef.current.contains(range.endContainer)) {
      return;
    }

    const offsets = computeTextOffsets(containerRef.current, range);
    if (!offsets) return;

    // Position popup at mouse up location
    const scrollContainer = scrollRef.current ?? containerRef.current.parentElement!;
    const scrollRect = scrollContainer.getBoundingClientRect();

    setPopupState({
      anchor: offsets,
      position: {
        top: e.clientY - scrollRect.top + scrollContainer.scrollTop + 8,
        left: e.clientX - scrollRect.left,
      },
    });

    // Clear browser selection so only yellow underline is visible
    selection.removeAllRanges();
  }, [isActive]);

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
