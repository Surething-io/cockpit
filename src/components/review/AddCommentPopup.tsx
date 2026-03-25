'use client';

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  selectedText: string;
  position: { top: number; left: number };
  onSubmit: (content: string) => void;
  onCancel: () => void;
}

export function AddCommentPopup({ selectedText, position, onSubmit, onCancel }: Props) {
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  // Click outside: dismiss only when content is empty
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        if (!content.trim()) {
          onCancel();
        }
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [content, onCancel]);

  const handleSubmit = () => {
    const trimmed = content.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  const truncatedText = selectedText.length > 60
    ? selectedText.slice(0, 57) + '...'
    : selectedText;

  return (
    <div
      ref={popupRef}
      className="absolute z-50 w-96 bg-card border border-border rounded-lg shadow-lg"
      style={{
        top: position.top,
        left: Math.max(8, position.left - 192), // center horizontally, clamp to left edge
      }}
    >
      {/* Selected text preview */}
      <div className="px-3 pt-3 pb-2">
        <div className="text-xs text-muted-foreground mb-1">{t('review.selectedText')}</div>
        <div className="text-xs bg-yellow-500/10 border-l-2 border-yellow-500 px-2 py-1 rounded-r truncate">
          {truncatedText}
        </div>
      </div>

      {/* Comment input */}
      <div className="px-3 pb-2">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={t('review.addCommentPlaceholder')}
          className="w-full px-2 py-1.5 text-sm bg-secondary border border-border rounded resize-none focus:outline-none focus:border-brand"
          rows={4}
        />
      </div>

      {/* Actions */}
      <div className="px-3 pb-3 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">{t('review.enterSubmitHint')}</span>
        <div className="flex gap-1">
          <button
            onClick={onCancel}
            className="px-2 py-1 text-xs rounded hover:bg-accent transition-colors text-muted-foreground"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!content.trim()}
            className="px-2 py-1 text-xs rounded bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-40"
          >
            {t('review.commentBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}
