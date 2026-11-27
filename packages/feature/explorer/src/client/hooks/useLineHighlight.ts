'use client';

import { useState, useEffect, useMemo } from 'react';
import { type BundledLanguage, getHighlighter, getLanguageFromPath, escapeHtml, tokensToHtml } from '@cockpit/shared-ui';

/**
 * Per-line syntax-highlighted HTML, returned synchronously in alignment
 * with the current `lines` array.
 *
 * ## Why this hook can't just hold the result in a single `useState`
 *
 * Earlier revisions of this file did exactly that:
 *
 *   ```ts
 *   const [highlightedLines, setHighlightedLines] = useState<string[]>([]);
 *   useEffect(() => {
 *     setHighlightedLines(lines.map(plainText));   // phase 1
 *     codeToTokens(...).then(setHighlightedLines); // phase 2
 *   }, [lines, ...]);
 *   ```
 *
 * Effects run AFTER commit, so the very next render after `lines`
 * changes is rendered with the OLD `highlightedLines` array but the
 * NEW `lines`. Consumers index it by `line.originalIdx`, which is
 * derived from the new `diffLines` — and the array entries it pulls
 * out come from the old `diffLines`. The result is one frame of
 * "row N shows another row's HTML" content misalignment, committed
 * to the DOM before the effect runs.
 *
 * That misaligned frame is invisible 99 % of the time (it's
 * immediately replaced by the phase-1 plain-text frame), BUT when
 * DiffView is mounted inside a hidden panel (three-pane workspace,
 * `translateX` offscreen) and the file is being edited externally,
 * the misaligned commit gives `@tanstack/react-virtual`'s
 * `measureElement` ResizeObserver a chance to record a bad row
 * height for that index. Because `useVirtualizer` is called without
 * `getItemKey`, the cache is keyed by array index — once a "row
 * height ≈ 0" entry lands in `measurementsCache`, the row's own
 * inline `height: ${size}px` feeds the same ~0 back into the next
 * measurement and the row collapses for good, overlapping its
 * neighbours until something else (panel resize, tree-sitter
 * cache refresh) jolts the ResizeObserver awake.
 *
 * Commit 0ec53c1 covered the "switch to a different file" trigger
 * by calling `virtualizer.measure()` on `leftLines/rightLines`
 * change. The "same file, contents edited while DiffView is in a
 * hidden panel" path slipped through, because:
 *   1. the new `lines` are committed alongside stale highlight HTML,
 *   2. ResizeObserver fires asynchronously while the effect that
 *      would call `virtualizer.measure()` is still queued, and
 *   3. on switch-back, no hook re-measures.
 *
 * ## The fix
 *
 * Move the plain-text fallback OUT of state and INTO a `useMemo`
 * that derives synchronously from the current `lines`:
 *
 *   - First render after `lines` change → `tokenCache` key mismatch
 *     → return `lines.map(escapeHtml)`. Alignment is guaranteed
 *     because both arrays are built from the same `lines` reference
 *     within the same render.
 *   - Async `codeToTokens` completes → `setTokenCache({key, html})`
 *     → next render the memo hits the cache and returns token HTML.
 *
 * The misaligned-frame failure mode is structurally impossible
 * now: there is no longer a state slot whose contents can disagree
 * with the current `lines`. Render count drops 3 → 2 (no separate
 * "phase 1 plain-text" render), and external callers see no API
 * change — they still get `string[]` aligned 1:1 with `lines`.
 */
export function useLineHighlight(lines: string[], filePath: string, enabled = true): string[] {
  const [tokenCache, setTokenCache] = useState<{ key: string; html: string[] } | null>(null);
  const [isDark, setIsDark] = useState(false);

  // Detect dark mode
  useEffect(() => {
    if (!enabled) return;
    const checkDarkMode = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    checkDarkMode();

    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, [enabled]);

  const linesKey = useMemo(() => enabled ? lines.join('\n') : '', [lines, enabled]);
  const currentKey = `${linesKey}:${filePath}:${isDark}`;

  // Render-time, synchronously aligned output. The cache is only
  // honoured when its key matches the CURRENT lines+filePath+theme;
  // otherwise we fall back to plain-text escaped from the current
  // lines array, which is by construction the same length / order
  // as the consumer's view of the data.
  const result = useMemo<string[]>(() => {
    if (enabled && tokenCache && tokenCache.key === currentKey) {
      return tokenCache.html;
    }
    // Fallback (also covers first paint before the highlighter
    // resolves). Same shape as the old "phase 1" setState, just
    // derived in-render instead of via state.
    return lines.map(l => escapeHtml(l || ' '));
  }, [lines, currentKey, tokenCache, enabled]);

  // Async upgrade: compute token HTML, then publish to the cache.
  // The cancelled flag guards against out-of-order resolutions when
  // `currentKey` changes again before the async work completes.
  useEffect(() => {
    if (!enabled || lines.length === 0) return;

    let cancelled = false;

    const highlight = async () => {
      try {
        const highlighter = await getHighlighter();
        if (cancelled) return;
        const language = getLanguageFromPath(filePath);
        const theme = isDark ? 'github-dark' : 'github-light';

        const tokenResult = highlighter.codeToTokens(linesKey, {
          lang: language as BundledLanguage,
          theme,
        });

        const htmlLines: string[] = [];
        for (let i = 0; i < tokenResult.tokens.length; i++) {
          htmlLines[i] = tokensToHtml(tokenResult.tokens[i]);
          // Yield every 500 lines to avoid blocking the main thread
          if (i % 500 === 0 && i > 0) {
            await new Promise(r => setTimeout(r, 0));
            if (cancelled) return;
          }
        }

        // Tag with the key we were invoked with so a stale resolve
        // can't overwrite a newer cache entry.
        setTokenCache({ key: currentKey, html: htmlLines });
      } catch (err) {
        console.error('Line highlight error:', err);
      }
    };

    highlight();
    return () => { cancelled = true; };

  }, [linesKey, filePath, isDark, enabled]);

  return result;
}
