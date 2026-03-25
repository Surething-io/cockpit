'use client';

import React, { useState, useEffect, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  const containerRect = container.getBoundingClientRect();
  const relX = x - containerRect.left;
  const relY = y - containerRect.top;

  // Position above-right of cursor: offset 40px up, 8px to the right
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
        {t('floatingToolbar.addComment')}
      </button>
      <button
        className="px-3 py-1.5 text-xs font-medium border border-brand text-brand rounded-md hover:bg-brand/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={onSendToAI}
        disabled={isChatLoading}
        title={isChatLoading ? t('comments.aiResponding') : t('floatingToolbar.sendToAI')}
      >
        {t('floatingToolbar.sendToAI')}
      </button>
      {onSearch && (
        <button
          className="px-3 py-1.5 text-xs font-medium border border-brand text-brand rounded-md hover:bg-brand/10 transition-colors"
          onClick={onSearch}
        >
          {t('floatingToolbar.search')}
        </button>
      )}
    </div>
  );
}

// ============================================
// ToolbarRenderer - isolated state to avoid parent component re-renders
// Only the toolbar's own show/hide triggers a re-render of this component.
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

  // Allow parent to trigger a re-render of this component via bumpRef
  useEffect(() => {
    bumpRef.current = () => forceRender(v => v + 1);
  }, [bumpRef]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- version is only used to trigger re-reading the ref
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
