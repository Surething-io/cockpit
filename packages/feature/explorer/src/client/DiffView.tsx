'use client';

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useComments, type CodeComment } from '@cockpit/feature-comments';
import { fetchAllCommentsWithCode, clearAllComments, buildAIMessage, type CodeReference } from '@cockpit/feature-comments';
import { useMenuContainer } from '@cockpit/shared-ui';
import { useAIBridge } from '@cockpit/shared-ui';
import { AddCommentInput, SendToAIInput, ToolbarRenderer } from '@cockpit/shared-ui';
import { computeLineDiff } from './index';
import {
  buildCompactRows,
  COMPACT_EXPAND_STEP,
  COMPACT_CONTEXT_LINES,
  type DiffLine,
  type GapState,
  type RenderRow,
  type SymbolInfo,
  type VisualLine,
} from './index';
import { toast } from '@cockpit/shared-ui';
import { useLineHighlight } from './index';
import { escapeHtml } from '@cockpit/shared-ui';
import { DiffMinimap } from './index';
import { ViewCommentCard } from './index';
import { useSelectionToolbar } from './useSelectionToolbar';

// computeLineDiff / DiffLine moved to @cockpit/feature-explorer; callers
// should import them directly from there. (Previously re-exported here for
// backward compat — removed to avoid a circular re-export through this
// file's own import above.)

// ============================================
// Types
// ============================================

interface DiffViewProps {
  oldContent: string;
  newContent: string;
  filePath: string;
  isNew?: boolean;
  isDeleted?: boolean;
  // Comment support
  cwd?: string;
  enableComments?: boolean;
  // Preview callback (e.g. Markdown preview, JSON readable)
  onPreview?: () => void;
  previewLabel?: string;
  // Content search callback (selected text → project-wide search)
  onContentSearch?: (query: string) => void;
  /**
   * Programmatic scroll target. When provided (and `tick` changes), the
   * virtualizer scrolls so the matching row is near the top of the viewport.
   * - `side: 'after'` matches `rightLines[i].lineNum === line` (new file line).
   * - `side: 'before'` matches `leftLines[i].lineNum === line` (old file line).
   * The `tick` field MUST change on each new request — otherwise repeat clicks
   * on the same line wouldn't re-trigger the scroll.
   */
  targetLine?: { line: number; side: 'before' | 'after'; tick: number } | null;
  /**
   * GitHub-style compact view: only changed lines + 3-line context
   * are rendered; unchanged stretches collapse into clickable bars
   * with bidirectional ↑ / ↓ arrows that reveal +20 lines per
   * click (`COMPACT_EXPAND_STEP`).
   *
   * Default `false` so existing call sites (DiffViewerModal,
   * CommitDetailPanel, …) keep their full-file behaviour. Currently
   * only `StatusDiffPane` (file-mode of git changes) defaults this
   * on, with a Compact/Full toggle for the user.
   *
   * (An earlier prototype consumed AST symbols to AUTO-EXPAND a
   * gap to its enclosing-function boundaries on first click; user
   * feedback was that the line count was uncontrollable and big
   * jumps disrupted reading. We deleted the auto-expansion path
   * and aligned expansion with GitHub's bidirectional +N exactly.
   * See `compactDiff.ts` header.)
   */
  compact?: boolean;
  /**
   * Function-like symbols (post-edit / AFTER snapshot) used by
   * compact mode to label each gap bar with the enclosing function
   * of the next changed region — same convention as GitHub's
   * "@@ -X +Y @@ funcName" hunk header. Read-only / informational;
   * does NOT influence expansion behaviour. Omitted (or empty) for
   * files without AST coverage (.json, .css, etc.) — bars then
   * just show "N lines hidden".
   */
  symbols?: readonly SymbolInfo[];
}

// ============================================
// Row height constant
// ============================================
const ROW_HEIGHT = 20;

/** Render a function-like symbol as `name(p1, p2, …)` for the gap
 *  bar's hunk-header label. Mirrors the chip-header style used in
 *  Code Map, so users see the same shape in both views. Symbols
 *  without `params` (non-callable kinds — class / interface / type
 *  / etc) render as just `name`. */
function formatSignature(s: SymbolInfo): string {
  if (!s.params) return s.name;
  return `${s.name}(${s.params.join(', ')})`;
}

// ============================================
// Main DiffView Component (Split View)
// ============================================
//
// Floating toolbar / selection plumbing lives in the shared
// `useSelectionToolbar` hook (see useSelectionToolbar.ts). DiffView's
// only diff-specific contribution is the `data-new-line` line resolver
// and the `lineSnapshot` builder that walks `diffLines` filtering for
// new-side rows. The hook+ToolbarRenderer combination is what keeps the
// toolbar's show/hide isolated from DiffView's virtual list re-renders.

