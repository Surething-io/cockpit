'use client';

/**
 * BlockDiffMinimap — chip-diff sibling of `DiffMinimap` (the right-side
 * minimap used by `DiffView`). Shares DiffMinimap's visual language —
 * `w-4` track, `bg-secondary` fill, green change stripes, neutral
 * viewport thumb, always-on (no auto-hide) — so chip-diff and
 * file-diff feel like the same family of widgets.
 *
 * Coordinate system: RENDERED-LINE space, NOT file-line space.
 *
 * The chip canvas only renders blocks the projection touched (filter
 * mode) — file regions between rendered blocks are physically gone
 * from the layout. If we positioned thumb / change runs / clicks in
 * file-line space (start = `(line - 1) / totalLines × 100%`), the
 * thumb at chip-canvas-top would land at e.g. 5% of the minimap (the
 * first rendered chip's startLine fraction) while the green change
 * markers — also at file-line positions — would land at 50%, 80%,
 * etc. The user scrolls to the very top of the canvas but the thumb
 * and the green ticks visually disagree about "where am I".
 *
 * Rendered-line space fixes this by stitching every rendered block's
 * `[startLine, endLine]` into a single contiguous index axis:
 *
 *   block A: file lines 50–60  → indices  0–10
 *   block B: file lines 200–210 → indices 11–21
 *   block C: file lines 500–510 → indices 22–32
 *   total rendered indices = 33
 *
 * Every position in the minimap (thumb, runs, click) is computed as
 * `idx / totalRenderedIdx × 100%`. The unrendered ranges (lines
 * 61–199, 211–499, 511–end) are collapsed out, so the minimap and
 * the chip canvas share the same vertical layout: minimap top = chip
 * canvas top, minimap bottom = chip canvas bottom.
 *
 * (Plain non-filter chip mode never mounts this component — see
 * BlockViewer's gate. So the "every block in the file is rendered"
 * case doesn't need a separate code path.)
 *
 * Click semantics:
 *   1. Direct hit inside a change run → jump to the clicked line.
 *   2. Within ~5% of a run → snap to the run's nearest endpoint
 *      (forgiving fat-finger clicks on a 16px-wide bar).
 *   3. Otherwise → jump to the start of the block the click landed
 *      in (scrollbar-style "click here to scroll to that chip").
 *
 * Caller is responsible for tracking `viewportRange` (which file
 * lines are currently visible in the chip viewport) and feeding it
 * back so the thumb stays in sync with the user's scroll position.
 */

import { useMemo, useRef } from 'react';

export interface RenderedBlockRange {
  qname: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
}

interface BlockDiffMinimapProps {
  /** Added/changed line numbers (after-file, 1-based, absolute).
   *  Lines outside any rendered block are dropped — they'd render as
   *  unjumpable green ticks. */
  addedLines: ReadonlySet<number>;
  /** Line ranges of every block currently rendered in chip view —
   *  the ONLY input that drives positioning. Both (a) the click-to-
   *  block fallback (priority 3) and (b) the rendered-line index
   *  axis are derived from it. */
  blockRanges: readonly RenderedBlockRange[];
  /** Currently-visible file-line range in the chip viewport — drives
   *  the viewport thumb. `null`/undefined hides the thumb (used
   *  before the first measurement so the thumb doesn't flash at
   *  line 1 on initial paint). */
  viewportRange?: { start: number; end: number } | null;
  /** Wired by the caller to a line-level flashTarget so the chip
   *  scrolls + pulses the precise row. */
  onJumpToLine: (qname: string, line: number) => void;
}

/** A run of consecutive added lines that share the same block.
 *  Visual collapse only — we render a 10-line change as ONE solid
 *  green stripe (matching DiffMinimap's "added line = colored
 *  stripe" feel) instead of 10 dashes with 1px gaps. Click handling
 *  still resolves to the precise line via Y-coordinate math, so the
 *  collapse is purely cosmetic. Two adjacent lines in DIFFERENT
 *  blocks aren't merged — a gap at the block boundary keeps the
 *  click → block mapping unambiguous. */
interface ChangeRun {
  /** First file-line in the run (1-based). */
  start: number;
  /** Last file-line in the run (1-based, inclusive). */
  end: number;
  qname: string;
}

