/**
 * blockFold — intra-block line folding for the code map's compact (精简) mode.
 *
 * Compact mode used to be a BLOCK-level filter only: `BlockViewer` dropped
 * every chip the diff didn't touch, but a chip that survived rendered all of
 * its lines. A 372-line function with a 4-line edit still cost 372 lines of
 * scrolling. This module supplies the second level — inside a surviving
 * block, keep the changed lines plus `COMPACT_CONTEXT_LINES` of context and
 * collapse each remaining run into a single clickable bar.
 *
 * The rule is deliberately the SAME one file-view mode uses
 * (`compactDiff.buildCompactRows`): changed line ± 3. Two diff surfaces that
 * hide lines by two different rules would make the reviewer re-learn what
 * "精简" means every time they flip between 文件 and 代码地图.
 *
 * What differs from `compactDiff` is the reveal interaction: file view offers
 * incremental ±20 expansion, this offers one click = whole gap. A code-map
 * gap sits inside a single function (already narrowed by the block filter),
 * so it is short enough that stepping through it in 20-line increments is
 * more clicks than value — and every reveal re-runs the right column's pin
 * placement, which we would rather do once.
 *
 * Coordinate systems — the whole reason this is a module and not a `filter()`
 * at the render site:
 *
 *   - FILE LINE: absolute, 1-based. What `addedLines`, `FnNode.startLine`,
 *     `RowPin.lines` and every `data-line` attribute speak.
 *   - VISUAL ROW: 0-based index of a rendered row inside the block body.
 *     Each visible line is one row AND EACH FOLD BAR IS ALSO EXACTLY ONE ROW
 *     (the bar is rendered at `LINE_HEIGHT_PX`) — that invariant is what
 *     keeps `rowOf` pure arithmetic and lets the callee-pin column keep its
 *     `top = HEADER + PADDING + row * LINE_HEIGHT` formula.
 *
 * `rowOf` is total: a hidden line resolves to the row of the bar that
 * swallowed it, so a pin whose call site got folded away parks ON that bar
 * rather than disappearing or drifting.
 */

import { COMPACT_CONTEXT_LINES } from '../compactDiff';

/**
 * Runs shorter than this are never folded. A bar occupies one row, so
 * folding a 1-line run saves nothing while still costing the reader a
 * "what's hidden here?" stop. 2 is the first length where the trade pays.
 */
export const MIN_FOLD_LINES = 2;

export interface FoldSegment {
  /** `lines` = rendered normally; `gap` = collapsed into one bar row. */
  kind: 'lines' | 'gap';
  /** 1-based, inclusive, absolute file lines. */
  startLine: number;
  endLine: number;
}

export interface LineRun {
  startLine: number;
  endLine: number;
}

export interface BlockFold {
  /** Ordered, contiguous, covering exactly the block's line range. */
  segments: readonly FoldSegment[];
  /** Visible runs, in order — the minimap's rendered-line axis. */
  visibleRuns: readonly LineRun[];
  /** Total folded-away line count (sum over gaps). */
  hiddenCount: number;
  /**
   * File line → visual row index inside the block body. Hidden lines map to
   * their gap bar's row; out-of-range lines clamp to the first / last row.
   */
  rowOf: (line: number) => number;
}

/**
 * Build the fold plan for one block, or `null` when nothing folds — every
 * line sits within context of a change, or the block is too short to have a
 * foldable run. `null` means "render as before": every consumer treats it as
 * the identity mapping, so no caller needs a second code path for the
 * unfolded case.
 *
 * A block with NO changed lines collapses to a single bar rather than
 * returning null. That only happens when the block filter is off (a language
 * with no `changedQnames` projection), and there, hiding an untouched body
 * behind one clickable row is exactly what compact was asked for — the chip
 * header still names the function and carries its line count.
 *
 * @param isExpanded Called with a gap's `startLine` (its stable id — gap
 *   boundaries are derived from the changed lines, which don't move while
 *   the user clicks). Returning true re-merges that gap into the visible
 *   set, which is how one-click reveal is implemented without the caller
 *   keeping a second, mutated copy of the plan.
 */
