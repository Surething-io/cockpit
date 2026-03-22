'use client';

import React, { useState, useEffect, useMemo, memo } from 'react';

// ============================================
// Floating Toolbar (portal version with container-relative positioning)
// ============================================

interface FloatingToolbarProps {
  x: number;
  y: number;
  visible: boolean;
  container: HTMLElement;
  onAddComment: () => void;
  onSendToAI: () => void;
  onSearch?: () => void;
  isChatLoading?: boolean;
}

export function FloatingToolbar({ x, y, visible, container, onAddComment, onSendToAI, onSearch, isChatLoading }: FloatingToolbarProps) {
  const containerRect = container.getBoundingClientRect();
  const relX = x - containerRect.left;
  const relY = y - containerRect.top;

  // 定位在鼠标右上方：向上偏移 40px，向右偏移 8px
  const toolbarTop = Math.max(0, relY - 40);
  const toolbarLeft = relX + 8;

  return (
    <div
      className="floating-toolbar absolute z-[200] flex items-center gap-1.5 bg-card border border-border rounded-lg shadow-xl p-1.5"
      style={{
        left: toolbarLeft,
        top: toolbarTop,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
      }}
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
      {onSearch && (
        <button
          className="px-3 py-1.5 text-xs font-medium border border-brand text-brand rounded-md hover:bg-brand/10 transition-colors"
          onClick={onSearch}
        >
          搜索
        </button>
      )}
    </div>
  );
}

// ============================================
// ToolbarRenderer - 独立状态，避免父组件重渲染
// 只有 toolbar 自身的显示/隐藏触发此组件 re-render。
// ============================================

export interface ToolbarData {
  x: number;
  y: number;
  range: { start: number; end: number };
  selectedText: string;
}

interface ToolbarRendererProps {
  floatingToolbarRef: React.RefObject<ToolbarData | null>;
  bumpRef: React.MutableRefObject<() => void>;
  container: HTMLElement;
  onAddComment: () => void;
  onSendToAI: () => void;
  onSearch?: () => void;
  isChatLoading?: boolean;
}

function ToolbarRendererInner({ floatingToolbarRef, bumpRef, container, onAddComment, onSendToAI, onSearch, isChatLoading }: ToolbarRendererProps) {
  const [version, forceRender] = useState(0);

  // 让父组件通过 bumpRef 触发本组件 re-render
  useEffect(() => {
    bumpRef.current = () => forceRender(v => v + 1);
  }, [bumpRef]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- version 仅用于触发 re-read ref
  const toolbar = useMemo(() => floatingToolbarRef.current, [version]);

  return (
    <FloatingToolbar
      x={toolbar?.x ?? 0}
      y={toolbar?.y ?? 0}
      visible={!!toolbar}
      container={container}
      onAddComment={onAddComment}
      onSendToAI={onSendToAI}
      onSearch={onSearch}
      isChatLoading={isChatLoading}
    />
  );
}
export const ToolbarRenderer = memo(ToolbarRendererInner);