export function DiffView({ oldContent, newContent, filePath, isNew = false, isDeleted = false, cwd, enableComments = false, onPreview, previewLabel, onContentSearch, targetLine, compact = false, symbols }: DiffViewProps) {
  const { t } = useTranslation();
  const resolvedPreviewLabel = previewLabel ?? t('common.preview');
  const diffLines = useMemo(() => computeLineDiff(oldContent, newContent), [oldContent, newContent]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const isSyncingHScrollRef = useRef(false);
  const [isMounted, setIsMounted] = useState(false);

  // Menu container for portal mounting (keeps floating elements within second screen)
  const menuContainer = useMenuContainer();

  // Chat context for "Send to AI" feature
  const aiBridge = useAIBridge();

  // Comment state
  const commentsEnabled = enableComments && !!cwd;
  const { comments, addComment, updateComment, deleteComment, refresh: refreshComments } = useComments({
    cwd: cwd || '',
    filePath,
  });

  const [viewingComment, setViewingComment] = useState<{
    comment: CodeComment;
    x: number;
    y: number;
  } | null>(null);

  // Floating toolbar plumbing — owned by the shared selection hook.
  // Storing in a ref (rather than state) is what keeps DiffView's virtual
  // list from re-reconciling on every selection change and losing the
  // browser selection out from under the user.
  //
  // The `rightPanelEl` state mirror exists because passing rightPanelRef
  // alone to the hook wouldn't re-trigger its effect when the element
  // first mounts — state changes do.
  const [rightPanelEl, setRightPanelEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (rightPanelRef.current !== rightPanelEl) setRightPanelEl(rightPanelRef.current);
  });
  const { toolbarRef: floatingToolbarRef, bumpRef: bumpToolbarRef, clearToolbar } = useSelectionToolbar({
    enabled: commentsEnabled,
    container: rightPanelEl,
    resolveLineRange: (node) => {
      if (!document.contains(node)) return null;
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
      const lineRow = el?.closest('[data-new-line]');
      if (!lineRow) return null;
      const n = parseInt(lineRow.getAttribute('data-new-line') || '0', 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      return { start: n, end: n };
    },
    // Walk diffLines and pull `content` for rows that appear in the new
    // file (unchanged + added). `diffLines` is captured by closure; the
    // hook re-reads this callback via a ref so it never gets stale.
    buildLineSnapshot: ({ start, end }) => {
      const out: string[] = [];
      let n = 0;
      for (const dl of diffLines) {
        if (dl.type === 'unchanged' || dl.type === 'added') {
          n++;
          if (n >= start && n <= end) out.push(dl.content);
        }
      }
      return out.join('\n');
    },
  });

  const [addCommentInput, setAddCommentInput] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
    selectedText: string;
    lineSnapshot: string;
  } | null>(null);

  const [sendToAIInput, setSendToAIInput] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
    selectedText: string;
    lineSnapshot: string;
  } | null>(null);

  // Track mount state for Portal
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Lines with comments (based on new file line numbers)
  const linesWithComments = useMemo(() => {
    const set = new Set<number>();
    for (const comment of comments) {
      for (let i = comment.startLine; i <= comment.endLine; i++) {
        set.add(i);
      }
    }
    return set;
  }, [comments]);

  // Comments grouped by end line
  const commentsByEndLine = useMemo(() => {
    const map = new Map<number, CodeComment[]>();
    for (const comment of comments) {
      const line = comment.endLine;
      if (!map.has(line)) map.set(line, []);
      map.get(line)!.push(comment);
    }
    return map;
  }, [comments]);

  const handleCommentBubbleClick = useCallback((comment: CodeComment, e: React.MouseEvent) => {
    e.stopPropagation();
    setViewingComment({ comment, x: e.clientX, y: e.clientY });
    clearToolbar();
    setAddCommentInput(null);
    setSendToAIInput(null);
  }, [clearToolbar]);

  const handleToolbarAddComment = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    setAddCommentInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      selectedText: toolbar.selectedText,
      lineSnapshot: toolbar.lineSnapshot,
    });
    clearToolbar();
  }, [clearToolbar, floatingToolbarRef]);

  const handleToolbarSendToAI = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    setSendToAIInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      selectedText: toolbar.selectedText,
      lineSnapshot: toolbar.lineSnapshot,
    });
    clearToolbar();
  }, [clearToolbar, floatingToolbarRef]);

  // Search the LITERAL selection — not the line-expanded snapshot. Using
  // the snapshot was the source of the long-standing "DiffView search
  // mysteriously expands to the whole line" bug.
  const handleToolbarSearch = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar || !onContentSearch) return;
    const query = toolbar.selectedText.trim();
    clearToolbar();
    if (query) onContentSearch(query);
  }, [onContentSearch, clearToolbar, floatingToolbarRef]);

  // Shared send-to-AI orchestration for both entries (standalone SendToAI
  // card / comment card button): all historical comments + the given
  // selection go out as one message, then the comment stack is cleared.
  const sendSelectionToAI = useCallback(async (selection: { range: { start: number; end: number }; lineSnapshot: string }, question: string) => {
    if (!aiBridge || !cwd) return;

    try {
      const allComments = await fetchAllCommentsWithCode(cwd);
      const references: CodeReference[] = [];

      for (const comment of allComments) {
        references.push({
          filePath: comment.filePath,
          startLine: comment.startLine,
          endLine: comment.endLine,
          codeContent: comment.codeContent,
          note: comment.content || undefined,
        });
      }

      references.push({
        filePath,
        startLine: selection.range.start,
        endLine: selection.range.end,
        codeContent: selection.lineSnapshot,
      });

      const message = buildAIMessage(references, question);
      aiBridge.sendMessage(message);

      await clearAllComments(cwd);
      refreshComments();
    } catch (err) {
      console.error('Failed to send to AI:', err);
    }
  }, [aiBridge, filePath, cwd, refreshComments]);

  // Both cards close themselves on submit — deliberately NO trailing state
  // reset after the async send (a late set(null) could clobber a card the
  // user opened in the meantime).
  const handleSendToAISubmit = useCallback((question: string) => {
    if (!sendToAIInput) return;
    void sendSelectionToAI(sendToAIInput, question);
  }, [sendToAIInput, sendSelectionToAI]);

  const handleCommentSendToAI = useCallback((question: string) => {
    if (!addCommentInput) return;
    void sendSelectionToAI(addCommentInput, question);
  }, [addCommentInput, sendSelectionToAI]);

  const handleCommentSubmit = useCallback(async (content: string) => {
    if (!addCommentInput) return;
    await addComment(
      addCommentInput.range.start,
      addCommentInput.range.end,
      content,
      addCommentInput.selectedText,
    );
    setAddCommentInput(null);
  }, [addCommentInput, addComment]);

  // Sync horizontal scroll between left and right panels
  useEffect(() => {
    const leftPanel = leftPanelRef.current;
    const rightPanel = rightPanelRef.current;
    if (!leftPanel || !rightPanel) return;

    const syncHScroll = (source: HTMLDivElement, target: HTMLDivElement) => {
      if (isSyncingHScrollRef.current) return;
      isSyncingHScrollRef.current = true;
      target.scrollLeft = source.scrollLeft;
      requestAnimationFrame(() => {
        isSyncingHScrollRef.current = false;
      });
    };

    const handleLeftScroll = () => syncHScroll(leftPanel, rightPanel);
    const handleRightScroll = () => syncHScroll(rightPanel, leftPanel);

    leftPanel.addEventListener('scroll', handleLeftScroll);
    rightPanel.addEventListener('scroll', handleRightScroll);

    return () => {
      leftPanel.removeEventListener('scroll', handleLeftScroll);
      rightPanel.removeEventListener('scroll', handleRightScroll);
    };
  }, []);

  // Split into left and right columns
  const { leftLines, rightLines } = useMemo(() => {
    const left: { lineNum: number; content: string; type: 'unchanged' | 'removed'; originalIdx: number }[] = [];
    const right: { lineNum: number; content: string; type: 'unchanged' | 'added'; originalIdx: number }[] = [];

    let leftIdx = 0;
    let rightIdx = 0;

    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i];
      if (line.type === 'unchanged') {
        // Align: pad with empty lines if needed
        while (left.length < right.length) {
          left.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
        }
        while (right.length < left.length) {
          right.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
        }
        leftIdx++;
        rightIdx++;
        left.push({ lineNum: leftIdx, content: line.content, type: 'unchanged', originalIdx: i });
        right.push({ lineNum: rightIdx, content: line.content, type: 'unchanged', originalIdx: i });
      } else if (line.type === 'removed') {
        leftIdx++;
        left.push({ lineNum: leftIdx, content: line.content, type: 'removed', originalIdx: i });
      } else if (line.type === 'added') {
        rightIdx++;
        right.push({ lineNum: rightIdx, content: line.content, type: 'added', originalIdx: i });
      }
    }

    // Final alignment
    while (left.length < right.length) {
      left.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
    }
    while (right.length < left.length) {
      right.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
    }

    return { leftLines: left, rightLines: right };
  }, [diffLines]);

  const allLines = useMemo(() => diffLines.map(line => line.content), [diffLines]);
  const highlightedLines = useLineHighlight(allLines, filePath);

  // ============================================
  // Compact mode — gap state + render-row pipeline.
  // When `compact === false` the pipeline degenerates to one diff
  // row per visual row (i.e. the original behaviour, just routed
  // through `renderRows`). Keeping a single virtualizer code path
  // for both modes avoids forking the JSX below.
  // ============================================

  const [gapStates, setGapStates] = useState<Map<number, GapState>>(
    () => new Map(),
  );

  // Reset gap states when the underlying diff changes (different file
  // or a fresh diff for the same file). Without this, an "expanded"
  // gap from file A would persist into file B as if its gap-id
  // referred to the same logical region — which it doesn't (gap ids
  // are positional, recomputed every build).
  //
  // Also reset the virtualizer's per-index measurement cache as a
  // defence-in-depth alongside `getItemKey` (see the comment on the
  // `useVirtualizer` call above). With content-keyed measurements
  // the cache no longer reuses stale entries across file/content
  // changes, but `virtualizer.measure()` still scrubs anything left
  // over from a partially-completed render cycle.
  //
  // Historical context (commit 0ec53c1): the original DiffView keyed
  // measurements by index and the row outer div had a height-feedback
  // loop (`height: ${virtualItem.size}px` inline AND
  // `ref={measureElement}` reading `getBoundingClientRect().height`
  // back into the cache). A single ~0 height recorded during a
  // layout-jitter frame (e.g. while `useLineHighlight` swapped
  // plain-text → token HTML) pinned itself there: a stretch of rows
  // would collapse to one row's vertical space — overlapping text.
  // The earlier fix added this `measure()` call; the *current* fix
  // also eliminates the misaligned render frame at the source (see
  // `useLineHighlight.ts`) and keys the cache by row identity.
  //
  // `useLayoutEffect` (not `useEffect`): we want this cache reset to
  // run BEFORE the browser paints the post-commit DOM and BEFORE
  // ResizeObserver fires for the new layout. With `useEffect` the
  // misaligned-content frame could have its row measurements
  // captured into the cache before this cleanup got a chance to
  // run — exactly the timing window that produced the original bug.
  //
  // virtualizer is a fresh instance every render but wraps stable
  // internal state (refs); intentionally not in deps (would loop).
  useLayoutEffect(() => {
    setGapStates(new Map());
    virtualizer.measure();

  }, [leftLines, rightLines]);

  // Cast away the `originalIdx` field that DiffView's internal row
  // builder added — `compactDiff` only needs `lineNum + type`.
  const visualLeft = leftLines as readonly VisualLine[];
  const visualRight = rightLines as readonly VisualLine[];

  // Stable identity for the optional `symbols` array — `buildCompactRows`
  // only re-runs when the data actually changes, not on every render
  // where the parent re-creates an inline literal. Cheap fallback for
  // the unset case keeps the dep stable too.
  const symbolsKey = useMemo(() => symbols ?? [], [symbols]);

  const { rows: renderRows, gaps: compactGaps } = useMemo(() => {
    if (!compact) {
      // Fast path: one diff row per visual row, no gaps.
      const rows: RenderRow[] = leftLines.map((_, i) => ({
        kind: 'diff' as const,
        idx: i,
      }));
      return { rows, gaps: [] };
    }
    return buildCompactRows(visualLeft, visualRight, gapStates, symbolsKey);
  }, [compact, leftLines, visualLeft, visualRight, gapStates, symbolsKey]);

  /** Click handler for a gap arrow. `direction === 'up'` extends
   *  the upper changed region's context downward into the gap;
   *  `'down'` extends the lower changed region's context upward.
   *  Each click reveals at most `COMPACT_EXPAND_STEP` rows, clamped
   *  to whatever's still hidden.
   *
   *  No scroll-anchor compensation — by design. With the virtualizer
   *  using `measureElement` (attached on every rendered row's outer
   *  div) the row-position math stays accurate as new rows materialise,
   *  and the browser's natural scrollTop preservation does exactly
   *  what we want:
   *
   *    - Click more-up → rows inserted before the bar. Anything ABOVE
   *      the click stays put in the viewport; bar + lower hunk slide
   *      down to make room. New rows appear above the bar — visible.
   *    - Click more-down → rows inserted between bar and lower hunk.
   *      Bar + upper hunk stay put. Lower hunk slides down. New rows
   *      appear below the bar — visible.
   *
   *  Both cases keep the user's reading area where they expect and
   *  put the new content in plain view. An earlier rev tried to pin
   *  the bar / a hunk-edge row via getBoundingClientRect + scrollTop
   *  +=delta; that fought the browser AND accumulated drift when
   *  estimateSize disagreed with actual rendered heights. measureElement
   *  is the right fix for the underlying drift; the explicit anchor
   *  code was solving a problem that doesn't exist once measurement
   *  is correct. */
  const handleGapExpand = useCallback(
    (gapId: number, direction: 'up' | 'down') => {
      const gap = compactGaps.find((g) => g.id === gapId);
      if (!gap) return;
      setGapStates((prev) => {
        const cur = prev.get(gapId) ?? { topRevealed: 0, bottomRevealed: 0 };
        const size = gap.endIdx - gap.startIdx + 1;
        const remaining = size - cur.topRevealed - cur.bottomRevealed;
        if (remaining <= 0) return prev;
        const step = Math.min(COMPACT_EXPAND_STEP, remaining);
        const next: GapState =
          direction === 'up'
            ? { ...cur, topRevealed: cur.topRevealed + step }
            : { ...cur, bottomRevealed: cur.bottomRevealed + step };
        return new Map(prev).set(gapId, next);
      });
    },
    [compactGaps],
  );

  // Helper for the targetLine effect: when the user wants to scroll
  // to a line that's currently inside a collapsed gap, look up the
  // gap id by visual index so we can expand it.
  const findGapIdForVisualIdx = useCallback(
    (visualIdx: number): number | null => {
      for (const g of compactGaps) {
        if (visualIdx >= g.startIdx && visualIdx <= g.endIdx) return g.id;
      }
      return null;
    },
    [compactGaps],
  );

  // Row-height estimator. The label row gets a touch more breathing
  // room than diff / more rows because it carries longer content
  // ("47 lines hidden · loginHandler(req, res, next)") plus a
  // visual filled-bg framing — at 20 px the text felt cramped
  // against the borders.
  //
  // Doubles as a floor for the row's INLINE `height` style (see the
  // five row renderers below: `Math.max(virtualItem.size, estimateRowSize(i))`).
  // Why the clamp: even with `getItemKey` + `useLayoutEffect` reset
  // (commit 60cd19d), the measurementsCache feedback loop can still
  // close — `virtualItem.size` reads as ~0 → inline height becomes 0
  // → ResizeObserver re-measures the 0-height box → 0 gets re-cached
  // → row stays pinned at 0 → every row below it has its `start`
  // short by 20-28 px → visual overlap at the bottom of the view
  // ("已隐藏 N 行" rows stacking on top of each other).
  //
  // Two known live triggers as of this writing: (a) left + right
  // panels both attach `ref={virtualizer.measureElement}` for the
  // same index, racing writes for `gap-label` rows whose left side
  // is an empty <div> (path ① in the fx report); (b) panel
  // visibility flips via SwipeableViewContainer's translateX while
  // a stale ResizeObserver entry fires during the hidden frame
  // (path ② — `useLayoutEffect` doesn't refire on visibility-only
  // changes).
  //
  // Clamping inline height ≥ estimate breaks the loop's "0 → 0"
  // step at the cheapest possible point: the cache may still hold
  // a bad value briefly, but the DOM box is forced ≥ estimate, so
  // the next RO event writes back the real height and the cache
  // self-heals on the next frame. Reverse direction (cache > real)
  // is unaffected — Math.max preserves any larger measurement.
  const GAP_LABEL_HEIGHT = 28;
  const estimateRowSize = useCallback(
    (i: number) =>
      renderRows[i]?.kind === 'gap-label' ? GAP_LABEL_HEIGHT : ROW_HEIGHT,
    [renderRows],
  );

  // Content-derived row keys for `useVirtualizer`'s `measurementsCache`.
  //
  // Without an explicit `getItemKey`, `@tanstack/react-virtual` keys
  // measurements by ARRAY INDEX. When `renderRows` is rebuilt (file
  // switch, content edit, compact gap expand/collapse, …) old
  // measurements at the same index numbers get reused as if they
  // describe the new rows — which is how 0ec53c1's "row collapses
  // to ~0 height, text overlaps" bug pinned itself in place.
  //
  // Keying by row identity:
  //   - `gap-label`  / `gap-expand`  → tied to the stable `gapId`
  //     (gap ids are positional but consistent across the lifetime
  //     of a given `diffLines` build).
  //   - `diff` rows → composite of left+right line number + type;
  //     this is stable as long as the same logical line stays at
  //     the same `row.idx`, and naturally diverges when content
  //     shifts (e.g. inserting 3 lines pushes everything below
  //     and the new lineNum/type combos make the cache misses
  //     happen exactly where they should).
  //
  // Combined with the existing `virtualizer.measure()` reset, this
  // closes the "stale cache pinned to wrong row" failure path
  // STRUCTURALLY rather than racing the cleanup against ResizeObserver
  // timing. Falls back to the index when a row hasn't materialised
  // yet (transient renders during prop updates).
  const getItemKey = useCallback(
    (i: number): number | string => {
      const row = renderRows[i];
      if (!row) return i;
      if (row.kind === 'gap-label') return `gl:${row.gapId}`;
      if (row.kind === 'gap-expand') return `ge:${row.gapId}:${row.direction}`;
      const L = leftLines[row.idx];
      const R = rightLines[row.idx];
      return `d:${L?.lineNum ?? 'x'}:${L?.type ?? 'x'}:${R?.lineNum ?? 'x'}:${R?.type ?? 'x'}`;
    },
    [renderRows, leftLines, rightLines],
  );

  // Virtual scrolling
  const virtualizer = useVirtualizer({
    count: renderRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: estimateRowSize,
    getItemKey,
    overscan: 20,
  });

  // Adjust left/right width based on file status: new file 25%/75%, deleted 75%/25%, otherwise 50%/50%
  const leftWidth = isNew ? 'w-1/4' : isDeleted ? 'w-3/4' : 'w-1/2';
  const rightWidth = isNew ? 'w-3/4' : isDeleted ? 'w-1/4' : 'w-1/2';

  // Prepare minimap line types — projected from `renderRows` so the
  // minimap's vertical scale matches the scroll container's. In
  // compact mode collapsed gaps don't contribute to the scrollable
  // height, so they shouldn't contribute to the minimap either.
  // Gap rows render as `unchanged` strips — the user reads the
  // proportions of the actually-visible content, not what's hidden.
  const minimapLines = useMemo(
    () =>
      renderRows.map((row) => {
        if (row.kind !== 'diff') return { type: 'unchanged' as const };
        const leftLine = leftLines[row.idx];
        const rightLine = rightLines[row.idx];
        if (leftLine.type === 'removed') return { type: 'removed' as const };
        if (rightLine?.type === 'added') return { type: 'added' as const };
        return { type: 'unchanged' as const };
      }),
    [renderRows, leftLines, rightLines],
  );

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  // Programmatic scroll: when the `targetLine` object reference changes, find
  // the virtualizer index whose left/right lineNum matches and scroll there.
  // The parent supplies a fresh object (with new `tick`) on every request, so
  // ref-equality changes are sufficient to retrigger this effect — including
  // when the user clicks the same symbol twice.
  //
  // Compact mode: the target visual row may be hidden inside a
  // collapsed gap. In that case we first auto-expand the containing
  // gap to level 2 (full reveal) so the target has a render row, then
  // do the scroll on the next tick — `renderRows` recomputes via the
  // memo dep on `gapStates`, the second-tick effect catches the now-
  // visible target.
  useEffect(() => {
    if (!targetLine) return;
    const arr = targetLine.side === 'after' ? rightLines : leftLines;
    const visualIdx = arr.findIndex((l) => l.lineNum === targetLine.line);
    if (visualIdx === -1) return;

    // Map the visual index → renderRow index (compact mode reorders
    // and may skip rows). Linear scan; renderRows is small relative
    // to a typical UI scroll.
    const renderIdx = renderRows.findIndex(
      (r) => r.kind === 'diff' && r.idx === visualIdx,
    );
    if (renderIdx === -1) {
      // Target is inside a still-hidden gap. Auto-expand the
      // containing gap so the target has a render row, then let
      // the next effect tick (`renderRows` change re-fires this
      // effect) do the actual scroll.
      const gapId = findGapIdForVisualIdx(visualIdx);
      if (gapId !== null) {
        const gap = compactGaps.find((g) => g.id === gapId);
        if (!gap) return;
        const size = gap.endIdx - gap.startIdx + 1;
        setGapStates((prev) => {
          const cur = prev.get(gapId) ?? { topRevealed: 0, bottomRevealed: 0 };
          if (cur.topRevealed + cur.bottomRevealed >= size) return prev;
          // Fully reveal — split arbitrarily into top side; the
          // resulting visible state is the same regardless of the
          // split because top + bottom === size.
          const next = new Map(prev);
          next.set(gapId, { topRevealed: size, bottomRevealed: 0 });
          return next;
        });
      }
      return;
    }

    // Defer one frame so layout is settled when DiffView just mounted with a
    // new file (e.g. user clicked a symbol in a different file).
    const raf = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(renderIdx, { align: 'start' });
    });
    return () => cancelAnimationFrame(raf);
    // virtualizer is a fresh instance every render; including it would loop.

  }, [targetLine, leftLines, rightLines, renderRows]);

  return (
    <div className="font-mono flex flex-col h-full text-sm">
      {/* Header row - fixed */}
      <div className="flex flex-shrink-0 border-b border-border">
        <div className={`${leftWidth} min-w-0 px-2 py-1 bg-accent text-muted-foreground text-center text-xs font-medium border-r border-border`}>
          {isNew ? '(New File)' : isDeleted ? 'Deleted' : 'Old'}
        </div>
        <div className={`${rightWidth} min-w-0 px-2 py-1 bg-accent text-muted-foreground text-xs font-medium relative`}>
          <span className="block text-center">{isDeleted ? '(Deleted)' : 'New'}</span>
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-2">
            {onPreview && (
              <button
                onClick={onPreview}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {resolvedPreviewLabel}
              </button>
            )}
            {!isDeleted && newContent && (
              <button
                onClick={() => { navigator.clipboard.writeText(newContent); toast(t('diffViewer.copiedAll')); }}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {t('common.copy')}
              </button>
            )}
          </div>
        </div>
        <div className="w-4 flex-shrink-0 bg-accent" />
      </div>
      {/* Content row - flex-1 with min-h-0 to prevent flex stretch */}
      <div className="flex-1 min-h-0 flex">
        {/* Scroll wrapper - single vertical scroll container for virtualized rendering */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="flex" style={{ height: `${totalSize}px` }}>
            {/* Left Panel - Old (horizontal scroll only) */}
            <div
              ref={leftPanelRef}
              className={`${leftWidth} overflow-x-auto border-r border-border`}
            >
              <div className="min-w-max h-full" style={{ position: 'relative' }}>
                {virtualItems.map((virtualItem) => {
                  const row = renderRows[virtualItem.index];
                  if (row.kind === 'gap-expand' || row.kind === 'gap-label') {
                    // Left half of a gap row. Only the middle
                    // (label) row carries `bg-accent` so it stands
                    // out as a distinct UI element; the
                    // expand-up / expand-down rows stay transparent
                    // by default and only light up on hover (right
                    // panel handles the hover bg). Borders frame
                    // the label row alone — without them the bg
                    // band would float without anchor.
                    const isLabel = row.kind === 'gap-label';
                    return (
                      <div
                        key={virtualItem.key}
                        ref={virtualizer.measureElement}
                        data-index={virtualItem.index}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${Math.max(virtualItem.size, estimateRowSize(virtualItem.index))}px`,
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                        className={isLabel ? 'bg-accent border-y border-border' : ''}
                      />
                    );
                  }
                  const line = leftLines[row.idx];
                  return (
                    <div
                      key={virtualItem.key}
                      ref={virtualizer.measureElement}
                      data-index={virtualItem.index}
                      data-row-idx={row.idx}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        minWidth: '100%',
                        width: 'max-content',
                        height: `${Math.max(virtualItem.size, estimateRowSize(virtualItem.index))}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                      className={`flex ${line.type === 'removed' ? 'bg-red-9/15 dark:bg-red-9/25' : ''}`}
                    >
                      <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
                        {line.lineNum || ''}
                      </span>
                      <span
                        className="whitespace-pre pl-2"
                        dangerouslySetInnerHTML={{ __html: (line.originalIdx >= 0 && highlightedLines[line.originalIdx]) || escapeHtml(line.content || ' ') }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Right Panel - New (horizontal scroll only) */}
            <div
              ref={rightPanelRef}
              className={`${rightWidth} overflow-x-auto`}
            >
              <div className="min-w-max h-full" style={{ position: 'relative' }}>
                {virtualItems.map((virtualItem) => {
                  const row = renderRows[virtualItem.index];
                  if (row.kind === 'gap-expand') {
                    // "··· more +N ···" row — top-of-gap
                    // (direction='up') or bottom-of-gap
                    // (direction='down'). Default state is
                    // TRANSPARENT (only the middle label row has
                    // bg-accent), so the more rows blend into the
                    // surrounding diff visually until you hover —
                    // intentionally subtle in idle state, obvious
                    // on intent.
                    return (
                      <button
                        key={virtualItem.key}
                        ref={virtualizer.measureElement}
                        data-index={virtualItem.index}
                        type="button"
                        onClick={() => handleGapExpand(row.gapId, row.direction)}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${Math.max(virtualItem.size, estimateRowSize(virtualItem.index))}px`,
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                        // Visible affordance:
                        //   default → transparent + muted text
                        //     (foreground/50) — quiet
                        //   hover   → bg-accent + text-brand —
                        //     same accent colour as the label row,
                        //     so hovering "joins" the more row
                        //     into the same visual block as the
                        //     label
                        //   active  → brand-teal flash bg
                        //
                        // Crucial: `transition-colors` ONLY (NOT
                        // `transition-all`). The row's `transform:
                        // translateY(start)` changes every time the
                        // virtualizer recomputes positions; with
                        // `transition-all` the browser would
                        // smoothly animate translateY over 150 ms
                        // and rows would slide past each other
                        // during state changes — visually chaotic
                        // and intermittently overlapping. Same
                        // reason we dropped `active:scale-[0.98]`:
                        // scale is also a transform, would interfere
                        // with the same animation channel.
                        //
                        // `focus:outline-none focus-visible:ring-1
                        // ring-inset ring-brand` replaces the
                        // browser default focus ring (which spilled
                        // 2-3 px onto adjacent diff rows after a
                        // click) with an inset 1 px brand ring that
                        // stays inside the row's box.
                        className="flex items-center justify-center text-[11px] text-foreground/50 hover:bg-accent hover:text-brand active:bg-brand/15 transition-colors duration-100 cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand/60"
                        title={t(
                          row.direction === 'up'
                            ? 'diffViewer.gap.expandUp'
                            : 'diffViewer.gap.expandDown',
                          { count: row.revealCount },
                        )}
                        aria-label={t(
                          row.direction === 'up'
                            ? 'diffViewer.gap.expandUp'
                            : 'diffViewer.gap.expandDown',
                          { count: row.revealCount },
                        )}
                      >
                        <span className="select-none">
                          {t('diffViewer.gap.more', {
                            count: row.revealCount,
                          })}
                        </span>
                      </button>
                    );
                  }
                  if (row.kind === 'gap-label') {
                    // Middle of the gap. Filled bg-accent +
                    // border-y so the label stands out as a
                    // distinct UI element between the (transparent)
                    // more rows. Carries `data-gap-id` — anchor
                    // element the scroll-pin effect tracks. Not
                    // clickable (whole-bar expand-all is the global
                    // Compact / Full toggle's job). Long function
                    // signatures truncate via min-w-0 + truncate.
                    return (
                      <div
                        key={virtualItem.key}
                        ref={virtualizer.measureElement}
                        data-index={virtualItem.index}
                        data-gap-id={row.gapId}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${Math.max(virtualItem.size, estimateRowSize(virtualItem.index))}px`,
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                        className="flex items-center justify-center gap-2 px-3 text-[11px] text-foreground/80 bg-accent border-y border-border min-w-0 select-none"
                      >
                        <span className="flex-shrink-0">
                          {t('diffViewer.gap.hidden', { count: row.hiddenCount })}
                        </span>
                        {row.enclosingFn && (
                          <>
                            <span className="opacity-50 flex-shrink-0">·</span>
                            <span
                              className="truncate min-w-0 font-medium"
                              title={formatSignature(row.enclosingFn)}
                            >
                              {formatSignature(row.enclosingFn)}
                            </span>
                          </>
                        )}
                      </div>
                    );
                  }
                  const line = rightLines[row.idx];
                  const lineNum = line?.lineNum || 0;
                  const hasComments = lineNum > 0 && linesWithComments.has(lineNum);
                  const lineComments = commentsByEndLine.get(lineNum);
                  const firstComment = lineComments?.[0];
                  const isInCommentRange = addCommentInput && lineNum >= addCommentInput.range.start && lineNum <= addCommentInput.range.end;
                  const isInAIRange = sendToAIInput && lineNum >= sendToAIInput.range.start && lineNum <= sendToAIInput.range.end;
                  const isInRange = isInCommentRange || isInAIRange;

                  return (
                    <div
                      key={virtualItem.key}
                      ref={virtualizer.measureElement}
                      data-index={virtualItem.index}
                      data-new-line={lineNum || undefined}
                      data-row-idx={row.idx}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        minWidth: '100%',
                        width: 'max-content',
                        height: `${Math.max(virtualItem.size, estimateRowSize(virtualItem.index))}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                      className={`flex ${
                        isInRange ? 'bg-blue-9/20' :
                        hasComments ? 'bg-amber-9/10' :
                        line?.type === 'added' ? 'bg-green-9/15 dark:bg-green-9/25' : ''
                      }`}
                    >
                      <span className={`flex-shrink-0 flex items-center gap-0.5 pr-1 text-slate-9 select-none border-r border-border ${
                        isInRange ? 'bg-blue-9/30' : ''
                      }`} style={{ width: commentsEnabled ? '52px' : '40px' }}>
                        {/* Comment bubble */}
                        {commentsEnabled && lineNum > 0 && hasComments && firstComment && (
                          <button
                            onClick={(e) => handleCommentBubbleClick(firstComment, e)}
                            className="w-4 h-4 flex items-center justify-center rounded hover:bg-accent text-amber-9"
                            title={t('codeViewer.nComments', { count: lineComments?.length })}
                          >
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z" clipRule="evenodd" />
                            </svg>
                          </button>
                        )}
                        {commentsEnabled && lineNum > 0 && !hasComments && <span className="w-4" />}
                        <span className="flex-1 text-right pr-1">{lineNum || ''}</span>
                      </span>
                      <span
                        className="whitespace-pre pl-2"
                        dangerouslySetInnerHTML={{ __html: (line?.originalIdx >= 0 && highlightedLines[line.originalIdx]) || escapeHtml(line?.content || ' ') }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        {/* Minimap - outside scroll container, fixed height */}
        <DiffMinimap
          lines={minimapLines}
          containerRef={scrollContainerRef}
        />
      </div>

      {/* Floating elements via Portal to menu container (keeps within second screen) */}
      {isMounted && menuContainer && createPortal(
        <>
          <ToolbarRenderer
            floatingToolbarRef={floatingToolbarRef}
            bumpRef={bumpToolbarRef}
            container={menuContainer}
            onAddComment={handleToolbarAddComment}
            onSendToAI={handleToolbarSendToAI}
            onSearch={onContentSearch ? handleToolbarSearch : undefined}
            isChatLoading={aiBridge?.isLoading ?? false}
          />
          {addCommentInput && (
            <AddCommentInput
              x={addCommentInput.x}
              y={addCommentInput.y}
              range={addCommentInput.range}
              filePath={filePath}
              lineSnapshot={addCommentInput.lineSnapshot}
              container={menuContainer}
              onSubmit={handleCommentSubmit}
              onSendToAI={aiBridge ? handleCommentSendToAI : undefined}
              onClose={() => setAddCommentInput(null)}
              isChatLoading={aiBridge?.isLoading}
            />
          )}
          {sendToAIInput && (
            <SendToAIInput
              x={sendToAIInput.x}
              y={sendToAIInput.y}
              range={sendToAIInput.range}
              filePath={filePath}
              lineSnapshot={sendToAIInput.lineSnapshot}
              container={menuContainer}
              onSubmit={handleSendToAISubmit}
              onClose={() => setSendToAIInput(null)}
              isChatLoading={aiBridge?.isLoading}
            />
          )}
          {viewingComment && (
            <ViewCommentCard
              x={viewingComment.x}
              y={viewingComment.y}
              comment={viewingComment.comment}
              container={menuContainer}
              onClose={() => setViewingComment(null)}
              onUpdateComment={updateComment}
              onDeleteComment={deleteComment}
            />
          )}
        </>,
        menuContainer
      )}
    </div>
  );
}

// ============================================
// Unified Diff View Component (with virtual scrolling)
// ============================================

/** A rendered unified row: either a diff line or a collapsed-gap bar. */
type UnifiedRow =
  | { kind: 'line'; line: DiffLine; index: number }
  | { kind: 'gap'; id: number; count: number };

/**
 * Simplified single-column compact view: collapse runs of unchanged lines
 * (keeping COMPACT_CONTEXT_LINES of context around each change) into one
 * "N lines hidden" bar that expands its WHOLE gap on click. No incremental
 * up/down reveal or function labels — that richer pipeline is split-view only
 * (compactDiff.ts); unified deliberately stays lean.
 *
 * Gap ids are positional over the fixed visible/hidden partition, so they're
 * stable across expand/collapse and across re-renders of the same file.
 */
function buildUnifiedCompactRows(diffLines: DiffLine[], expandedGaps: Set<number>): UnifiedRow[] {
  const n = diffLines.length;
  const visible = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (diffLines[i].type === 'unchanged') continue;
    const lo = Math.max(0, i - COMPACT_CONTEXT_LINES);
    const hi = Math.min(n - 1, i + COMPACT_CONTEXT_LINES);
    for (let j = lo; j <= hi; j++) visible[j] = true;
  }
  const rows: UnifiedRow[] = [];
  let gapId = 0;
  let i = 0;
  while (i < n) {
    if (visible[i]) {
      rows.push({ kind: 'line', line: diffLines[i], index: i });
      i++;
      continue;
    }
    let j = i;
    while (j < n && !visible[j]) j++;
    const id = gapId++;
    if (expandedGaps.has(id)) {
      for (let k = i; k < j; k++) rows.push({ kind: 'line', line: diffLines[k], index: k });
    } else {
      rows.push({ kind: 'gap', id, count: j - i });
    }
    i = j;
  }
  return rows;
}

export function DiffUnifiedView({ oldContent, newContent, filePath, compact = false }: Omit<DiffViewProps, 'isNew' | 'isDeleted'>) {
  const { t } = useTranslation();
  const diffLines = useMemo(() => computeLineDiff(oldContent, newContent), [oldContent, newContent]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const allLines = useMemo(() => diffLines.map(line => line.content), [diffLines]);
  const highlightedLines = useLineHighlight(allLines, filePath);

  // Expanded gaps — reset when the underlying file/diff changes so a gap id
  // from file A can't persist into file B (its positional id would refer to a
  // different region). Mirrors the split view's gap-state reset.
  const [expandedGaps, setExpandedGaps] = useState<Set<number>>(() => new Set());
  useEffect(() => { setExpandedGaps(new Set()); }, [oldContent, newContent, filePath]);

  const rows = useMemo<UnifiedRow[]>(() => {
    if (!compact) return diffLines.map((line, index) => ({ kind: 'line', line, index }));
    return buildUnifiedCompactRows(diffLines, expandedGaps);
  }, [compact, diffLines, expandedGaps]);

  // Content-derived row keys — see the comment on the split-view virtualizer
  // for the full rationale. A gap is keyed by its stable positional id; a line
  // by type + old/new line numbers.
  const getItemKey = useCallback(
    (i: number): number | string => {
      const r = rows[i];
      if (!r) return i;
      if (r.kind === 'gap') return `gap:${r.id}`;
      const dl = r.line;
      return `${dl.type}:${dl.oldLineNum ?? 'x'}:${dl.newLineNum ?? 'x'}`;
    },
    [rows],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey,
    overscan: 20,
  });

  return (
    <div ref={scrollContainerRef} className="font-mono text-sm overflow-auto h-full">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const row = rows[virtualItem.index];
          if (!row) return null;
          const style = {
            position: 'absolute' as const,
            top: 0,
            left: 0,
            minWidth: '100%',
            width: 'max-content' as const,
            height: `${virtualItem.size}px`,
            transform: `translateY(${virtualItem.start}px)`,
          };

          if (row.kind === 'gap') {
            const label = t('diffViewer.gap.hidden', { count: row.count });
            return (
              <div
                key={virtualItem.key}
                style={style}
                onClick={() => setExpandedGaps((prev) => new Set(prev).add(row.id))}
                className="flex items-center cursor-pointer bg-slate-2 hover:bg-accent border-y border-border text-xs text-slate-9 select-none"
                title={label}
              >
                <span className="w-full text-center">{label}</span>
              </div>
            );
          }

          const line = row.line;
          return (
            <div
              key={virtualItem.key}
              style={style}
              className={`flex ${
                line.type === 'removed'
                  ? 'bg-red-9/15 dark:bg-red-9/25'
                  : line.type === 'added'
                  ? 'bg-green-9/15 dark:bg-green-9/25'
                  : ''
              }`}
            >
              {/* Line numbers */}
              <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
                {line.type !== 'added' ? line.oldLineNum : ''}
              </span>
              <span className="w-10 flex-shrink-0 text-right pr-2 text-slate-9 select-none border-r border-border">
                {line.type !== 'removed' ? line.newLineNum : ''}
              </span>
              {/* Symbol */}
              <span
                className={`w-6 flex-shrink-0 text-center select-none ${
                  line.type === 'removed'
                    ? 'text-red-11'
                    : line.type === 'added'
                    ? 'text-green-11'
                    : 'text-slate-9'
                }`}
              >
                {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
              </span>
              {/* Content with syntax highlighting */}
              <span
                className="flex-1 whitespace-pre pl-1"
                dangerouslySetInnerHTML={{ __html: highlightedLines[row.index] || escapeHtml(line.content || ' ') }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Default export is the split view
export default DiffView;
