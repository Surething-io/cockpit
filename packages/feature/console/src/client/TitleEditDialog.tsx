'use client';

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface Props {
  open: boolean;
  initialValue: string;
  onCancel: () => void;
  onSave: (newTitle: string) => void | Promise<void>;
}

/**
 * Single-line input modal for setting / renaming a bubble title.
 *
 * Used by ShortIdBadge's ✎ button. Renders into document.body via portal so
 * it's not clipped by the bubble's overflow or the 3-panel swipe transform
 * (per CLAUDE.md modal positioning constraints).
 *
 * KISS UX:
 *   - Auto-focus + auto-select on open (rename-friendly).
 *   - Enter → save (if changed) and close. Empty input → clears the title.
 *   - Esc → cancel.
 *   - Click backdrop → cancel.
 *   - 64 char visible cap; server-side also caps at 256.
 */
export function TitleEditDialog({ open, initialValue, onCancel, onSave }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setSaving(false);
      // Defer focus so the ref is attached after portal mount.
      const id = requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [open, initialValue]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open || typeof document === 'undefined') return null;

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(value.trim());
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      onMouseDown={(e) => {
        // Backdrop click → cancel. Don't trigger if mousedown happened inside the panel.
        if (e.target === e.currentTarget) onCancel();
      }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/60 backdrop-blur-sm"
    >
      <div className="w-[320px] rounded-lg border border-border bg-card p-4 shadow-xl">
        <div className="mb-2 text-sm font-medium text-foreground">
          {t('shortIdBadge.dialogTitle')}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, 64))}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            // IME composition guard: when typing CJK / Hangul / etc. through
            // an input method, Enter commits the candidate — DO NOT treat it
            // as "save". `isComposing` is the modern signal; `keyCode 229`
            // is the legacy fallback some browsers/IMEs still use.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            void handleSave();
          }}
          placeholder={t('shortIdBadge.dialogPlaceholder')}
          maxLength={64}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm font-mono outline-none focus:border-brand"
        />
        <div className="mt-3 flex justify-end gap-2 text-sm">
          <button
            onClick={onCancel}
            className="rounded px-3 py-1 text-muted-foreground hover:bg-accent"
            disabled={saving}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void handleSave()}
            className="rounded bg-brand px-3 py-1 text-white hover:opacity-90 disabled:opacity-50"
            disabled={saving}
          >
            {saving ? '…' : t('common.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
