'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';

// ============================================
// Types
// ============================================

export interface SessionToastItem {
  id: string;
  projectName: string;
  message?: string;  // lastUserMessage 预览
  cwd: string;
  sessionId: string;
}

// ============================================
// 全局 toast 队列（独立于 React 组件树）
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
// Toast 容器（左下角，独立于右下角的普通 toast）
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
// 单个 Toast 卡片
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
  const [leaving, setLeaving] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const dismiss = useCallback(() => {
    setLeaving(true);
    setTimeout(() => onRemove(item.id), 300);
  }, [item.id, onRemove]);

  // 5 秒自动消失
  useEffect(() => {
    timerRef.current = setTimeout(dismiss, 5000);
    return () => clearTimeout(timerRef.current);
  }, [dismiss]);

  const handleClick = useCallback(() => {
    clearTimeout(timerRef.current);
    onNavigate(item.cwd, item.sessionId);
    onRemove(item.id);
  }, [item, onNavigate, onRemove]);

  // hover 时暂停自动消失
  const handleMouseEnter = useCallback(() => {
    clearTimeout(timerRef.current);
  }, []);

  const handleMouseLeave = useCallback(() => {
    timerRef.current = setTimeout(dismiss, 2000);
  }, [dismiss]);

  return (
    <div
      className={`pointer-events-auto bg-card border border-border rounded-lg shadow-lg px-3 py-2.5 min-w-[260px] max-w-[340px] cursor-pointer hover:bg-accent transition-all ${
        leaving ? 'opacity-0 -translate-x-4' : 'opacity-100 translate-x-0'
      }`}
      style={{
        animation: leaving ? undefined : 'slideInLeft 0.3s ease-out',
      }}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex items-center gap-2">
        {/* 完成图标 */}
        <svg className="w-4 h-4 text-green-9 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span className="text-sm font-medium text-foreground truncate">{item.projectName}</span>
        <span className="text-xs text-green-11 flex-shrink-0">完成</span>
        {/* 关闭按钮 */}
        <button
          onClick={(e) => { e.stopPropagation(); dismiss(); }}
          className="ml-auto p-0.5 text-muted-foreground hover:text-foreground rounded transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {item.message && (
        <div className="text-xs text-muted-foreground truncate mt-1 ml-6">
          {item.message}
        </div>
      )}
    </div>
  );
}
