'use client';

import { useCallback, useRef, useState, type ComponentPropsWithoutRef } from 'react';

/**
 * Renders fenced code blocks in MDX with a hover-revealed "Copy" button in the
 * top-right corner. Used as the `pre` override in `mdxComponents` so every
 * ```bash / ```ts / etc. block gets copy capability — no per-call JSX wrapper
 * needed (replaces the previous `<CopyableCommand command="..." />` component).
 *
 * Why client-only: `navigator.clipboard` lives in the browser, and `useState`
 * for the post-click "Copied" flash needs hydration. The surrounding MDX is
 * still rendered on the server (RSC); only this leaf is client.
 */
export function CopyableCodeBlock({
  children,
  className,
  ...rest
}: ComponentPropsWithoutRef<'pre'>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    // innerText collapses syntax-highlighter spans into the actual text the
    // user sees, including newlines — matches what they'd select-all-and-copy
    // manually. .trim() drops the trailing newline the fence adds.
    const text = ref.current?.innerText?.trim() ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can throw in insecure contexts or when permissions
      // are denied. Swallow silently — the user can still select+copy.
    }
  }, []);

  return (
    <div className="group relative my-4">
      <pre
        ref={ref}
        className={
          'overflow-x-auto rounded-md border border-border bg-muted/50 p-4 text-sm font-mono leading-6 ' +
          (className ?? '')
        }
        {...rest}
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 rounded border border-border bg-card/95 px-2 py-1 text-[11px] font-medium opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:border-brand/50"
        aria-label="Copy code"
      >
        {copied ? '✓ Copied' : '⧉ Copy'}
      </button>
    </div>
  );
}
