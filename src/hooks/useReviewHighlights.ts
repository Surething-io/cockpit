'use client';

import { useEffect, RefObject, useCallback, useRef, useState } from 'react';
import { ReviewComment } from '@/lib/review-utils';

// ============================================
// Types
// ============================================

export interface HighlightRect {
  commentId: string;
  top: number;
  left: number;
  width: number;
  height: number;
}

// ============================================
// Text node map (read-only, no DOM mutation)
// ============================================

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

// ============================================
// Compute visual rects via Range.getClientRects()
// ============================================

function computeHighlightRects(
  container: HTMLElement,
  scrollContainer: HTMLElement,
  comments: ReviewComment[],
): HighlightRect[] {
  const allRects: HighlightRect[] = [];
  const scrollRect = scrollContainer.getBoundingClientRect();

  const textNodes = getTextNodeMap(container);
  if (textNodes.length === 0) return allRects;

  for (const comment of comments) {
    const { startOffset, endOffset } = comment.anchor;
    if (startOffset >= endOffset) continue;

    // Find the start text node + local offset
    let startNode: Text | null = null;
    let startNodeOffset = 0;
    let endNode: Text | null = null;
    let endNodeOffset = 0;

    for (const { node, start, end } of textNodes) {
      if (!startNode && startOffset >= start && startOffset < end) {
        startNode = node;
        startNodeOffset = startOffset - start;
      }
      if (endOffset > start && endOffset <= end) {
        endNode = node;
        endNodeOffset = endOffset - start;
        break;
      }
    }

    if (!startNode || !endNode) continue;

    // Create Range and get visual rects
    const range = document.createRange();
    try {
      range.setStart(startNode, startNodeOffset);
      range.setEnd(endNode, endNodeOffset);
    } catch {
      continue;
    }

    const clientRects = range.getClientRects();
    for (const rect of clientRects) {
      if (rect.width < 1 || rect.height < 1) continue;

      allRects.push({
        commentId: comment.id,
        // Viewport-relative → scroll-container-absolute
        top: rect.top - scrollRect.top + scrollContainer.scrollTop,
        left: rect.left - scrollRect.left + scrollContainer.scrollLeft,
        width: rect.width,
        height: rect.height,
      });
    }
  }

  return allRects;
}

// ============================================
// Hook
// ============================================

export function useReviewHighlights(
  containerRef: RefObject<HTMLDivElement | null>,
  scrollRef: RefObject<HTMLDivElement | null>,
  comments: ReviewComment[],
  activeCommentId: string | null,
) {
  const [rects, setRects] = useState<HighlightRect[]>([]);
  const rafRef = useRef<number>(0);
  const commentsRef = useRef(comments);
  useEffect(() => {
    commentsRef.current = comments;
  }, [comments]);

  // Core recalc function (with shallow compare to avoid infinite loops)
  const recalcRects = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const container = containerRef.current;
      const scrollContainer = scrollRef.current;
      if (!container || !scrollContainer) return;
      const newRects = computeHighlightRects(container, scrollContainer, commentsRef.current);
      setRects(prev => {
        if (prev.length === newRects.length && prev.every((r, i) =>
          r.commentId === newRects[i].commentId &&
          Math.abs(r.top - newRects[i].top) < 0.5 &&
          Math.abs(r.left - newRects[i].left) < 0.5 &&
          Math.abs(r.width - newRects[i].width) < 0.5 &&
          Math.abs(r.height - newRects[i].height) < 0.5
        )) return prev;
        return newRects;
      });
    });
  }, [containerRef, scrollRef]);

  // Recalc when comments or active comment changes
  useEffect(() => {
    recalcRects();
  }, [comments, activeCommentId, recalcRects]);

  // MutationObserver: recalc when MarkdownRenderer updates the DOM
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const mo = new MutationObserver(() => recalcRects());
    mo.observe(container, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [containerRef, recalcRects]);

  // ResizeObserver: recalc on container size change (font load, image load, etc.)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver(() => recalcRects());
    ro.observe(container);
    return () => ro.disconnect();
  }, [containerRef, recalcRects]);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Scroll to highlight
  const scrollToHighlight = useCallback((commentId: string) => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;

    const firstRect = rects.find(r => r.commentId === commentId);
    if (!firstRect) return;

    const containerHeight = scrollContainer.clientHeight;
    scrollContainer.scrollTo({
      top: firstRect.top - containerHeight / 2 + firstRect.height / 2,
      behavior: 'smooth',
    });
  }, [scrollRef, rects]);

  return { rects, scrollToHighlight };
}
