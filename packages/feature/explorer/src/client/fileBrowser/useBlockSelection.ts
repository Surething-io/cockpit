'use client';

/**
 * useBlockSelection — drag-to-select-with-floating-toolbar plumbing for
 * the Block / BlockDiff viewers.
 *
 * Why a fresh hook instead of reusing `useCodeViewerLogic`: the
 * existing hook is welded to the virtual-list CodeViewer (it owns
 * row-type enums, search state, scroll-to-line, blame, and a dozen
 * other things). Block view doesn't have any of that — it's just a
 * stack of Shiki HTML islands. Lifting only the "selection → toolbar"
 * sliver into a small standalone hook keeps the surface honest and
 * avoids dragging the virtual-list assumptions in.
 *
 * Three-phase event flow, mirroring the convention established in
 * useCodeViewerLogic / DiffView:
 *
 *   - mousedown   → mark drag start, clear any open toolbar
 *   - mouseup     → if the user actually dragged AND there's a non-empty
 *                   selection inside our container, find the line range
 *                   and pop the toolbar. Clicks on the toolbar itself
 *                   are skipped so its onClick can fire normally.
 *   - selectionchange → hide the toolbar when the selection vanishes
 *                       (e.g. user clicked elsewhere). Skipped while
 *                       dragging to avoid re-render storms.
 *
 * Line-resolution strategy: each rendered code line carries the
 * `data-line` attribute (an absolute file line number). We climb from
 * each selection endpoint until we hit a `[data-line]` carrier, read
 * its int, and take min/max to form a `{start, end}` range. Selections
 * whose endpoints don't resolve to lines (e.g. dragged into chrome)
 * are silently ignored.
 *
 * Optional `bodyScope` lets BlockDiffViewer restrict selection to one
 * side of the diff: pass `[data-after]` and only after-side selections
 * make it past the resolver.
 */

import { useEffect, useState } from 'react';

export interface BlockSelectionToolbar {
  /** clientX/clientY of the mouseup event — caller positions the
   *  toolbar relative to its container by subtracting that container's
   *  bounding rect. */
  x: number;
  y: number;
  /** Absolute file line range (inclusive). */
  range: { start: number; end: number };
  /** The exact text the user selected — useful for SendToAI prompts
   *  and for echoing in AddCommentInput previews. */
  selectedText: string;
}

interface UseBlockSelectionOpts {
  /** Master switch — false when comments aren't enabled (no cwd, etc). */
  enabled: boolean;
  /**
   * The container element (NOT a ref). Pass the element directly so
   * the effect re-runs when the element mounts / unmounts. Using a
   * `RefObject` here would silently break: refs don't trigger re-renders,
   * so if the caller's container starts null and is filled in on a
   * later render (e.g. after a `loading → ready` transition that swaps
   * the rendered subtree), the effect's deps wouldn't change and the
   * mousedown / mouseup listeners would never get attached. Callers
   * should do `const [el, setEl] = useState<HTMLElement | null>(null)`
   * and `<div ref={setEl}>` so each mount fires a re-render.
   */
  container: HTMLElement | null;
  /** Optional CSS selector restricting which subtree a line endpoint
   *  must live under. BlockDiffViewer uses this to scope selection to
   *  the after-side panel only. */
  bodyScope?: string;
}

export interface UseBlockSelectionReturn {
  toolbar: BlockSelectionToolbar | null;
  /** Imperatively close the toolbar — called by the caller once an
   *  AddComment / SendToAI action is committed so the toolbar doesn't
   *  linger over the now-open input card. */
  clearToolbar: () => void;
}

const DRAG_THRESHOLD_PX = 5;

export function useBlockSelection({
  enabled,
  container,
  bodyScope,
}: UseBlockSelectionOpts): UseBlockSelectionReturn {
  const [toolbar, setToolbar] = useState<BlockSelectionToolbar | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!container) return;

    let isDragging = false;
    let downX = 0;
    let downY = 0;

    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      downX = e.clientX;
      downY = e.clientY;
      // Clicks on the toolbar's own buttons must NOT clear the toolbar
      // here, otherwise React unmounts it before its onClick fires.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.floating-toolbar')) return;
      setToolbar((prev) => (prev ? null : prev));
    };

    const handleMouseUp = (e: MouseEvent) => {
      isDragging = false;

      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.floating-toolbar')) return;

      const moved =
        Math.abs(e.clientX - downX) > DRAG_THRESHOLD_PX ||
        Math.abs(e.clientY - downY) > DRAG_THRESHOLD_PX;

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim() || !moved) {
        setToolbar((prev) => (prev ? null : prev));
        return;
      }

      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setToolbar((prev) => (prev ? null : prev));
        return;
      }

      const startLine = resolveLine(range.startContainer, container, bodyScope);
      const endLine = resolveLine(range.endContainer, container, bodyScope);
      if (startLine == null || endLine == null) {
        setToolbar((prev) => (prev ? null : prev));
        return;
      }

      const lo = Math.min(startLine, endLine);
      const hi = Math.max(startLine, endLine);
      setToolbar({
        x: e.clientX,
        y: e.clientY,
        range: { start: lo, end: hi },
        selectedText: sel.toString(),
      });
    };

    const handleSelectionChange = () => {
      if (isDragging) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setToolbar((prev) => (prev ? null : prev));
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
  }, [enabled, container, bodyScope]);

  return {
    toolbar,
    clearToolbar: () => setToolbar(null),
  };
}

/**
 * Walk up from a Range endpoint (text or element node) until we find
 * the nearest ancestor with a `data-line` attribute, optionally
 * restricted to a subtree matching `bodyScope`. Returns the parsed
 * line number, or null if the endpoint is in chrome (no carrier) or
 * the wrong subtree.
 */
function resolveLine(
  node: Node,
  container: HTMLElement,
  bodyScope: string | undefined,
): number | null {
  if (!document.contains(node)) return null;
  const startEl: Element | null =
    node.nodeType === Node.TEXT_NODE
      ? (node.parentElement as Element | null)
      : (node as Element);
  if (!startEl) return null;
  const carrier = startEl.closest('[data-line]');
  if (!carrier || !container.contains(carrier)) return null;
  if (bodyScope && !carrier.closest(bodyScope)) return null;
  const v = carrier.getAttribute('data-line');
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
