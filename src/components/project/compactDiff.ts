/**
 * compactDiff — pure helpers for rendering DiffView in "compact" mode
 * (changes-only, GitHub-style with collapsed unchanged regions).
 *
 * Pipeline:
 *
 *   1. `buildCompactRows(leftLines, rightLines, gapStates, symbols)`
 *      → `{ rows, gaps }`
 *
 *      `rows` is the flat list the virtualizer iterates: a sequence of
 *      `{ kind: 'diff', idx }` (a real diff row to render) and
 *      `{ kind: 'gap', gapId, hiddenCount, level, nextState }` (a bar
 *      to render in place of N consecutive hidden rows).
 *
 *      `gaps` is the canonical gap list keyed by id. Used by the
 *      click handler to look up `nextState` semantics from the bar.
 *
 *   2. Per-gap `level` is one of {0, 1, 2}:
 *        0 = collapsed (default)
 *        1 = AST-expanded — the enclosing function head/tail is shown
 *            on each side of the gap, but anything between two
 *            different functions stays hidden as sub-gap(s)
 *        2 = fully expanded — every line of the gap rendered
 *      `nextState` skips state 1 when it would visually equal 2 (no
 *      function info available, or the AST expansion happens to cover
 *      the whole gap).
 *
 * Coordinate systems (this is the gotcha):
 *   - The diff is two columns of "visual rows" (`leftLines[i]` aligns
 *     with `rightLines[i]`). One visual row is one virtualizer index.
 *   - Symbol ranges use NEW-FILE LINES (because `symbols` comes from
 *     the post-edit `flatSymbols`, which is what the right column
 *     shows). When mapping a symbol's `[startLine, endLine]` back to
 *     visual rows we look up `rightLines[i].lineNum` — which equals
 *     the new-file line on `unchanged | added` rows and is `0` on
 *     padding / pure-`removed` rows.
 *   - This means a function that lives entirely in lines that were
 *     deleted (no new-file lines) won't be addressable by symbol
 *     range — but that's fine: those lines are all `removed` and
 *     hence already in the changed-rows-with-context set, never
 *     appear in a gap.
 */

/** Default unchanged-line context to keep around each changed run.
 *  GitHub uses 3; matches reader expectations. Hardcoded for KISS;
 *  if/when users want more, adding a prop is trivial. */
export const COMPACT_CONTEXT_LINES = 3;

/** A function-like symbol's line range — what the AST-expand path
 *  needs from `IndexedSymbol`. Caller projects from `FunctionNode`
 *  or equivalent. Sorted by `startLine` is NOT required (we sort
 *  internally). */
export interface SymbolRange {
  startLine: number;
  endLine: number;
}

/** A visual row's left + right columns — minimal type the helpers
 *  need. Matches `leftLines[i]` / `rightLines[i]` shape from
 *  DiffView's own row builder. */
export interface VisualLine {
  lineNum: number;
  type: 'unchanged' | 'removed' | 'added';
}

/** Visual-row index range INCLUSIVE on both ends. */
interface RowRange {
  start: number;
  end: number;
}

/** A run of consecutive HIDDEN visual rows — the thing we render as
 *  a gap bar. `id` is stable across renders (assigned by source
 *  order); `level` is the user's expansion choice (state machine
 *  entry below). */
export interface Gap {
  id: number;
  startIdx: number;
  endIdx: number;
}

/** Output row types for the virtualizer. `diff` rows index into
 *  `leftLines` / `rightLines`; `gap` rows render the expandable
 *  bar. */
export type RenderRow =
  | { kind: 'diff'; idx: number }
  | {
      kind: 'gap';
      /** Stable id of the parent gap (a partially-expanded gap can
       *  produce MULTIPLE bar rows — one per residual sub-range —
       *  which all share the same id). */
      gapId: number;
      /** How many hidden rows this bar represents. Shown in the
       *  bar's text ("── 12 lines hidden ──"). */
      hiddenCount: number;
      /** Current level of the parent gap. Drives the bar's label
       *  (state 0 = "show context", state 1 = "show all"). */
      level: 0 | 1;
      /** State to transition to on click. Pre-computed so the click
       *  handler doesn't have to re-derive AST usefulness. */
      nextState: 1 | 2;
    };

/** Find the smallest (innermost) symbol whose range contains
 *  `line`. Linear over symbols — fine for ≤ 200 symbols/file. */
function innerEnclosing(
  symbols: readonly SymbolRange[],
  line: number,
): SymbolRange | null {
  let best: SymbolRange | null = null;
  for (const s of symbols) {
    if (s.startLine <= line && line <= s.endLine) {
      if (!best || s.endLine - s.startLine < best.endLine - best.startLine) {
        best = s;
      }
    }
  }
  return best;
}

/** Map a new-file line number to its visual-row index. Linear scan
 *  — only called once per gap (twice per gap actually) at compact-
 *  mode build time, so O(rows) per gap is fine for typical files.
 *  Returns `null` if the line isn't represented (shouldn't happen
 *  for lines that ARE in the file, but we defend). */
