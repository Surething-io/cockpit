'use client';

/**
 * BlockCommentBubbles — per-line comment marker overlay for one block.
 *
 * Why an overlay rather than splicing into the Shiki HTML: the body is
 * a single `dangerouslySetInnerHTML` blob to keep highlighting cheap.
 * Inserting per-line elements would mean parsing Shiki's output and
 * re-stitching it on every comment change. An absolutely-positioned
 * sibling layer is simpler, layout-stable, and lets the user click a
 * bubble without disturbing text selection on the underlying line.
 *
 * Geometry: comment bubbles share the same line-height contract as
 * the FunctionRow's right-column pin alignment — `LINE_HEIGHT_PX = 18`
 * paired with the body's explicit lineHeight style, plus the constant
 * header / body-padding offsets. We anchor each bubble to the
 * comment's `endLine` (matches CodeViewer's `commentsByEndLine`
 * convention — the end of the range is where the user expects the
 * marker visually).
 *
 * Out-of-range comments (those whose endLine falls outside the block's
 * [startLine, endLine] window) are silently dropped. Surfacing them is
 * a follow-up — phase 1 keeps the overlay strictly local to the block
 * to avoid mis-aligned markers.
 */

import { MessageSquare } from 'lucide-react';
import type { CodeComment } from '@cockpit/feature-comments';
import { Tooltip } from '@cockpit/shared-ui';

interface BlockCommentBubblesProps {
  /** All comments for the focal file. The component filters by line
   *  range internally — caller passes the full set rather than each
   *  block re-doing the same filter on the parent side. */
  comments: readonly CodeComment[];
  /** Block's source-line range (1-based, inclusive). */
  startLine: number;
  endLine: number;
  /** Pixel height of one rendered code line. Must match the body's
   *  explicit lineHeight style and FunctionRow's LINE_HEIGHT_PX. */
  lineHeight: number;
  /** Pixel offset from the block's top to the first code line —
   *  header height + body padding-top. Caller passes its own value
   *  because BlockViewer and BlockDiffViewer have slightly different
   *  header chromes. */
  bodyTopOffset: number;
  onCommentClick: (comment: CodeComment, e: React.MouseEvent) => void;
}

export function BlockCommentBubbles({
  comments,
  startLine,
  endLine,
  lineHeight,
  bodyTopOffset,
  onCommentClick,
}: BlockCommentBubblesProps) {
  // Group by endLine so multiple comments on the same line stack into
  // a single bubble with a count badge — matches CodeViewer's behavior.
  const byEndLine = new Map<number, CodeComment[]>();
  for (const c of comments) {
    if (c.endLine < startLine || c.endLine > endLine) continue;
    const list = byEndLine.get(c.endLine);
    if (list) list.push(c);
    else byEndLine.set(c.endLine, [c]);
  }

  if (byEndLine.size === 0) return null;

  return (
    <div className="absolute top-0 right-0 bottom-0 w-6 pointer-events-none">
      {Array.from(byEndLine.entries()).map(([line, list]) => {
        const top = bodyTopOffset + (line - startLine) * lineHeight;
        // Anchor the bubble's vertical CENTER to the line's CENTER so
        // it visually reads as "this line". The bubble is roughly
        // 16px tall; offset half its height to center on the line's
        // mid (lineHeight/2).
        const centeredTop = top + lineHeight / 2 - 8;
        const first = list[0];
        const more = list.length - 1;
        return (
          <Tooltip
            key={line}
            content={
              list.length === 1
                ? first.content
                : `${list.length} comments — click to view`
            }
          >
            <button
              onClick={(e) => onCommentClick(first, e)}
              className="pointer-events-auto absolute right-1 w-4 h-4 rounded-full bg-amber-9/70 hover:bg-amber-11 text-white flex items-center justify-center shadow-sm transition-colors"
              style={{ top: `${centeredTop}px` }}
            >
              <MessageSquare className="w-2.5 h-2.5" />
              {more > 0 && (
                <span className="absolute -top-1 -right-1 bg-amber-11 text-white rounded-full text-[8px] leading-none w-3 h-3 flex items-center justify-center">
                  {more + 1}
                </span>
              )}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
