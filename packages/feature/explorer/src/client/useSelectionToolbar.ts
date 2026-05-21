'use client';

/**
 * useSelectionToolbar — single canonical drag-to-select-with-floating-toolbar
 * plumbing for CodeViewer / DiffView / BlockViewer / MarkdownPreview.
 *
 * Replaces the four near-identical event-flow implementations that used
 * to live in `useCodeViewerLogic`, `DiffView`, `useBlockSelection`, and
 * `InteractiveMarkdownPreview`. The four call sites used different field
 * names (`selectedText` vs `codeContent`) for "the content of the
 * selection" with different semantics (literal selection vs whole-line
 * expansion), which produced both bugs (DiffView's search expanded to
 * the full line) and silent inconsistencies (3/4 sites failed to pass
 * `selectedText` to `addComment`).
 *
 * This hook fixes that by surfacing BOTH variants on the same
 * `ToolbarData` record:
 *   - `selectedText`  = literal `selection.toString()` (for Search / DB)
 *   - `lineSnapshot`  = caller-provided line/source-block expansion (for
 *                       preview cards / AI references)
 *
 * Why ref + bump (rather than React state):
 * - CodeViewer mounts inside a virtual list. Re-rendering its tree on
 *   every selection change is expensive AND destroys the live selection
 *   (because the row DOM gets rebuilt). The ref+bump pattern lets the
 *   FloatingToolbar component re-render in isolation while the parent
 *   tree stays untouched.
 * - The three older implementations had already independently
 *   converged on this pattern; this hook centralises it.
 *
 * Three-phase event flow:
 *   - mousedown        → mark drag start, clear any open toolbar
 *   - mouseup          → if the user dragged AND the selection is non-empty
 *                        AND both endpoints resolve to a line range via
 *                        `resolveLineRange`, store ToolbarData and bump
 *   - selectionchange  → hide the toolbar when the selection vanishes
 *                        (e.g. user clicked elsewhere). Skipped during
 *                        an active drag to avoid render storms.
 */

import { useEffect, useRef } from 'react';
import type { ToolbarData } from '@cockpit/shared-ui';

export interface UseSelectionToolbarOpts {
  /** Master switch — when false the listeners are not attached. */
  enabled: boolean;
  /**
   * The container element (NOT a ref). Pass the element directly so the
   * effect re-runs when the element mounts / unmounts. Using a RefObject
   * here would silently break for callers whose container becomes
   * non-null on a later render — the effect's deps wouldn't change and
   * listeners would never get attached. Callers should do
   *   const [el, setEl] = useState<HTMLElement | null>(null);
   *   <div ref={setEl}>
   * so each mount fires a re-render.
   */
  container: HTMLElement | null;
  /**
   * Resolve a Range endpoint (text or element node) to a line range
   * `{start, end}` (inclusive). The hook calls this for both endpoints
   * of the selection, then takes `min(starts)` / `max(ends)` to form
   * the final range stored on ToolbarData.
   *
   * Returning `null` from EITHER endpoint cancels the toolbar — used
   * to silently ignore selections that drift into chrome (gutter, line
   * numbers, etc) or, in BlockDiffViewer, into the wrong side of the
   * diff panel.
   *
   * Per-caller line-resolution strategy:
   *   - CodeViewer / BlockViewer: `el.closest('[data-line]')`
   *     → `{start: n, end: n}` (collapsed; outer hook does min/max)
   *   - DiffView (right panel): `el.closest('[data-new-line]')`
   *     → `{start: n, end: n}`
   *   - BlockDiffViewer (after side only): closest `[data-line]` plus
   *     `closest('[data-after]')` guard → null if wrong side
   *   - MarkdownPreview: `el.closest('[data-source-start]')`
   *     → `{start: src-start, end: src-end}` (a non-collapsed range,
   *     because markdown blocks span multiple source lines)
   */
  resolveLineRange: (
    node: Node,
  ) => { start: number; end: number } | null;
  /**
   * Given the already-computed final line range, return the
   * `lineSnapshot` string — the whole-line / source-block expansion
   * of the selection. Caller owns the expansion strategy:
   *   - Code views:   `lines.slice(start - 1, end).join('\n')`
   *   - Diff views:   walk `diffLines`, push `dl.content` for lines
   *                   in [start, end], join with '\n'
   *   - Markdown:     `sourceLines.slice(start - 1, end).join('\n')`
   */
  buildLineSnapshot: (range: { start: number; end: number }) => string;
  /** Pixel threshold below which mouseup is treated as a click (no
   *  toolbar). Default 5px — matches the legacy implementations. */
  dragThresholdPx?: number;
}

