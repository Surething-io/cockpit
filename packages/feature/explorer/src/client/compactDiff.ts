/**
 * compactDiff — pure helpers for rendering DiffView in "compact" mode
 * (changes-only, GitHub-style with collapsed unchanged regions).
 *
 * Pipeline:
 *
 *   buildCompactRows(leftLines, rightLines, gapStates)
 *      → { rows, gaps }
 *
 *   `rows` is the flat list the virtualizer iterates: a sequence of
 *   `{ kind: 'diff', idx }` (a real diff row to render) and
 *   `{ kind: 'gap', gapId, hiddenCount }` (a bar to render in place
 *   of N consecutive hidden rows).
 *
 *   `gaps` is the canonical gap registry — used by the click handler
 *   to clamp `topRevealed + bottomRevealed` against `gap.size`.
 *
 * State model — bidirectional incremental, GitHub-style:
 *
 *   For each gap, the user maintains two counters:
 *     - `topRevealed`: rows revealed at gap.startIdx, extending the
 *       upper changed region's context downward into the gap.
 *     - `bottomRevealed`: rows revealed at gap.endIdx, extending the
 *       lower changed region's context upward.
 *
 *   The bar always sits at the residual hidden middle. As the user
 *   clicks ↑ or ↓, one counter grows by `COMPACT_EXPAND_STEP` (20
 *   rows; matches GitHub) and the bar moves / shrinks. When
 *   `topRevealed + bottomRevealed >= gap.size`, the residual is
 *   empty and the bar disappears.
 *
 * Why bidirectional incremental, not "expand-all" or "expand-to-
 * function-boundary":
 *
 *   - Predictable line count per click: the user knows what each
 *     click will reveal (always +20, clamped to remaining). Avoids
 *     "I clicked once and 200 lines appeared".
 *   - Scroll anchoring (handled in DiffView's render layer) keeps
 *     the user's viewport stable. With unbounded reveals the
 *     anchor is harder to keep meaningful.
 *   - Earlier prototypes used the AST to expand to enclosing-
 *     function boundaries; user feedback was that the line count
 *     was uncontrollable and big jumps disrupted reading. We
 *     deleted the AST path and aligned with GitHub's UX exactly.
 *
 * Coordinate systems:
 *   The diff is two columns of "visual rows" (`leftLines[i]` aligns
 *   with `rightLines[i]`). One visual row is one virtualizer index.
 *   A "gap" in this module's vocabulary is a consecutive run of
 *   visual-row indices that don't make it into any hunk's context
 *   window.
 */

/** Default unchanged-line context to keep around each changed run.
 *  GitHub uses 3; matches reader expectations. */
export const COMPACT_CONTEXT_LINES = 3;

/** Lines revealed per ↑ / ↓ click. GitHub uses 20. Hardcoded; if
 *  someone wants this configurable in future, it becomes a prop. */
export const COMPACT_EXPAND_STEP = 20;

/** A visual row's left + right columns — minimal type the helpers
 *  need. Matches `leftLines[i]` / `rightLines[i]` shape from
 *  DiffView's own row builder. */
export interface VisualLine {
  lineNum: number;
  type: 'unchanged' | 'removed' | 'added';
}

/** A function-like symbol — just enough for the gap bar to label
 *  itself with "this hidden region precedes a change inside foo()".
 *  Caller projects from `FunctionNode` (or any equivalent) and
 *  filters to function-like kinds; we don't care about the kind
 *  here.
 *
 *  Why caller-provides instead of fetched here: the source of truth
 *  is `useFileFunctions`, which lives in the React component tree
 *  with its own caching + mtime-aware refresh. Threading the array
 *  through as a prop keeps `compactDiff` pure. */
export interface SymbolInfo {
  name: string;
  startLine: number;
  endLine: number;
  /** Optional parameter names for callables (function | method).
   *  Undefined means "don't render parens"; empty array means
   *  "render `()`". Same convention as `FunctionNode.params`. */
  params?: readonly string[];
}

/** Per-gap user expansion state. Missing entries default to
 *  `{ topRevealed: 0, bottomRevealed: 0 }` (fully collapsed). */
