'use client';

import { useState, useCallback, useRef, useLayoutEffect, type KeyboardEvent } from 'react';
import { Send, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Minimal touch-friendly composer for the mobile chat (/m).
// Text + send + stop only — no image paste, no slash menu, no desktop toolbar.
// Slash text (e.g. skill commands) is sent verbatim and handled by the agent.
interface MobileChatInputProps {
  onSend: (content: string) => void;
  onStop: () => void;
  // True while a run is active (this session is streaming or running elsewhere).
  isRunning: boolean;
  // True when sending is not allowed (mirrors isRunning; kept explicit for clarity).
  disabled: boolean;
}

export function MobileChatInput({ onSend, onStop, isRunning, disabled }: MobileChatInputProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea up to a few lines.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input]);

  const submit = useCallback(() => {
    const content = input.trim();
    if (!content || disabled) return;
    onSend(content);
    setInput('');
  }, [input, disabled, onSend]);

  // Mobile-first: plain Enter inserts a newline (the soft-keyboard return key
  // must NOT send), sending is the explicit button. Cmd/Ctrl+Enter stays as a
  // send shortcut for users on a hardware keyboard.
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }, [submit]);

  return (
    <div className="flex items-end gap-2 border-t border-border bg-card px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder={t('mobile.messagePlaceholder')}
        className="flex-1 resize-none rounded-2xl border border-border bg-background px-4 py-2.5 text-base leading-snug outline-none focus:border-brand"
      />
      {isRunning ? (
        <button
          type="button"
          onClick={onStop}
          aria-label={t('mobile.stop')}
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-red-500 text-white active:scale-95"
        >
          <Square className="h-5 w-5" fill="currentColor" />
        </button>
      ) : (
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !input.trim()}
          aria-label={t('mobile.send')}
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-brand text-white active:scale-95 disabled:opacity-40"
        >
          <Send className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}
