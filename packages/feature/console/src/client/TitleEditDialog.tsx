'use client';

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface Props {
  open: boolean;
  /** The trigger element (✎ button) the popover anchors below. */
  anchorRef: React.RefObject<HTMLElement | null>;
  initialValue: string;
  onCancel: () => void;
  onSave: (newTitle: string) => void | Promise<void>;
}

const POPOVER_WIDTH = 260;
const GAP = 4;
const MARGIN = 8;

/**
 * Inline popover for setting / renaming a bubble title.
 *
 * Used by ShortIdBadge's ✎ button. Anchors directly below the trigger so the
 * rest of the UI stays visible and interactive — no full-screen backdrop.
 *
 * Renders into document.body via portal and positions with the anchor's
 * viewport-space rect (position: fixed) so it's not clipped by the bubble's
 * overflow or the 3-panel swipe translateX (per CLAUDE.md modal constraints).
 *
 * KISS UX:
 *   - Auto-focus + auto-select on open (rename-friendly).
 *   - Enter → save (if changed) and close. Empty input → clears the title.
 *   - Esc → cancel. Click outside → cancel (no save).
 *   - Flips above the trigger when there's no room below.
 *   - 64 char visible cap; server-side also caps at 256.
 */
export function TitleEditDialog({ open, anchorRef, initialValue, onCancel, onSave }: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

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
    setPos(null);
  }, [open, initialValue]);

  // Position the popover below (or above) the anchor, clamped to the viewport.
  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const a = anchor.getBoundingClientRect();
    const h = popoverRef.current?.offsetHeight ?? 0;
    let top = a.bottom + GAP;
    if (h && top + h > window.innerHeight - MARGIN) {
      const above = a.top - GAP - h;
      if (above >= MARGIN) top = above;
    }
    let left = a.left;
    left = Math.min(left, window.innerWidth - POPOVER_WIDTH - MARGIN);
    left = Math.max(left, MARGIN);
    setPos({ top, left });
  }, [anchorRef]);

  // Measure after mount (two-pass: first render hidden, then place once we
  // know the popover height so the flip decision uses the real size).
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    // Outside click → cancel. Ignore the anchor so its own toggle isn't fought.
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onCancel();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [open, onCancel, anchorRef]);

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
      ref={popoverRef}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: POPOVER_WIDTH,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="fixed z-[100] rounded-lg border border-border bg-card p-3 shadow-lv3"
    >
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
          className="rounded px-3 py-1 text-muted-foreground hover:bg-hover"
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
    </div>,
    document.body,
  );
}