export interface GapState {
  /** Rows revealed at the gap's TOP (extending the upper changed
   *  region's context downward). Always 0 ≤ topRevealed ≤ gap.size. */
  topRevealed: number;
  /** Rows revealed at the gap's BOTTOM (extending the lower changed
   *  region's context upward). Always 0 ≤ bottomRevealed ≤ gap.size,
   *  AND topRevealed + bottomRevealed ≤ gap.size. */
  bottomRevealed: number;
}

/** A run of consecutive HIDDEN visual rows — the thing we render as
 *  a gap bar. `id` is stable across renders (assigned by source
 *  order). */
export interface Gap {
  id: number;
  startIdx: number;
  endIdx: number;
}

/** Output row types for the virtualizer.
 *
 *  `diff` rows index into `leftLines` / `rightLines`.
 *
 *  Each gap with non-empty residual emits THREE rows in a row:
 *
 *    1. `gap-expand` (direction: 'up')   — clickable "… more +N …"
 *    2. `gap-label`                      — "{count} lines hidden · funcName(...)"
 *    3. `gap-expand` (direction: 'down') — clickable "… more +N …"
 *
 *  Why three rows instead of one bar with arrow buttons: testing
 *  showed users couldn't decode `↑` / `↓` icons (no scale, no
 *  direction-of-effect hint). Putting "more +N" text labels above
 *  AND below the count label makes the action explicit and the
 *  direction self-evident from spatial position. Always-visible
 *  (no hover) so discoverability is automatic.
 *
 *  Trade-off: each gap now occupies ~3× the height it used to. For
 *  the common case (5–30 gaps in a typical changed file) this adds
 *  60–360 px of vertical space, which is acceptable given the UX
 *  win on first-time users.
 *
 *  All three rows share `gapId` so the click handler / scroll-
 *  anchor effect can connect them. `data-gap-id` lives on the
 *  middle (label) row — most stable spatial reference as
 *  expansion shrinks the gap toward the middle. */
export type RenderRow =
  | { kind: 'diff'; idx: number }
  | {
      kind: 'gap-expand';
      /** Stable id of the parent gap. */
      gapId: number;
      /** Which side of the residual range this button extends:
       *    'up'   → reveals rows AT THE TOP of the gap (extends
       *             the upper hunk's tail down into the gap)
       *    'down' → reveals rows AT THE BOTTOM of the gap (extends
       *             the lower hunk's head up into the gap)
       *  Spatially the 'up' row sits just above the label and the
       *  'down' row just below — visual position implies direction
       *  so the user doesn't have to decode an icon. */
      direction: 'up' | 'down';
      /** Lines this click would reveal: `min(STEP, residualSize)`.
       *  Shown in the row's text "more +{revealCount}". Drops
       *  below STEP when the residual is smaller than the step,
       *  so the label never lies — clicking with revealCount=5
       *  closes the gap, doesn't pretend +20. */
      revealCount: number;
    }
  | {
      kind: 'gap-label';
      gapId: number;
      /** How many rows the residual still hides. Shown as
       *  "{count} lines hidden". */
      hiddenCount: number;
      /** Function-like symbol enclosing the FIRST changed line BELOW
       *  the bar (i.e. the next changed region the user will see
       *  when scrolling down). Mirrors GitHub's "@@ -X +Y @@ funcName"
       *  hunk-header convention.
       *
       *  Undefined when:
       *    - The next changed region's line is in top-level code
       *      (no enclosing function-like symbol).
       *    - The file has no symbols available (caller passed no
       *      `symbols`, or the file isn't in the codeMap index —
       *      .json / .md / .css / etc).
       *    - The next visible row's `lineNum` is 0 (pure-removed
       *      / padding row — has no new-file line to look up). */
      enclosingFn?: SymbolInfo;
    };

/** Find the smallest (innermost) symbol whose range contains
 *  `line`. Linear over symbols — fine for ≤ 200 symbols/file. */
function innerEnclosing(
  symbols: readonly SymbolInfo[],
  line: number,
): SymbolInfo | null {
  let best: SymbolInfo | null = null;
  for (const s of symbols) {
    if (s.startLine <= line && line <= s.endLine) {
      if (!best || s.endLine - s.startLine < best.endLine - best.startLine) {
        best = s;
      }
    }
  }
  return best;
}

