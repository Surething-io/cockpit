'use client';

import React from 'react';

// ============================================
// Floating Toolbar (portal version with container-relative positioning)
// ============================================

interface FloatingToolbarProps {
  x: number;
  y: number;
  container: HTMLElement;
  onAddComment: () => void;
  onSendToAI: () => void;
  isChatLoading?: boolean;
}

export function FloatingToolbar({ x, y, container, onAddComment, onSendToAI, isChatLoading }: FloatingToolbarProps) {
  const containerRect = container.getBoundingClientRect();
  const relX = x - containerRect.left;
  const relY = y - containerRect.top;

  return (
    <div
      className="absolute z-[200] flex items-center gap-1.5 bg-card border border-border rounded-lg shadow-xl p-1.5"
      style={{ left: relX, top: relY }}
    >
      <button
        className="px-3 py-1.5 text-xs font-medium border border-brand text-brand rounded-md hover:bg-brand/10 transition-colors"
        onClick={onAddComment}
      >
        添加评论
      </button>
      <button
        className="px-3 py-1.5 text-xs font-medium border border-brand text-brand rounded-md hover:bg-brand/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={onSendToAI}
        disabled={isChatLoading}
        title={isChatLoading ? 'AI 正在响应中...' : '发送到 AI'}
      >
        发送 AI
      </button>
    </div>
  );
}