export interface UseSelectionToolbarReturn {
  /** Pass through to `<ToolbarRenderer>` from shared-ui — the renderer
   *  reads `.current` on every bump. */
  toolbarRef: React.RefObject<ToolbarData | null>;
  /** Pass through to `<ToolbarRenderer>`. Action handlers and the
   *  internal listeners both invoke `bumpRef.current()` to force the
   *  isolated renderer to re-read the ref. */
  bumpRef: React.MutableRefObject<() => void>;
  /** Imperatively close the toolbar — called by the caller's action
   *  handlers (AddComment / SendToAI / Search) right after extracting
   *  the data, so the toolbar doesn't linger over the now-open card. */
  clearToolbar: () => void;
}

export function useSelectionToolbar({
  enabled,
  container,
  resolveLineRange,
  buildLineSnapshot,
  dragThresholdPx = 5,
}: UseSelectionToolbarOpts): UseSelectionToolbarReturn {
  const toolbarRef = useRef<ToolbarData | null>(null);
  const bumpRef = useRef<() => void>(() => {});

  // Keep callbacks fresh in a ref so the listener-attachment effect
  // can have a small, stable dep list (`[enabled, container]`) and not
  // re-attach the mousedown/mouseup/selectionchange triple every render.
  const resolveRef = useRef(resolveLineRange);
  const snapshotRef = useRef(buildLineSnapshot);
  const thresholdRef = useRef(dragThresholdPx);
  resolveRef.current = resolveLineRange;
  snapshotRef.current = buildLineSnapshot;
  thresholdRef.current = dragThresholdPx;

  useEffect(() => {
    if (!enabled || !container) return;

    let isDragging = false;
    let downX = 0;
    let downY = 0;

    const clear = () => {
      if (toolbarRef.current) {
        toolbarRef.current = null;
        bumpRef.current();
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      downX = e.clientX;
      downY = e.clientY;
      // Clicks on the toolbar's own buttons must NOT clear the toolbar
      // here, otherwise React unmounts it before its onClick fires.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.floating-toolbar')) return;
      clear();
    };

    const handleMouseUp = (e: MouseEvent) => {
      isDragging = false;

      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.floating-toolbar')) return;

      const threshold = thresholdRef.current;
      const moved =
        Math.abs(e.clientX - downX) > threshold ||
        Math.abs(e.clientY - downY) > threshold;

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim() || !moved) {
        clear();
        return;
      }

      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        clear();
        return;
      }

      const a = resolveRef.current(range.startContainer);
      const b = resolveRef.current(range.endContainer);
      if (!a || !b) {
        clear();
        return;
      }

      const start = Math.min(a.start, b.start);
      const end = Math.max(a.end, b.end);
      const selectedText = sel.toString();
      const lineSnapshot = snapshotRef.current({ start, end });

      toolbarRef.current = {
        x: e.clientX,
        y: e.clientY,
        range: { start, end },
        selectedText,
        lineSnapshot,
      };
      bumpRef.current();
    };

    const handleSelectionChange = () => {
      if (isDragging) return;
      if (!toolbarRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        clear();
      }
    };

    container.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      container.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, [enabled, container]);

  return {
    toolbarRef,
    bumpRef,
    clearToolbar: () => {
      if (toolbarRef.current) {
        toolbarRef.current = null;
        bumpRef.current();
      }
    },
  };
}
