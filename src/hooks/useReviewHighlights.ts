'use client';

import { useEffect, RefObject, MutableRefObject, useCallback, useRef } from 'react';
import { ReviewComment } from '@/lib/review-utils';

/**
 * Walk all text nodes in a container, returning an array of { node, start, end }
 * where start/end are the global character offsets in container.textContent.
 */
function getTextNodeMap(container: HTMLElement): Array<{ node: Text; start: number; end: number }> {
  const result: Array<{ node: Text; start: number; end: number }> = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let offset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const len = node.textContent?.length || 0;
    result.push({ node, start: offset, end: offset + len });
    offset += len;
  }

  return result;
}

/**
 * Remove all <mark class="review-highlight"> elements, unwrapping their content.
 */
function clearHighlights(container: HTMLElement) {
  const marks = container.querySelectorAll('mark.review-highlight');
  marks.forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    // Merge adjacent text nodes
    parent.normalize();
  });
}

/**
 * Apply highlights for a set of comment anchors.
 * Process in reverse startOffset order to avoid invalidating earlier offsets.
 */
function applyHighlights(
  container: HTMLElement,
  comments: ReviewComment[],
  activeCommentId: string | null,
) {
  if (comments.length === 0) return;

  // Sort by startOffset descending (apply from end to start to preserve offsets)
  const sorted = [...comments].sort((a, b) => b.anchor.startOffset - a.anchor.startOffset);

  for (const comment of sorted) {
    const { startOffset, endOffset } = comment.anchor;
    if (startOffset >= endOffset) continue;

    // Rebuild text node map each iteration (DOM changes with each wrap)
    const textNodes = getTextNodeMap(container);

    // Find text nodes that overlap [startOffset, endOffset)
    for (const { node, start, end } of textNodes) {
      if (end <= startOffset || start >= endOffset) continue;

      // Compute overlap within this text node
      const overlapStart = Math.max(startOffset, start) - start;
      const overlapEnd = Math.min(endOffset, end) - start;

      if (overlapStart >= overlapEnd) continue;
      if (!node.textContent) continue;

      // Split the text node and wrap the overlap portion
      const mark = document.createElement('mark');
      const isPending = comment.id === '__pending__';
      mark.className = `review-highlight${comment.id === activeCommentId ? ' active' : ''}${isPending ? ' pending' : ''}`;
      mark.dataset.commentId = comment.id;

      // Split at end first (to preserve start offset)
      let targetNode: Text = node;
      if (overlapEnd < (node.textContent.length)) {
        targetNode.splitText(overlapEnd);
      }
      if (overlapStart > 0) {
        targetNode = targetNode.splitText(overlapStart);
      }

      // Wrap the target node
      targetNode.parentNode?.insertBefore(mark, targetNode);
      mark.appendChild(targetNode);
    }
  }
}

export function useReviewHighlights(
  containerRef: RefObject<HTMLDivElement | null>,
  comments: ReviewComment[],
  activeCommentId: string | null,
  onHighlightClick: (commentId: string) => void,
  scrollToHighlightRef: MutableRefObject<((commentId: string) => void) | undefined>,
) {
  const onClickRef = useRef(onHighlightClick);
  useEffect(() => {
    onClickRef.current = onHighlightClick;
  }, [onHighlightClick]);

  // Apply/reapply highlights when comments or active comment changes
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Small delay to ensure MarkdownRenderer has finished rendering
    const timer = setTimeout(() => {
      clearHighlights(container);
      applyHighlights(container, comments, activeCommentId);
    }, 50);

    return () => clearTimeout(timer);
  }, [containerRef, comments, activeCommentId]);

  // Click handler for highlights (delegated)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handler = (e: MouseEvent) => {
      const mark = (e.target as HTMLElement).closest('mark.review-highlight');
      if (mark && mark instanceof HTMLElement && mark.dataset.commentId) {
        e.stopPropagation();
        onClickRef.current(mark.dataset.commentId);
      }
    };

    container.addEventListener('click', handler);
    return () => container.removeEventListener('click', handler);
  }, [containerRef]);

  // Expose scroll-to-highlight function
  const scrollToHighlight = useCallback((commentId: string) => {
    const container = containerRef.current;
    if (!container) return;
    const mark = container.querySelector(`mark.review-highlight[data-comment-id="${commentId}"]`);
    if (mark) {
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [containerRef]);

  useEffect(() => {
    scrollToHighlightRef.current = scrollToHighlight;
  }, [scrollToHighlight, scrollToHighlightRef]);
}