/** Internal: rendered-line-index lookup table built once per
 *  blockRanges change. `prefix[i]` = sum of lines in blocks 0..i-1,
 *  i.e. the rendered index where block i starts. */
interface RenderedAxis {
  /** Sorted by startLine, ascending. */
  blocks: readonly RenderedBlockRange[];
  /** `prefix[i]` is the rendered-index at which `blocks[i]` starts.
   *  Length = blocks.length + 1; the final entry is the total. */
  prefix: readonly number[];
  /** Total rendered-line count = sum of every block's line count. */
  total: number;
}

function buildAxis(blockRanges: readonly RenderedBlockRange[]): RenderedAxis {
  const blocks = [...blockRanges].sort((a, b) => a.startLine - b.startLine);
  const prefix: number[] = [0];
  for (const b of blocks) {
    const size = Math.max(0, b.endLine - b.startLine + 1);
    prefix.push(prefix[prefix.length - 1] + size);
  }
  return { blocks, prefix, total: prefix[prefix.length - 1] };
}

/** File-line → rendered-index. Returns null if the line is in no
 *  rendered block (caller should silently skip). */
function fileLineToIdx(axis: RenderedAxis, line: number): number | null {
  for (let i = 0; i < axis.blocks.length; i++) {
    const b = axis.blocks[i];
    if (line >= b.startLine && line <= b.endLine) {
      return axis.prefix[i] + (line - b.startLine);
    }
  }
  return null;
}

/** Rendered-index → {qname, line}. Used by click handling to turn
 *  a click Y-fraction into a concrete (block, file-line) target.
 *  Idx is clamped to `[0, total)` by the caller. */
function idxToFileLine(
  axis: RenderedAxis,
  idx: number,
): { qname: string; line: number } | null {
  if (axis.total <= 0) return null;
  const clamped = Math.max(0, Math.min(axis.total - 1, idx));
  for (let i = 0; i < axis.blocks.length; i++) {
    const blockStart = axis.prefix[i];
    const blockEnd = axis.prefix[i + 1]; // exclusive
    if (clamped >= blockStart && clamped < blockEnd) {
      const b = axis.blocks[i];
      return {
        qname: b.qname,
        line: b.startLine + Math.round(clamped - blockStart),
      };
    }
  }
  return null;
}

