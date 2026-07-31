'use client';

// Shared token-hover plumbing for the LSP hover card.
//
// Two surfaces feed the same hover pipeline — CodeViewer's `CodeLine`
// and DiffView's after-side rows — and both need an identical set of
// suppression rules plus a 1-based column. Keeping that logic here means
// a fix to the caret math (or to the drag/selection rules) lands on both
// at once instead of drifting apart.

/**
 * Calculate the 1-based column of a mouse position within a rendered code
 * line. `caretRangeFromPoint` locates the text node + offset under the
 * cursor; the TreeWalker then accumulates the characters preceding it, so
 * Shiki's nested token spans don't affect the count. Falls back to column
 * 1 when the point resolves outside `codeSpan`.
 */
export function getColumnFromClick(e: React.MouseEvent, codeSpan: HTMLElement): number {
  const range = document.caretRangeFromPoint(e.clientX, e.clientY);
  if (!range || !codeSpan.contains(range.startContainer)) {
    return 1;
  }

  const targetNode = range.startContainer;
  const targetOffset = range.startOffset;

  const walker = document.createTreeWalker(codeSpan, NodeFilter.SHOW_TEXT);
  let column = 1;
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    if (node === targetNode) {
      column += targetOffset;
      return column;
    }
    column += node.textContent?.length || 0;
  }

  return column;
}

/**
 * Resolve a mouseover event into the coordinates of an LSP hover request,
 * or null when the event should be ignored.
 *
 * Suppression rules, shared by every hover surface:
 *   - a mouse button is held → the user is drag-selecting, not reading;
 *   - a non-collapsed selection exists → the floating comment / send-to-AI
 *     toolbar owns the interaction, and a hover card would fight it;
 *   - the target is not a Shiki token (a `<span>` carrying an inline
 *     color) → whitespace, gutters and line-number cells never resolve to
 *     a meaningful symbol.
 *
 * `rect` anchors the card to the bottom-left of the hovered token, in
 * viewport coordinates.
 */
export function resolveTokenHover(
  e: React.MouseEvent,
  codeSpan: HTMLElement,
): { column: number; rect: { x: number; y: number } } | null {
  if (e.buttons !== 0) return null;

  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return null;

  const target = e.target as HTMLElement;
  if (target.tagName !== 'SPAN' || !target.style.color) return null;

  const rect = target.getBoundingClientRect();
  return {
    column: getColumnFromClick(e, codeSpan),
    rect: { x: rect.left, y: rect.bottom + 4 },
  };
}
