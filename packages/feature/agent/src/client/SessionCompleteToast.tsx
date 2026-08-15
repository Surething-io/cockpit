'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { SessionNumberBadge } from './SessionNumberBadge';

// ============================================
// Types
// ============================================

export interface SessionToastItem {
  id: string;
  projectName: string;
  message?: string;  // lastUserMessage preview
  cwd: string;
  sessionId: string;
  projectNumber?: number | string;
  sessionNumber?: number | string;
}

// ============================================
// Global toast queue (independent of the React component tree)
// ============================================

type Listener = () => void;

let toasts: SessionToastItem[] = [];
let listeners: Listener[] = [];

function emitChange() {
  listeners.forEach(fn => fn());
}

export function showSessionCompleteToast(item: Omit<SessionToastItem, 'id'>) {
  const id = `session-toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  toasts = [...toasts, { ...item, id }];
  emitChange();
}

function removeToast(id: string) {
  toasts = toasts.filter(t => t.id !== id);
  emitChange();
}

function useSessionToasts() {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const listener = () => forceUpdate(n => n + 1);
    listeners.push(listener);
    return () => { listeners = listeners.filter(l => l !== listener); };
  }, []);
  return toasts;
}

// ============================================
// Toast container (bottom-left, independent of the bottom-right normal toast)
// ============================================

export function SessionCompleteToastContainer({
  onNavigate,
}: {
  onNavigate: (cwd: string, sessionId: string) => void;
}) {
  const items = useSessionToasts();

  if (items.length === 0) return null;

  return createPortal(
    <div className="fixed bottom-4 left-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {items.map(item => (
        <SessionToastCard
          key={item.id}
          item={item}
          onNavigate={onNavigate}
          onRemove={removeToast}
        />
      ))}
    </div>,
    document.body,
  );
}

// ============================================
// Individual toast card
// ============================================

function SessionToastCard({
  item,
  onNavigate,
  onRemove,
}: {
  item: SessionToastItem;
  onNavigate: (cwd: string, sessionId: string) => void;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [leaving, setLeaving] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const dismiss = useCallback(() => {
    setLeaving(true);
    setTimeout(() => onRemove(item.id), 300);
  }, [item.id, onRemove]);

  // Auto-dismiss after 5 seconds
  useEffect(() => {
    timerRef.current = setTimeout(dismiss, 5000);
    return () => clearTimeout(timerRef.current);
  }, [dismiss]);

  const handleClick = useCallback(() => {
    clearTimeout(timerRef.current);
    onNavigate(item.cwd, item.sessionId);
    onRemove(item.id);
  }, [item, onNavigate, onRemove]);

  // Pause auto-dismiss on hover
  const handleMouseEnter = useCallback(() => {
    clearTimeout(timerRef.current);
  }, []);

  const handleMouseLeave = useCallback(() => {
    timerRef.current = setTimeout(dismiss, 2000);
  }, [dismiss]);

  return (
    <div
      className={`group pointer-events-auto relative bg-popover border border-border rounded-lg shadow-lv3 px-3 py-3 min-h-[84px] min-w-[260px] max-w-[340px] cursor-pointer transition-all ${
        leaving ? 'opacity-0 -translate-x-4' : 'opacity-100 translate-x-0'
      }`}
      style={{
        animation: leaving ? undefined : 'slideInLeft 0.3s ease-out',
      }}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/*
        Hover tint as an overlay, not as `hover:bg-hover` on the card itself:
        `--tint-hover` is a translucent rgba, so applying it as background-color
        REPLACES the opaque `bg-popover` and makes the whole toast see-through
        (the sidebar menu underneath bleeds right through it).
      */}
      <div className="pointer-events-none absolute inset-0 rounded-lg bg-hover opacity-0 group-hover:opacity-100 transition-opacity" />
      <div className="relative flex items-start gap-2">
        {/* Completion icon */}
        <svg className="w-4 h-4 text-green-9 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span className="text-sm font-medium text-foreground truncate">{item.projectName}</span>
        <span className="text-xs text-green-11 flex-shrink-0">{t('common.done')}</span>
        <SessionNumberBadge projectNumber={item.projectNumber} sessionNumber={item.sessionNumber} className="ml-auto" />
        {/* Close button */}
        <button
          onClick={(e) => { e.stopPropagation(); dismiss(); }}
          className="p-0.5 text-muted-foreground hover:text-foreground rounded transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {/*
        line-clamp rather than `truncate`: a one-line ellipsis cuts the summary
        at ~20 CJK chars, which is rarely enough to tell which task finished.
        Two lines fill the card's existing min-height instead of leaving it
        half empty. `break-words` keeps long unbroken paths and URLs from
        overflowing the fixed max-width.
      */}
      {item.message && (
        <div className="relative text-xs text-muted-foreground line-clamp-2 break-words mt-1 ml-6">
          {item.message}
        </div>
      )}
    </div>
  );
}
