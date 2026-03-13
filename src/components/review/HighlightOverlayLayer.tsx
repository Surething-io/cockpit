'use client';

import React from 'react';
import { HighlightRect } from '@/hooks/useReviewHighlights';

interface Props {
  rects: HighlightRect[];
  activeCommentId: string | null;
  pendingCommentId: string | null;
  isDark: boolean;
}

// ---- Color tokens ----
const LIGHT = {
  bg: 'rgba(234, 179, 8, 0.15)',
  bgActive: 'rgba(234, 179, 8, 0.4)',
  bgPending: 'rgba(234, 179, 8, 0.3)',
  border: 'rgba(234, 179, 8, 0.7)',
  borderPending: 'rgba(234, 179, 8, 0.9)',
};
const DARK = {
  bg: 'rgba(234, 179, 8, 0.1)',
  bgActive: 'rgba(234, 179, 8, 0.3)',
  bgPending: 'rgba(234, 179, 8, 0.2)',
  border: 'rgba(234, 179, 8, 0.5)',
  borderPending: 'rgba(234, 179, 8, 0.7)',
};

export function HighlightOverlayLayer({
  rects,
  activeCommentId,
  pendingCommentId,
  isDark,
}: Props) {
  if (rects.length === 0) return null;

  const c = isDark ? DARK : LIGHT;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: 0,
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      {rects.map((rect, i) => {
        const isActive = rect.commentId === activeCommentId;
        const isPending = rect.commentId === pendingCommentId;

        let bg = c.bg;
        if (isPending) bg = c.bgPending;
        else if (isActive) bg = c.bgActive;

        return (
          <div
            key={`${rect.commentId}-${i}`}
            data-comment-id={rect.commentId}
            style={{
              position: 'absolute',
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
              backgroundColor: bg,
              borderBottom: `1px solid ${isPending ? c.borderPending : c.border}`,
              borderRadius: 1,
              pointerEvents: 'none',
            }}
          />
        );
      })}
    </div>
  );
}
