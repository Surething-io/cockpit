'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type CopyState = 'idle' | 'copied' | 'failed';

export interface CopyLabels {
  idle: string;
  copied: string;
  failed: string;
}

/**
 * The install command — the page's single conversion event.
 *
 * Three things this has to get right, all of which the previous version got
 * wrong:
 *
 * 1. **The command stays selectable.** It used to be the label of a `<button>`,
 *    so drag-select never started and the manual fallback a developer reaches
 *    for first did not exist. The pill is a plain element now; only the copy
 *    affordance is a real `<button>`.
 * 2. **Clipboard failure is visible.** `navigator.clipboard` is undefined on
 *    every non-secure origin — including the shared-dev-box HTTP deployment
 *    this product advertises — and the old empty `catch {}` swallowed it, so
 *    the button silently did nothing. We fall back to `execCommand`; when that
 *    fails too we select the text for the user and say so.
 * 3. **The result reaches assistive tech.** The confirmation is a live region.
 *    Before this the page had none at all, so `Copied` was screen-reader silent.
 */
export function CopyableCommand({
  command,
  labels,
}: {
  command: string;
  labels: CopyLabels;
}) {
  const [state, setState] = useState<CopyState>('idle');
  const codeRef = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const flash = useCallback((next: CopyState) => {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    // A failure needs longer than a success: it asks the reader to do something.
    timer.current = setTimeout(() => setState('idle'), next === 'copied' ? 1500 : 4000);
  }, []);

  const selectCommand = useCallback(() => {
    const node = codeRef.current;
    if (!node) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);

  const copy = useCallback(async () => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(command);
        flash('copied');
        return;
      } catch {
        // Permission denied, or a non-secure origin. Fall through.
      }
    }
    // Deprecated, but it is the only path that works on an http:// origin.
    try {
      const ta = document.createElement('textarea');
      ta.value = command;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) {
        flash('copied');
        return;
      }
    } catch {
      // Fall through to manual selection.
    }
    selectCommand();
    flash('failed');
  }, [command, flash, selectCommand]);

  const label =
    state === 'copied' ? labels.copied : state === 'failed' ? labels.failed : labels.idle;

  return (
    <div className="flex w-full max-w-full items-center gap-3 rounded-lg border border-border bg-card py-2.5 pl-4 pr-2 font-mono text-sm transition-colors focus-within:border-brand/60 sm:w-auto">
      <span aria-hidden className="select-none text-muted-foreground">
        $
      </span>
      {/* Scrolls horizontally instead of wrapping: at 390px this command used to
          break across two lines, separating `$` from what it actually runs. */}
      <code
        ref={codeRef}
        /* The right-edge fade is the only remaining signal that the command
           continues: suppressing the scrollbar to stop it wrapping also removed
           the cue, so the visible string ended on a dangling `&` at 390px with
           nothing to say more existed. Only below `sm`, where it overflows. */
        className="scrollbar-hide min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-foreground [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] sm:[mask-image:none]"
      >
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={labels.idle}
        data-state={state}
        /* Below `sm` the label is hidden, so the button would collapse to a
           30x22 tap target. `-my-2.5` eats the pill's vertical padding so the
           hit area reaches 44x44 without making the pill any taller. */
        className="-my-2.5 flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=copied]:text-brand data-[state=failed]:text-foreground sm:my-0 sm:h-auto sm:min-w-0 sm:justify-start sm:py-1"
      >
        {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
        {/* The label is decoration for idle and copied, so it can hide on narrow
            screens — but on `failed` it carries the recovery instruction, and
            the clipboard API is missing precisely on the non-secure origins this
            product is deployed to. Hiding it below `sm` made the failure state
            silent on the devices most likely to reach it. */}
        <span className={state === 'failed' ? 'inline' : 'hidden sm:inline'}>{label}</span>
      </button>
      {/* The page's only live region. Announces the outcome, while the button
          itself keeps a stable accessible name for its action. */}
      <span role="status" aria-live="polite" className="sr-only">
        {state === 'idle' ? '' : label}
      </span>
    </div>
  );
}

/* Drawn marks at one stroke weight, replacing the ⧉ / ✓ Unicode glyphs the
   previous version used as an icon system. */

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  );
}