/**
 * Build compact-mode render rows + the gap registry from a pair of
 * (already-aligned) visual line arrays + per-gap user state +
 * (optional) function-like symbol ranges for the AFTER snapshot.
 *
 * `symbols` is read-only and informational — it does NOT influence
 * gap expansion (that's bidirectional +N rows on each click). Its
 * only job is to label each gap bar with the enclosing function of
 * the next changed region. Pass `[]` (or omit) for files without
 * AST data.
 *
 * Time: O(rows + gaps × symbols). Both factors are tiny in practice
 * (gaps cap at maybe 50 for huge files; symbols cap at file size);
 * recomputed only when leftLines / rightLines / gapStates / symbols
 * change.
 */
export function buildCompactRows(
  leftLines: readonly VisualLine[],
  rightLines: readonly VisualLine[],
  gapStates: ReadonlyMap<number, GapState>,
  symbols: readonly SymbolInfo[] = [],
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
  // hidden indices). Gap ids are positional — stable across renders
  // for the same diff but invalidated if leftLines / rightLines
  // change (e.g. user navigated to a different file). Caller resets
  // `gapStates` on that transition.
  const gaps: Gap[] = [];
  for (let i = 0; i < n; i++) {
    if (visible.has(i)) continue;
    const startIdx = i;
    while (i < n && !visible.has(i)) i++;
    gaps.push({ id: gaps.length, startIdx, endIdx: i - 1 });
    i--; // outer loop increments
  }

  // Step 4 — augment `visible` with per-gap revealed top/bottom
  // ranges. Anything still-hidden after this becomes a gap bar.
  for (const g of gaps) {
    const state = gapStates.get(g.id) ?? { topRevealed: 0, bottomRevealed: 0 };
    const size = g.endIdx - g.startIdx + 1;
    // Clamp defensively. Caller is supposed to keep states valid,
    // but state could be stale from a previous file with a larger
    // gap at the same id. Better to under-reveal than over-reveal
    // (which would index past the gap into the next hunk).
    const topRevealed = Math.max(0, Math.min(state.topRevealed, size));
    const bottomRevealed = Math.max(
      0,
      Math.min(state.bottomRevealed, size - topRevealed),
    );
    for (let k = g.startIdx; k < g.startIdx + topRevealed; k++) visible.add(k);
    for (let k = g.endIdx - bottomRevealed + 1; k <= g.endIdx; k++) visible.add(k);
  }

  // Step 5 — build the row list. Walk `n` visual rows; emit a diff
  // row for every visible index; collapse runs of hidden indices
  // into one gap bar each. Each hidden run belongs to exactly one
  // gap (top + bottom reveals leave a SINGLE residual middle range,
  // never two), so no parent-gap lookup is needed during the walk.
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

    const parent = gaps.find(
      (g) => g.startIdx <= subStart && subEnd <= g.endIdx,
    );
    if (!parent) continue; // defensive — shouldn't happen

    const hiddenCount = subEnd - subStart + 1;
    const revealCount = Math.min(COMPACT_EXPAND_STEP, hiddenCount);

    // Enclosing function of the FIRST changed line below this
    // hidden run (the next thing the user will see when scrolling
    // down). For a partially-expanded gap this is `subEnd + 1`,
    // which is by definition visible. For an end-of-file gap
    // (`subEnd + 1 >= n`) there's nothing below — leave undefined.
    let enclosingFn: SymbolInfo | undefined;
    if (symbols.length > 0 && subEnd + 1 < n) {
      // Walk forward to skip pure-removed / padding rows whose
      // `rightLine.lineNum` is 0 (no new-file line to look up).
      for (let j = subEnd + 1; j < n; j++) {
        const ln = rightLines[j].lineNum;
        if (ln <= 0) continue;
        enclosingFn = innerEnclosing(symbols, ln) ?? undefined;
        break;
      }
    }

    // Three rows per non-empty gap. Order matters: top-expand
    // first so the user reads spatial top-to-bottom as
    // expand-up | label | expand-down. The middle (label) row
    // carries `data-gap-id` for scroll anchoring.
    rows.push({
      kind: 'gap-expand',
      gapId: parent.id,
      direction: 'up',
      revealCount,
    });
    rows.push({
      kind: 'gap-label',
      gapId: parent.id,
      hiddenCount,
      enclosingFn,
    });
    rows.push({
      kind: 'gap-expand',
      gapId: parent.id,
      direction: 'down',
      revealCount,
    });
  }

  return { rows, gaps };
}