function newLineToIdx(
  rightLines: readonly VisualLine[],
  newLine: number,
): number | null {
  for (let i = 0; i < rightLines.length; i++) {
    if (rightLines[i].lineNum === newLine) return i;
  }
  return null;
}

/** For a given gap, compute the visual-row ranges that should be
 *  REVEALED at level 1 (AST-aware expand). Returns 0, 1, or 2 ranges
 *  inside `[gap.startIdx, gap.endIdx]`. Empty array means AST has
 *  nothing useful — caller should fast-forward state 0 → 2.
 *
 *  Algorithm:
 *   - "Top side": find the function enclosing the line just BEFORE
 *     the gap (last visible row's new-line). If that function
 *     extends INTO the gap, reveal `[gap.start, fnEndIdx]` so the
 *     user sees the function's tail.
 *   - "Bottom side": find the function enclosing the line just
 *     AFTER the gap (first visible row's new-line). If that
 *     function STARTS inside the gap, reveal `[fnStartIdx, gap.end]`
 *     so the user sees the function's head.
 *   - If the two reveals overlap or touch (same function spans the
 *     whole gap, or two functions back-to-back with no in-between
 *     code), merge into one range covering the whole gap. */
function computeAstReveal(
  gap: Gap,
  rightLines: readonly VisualLine[],
  symbols: readonly SymbolRange[],
): RowRange[] {
  // Find the new-file line numbers immediately bracketing the gap.
  // gap.startIdx-1 may be -1 (gap starts at row 0); gap.endIdx+1
  // may be rightLines.length (gap ends at last row). In either
  // edge case the AST expansion on that side is a no-op.
  const beforeIdx = gap.startIdx - 1;
  const afterIdx = gap.endIdx + 1;

  // Walk back/forward to skip rows whose right-side has lineNum=0
  // (pure-removed rows or padding). Those don't have a new-file
  // line to feed into `innerEnclosing`.
  const beforeLine = (() => {
    for (let i = beforeIdx; i >= 0; i--) {
      const ln = rightLines[i].lineNum;
      if (ln > 0) return ln;
    }
    return null;
  })();
  const afterLine = (() => {
    for (let i = afterIdx; i < rightLines.length; i++) {
      const ln = rightLines[i].lineNum;
      if (ln > 0) return ln;
    }
    return null;
  })();

  const reveals: RowRange[] = [];

  // Top reveal — function enclosing `beforeLine` extends into gap.
  if (beforeLine !== null) {
    const upperFn = innerEnclosing(symbols, beforeLine);
    if (upperFn && upperFn.endLine > beforeLine) {
      const tailIdx = newLineToIdx(rightLines, upperFn.endLine);
      if (tailIdx !== null) {
        const end = Math.min(tailIdx, gap.endIdx);
        reveals.push({ start: gap.startIdx, end });
      }
    }
  }

  // Bottom reveal — function enclosing `afterLine` starts inside gap.
  if (afterLine !== null) {
    const lowerFn = innerEnclosing(symbols, afterLine);
    if (lowerFn && lowerFn.startLine < afterLine) {
      const headIdx = newLineToIdx(rightLines, lowerFn.startLine);
      if (headIdx !== null) {
        const start = Math.max(headIdx, gap.startIdx);
        reveals.push({ start, end: gap.endIdx });
      }
    }
  }

  if (reveals.length === 0) return [];

  // Merge overlapping/touching ranges (case: same function on both
  // sides, or two functions back-to-back). Sort by start, then
  // sweep.
  reveals.sort((a, b) => a.start - b.start);
  const merged: RowRange[] = [reveals[0]];
  for (let i = 1; i < reveals.length; i++) {
    const last = merged[merged.length - 1];
    const cur = reveals[i];
    if (cur.start <= last.end + 1) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

/**
 * Build compact-mode render rows + the gap registry from a pair of
 * (already-aligned) visual line arrays + per-gap user state +
 * (optional) AST symbol ranges.
 *
 * `gapStates` is a `Map<gapId, level>` owned by the caller (React
 * state). Missing entries default to level 0.
 *
 * `symbols` is OPTIONAL. When absent or empty, the click action on
 * a gap bar transitions directly 0 → 2 (single click = expand all).
 * When present, the cycle is 0 → 1 → 2 with the AST-expanded
 * intermediate.
 *
 * Returns:
 *   - `rows`: the virtualizer input — diff rows + gap bars in
 *     visual order. Each gap bar carries its own `level` and
 *     `nextState` so the click handler is dumb.
 *   - `gaps`: the registry, used by the caller for things like
 *     "expand all" / debug introspection.
 *
 * Time: O(rows + gaps × symbols). Both factors are tiny in practice
 * (gaps × symbols caps at maybe 50 × 200 = 10k for huge files;
 * recomputed only when leftLines / rightLines / gapStates / symbols
 * change).
 */
export function buildCompactRows(
  leftLines: readonly VisualLine[],
  rightLines: readonly VisualLine[],
  gapStates: ReadonlyMap<number, 0 | 1 | 2>,
  symbols: readonly SymbolRange[] = [],
): { rows: RenderRow[]; gaps: Gap[] } {
  const n = leftLines.length;

  // Step 1 — classify each visual row as changed (anything but
  // `unchanged | unchanged`) or unchanged.
  const isChanged = (i: number) =>
    leftLines[i].type !== 'unchanged' || rightLines[i].type !== 'unchanged';

  // Step 2 — find the visible set: every changed row + 3 lines of
  // context on each side. Context windows around adjacent runs may
  // overlap; the Set dedupes.
  const visible = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (!isChanged(i)) continue;
    const lo = Math.max(0, i - COMPACT_CONTEXT_LINES);
    const hi = Math.min(n - 1, i + COMPACT_CONTEXT_LINES);
    for (let j = lo; j <= hi; j++) visible.add(j);
  }

  // Step 3 — derive gaps from the complement (consecutive runs of
  // hidden indices).
  const gaps: Gap[] = [];
  for (let i = 0; i < n; i++) {
    if (visible.has(i)) continue;
    const startIdx = i;
    while (i < n && !visible.has(i)) i++;
    gaps.push({ id: gaps.length, startIdx, endIdx: i - 1 });
    i--; // outer loop increments
  }

  const useAst = symbols.length > 0;

  // Step 4 — for each gap at level 1, compute the AST-revealed
  // sub-ranges. Augment `visible` with those rows so the rendering
  // pass treats them as visible. Cache the ranges so the rendering
  // pass can also place sub-gap bars in the residual hidden runs.
  const gapAstReveals = new Map<number, RowRange[]>();
  // Also: for each gap, decide what `nextState` clicking it
  // implies. If AST has nothing useful for this gap, skip level 1
  // (the bar at level 0 jumps straight to level 2).
  const gapNextFromZero = new Map<number, 1 | 2>();

  for (const g of gaps) {
    let astRanges: RowRange[] = [];
    if (useAst) {
      astRanges = computeAstReveal(g, rightLines, symbols);
      // If AST coverage equals the whole gap, level 1 == level 2
      // visually; don't bother stopping at 1.
      const coversAll =
        astRanges.length === 1 &&
        astRanges[0].start === g.startIdx &&
        astRanges[0].end === g.endIdx;
      gapNextFromZero.set(g.id, coversAll ? 2 : astRanges.length > 0 ? 1 : 2);
    } else {
      gapNextFromZero.set(g.id, 2);
    }
    if ((gapStates.get(g.id) ?? 0) === 1 && astRanges.length > 0) {
      gapAstReveals.set(g.id, astRanges);
    }
  }

  // Apply level 2 (full reveal) and level 1 (AST reveal) to the
  // visible set BEFORE building rows. Rendering then becomes a
  // single linear pass: visible → diff row, hidden → gap bar.
  for (const g of gaps) {
    const lvl = gapStates.get(g.id) ?? 0;
    if (lvl === 2) {
      for (let k = g.startIdx; k <= g.endIdx; k++) visible.add(k);
    } else if (lvl === 1) {
      const ranges = gapAstReveals.get(g.id) ?? [];
      for (const r of ranges) {
        for (let k = r.start; k <= r.end; k++) visible.add(k);
      }
    }
  }

  // Step 5 — build the row list. Walk `n` visual rows; emit a diff
  // row for every visible index; collapse runs of hidden indices
  // into one gap bar each (a partially-expanded gap may emit 1 or
  // 2 sub-gap bars all sharing the parent's `gapId`).
  const rows: RenderRow[] = [];
  for (let i = 0; i < n; i++) {
    if (visible.has(i)) {
      rows.push({ kind: 'diff', idx: i });
      continue;
    }
    const subStart = i;
    while (i < n && !visible.has(i)) i++;
    const subEnd = i - 1;
    i--; // outer loop increments

    // Find the parent gap. (Linear scan over `gaps`; gaps are
    // sorted by startIdx so an early-exit binary search would be
    // possible but unnecessary at our scale.)
    const parent = gaps.find(
      (g) => g.startIdx <= subStart && subEnd <= g.endIdx,
    );
    if (!parent) continue; // defensive — shouldn't happen
    const lvl = gapStates.get(parent.id) ?? 0;
    if (lvl === 2) continue; // shouldn't reach here; defensive
    const nextState: 1 | 2 = lvl === 1 ? 2 : (gapNextFromZero.get(parent.id) ?? 2);
    rows.push({
      kind: 'gap',
      gapId: parent.id,
      hiddenCount: subEnd - subStart + 1,
      level: lvl as 0 | 1,
      nextState,
    });
  }

  return { rows, gaps };
}
