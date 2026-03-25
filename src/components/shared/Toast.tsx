'use client';

import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react';
import i18n from '@/lib/i18n';

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastContextType {
  showToast: (message: string, type?: Toast['type']) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: Toast['type'] = 'success') => {
    const id = `toast-${Date.now()}`;
    setToasts(prev => [...prev, { id, message, type }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </ToastContext.Provider>
  );
}

function ToastContainer({ toasts, onRemove }: { toasts: Toast[]; onRemove: (id: string) => void }) {
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map(toast => (
        <ToastItem key={toast.id} toast={toast} onRemove={onRemove} />
      ))}
    </div>
  );
}

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onRemove(toast.id);
    }, 3000);
    return () => clearTimeout(timer);
  }, [toast.id, onRemove]);

  const bgColor = {
    success: 'bg-green-9',
    error: 'bg-red-9',
    info: 'bg-brand',
  }[toast.type];

  const icon = {
    success: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
    error: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    ),
    info: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  }[toast.type];

  return (
    <div
      className={`${bgColor} text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 min-w-[200px] animate-slide-in`}
      style={{
        animation: 'slideIn 0.3s ease-out',
      }}
    >
      {icon}
      <span className="text-sm">{toast.message}</span>
      <button
        onClick={() => onRemove(toast.id)}
        className="ml-auto p-1 hover:bg-white/20 rounded transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// ============================================
// confirm() - Custom confirm dialog (replaces window.confirm)
// ============================================

export function confirm(message: string, options?: {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}): Promise<boolean> {
  const { title = i18n.t('confirm.title'), confirmText = i18n.t('confirm.ok'), cancelText = i18n.t('confirm.cancel'), danger = false } = options || {};

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[200] flex items-center justify-center';
    overlay.style.animation = 'confirmFadeIn 0.15s ease-out';

    const cleanup = (result: boolean) => {
      overlay.style.animation = 'confirmFadeOut 0.12s ease-in';
      overlay.addEventListener('animationend', () => {
        document.body.removeChild(overlay);
        resolve(result);
      }, { once: true });
    };

    // Close on background click
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    // ESC to close
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        document.removeEventListener('keydown', handleKey, true);
        cleanup(false);
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        document.removeEventListener('keydown', handleKey, true);
        cleanup(true);
      }
    };
    document.addEventListener('keydown', handleKey, true);

    const confirmBtnClass = danger
      ? 'bg-red-9 hover:bg-red-10 text-white'
      : 'bg-brand hover:bg-brand/90 text-white';

    overlay.innerHTML = `
      <div class="fixed inset-0 bg-black/50"></div>
      <div class="relative bg-card border border-border rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4" style="animation: confirmScaleIn 0.15s ease-out">
        <div class="text-base font-medium text-foreground mb-2">${title}</div>
        <div class="text-sm text-muted-foreground mb-6">${message}</div>
        <div class="flex justify-end gap-3">
          <button data-action="cancel" class="px-4 py-2 text-sm rounded-lg border border-border text-foreground hover:bg-accent transition-colors">${cancelText}</button>
          <button data-action="confirm" class="px-4 py-2 text-sm rounded-lg ${confirmBtnClass} transition-colors">${confirmText}</button>
        </div>
      </div>
    `;

    overlay.querySelector('[data-action="cancel"]')!.addEventListener('click', () => {
      document.removeEventListener('keydown', handleKey, true);
      cleanup(false);
    });
    overlay.querySelector('[data-action="confirm"]')!.addEventListener('click', () => {
      document.removeEventListener('keydown', handleKey, true);
      cleanup(true);
    });

    document.body.appendChild(overlay);

    // Auto-focus the confirm button
    (overlay.querySelector('[data-action="confirm"]') as HTMLButtonElement)?.focus();
  });
}

// ============================================
// Simple standalone toast function (no Provider needed)
// ============================================
let toastContainer: HTMLDivElement | null = null;
const toastRoot: ReturnType<typeof import('react-dom/client').createRoot> | null = null;

function getToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.className = 'fixed bottom-4 right-4 z-[100] flex flex-col-reverse items-end gap-2';
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

export function toast(message: string, type: Toast['type'] = 'success') {
  const container = getToastContainer();
  const toastEl = document.createElement('div');
  toastEl.className = `${
    type === 'success' ? 'bg-green-9' : type === 'error' ? 'bg-red-9' : 'bg-brand'
  } text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 min-w-[200px]`;
  toastEl.style.animation = 'slideIn 0.3s ease-out';

  const iconSvg = type === 'success'
    ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />'
    : type === 'error'
    ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />'
    : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />';

  toastEl.innerHTML = `
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">${iconSvg}</svg>
    <span class="text-sm">${message}</span>
  `;

  container.appendChild(toastEl);

  setTimeout(() => {
    toastEl.style.animation = 'slideOut 0.3s ease-in';
    setTimeout(() => {
      container.removeChild(toastEl);
    }, 300);
  }, 3000);
}