export function BlockDiffMinimap({
  addedLines,
  blockRanges,
  viewportRange,
  onJumpToLine,
}: BlockDiffMinimapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const axis = useMemo(() => buildAxis(blockRanges), [blockRanges]);

  // Filter addedLines to those inside a rendered block (lines outside
  // any rendered block are unreachable in chip view and would render
  // as un-jumpable ticks), then fold consecutive same-block lines
  // into runs for compact rendering.
  const runs = useMemo<ChangeRun[]>(() => {
    if (axis.total <= 0 || addedLines.size === 0) return [];
    const ticks: { line: number; qname: string }[] = [];
    for (const line of addedLines) {
      const block = axis.blocks.find(
        (r) => line >= r.startLine && line <= r.endLine,
      );
      if (block) ticks.push({ line, qname: block.qname });
    }
    ticks.sort((a, b) => a.line - b.line);

    const out: ChangeRun[] = [];
    let cur: ChangeRun | null = null;
    for (const t of ticks) {
      if (cur && t.line === cur.end + 1 && t.qname === cur.qname) {
        cur.end = t.line;
      } else {
        if (cur) out.push(cur);
        cur = { start: t.line, end: t.line, qname: t.qname };
      }
    }
    if (cur) out.push(cur);
    return out;
  }, [addedLines, axis]);

  if (axis.total <= 0) return null;

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return;
    const fraction = (e.clientY - rect.top) / rect.height;
    const target = idxToFileLine(axis, fraction * axis.total);
    if (!target) return;
    const targetLine = target.line;

    // 1. Direct hit on a change run → jump to the clicked line (not
    //    the run's start) so multi-line changes give per-line
    //    addressability — same UX as VSCode's overview ruler.
    const containingRun = runs.find(
      (r) =>
        r.qname === target.qname &&
        targetLine >= r.start &&
        targetLine <= r.end,
    );
    if (containingRun) {
      onJumpToLine(containingRun.qname, targetLine);
      return;
    }

    // 2. Near-miss on a run within ~5% of the rendered axis → snap
    //    to the run's nearest endpoint. Forgives fat-finger clicks
    //    on a thin bar. Tolerance is computed in rendered-index
    //    space (not file-line space) so it stays proportional to
    //    the visual minimap height even when the rendered set is
    //    a sparse subset of a giant file.
    if (runs.length > 0) {
      const tolerance = Math.max(2, Math.round(axis.total * 0.05));
      const targetIdx = fileLineToIdx(axis, targetLine);
      if (targetIdx !== null) {
        let best: ChangeRun | null = null;
        let bestDist = Infinity;
        for (const r of runs) {
          const startIdx = fileLineToIdx(axis, r.start);
          const endIdx = fileLineToIdx(axis, r.end);
          if (startIdx === null || endIdx === null) continue;
          const d =
            targetIdx < startIdx
              ? startIdx - targetIdx
              : targetIdx > endIdx
                ? targetIdx - endIdx
                : 0;
          if (d < bestDist) {
            best = r;
            bestDist = d;
          }
        }
        if (best && bestDist <= tolerance) {
          const snapLine =
            targetLine < best.start
              ? best.start
              : targetLine > best.end
                ? best.end
                : targetLine;
          onJumpToLine(best.qname, snapLine);
          return;
        }
      }
    }

    // 3. Click landed in a rendered block but no run hit → jump to
    //    the block's start. Scrollbar-style fallback so clicking
    //    inside a "covered but unchanged" region still scrolls
    //    SOMEWHERE sensible. Block start (rather than the
    //    interpolated line) keeps the chip's top in view; landing
    //    mid-block puts the chip header off-screen and disorients.
    const containingBlock = axis.blocks.find((r) => r.qname === target.qname);
    if (containingBlock) {
      onJumpToLine(containingBlock.qname, containingBlock.startLine);
    }
  };

  // Helper to convert a file-line range into a percentage band on
  // the minimap. Returns null if both endpoints are outside any
  // rendered block (shouldn't happen for runs — we already filter —
  // but viewportRange can briefly have stale values during scroll).
  const lineRangeToBand = (start: number, end: number) => {
    const startIdx = fileLineToIdx(axis, start);
    const endIdx = fileLineToIdx(axis, end);
    if (startIdx === null || endIdx === null) return null;
    const top = (startIdx / axis.total) * 100;
    const heightPct = ((endIdx - startIdx + 1) / axis.total) * 100;
    return { top, heightPct };
  };

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      className="w-4 flex-shrink-0 bg-secondary border-l border-border relative cursor-pointer"
      title="Diff minimap — click to jump"
    >
      {/* Green change-run stripes — DiffMinimap-equivalent. Min 2px
          height (matching DiffMinimap's `minHeight: 2px`) so a
          single-line run in a 5000-line file doesn't collapse to a
          sub-pixel sliver and disappear. */}
      {runs.map((r) => {
        const band = lineRangeToBand(r.start, r.end);
        if (!band) return null;
        return (
          <div
            key={`run:${r.qname}:${r.start}-${r.end}`}
            className="absolute left-0 right-0 bg-green-9 pointer-events-none"
            style={{
              top: `${band.top}%`,
              height: `${band.heightPct}%`,
              minHeight: '2px',
            }}
          />
        );
      })}

      {/* Viewport thumb — same neutral fill / border treatment as
          DiffMinimap's viewport indicator (`bg-muted/60 border-y
          border-border`). Always visible (no auto-hide), pinned on
          top of the change runs. Min 1.2% height so a tiny viewport
          (one fully-visible 3-line block in a 5000-line file) still
          renders as a visible block instead of a hairline.

          Positioned in rendered-index space — same axis as the
          change runs, so they share a single coordinate system and
          the thumb visually overlaps the runs that ARE in view. */}
      {viewportRange &&
        viewportRange.end >= viewportRange.start &&
        (() => {
          const band = lineRangeToBand(
            viewportRange.start,
            viewportRange.end,
          );
          if (!band) return null;
          return (
            <div
              className="absolute left-0 right-0 bg-muted/60 border-y border-border pointer-events-none"
              style={{
                top: `${band.top}%`,
                height: `${Math.max(1.2, band.heightPct)}%`,
              }}
            />
          );
        })()}
    </div>
  );
}