export function buildBlockFold(
  startLine: number,
  endLine: number,
  changedLines: ReadonlySet<number>,
  isExpanded: (gapStartLine: number) => boolean,
  context: number = COMPACT_CONTEXT_LINES,
): BlockFold | null {
  if (endLine < startLine) return null;

  // Step 1: changed lines inside this block → context windows, merged.
  // Adjacent windows (`next.start === cur.end + 1`) merge too: leaving a
  // zero-length gap between them would emit a bar that hides nothing.
  const anchors: number[] = [];
  for (const line of changedLines) {
    if (line >= startLine && line <= endLine) anchors.push(line);
  }
  anchors.sort((a, b) => a - b);

  let visible: LineRun[] = [];
  for (const a of anchors) {
    const lo = Math.max(startLine, a - context);
    const hi = Math.min(endLine, a + context);
    const last = visible[visible.length - 1];
    if (last && lo <= last.endLine + 1) {
      if (hi > last.endLine) last.endLine = hi;
    } else {
      visible.push({ startLine: lo, endLine: hi });
    }
  }

  // Step 2: complement → candidate gaps; short ones and user-expanded ones
  // fall back to visible.
  const gaps: LineRun[] = [];
  let cursor = startLine;
  for (const run of visible) {
    if (run.startLine > cursor) {
      gaps.push({ startLine: cursor, endLine: run.startLine - 1 });
    }
    cursor = run.endLine + 1;
  }
  if (cursor <= endLine) gaps.push({ startLine: cursor, endLine });

  const keptGaps: LineRun[] = [];
  const reclaimed: LineRun[] = [];
  for (const g of gaps) {
    const size = g.endLine - g.startLine + 1;
    if (size < MIN_FOLD_LINES || isExpanded(g.startLine)) reclaimed.push(g);
    else keptGaps.push(g);
  }
  if (keptGaps.length === 0) return null;

  // Step 3: re-merge visible + reclaimed into ordered runs.
  visible = mergeRuns([...visible, ...reclaimed]);

  // Step 4: stitch runs and gaps into one ordered segment list, and build
  // the row lookup off the same walk (bar = 1 row, line = 1 row).
  const segments: FoldSegment[] = [];
  const merged: Array<FoldSegment> = [
    ...visible.map((r): FoldSegment => ({ kind: 'lines', ...r })),
    ...keptGaps.map((r): FoldSegment => ({ kind: 'gap', ...r })),
  ].sort((a, b) => a.startLine - b.startLine);
  for (const s of merged) segments.push(s);

  const rowStarts: number[] = [];
  let row = 0;
  for (const s of segments) {
    rowStarts.push(row);
    row += s.kind === 'gap' ? 1 : s.endLine - s.startLine + 1;
  }
  const totalRows = row;

  const rowOf = (line: number): number => {
    // Linear walk: a block has a handful of segments, and this is called
    // once per pin / comment bubble — a binary search would cost more in
    // reading than it saves in cycles.
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (line < s.startLine) break;
      if (line <= s.endLine) {
        return s.kind === 'gap' ? rowStarts[i] : rowStarts[i] + (line - s.startLine);
      }
    }
    return line < startLine ? 0 : Math.max(0, totalRows - 1);
  };

  return {
    segments,
    visibleRuns: visible,
    hiddenCount: keptGaps.reduce((n, g) => n + (g.endLine - g.startLine + 1), 0),
    rowOf,
  };
}

/** Sort by start and merge overlapping / adjacent runs. */
function mergeRuns(runs: LineRun[]): LineRun[] {
  const sorted = [...runs].sort((a, b) => a.startLine - b.startLine);
  const out: LineRun[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startLine <= last.endLine + 1) {
      if (r.endLine > last.endLine) last.endLine = r.endLine;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
