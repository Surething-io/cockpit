'use client';

/**
 * Code Map — single-file architectural review view.
 *
 * Layout: a stack of "function rows", one per top-level symbol in the
 * focal file. Each row is a 3-cell strip:
 *
 *     ┌────────────────┬─────────────────────────────┬────────────────┐
 *     │ upstream pins  │  function header + body     │ downstream pins│
 *     └────────────────┴─────────────────────────────┴────────────────┘
 *
 * Rows are stacked vertically inside one scroll container, so reading
 * the file feels exactly like reading source in an editor: scroll down
 * for the next function. Pins for callers / callees of each function
 * sit in the same row, naturally aligned without needing scroll-sync
 * acrobatics.
 *
 * For barrel files (only imports + re-exports → no extractable
 * symbols), we synthesise a single "whole file" row so the user still
 * sees the code instead of a blank panel.
 *
 * Cmd+K opens the search palette to jump to a different focal file or
 * symbol; clicking a caller/callee pin jumps focal to that function's
 * file, scrolls its block into view, briefly flashes the header, AND
 * appends both the source and target to the FunctionHistoryDrawer so
 * the user can see (and replay) the trail of where they've been.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, RefreshCw, Search, X } from 'lucide-react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { fetchProjectGraphSearch } from '../effect/gitClient';
import { fetchFileTextRaw } from '../effect/filesClient';

import { SymbolIcon } from './symbolIcon';

import { useFileFunctions } from '../hooks/useFileBlocks';
import { useAIBridge } from '@cockpit/shared-ui';
import { useComments, type CodeComment } from '@cockpit/feature-comments';
import {
  buildAIMessage,
  clearAllComments,
  fetchAllCommentsWithCode,
  type CodeReference,
} from '@cockpit/feature-comments';
import { useTheme } from '@cockpit/shared-ui';
import {
  getHighlighter,
  getLanguageFromPath,
  tokensToHtml,
  type BundledLanguage,
} from '@cockpit/shared-ui';
import type {
  CrossFileCallEdge,
  FunctionNode as FnNode,
  SearchHit,
  SearchResponse,
} from '@cockpit/feature-explorer/server/codeMap/projectGraph/types';
import {
  FunctionHistoryDrawer,
  pushHistoryEntry,
  type HistoryEntry,
} from './FunctionHistoryDrawer';
import { FileTOCSection } from './FileTOCSection';
import { useBlockSelection } from './useBlockSelection';
import { BlockCommentBubbles } from './BlockCommentBubbles';
import { BlockDiffMinimap } from './BlockDiffMinimap';
import { FloatingToolbar } from '@cockpit/shared-ui';
import { AddCommentInput, SendToAIInput } from '@cockpit/shared-ui';
import { ViewCommentCard } from '../ViewCommentCard';

// ============================================================================
// Helpers
// ============================================================================

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

// ============================================================================
// Mini code viewer for a single function block
// ============================================================================

interface CodeBlockProps {
  symbol: FnNode;
  /** Full focal-file source — sliced here to the symbol's line range. */
  fileSource: string | null;
  hasChange: boolean;
  /** Absolute file line numbers that should render with the green
   *  added/changed background. Used by the diff wrapper
   *  (`BlockDiffViewer`) to surface line-level diff information inside
   *  the chip layout without forking CodeBlock. Undefined = no overlay. */
  addedLines?: ReadonlySet<number>;
  /**
   * Called once the block has reached a stable height: either Shiki's
   * HTML has been set, OR a highlight error fell back to the small
   * inline error message. After this signal, the body's height does
   * NOT change (until startLine/endLine change, which would unmount
   * us anyway). The parent uses these signals to gate scroll-into-view
   * until the focal file's full layout has settled — otherwise blocks
   * above the target keep growing AFTER our scroll lands, pushing
   * the target back off the viewport. Same gate, regardless of whether
   * the scroll is animated or instant: the question is "where is the
   * target NOW?" and the answer needs the layout to be done shifting.
   */
  onHighlighted: (qname: string) => void;
  /** All comments for the focal file. The block self-filters by line
   *  range — passing the full set keeps the parent simple. */
  comments?: readonly CodeComment[];
  /** Click handler for an existing comment marker. */
  onCommentClick?: (comment: CodeComment, e: React.MouseEvent) => void;
}

function CodeBlock({
  symbol,
  fileSource,
  hasChange,
  onHighlighted,
  comments,
  onCommentClick,
  addedLines,
}: CodeBlockProps) {
  const { resolvedTheme } = useTheme();
  const language = useMemo(
    () => getLanguageFromPath(symbol.filePath),
    [symbol.filePath],
  );
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!fileSource) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const lines = fileSource.split('\n');
        const slice = lines
          .slice(symbol.startLine - 1, symbol.endLine)
          .join('\n');
        const highlighter = await getHighlighter();
        const themeName = resolvedTheme === 'dark' ? 'github-dark' : 'github-light';
        const tokens = highlighter.codeToTokens(slice, {
          lang: language as BundledLanguage,
          theme: themeName,
        });
        // Per-line: a flex row whose `min-width: max-content` makes it
        // grow to fit its content; the body's `overflow-x: auto` then
        // surfaces a scrollbar for oversize lines instead of wrapping.
        const out = tokens.tokens
          .map((line, i) => {
            const lineNo = symbol.startLine + i;
            // data-line carries the absolute file line number — used by
            // useBlockSelection to resolve a drag-selection to a line
            // range, and by BlockCommentBubbles to anchor existing
            // comment markers next to their target lines.
            //
            // Diff overlay: when this line was touched by the diff
            // (added or modified), the diff wrapper (`BlockDiffViewer`)
            // passes its absolute line number in `addedLines`. We tint
            // the row green via `bg-green-9/15` — same green family
            // used by file-mode DiffView's after-side, for visual
            // continuity across the two diff modes.
            const isAdded = addedLines?.has(lineNo) ?? false;
            const bgClass = isAdded ? ' bg-green-9/15' : '';
            return (
              `<div class="flex${bgClass}" style="min-width:max-content" data-line="${lineNo}">` +
              `<span class="select-none pr-3 text-muted-foreground/60 tabular-nums" style="min-width:3.2rem;text-align:right">${lineNo}</span>` +
              `<span class="whitespace-pre">${tokensToHtml(line)}</span></div>`
            );
          })
          .join('');
        if (!cancelled) {
          setHtml(out);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'highlight failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileSource, symbol.startLine, symbol.endLine, language, resolvedTheme, symbol.filePath, addedLines]);

  // Stable-height signal — fires whenever html OR err transitions to
  // a non-null value. Idempotent against the parent's tracking Set,
  // so re-renders / strict-mode double-fires are harmless.
  useEffect(() => {
    if (html !== null || err !== null) {
      onHighlighted(symbol.qualifiedName);
    }
  }, [html, err, symbol.qualifiedName, onHighlighted]);

  return (
    <div className="flex-1 min-w-0 bg-card border border-border rounded overflow-hidden relative">
      {/*
       * Header — function name + meta. Tagged with `data-block-header`
       * so the parent's flash effect can locate it via querySelector
       * and toggle the `block-flash` class without us needing a ref map.
       */}
      <div
        data-block-header
        className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-secondary/40 text-xs"
      >
        <SymbolIcon
          kind={symbol.kind}
          qname={symbol.qualifiedName}
          className="w-3.5 h-3.5 flex-shrink-0"
        />
        {/* `name` + (optional) `(p1, p2, …)` share one truncation
            container — when the row is narrow they wrap as a single
            unit (`loginHandler(req, res…`) instead of cutting the
            name off mid-word and leaving a stray param tail.
            `params === undefined` for non-callables / unsupported
            languages → no parens, no visual difference from before
            this feature shipped. `params === []` (genuinely zero
            params) → `()` rendered, distinguishing a no-arg function
            from "we couldn't resolve params". */}
        <span className="font-mono truncate min-w-0">
          <span className="font-medium">{symbol.name}</span>
          {symbol.params !== undefined && (
            <span className="text-muted-foreground/80">
              ({symbol.params.join(', ')})
            </span>
          )}
        </span>
        <span className="text-[10px] text-muted-foreground/70 flex-shrink-0">
          {symbol.kind} · L{symbol.startLine}-{symbol.endLine}
        </span>
        <span className="flex-1" />
        {hasChange && (
          <span
            className="flex-shrink-0 w-2 h-2 rounded-full bg-amber-11"
            data-tooltip="File has uncommitted change"
          />
        )}
      </div>
      {/* Body. Explicit lineHeight is the contract that lets the parent
          row's right column align callee pins to source lines via simple
          arithmetic — Shiki's per-line `<div class="flex">` rows inherit
          this value, so each rendered code line is exactly LINE_HEIGHT_PX
          tall regardless of font/glyph particulars.
          `data-block-body` marks the selectable code surface — comment
          overlays and the BlockDiffViewer's after-side scope use this
          marker to filter what a drag selection counts as. */}
      <div
        data-block-body
        className="text-[11px] font-mono px-2 py-2 overflow-auto"
        style={{ lineHeight: `${LINE_HEIGHT_PX}px` }}
      >
        {!fileSource && <span className="text-muted-foreground">Loading…</span>}
        {err && <span className="text-red-11">{err}</span>}
        {html && <div dangerouslySetInnerHTML={{ __html: html }} />}
      </div>
      {/* Existing-comment bubbles, anchored by absolute geometry. Sits
          OUTSIDE the body's overflow-auto so it doesn't drift when the
          user horizontally scrolls a long line. */}
      {comments && comments.length > 0 && onCommentClick && (
        <BlockCommentBubbles
          comments={comments}
          startLine={symbol.startLine}
          endLine={symbol.endLine}
          lineHeight={LINE_HEIGHT_PX}
          bodyTopOffset={HEADER_HEIGHT_PX + BODY_PADDING_TOP_PX}
          onCommentClick={onCommentClick}
        />
      )}
    </div>
  );
}

// ============================================================================
// Pin chip — small label in the side columns
// ============================================================================

interface PinChipProps {
  /** Direction relative to the focal file: `in` = caller from outside,
   *  `out` = callee outside. Used for cross-file pins to drive amber/
   *  green palette and the textual `in`/`out` badge. Ext / self pins
   *  ignore this — they have their own visuals. */
  side: 'in' | 'out';
  /** The pin payload — discriminated union of cross-file / same-file /
   *  external. Visual + label + tooltip are derived per-kind below. */
  pin: RowPin;
  /** When true, the pin gets an amber accent ring — used in the diff
   *  view to flag "the function on the other end of this edge ALSO
   *  changed", so the reviewer sees ripple boundaries at a glance. Ext
   *  pins are never accented (no "other end" in the project graph). */
  accent?: boolean;
  onClick: () => void;
}

function PinChip({ side, pin, accent, onClick }: PinChipProps) {
  // Per-kind visual + label + tooltip. We split the three flavours up
  // front rather than threading conditionals through every render
  // expression; readability + grep-ability over saved lines.
  let baseClasses: string;
  let tag: string;
  let tagColor: string;
  let displayName: string;
  let displayBasename: string | null;
  let tooltipPrefix: string;
  let tooltipBody: string;
  const callCount = pin.lines.length;

  if (pin.kind === 'ext') {
    // External package — the most muted variant. No accent ring (no
    // notion of "the other end also changed"). Click flashes the
    // imports block; we don't navigate because the function lives
    // outside the project's file index.
    baseClasses =
      'bg-secondary/30 border-border/50 hover:border-muted-foreground/60';
    tag = 'ext';
    tagColor = 'text-muted-foreground/60';
    displayName = pin.name;
    displayBasename = pin.packageSpec;
    tooltipPrefix = 'external';
    tooltipBody = pin.packageSpec;
  } else if (pin.kind === 'method') {
    // Receiver-resolved-but-method-missing fallback. Same muted
    // palette as ext. Label shows `receiver.method` so the user can
    // tell exactly which call site this represents.
    baseClasses =
      'bg-secondary/30 border-border/50 hover:border-muted-foreground/60';
    tag = 'method';
    tagColor = 'text-muted-foreground/60';
    displayName = `${pin.receiverName}.${pin.methodName}`;
    displayBasename = null;
    tooltipPrefix = 'method (unresolved)';
    tooltipBody =
      callCount > 0 ? `at line${callCount > 1 ? 's' : ''} ${pin.lines.join(', ')}` : '';
  } else if (pin.kind === 'self') {
    // Same-file: muted neutral. File basename dropped (would just
    // echo the focal's own name).
    baseClasses = 'bg-secondary/40 border-border hover:border-muted-foreground';
    tag = 'self';
    tagColor = 'text-muted-foreground/70';
    displayName = pin.external.name;
    displayBasename = null;
    tooltipPrefix = 'same-file';
    tooltipBody =
      callCount > 0 ? `at line${callCount > 1 ? 's' : ''} ${pin.lines.join(', ')}` : '';
  } else {
    // Cross-file: amber on left (incoming), green on right (outgoing).
    baseClasses =
      side === 'in'
        ? 'bg-amber-9/15 border-amber-9/40 hover:border-amber-11'
        : 'bg-green-9/15 border-green-9/40 hover:border-green-11';
    tag = side;
    tagColor = side === 'in' ? 'text-amber-11' : 'text-green-11';
    displayName = pin.external.name;
    displayBasename = basename(pin.external.filePath);
    tooltipPrefix = side === 'in' ? 'caller' : 'callee';
    tooltipBody = pin.external.filePath;
  }
  // Impact accent: amber outline ring on top of the base palette,
  // signalling "this neighbour also changed". Cross-file / self only —
  // ext / method pins have no project-graph "other end" to flag.
  const accentRing =
    accent && pin.kind !== 'ext' && pin.kind !== 'method'
      ? ' ring-1 ring-amber-9/70 ring-offset-0'
      : '';

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`${baseClasses}${accentRing} w-full text-left border rounded px-1.5 py-0.5 text-[10px] font-mono cursor-pointer transition-colors flex items-center gap-1.5`}
      data-tooltip={`${tooltipPrefix}${tooltipBody ? ' · ' + tooltipBody : ''}`}
    >
      <span
        className={`${tagColor} text-[9px] uppercase tracking-wider font-semibold flex-shrink-0`}
      >
        {tag}
      </span>
      <span className="truncate flex-1 min-w-0">
        <span className="font-medium">{displayName}</span>
        {displayBasename && (
          <span className="text-muted-foreground/70 ml-1">{displayBasename}</span>
        )}
        {callCount > 1 && (
          <span className="text-muted-foreground/60 ml-1">·{callCount}×</span>
        )}
      </span>
    </button>
  );
}

// ============================================================================
// Function row — one strip of [upstream | code | downstream]
// ============================================================================

/**
 * A single row's pin payload — discriminated union over three flavours:
 *
 *   - `cross` : cross-file edge to a project function (real FnNode).
 *   - `self`  : same-file edge to another top-level in this file (real FnNode).
 *   - `ext`   : import into an external module (npm package / unresolved
 *               spec). No FnNode — we only have a name + packageSpec.
 *               Renders muted with an "EXT" badge; click flashes the
 *               focal file's `__imports__` block (visibility-only nav).
 *
 * `lines` are call-site lines in the focal file (right-column pins
 * align to `lines[0]`). For `cross` upstream pins, lines are in the
 * external file instead — but the left column doesn't line-align so
 * they're tooltip-only there.
 */
type RowPin =
  | { kind: 'cross'; external: FnNode; lines: number[] }
  | { kind: 'self'; external: FnNode; lines: number[] }
  | { kind: 'ext'; name: string; packageSpec: string; lines: number[] }
  | {
      // Receiver-resolved-but-method-missing: `obj.foo()` where `obj`
      // is a project import but `foo` couldn't be located in obj's
      // home file. Visibility-only pin (no nav target). Click flashes
      // the focal file's __imports__ block so the user can see where
      // `obj` came from.
      kind: 'method';
      receiverName: string;
      methodName: string;
      lines: number[];
    };

interface FunctionRowProps {
  symbol: FnNode;
  fileSource: string | null;
  hasChange: boolean;
  /** Caller pins (left column). Cross-file and intra-file mixed; cross
   *  pins first to keep the architectural reading at the top. */
  upstream: RowPin[];
  /** Callee pins (right column). Will be vertically anchored to their
   *  first call-site line. Cross + intra mixed. */
  downstream: RowPin[];
  /**
   * Pin click — parent dispatches based on `pin.kind`:
   *   - cross / self : record both endpoints into the history FIFO,
   *                    flip focal to the target, flash the target block.
   *   - ext          : flash the focal file's `__imports__` block;
   *                    no history, no focal change (the function lives
   *                    outside the project graph, no node to jump to).
   *
   * Receives `currentSymbol` so cross-file jumps know who they came
   * from for history-FIFO purposes.
   */
  onPinClick: (pin: RowPin, currentSymbol: FnNode) => void;
  /** Forwarded to CodeBlock — see CodeBlockProps.onHighlighted. */
  onHighlighted: (qname: string) => void;
  /** Forwarded to CodeBlock — full file comment list, the block self-filters. */
  comments?: readonly CodeComment[];
  /** Forwarded to CodeBlock — bubble click handler. */
  onCommentClick?: (comment: CodeComment, e: React.MouseEvent) => void;
  /** Set of qnames whose pins should render with an amber accent ring.
   *  Forwarded to PinChip.accent. Used in the diff view to highlight
   *  edges whose other end also changed. */
  accentQnames?: ReadonlySet<string>;
  /** Forwarded to CodeBlock — line-level diff overlay. */
  addedLines?: ReadonlySet<number>;
}

// ----------------------------------------------------------------------------
// Right-column geometry — used to align callee pins to their call line.
//
// Numbers are derived from the literal Tailwind classes on the header /
// body containers. If those classes change, update these constants too;
// the body's `style.lineHeight` and `LINE_HEIGHT_PX` are intentionally
// kept in lockstep so position math matches visual rendering.
// ----------------------------------------------------------------------------
const LINE_HEIGHT_PX = 18;
const HEADER_HEIGHT_PX = 29; // px-2 py-1.5 + text-xs (lh 16) + 1px border-b
const BODY_PADDING_TOP_PX = 8; // py-2
const PIN_HEIGHT_PX = 22; // text-[10px] py-0.5 + border + small breathing

/**
 * Stable React key for a RowPin. Mixes the side ('in'/'out') so the
 * same external can be rendered in both columns of different rows
 * without key collision, plus enough identity bits per kind:
 *   - cross / self : (filePath, qname)
 *   - ext          : (packageSpec, name)  — no filePath / qname exists
 */
function pinKey(side: 'in' | 'out', pin: RowPin): string {
  switch (pin.kind) {
    case 'cross':
      return `${side}:x:${pin.external.filePath}::${pin.external.qualifiedName}`;
    case 'self':
      return `${side}:s:${pin.external.filePath}::${pin.external.qualifiedName}`;
    case 'ext':
      return `${side}:e:${pin.packageSpec}::${pin.name}`;
    case 'method':
      return `${side}:m:${pin.receiverName}::${pin.methodName}`;
  }
}

/**
 * Accent decision: cross / self use accentQnames lookup (target function
 * also changed). Ext / method pins never accent — there's no "other
 * end" inside the project graph to mark.
 */
function pinAccent(pin: RowPin, accentQnames?: ReadonlySet<string>): boolean {
  if (pin.kind === 'ext' || pin.kind === 'method') return false;
  return accentQnames?.has(pin.external.qualifiedName) ?? false;
}

/**
 * Map each downstream pin to a `top` (in px from the row's top), aligned
 * to its first call line. Pins whose natural tops would overlap get
 * pushed down so each retains a `PIN_HEIGHT_PX` slot. Order is preserved
 * by call-line; on ties we keep input order (stable sort).
 */
function placeDownstreamPins(
  pins: RowPin[],
  symbol: FnNode,
): number[] {
  if (pins.length === 0) return [];
  const indexed = pins.map((p, i) => ({
    i,
    line: clamp(
      p.lines[0] ?? symbol.startLine,
      symbol.startLine,
      symbol.endLine,
    ),
  }));
  indexed.sort((a, b) => a.line - b.line || a.i - b.i);
  const placed = new Array<number>(pins.length).fill(0);
  let prevBottom = -Infinity;
  for (const { i, line } of indexed) {
    const natural =
      HEADER_HEIGHT_PX +
      BODY_PADDING_TOP_PX +
      (line - symbol.startLine) * LINE_HEIGHT_PX;
    const top = Math.max(natural, prevBottom);
    placed[i] = top;
    prevBottom = top + PIN_HEIGHT_PX;
  }
  return placed;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Build a HistoryEntry from a graph FunctionNode. Kept inline (rather
 * than exported) because no other module needs it — the conversion is
 * a 4-field copy that only happens at the click site.
 */
function fnToEntry(fn: FnNode): HistoryEntry {
  return {
    filePath: fn.filePath,
    qname: fn.qualifiedName,
    name: fn.name,
    kind: fn.kind,
  };
}

function FunctionRow({
  symbol,
  fileSource,
  hasChange,
  upstream,
  downstream,
  onPinClick,
  onHighlighted,
  comments,
  onCommentClick,
  accentQnames,
  addedLines,
}: FunctionRowProps) {
  // Right-column pins are aligned to their first call line. Compute
  // the placement once per render — cheap (linear in pin count) and
  // saves rendering each pin into a flex stack.
  const downstreamTops = placeDownstreamPins(downstream, symbol);

  // The outer wrapper is tagged with `data-block-qname` so the parent's
  // flashTarget effect can locate this row by qualified name and scroll
  // it into view without us holding a ref map. `data-start-line` /
  // `data-end-line` carry the absolute file-line range so the diff
  // ruler's viewport-tracking effect can interpolate "what file-lines
  // are currently scrolled into view" from each block's bounding rect
  // without threading the workingFunctions array through closures.
  //
  // Side cells get fixed widths — the centre claims the rest. flex-shrink-0
  // on the sides keeps them stable when the centre body has a horizontal
  // scrollbar for long lines.
  return (
    <div
      data-block-qname={symbol.qualifiedName}
      data-start-line={symbol.startLine}
      data-end-line={symbol.endLine}
      className="flex gap-2 items-stretch scroll-mt-2"
    >
      {/* Left column: callers stacked top-aligned. We DON'T align in-pins
          to lines because the call line lives in the CALLER's file, not
          here — there's nothing in this row's body to align them to. */}
      <div className="w-44 flex-shrink-0 flex flex-col gap-1 pt-1">
        {upstream.length === 0 ? (
          <div className="text-[10px] text-muted-foreground/40 italic px-1.5">no callers</div>
        ) : (
          upstream.map((p) => (
            <PinChip
              key={pinKey('in', p)}
              side="in"
              pin={p}
              accent={pinAccent(p, accentQnames)}
              onClick={() => onPinClick(p, symbol)}
            />
          ))
        )}
      </div>
      <CodeBlock
        symbol={symbol}
        fileSource={fileSource}
        hasChange={hasChange}
        onHighlighted={onHighlighted}
        comments={comments}
        onCommentClick={onCommentClick}
        addedLines={addedLines}
      />
      {/* Right column: callees absolutely positioned, each `top` aligned
          to its first call site so the pin sits next to the actual line.
          Overlap is resolved in placeDownstreamPins. */}
      <div className="w-44 flex-shrink-0 relative">
        {downstream.length === 0 ? (
          <div className="text-[10px] text-muted-foreground/40 italic px-1.5 pt-1">
            no callees
          </div>
        ) : (
          downstream.map((p, i) => (
            <div
              key={pinKey('out', p)}
              className="absolute left-0 right-0"
              style={{ top: `${downstreamTops[i]}px` }}
            >
              <PinChip
                side="out"
                pin={p}
                accent={pinAccent(p, accentQnames)}
                onClick={() => onPinClick(p, symbol)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Search palette (Cmd+K)
// ============================================================================

interface SearchPaletteProps {
  cwd: string;
  onSelect: (hit: SearchHit) => void;
  onClose: () => void;
}

function SearchPalette({ cwd, onSelect, onClose }: SearchPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchResponse>({ files: [], symbols: [] });
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);

  const flat = useMemo(() => [...hits.files, ...hits.symbols], [hits]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits({ files: [], symbols: [] });
      return;
    }
    setLoading(true);
    const handle = setTimeout(async () => {
      const params = new URLSearchParams({ cwd, q, limit: '12' });
      const exit = await BrowserRuntime.runPromiseExit(fetchProjectGraphSearch<SearchResponse>(params));
      if (exit._tag === 'Success') {
        setHits(exit.value);
        setActiveIdx(0);
      }
      setLoading(false);
    }, 120);
    return () => clearTimeout(handle);
  }, [query, cwd]);

  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (flat.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, flat.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hit = flat[activeIdx];
        if (hit) onSelect(hit);
      }
    },
    [flat, activeIdx, onClose, onSelect],
  );

  return (
    <div
      className="absolute inset-0 bg-background/40 z-20 flex items-start justify-center pt-24"
      onClick={onClose}
    >
      <div
        className="w-[480px] max-w-[80%] bg-card border border-border rounded shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <Search className="w-4 h-4 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder={t('blockViewer.search.hint', 'Start typing to search')}
            className="flex-1 bg-transparent border-0 outline-none text-sm"
          />
          {loading && <span className="text-xs text-muted-foreground">…</span>}
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {flat.length === 0 && query && !loading && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t('blockViewer.search.noResults', 'No matches')}
            </div>
          )}
          <SearchSection
            label={t('blockViewer.search.files', 'Files')}
            hits={hits.files}
            startIdx={0}
            activeIdx={activeIdx}
            onSelect={onSelect}
            setActive={setActiveIdx}
          />
          <SearchSection
            label={t('blockViewer.search.symbols', 'Symbols')}
            hits={hits.symbols}
            startIdx={hits.files.length}
            activeIdx={activeIdx}
            onSelect={onSelect}
            setActive={setActiveIdx}
          />
        </div>
      </div>
    </div>
  );
}

interface SearchSectionProps {
  label: string;
  hits: SearchHit[];
  startIdx: number;
  activeIdx: number;
  onSelect: (hit: SearchHit) => void;
  setActive: (i: number) => void;
}

function SearchSection({ label, hits, startIdx, activeIdx, onSelect, setActive }: SearchSectionProps) {
  if (hits.length === 0) return null;
  return (
    <div>
      <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground bg-secondary/40">
        {label}
      </div>
      {hits.map((h, i) => {
        const idx = startIdx + i;
        const isActive = idx === activeIdx;
        return (
          <button
            key={`${h.type}:${h.label}:${i}`}
            onMouseEnter={() => setActive(idx)}
            onClick={() => onSelect(h)}
            className={`w-full text-left px-3 py-1.5 text-xs flex items-start gap-2 ${isActive ? 'bg-secondary' : 'hover:bg-secondary/60'}`}
          >
            {/* File hits get a generic FileText icon; symbol hits route
                through SymbolIcon so they line up visually with the same
                symbol's block header / history drawer entry. */}
            {h.target.kind === 'file' ? (
              <FileText className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" />
            ) : (
              <SymbolIcon
                kind={h.target.symbolKind}
                qname={h.target.qualifiedName}
                className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"
              />
            )}
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="font-mono truncate">{h.label}</span>
              {h.hint && (
                <span className="text-[10px] text-muted-foreground truncate">{h.hint}</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ============================================================================
// Top-level component
// ============================================================================

interface BlockViewerProps {
  cwd: string;
  /** File the user has selected in the left tree — drives the focal chip. */
  highlightedFilePath?: string | null;
  /** Files with uncommitted changes (overlay source). */
  changedFiles: ReadonlySet<string>;
  /** "Switch back to line view" callback. Optional because some hosts
   *  (like the diff wrapper) don't have a meaningful "code mode" to
   *  flip to — the toggle button hides itself when this is omitted. */
  onSwitchToCode?: () => void;
  /** Enable selection-driven review comments. Mirrors CodeViewer's
   *  prop of the same name — when true (and `cwd` is present) the user
   *  can drag-select code to pop the FloatingToolbar. */
  enableComments?: boolean;
  /** Same shape as CodeViewer / DiffView's prop. When provided, the
   *  FloatingToolbar shows a "Search" button that hands the selected
   *  text off to the host (typically: switch to search tab + run a
   *  project-wide content search). Omit to hide the button. */
  onContentSearch?: (query: string) => void;
  /** Fires whenever the displayed focal file changes — initial mount,
   *  pin-jump, history-drawer click, Cmd+K hit. The diff wrapper uses
   *  this to refetch + re-project diff overlay for the new focal so
   *  chip-diff highlighting follows pin navigation across changed
   *  files. Plain (non-diff) BlockViewer hosts can ignore. */
  onFocalChange?: (focalFile: string | null) => void;

  // -- Diff-projection hooks ----------------------------------------------
  // These three pairs are how `BlockDiffViewer` (the git-diff version
  // of the chip layout) turns BlockViewer into a diff projection
  // without forking the component. Plain BlockViewer leaves all of
  // them unset and behaves as before.

  /** When set, only render rows whose qualifiedName is in this set. The
   *  filter is APPLIED ONLY TO THE FILE THAT MATCHES THE WRAPPER'S
   *  ORIGIN (i.e. when the user pin-jumps to a different file, the
   *  filter falls away — see Q4 in the design discussion). */
  qnameFilter?: ReadonlySet<string>;
  /** When the focal file's path matches `qnameFilter`'s origin, the
   *  filter is "active". Without this anchor we'd silently filter out
   *  every block in any file the user navigated to. */
  qnameFilterFile?: string;
  /** Pin chips whose `external.qualifiedName` is in this set get an
   *  amber accent ring — flags "the function on the other end of this
   *  edge ALSO changed" so the reviewer can see ripple boundaries at
   *  a glance. */
  accentQnames?: ReadonlySet<string>;
  /** Anchored to `accentQnames` the same way `qnameFilter` is anchored
   *  to `qnameFilterFile` — accents only render when the user is still
   *  looking at the file the diff was computed against. */
  accentFile?: string;
  /** After-file line numbers that should render with the green added/
   *  modified background. Same anchoring rule as the two above. */
  addedLines?: ReadonlySet<number>;
  /** File path that `addedLines` was computed against. */
  addedLinesFile?: string;

  /** Render-prop slot — returns content rendered at the END of the
   *  Header's left half (after focal path + stats). Receives the
   *  current focal so it can build focal-aware buttons (e.g. a copy
   *  path button that reflects pin navigation). */
  headerExtraLeft?: (state: BlockViewerHeaderState) => React.ReactNode;
  /** Render-prop slot — returns content rendered at the START of the
   *  Header's right half (before search / refresh / code toggle).
   *  Same signature as headerExtraLeft. */
  headerExtraRight?: (state: BlockViewerHeaderState) => React.ReactNode;
}

export function BlockViewer({
  cwd,
  highlightedFilePath,
  changedFiles,
  onSwitchToCode,
  enableComments = false,
  onContentSearch,
  onFocalChange,
  qnameFilter,
  qnameFilterFile,
  accentQnames,
  accentFile,
  addedLines,
  addedLinesFile,
  headerExtraLeft,
  headerExtraRight,
}: BlockViewerProps) {
  const { t } = useTranslation();

  // Focal file: defaults to whatever the left tree highlights, can be
  // transiently overridden by Cmd+K hits / pin clicks until the
  // highlighted file changes again.
  const [focalOverride, setFocalOverride] = useState<string | null>(null);
  const focalFile = focalOverride ?? highlightedFilePath ?? null;
  useEffect(() => {
    setFocalOverride(null);
  }, [highlightedFilePath]);

  // Notify host on every focal change so it can react (e.g. the diff
  // wrapper re-fetches + re-projects the diff overlay for the new
  // file). Fired post-commit so callers can safely call setState in
  // their handler. The dep on `onFocalChange` keeps this stable when
  // the host memoises its callback; if the host doesn't memo, the
  // effect re-fires harmlessly with the same focal value.
  useEffect(() => {
    onFocalChange?.(focalFile);
  }, [focalFile, onFocalChange]);

  const { state, refresh } = useFileFunctions(cwd, focalFile);

  // Source text for the focal file — needed so each block can slice
  // and highlight its own lines. One fetch per focal-file change.
  // We also keep `mtimeMs` from the response so the freshness-check
  // effect below can cross-check it against the indexed projection's
  // mtime: `/api/files/text` always reads fresh from disk, while
  // `/api/projectGraph/file-functions` is backed by an in-memory
  // index that's only refreshed by `refreshFocalFile` per request
  // OR by the manual "Rebuild project graph" button. When the two
  // disagree (file was edited on disk but our cached projection is
  // older), we trigger a refresh so the chip layout matches the
  // text we're slicing it from.
  const [fileSource, setFileSource] = useState<{
    content: string;
    mtimeMs: number;
  } | null>(null);
  useEffect(() => {
    if (!focalFile) {
      setFileSource(null);
      return;
    }
    let cancelled = false;
    setFileSource(null);
    (async () => {
      const params = new URLSearchParams({ cwd, path: focalFile });
      const exit = await BrowserRuntime.runPromiseExit(
        fetchFileTextRaw<{ content: string; mtimeMs: number }>(params)
      );
      if (cancelled) return;
      if (exit._tag === 'Success') {
        setFileSource({ content: exit.value.content, mtimeMs: exit.value.mtimeMs });
      } else {
        console.error('[BlockViewer] failed to load file source for', focalFile, exit.cause);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, focalFile]);

  // Freshness cross-check. When fileSource arrives with an mtime
  // newer than `state.data.mtimeMs`, the projection was built from
  // a stale snapshot — call `refresh()` to invalidate the client
  // cache and refetch (which will trigger the server-side
  // `refreshFocalFile` for free, since it stats on every request).
  //
  // Why not server-only: the client `ffCache` (in `useFileBlocks`)
  // is keyed by `(cwd, file)` only. A second visit to the same
  // focal hits cache → returns the OLD entry without ever calling
  // the server. The cross-check forces a refetch when we have
  // evidence the cache is stale. Common case (same mtime) is
  // free: the comparison is one number.
  //
  // Skips: synthetic responses (markdown / unsupported / not-found
  // fallback) where `mtimeMs` may be 0; we just don't cross-check
  // (those paths don't have a re-parse story anyway).
  const refreshedForMtime = useRef<number | null>(null);
  useEffect(() => {
    if (!fileSource) return;
    if (state.state !== 'ready') return;
    const dataMtime = state.data.mtimeMs;
    if (!dataMtime) return; // synthetic / no-mtime response
    if (fileSource.mtimeMs <= dataMtime) return;
    // Avoid a refresh loop: if we already triggered a refresh for
    // this exact fileSource mtime and the projection still hasn't
    // caught up (e.g. server can't see the file for some reason),
    // don't keep re-firing. The user's manual refresh button is
    // the escape hatch.
    if (refreshedForMtime.current === fileSource.mtimeMs) return;
    refreshedForMtime.current = fileSource.mtimeMs;
    refresh();
  }, [fileSource, state, refresh]);

  // History FIFO of visited functions. Populated ONLY by pin
  // navigation (and the user re-clicking entries in the history
  // drawer) — Cmd+K hits intentionally don't record because search
  // jumps aren't part of the "tracing a call chain" flow.
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);

  // Flash-target signal: when set, the effect below scroll-into-views
  // the matching block and pulses it. The `nonce` field forces the
  // effect to re-fire even if the user clicks the same pin twice in a
  // row (otherwise React would skip the state update).
  //
  // Optional `line` switches to LINE-LEVEL flash: instead of scrolling
  // to the block's top + flashing its header, we scrollIntoView the
  // matching `[data-line=N]` element with `block: 'center'` and run
  // the `.line-flash` animation on it. Used by the chip-diff overview
  // ruler so a tick click lands on the precise changed line, not just
  // the containing function block.
  const [flashTarget, setFlashTarget] = useState<{
    filePath: string;
    qname: string;
    line?: number;
    nonce: number;
  } | null>(null);
  const flashNonceRef = useRef(0);
  // Each flashTarget nonce is consumed at most once. Without this, the
  // scroll effect would re-fire every time `highlightedQnames` grows
  // past `expected` (set is in the deps), repeatedly re-scrolling the
  // viewport whenever a block re-renders.
  const consumedFlashNonceRef = useRef(0);

  // Per-focal-file set of CodeBlocks that have reported reaching a
  // stable height. This is the gate the scroll effect waits on — until
  // every rendered block has signalled, scrolling would measure
  // half-rendered placeholders and the smooth animation's endpoint
  // would land on a stale docY (root cause of the "first click wrong,
  // second click correct" bug).
  const [highlightedQnames, setHighlightedQnames] = useState<Set<string>>(
    () => new Set(),
  );

  // Reset the tracking Set whenever the focal file the hook actually
  // LOADED changes — not when `focalFile` changes, because there's a
  // window between focal change and state going `ready` where old
  // CodeBlocks for the previous file are still mounted and we'd be
  // ignoring their (now-stale) signals anyway.
  const focalDataPath = state.state === 'ready' ? state.data.filePath : null;
  useEffect(() => {
    setHighlightedQnames(new Set());
  }, [focalDataPath]);

  const handleBlockHighlighted = useCallback((qname: string) => {
    setHighlightedQnames((prev) => {
      // Returning prev when already-present avoids creating a new Set
      // reference, which avoids re-rendering the (memo-less) children.
      if (prev.has(qname)) return prev;
      const next = new Set(prev);
      next.add(qname);
      return next;
    });
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Pin click — dispatches on pin.kind:
  //   • cross / self  : record both endpoints into history (source first
  //                     so target lands at the FIFO head), switch focal
  //                     to target, flash target block.
  //   • ext / method  : flash the focal file's `__imports__` block.
  //                     No history (looking at imports isn't part of
  //                     the call-tracing flow), no focal change (stay
  //                     in the file the user was reading). Both kinds
  //                     are visibility-only pins — clicking gives a
  //                     navigational hint to where the receiver entered
  //                     scope, no actual jump.
  const handlePinClick = useCallback(
    (pin: RowPin, currentSymbol: FnNode) => {
      if (pin.kind === 'ext' || pin.kind === 'method') {
        const path = currentSymbol.filePath;
        if (!path) return;
        flashNonceRef.current += 1;
        setFlashTarget({
          filePath: path,
          qname: '__imports__',
          nonce: flashNonceRef.current,
        });
        return;
      }
      const current = fnToEntry(currentSymbol);
      const target = fnToEntry(pin.external);
      setHistory((prev) => pushHistoryEntry(pushHistoryEntry(prev, current), target));
      setFocalOverride(target.filePath);
      flashNonceRef.current += 1;
      setFlashTarget({
        filePath: target.filePath,
        qname: target.qname,
        nonce: flashNonceRef.current,
      });
    },
    [],
  );

  // Re-clicking a history entry: jump to it and flash, but DO NOT
  // touch the FIFO. The list represents the *original* tracing order
  // (the trail of pin hops); replaying an entry shouldn't reshuffle
  // that trail — otherwise the user loses their breadcrumb whenever
  // they peek at an earlier step.
  const handleHistorySelect = useCallback((entry: HistoryEntry) => {
    setFocalOverride(entry.filePath);
    flashNonceRef.current += 1;
    setFlashTarget({
      filePath: entry.filePath,
      qname: entry.qname,
      nonce: flashNonceRef.current,
    });
  }, []);

  // Cmd+K palette select. File hits just switch focal; symbol hits
  // ALSO queue a flash → the existing flash effect waits until
  // `state.data.filePath === flashTarget.filePath` before scrolling,
  // so cross-file jumps "just work": setFocalOverride kicks off the
  // useFileFunctions fetch, blocks render, gate opens, scroll fires.
  // Without this, symbol hits used to drop the user at line 1 of the
  // target file with the actual symbol potentially hundreds of lines
  // away — same UX as a search engine taking you to a domain instead
  // of the matching page.
  const handleSearchSelect = useCallback((hit: SearchHit) => {
    setSearchOpen(false);
    setFocalOverride(hit.target.filePath);
    if (hit.target.kind === 'symbol') {
      flashNonceRef.current += 1;
      setFlashTarget({
        filePath: hit.target.filePath,
        qname: hit.target.qualifiedName,
        line: hit.target.line,
        nonce: flashNonceRef.current,
      });
    }
  }, []);

  // Block overview ruler click: line-level flash. Used in both plain
  // chip mode (click on a block backdrop → jump to the block's start
  // line) and chip-diff mode (click on a green change-run → jump to
  // the precise changed line). Like history-drawer selection, this
  // DOESN'T touch focal (the ruler only ever surfaces blocks for the
  // file already in view) and DOESN'T write history (it's a
  // navigation aid within the file, not a call-graph hop).
  const handleRulerJump = useCallback(
    (qname: string, line: number) => {
      if (!focalFile) return;
      flashNonceRef.current += 1;
      setFlashTarget({
        filePath: focalFile,
        qname,
        line,
        nonce: flashNonceRef.current,
      });
    },
    [focalFile],
  );

  // Scroll container ref — also drives the block overview ruler's
  // viewport thumb ("where am I" indicator). Held as state via a
  // callback ref so the viewport-tracking effect re-binds the moment
  // the element mounts
  // (the JSX path that renders this div is gated on data being ready,
  // so a plain useRef would stay null past the loading→ready
  // transition and the effect would never see it).
  const [scrollContainer, setScrollContainer] =
    useState<HTMLDivElement | null>(null);
  // Viewport line range — first..last file-line currently visible in
  // the chip scroll container. `null` until the first measurement,
  // which lets BlockDiffMinimap hide the thumb instead of flashing
  // it at line 1 on initial paint. Only consumed in chip-diff mode
  // (BlockDiffMinimap is the only viewport-aware widget); plain
  // chip mode uses the native browser scrollbar and ignores this.
  const [viewportRange, setViewportRange] = useState<{
    start: number;
    end: number;
  } | null>(null);

  // Track which file-lines are currently visible in the chip viewport,
  // so BlockDiffMinimap can render a "where am I" thumb. The tracker:
  //
  //   1. Walks every `[data-block-qname]` element inside the scroll
  //      container.
  //   2. For each block whose bounding rect intersects the container's
  //      rect, reads `data-start-line` / `data-end-line` and linearly
  //      interpolates the visible vertical band → file-line range.
  //   3. Aggregates min/max across all visible blocks → viewportRange.
  //
  // Block-rect interpolation (rather than per-line `[data-line]`
  // queries) keeps this O(blocks) on every scroll tick — a 5000-line
  // file with 50 chip blocks has 50 rects, not thousands of line-divs.
  // Slight imprecision inside a tall block is fine for an overview;
  // exact line addressability lives in the click handler, not the
  // thumb.
  //
  // Throttled via rAF so a fast scroll coalesces to one measurement
  // per frame. ResizeObserver reruns on container resize (panel
  // expand/collapse, window resize) so the thumb stays accurate.
  useEffect(() => {
    if (!scrollContainer) return;
    let rafId: number | null = null;
    const compute = () => {
      rafId = null;
      const cRect = scrollContainer.getBoundingClientRect();
      if (cRect.height <= 0) return;
      const blocks = scrollContainer.querySelectorAll<HTMLElement>(
        '[data-block-qname]',
      );
      let minLine = Infinity;
      let maxLine = -Infinity;
      blocks.forEach((el) => {
        const startStr = el.dataset.startLine;
        const endStr = el.dataset.endLine;
        if (!startStr || !endStr) return;
        const startLine = Number(startStr);
        const endLine = Number(endStr);
        if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return;
        const r = el.getBoundingClientRect();
        if (r.height <= 0) return;
        // No overlap with viewport → skip.
        if (r.bottom <= cRect.top || r.top >= cRect.bottom) return;
        const visibleTop = Math.max(0, cRect.top - r.top);
        const visibleBottom = Math.min(r.height, cRect.bottom - r.top);
        const lineCount = endLine - startLine + 1;
        const startInBlock = Math.floor((visibleTop / r.height) * lineCount);
        const endInBlock = Math.ceil((visibleBottom / r.height) * lineCount) - 1;
        const blockStart = startLine + Math.max(0, startInBlock);
        const blockEnd = startLine + Math.min(lineCount - 1, Math.max(0, endInBlock));
        if (blockStart < minLine) minLine = blockStart;
        if (blockEnd > maxLine) maxLine = blockEnd;
      });
      if (minLine === Infinity || maxLine === -Infinity) {
        setViewportRange(null);
      } else {
        setViewportRange((prev) =>
          prev && prev.start === minLine && prev.end === maxLine
            ? prev
            : { start: minLine, end: maxLine },
        );
      }
    };
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(compute);
    };
    schedule();
    scrollContainer.addEventListener('scroll', schedule, { passive: true });
    // Resize / DOM mutations also recompute viewport (so the thumb
    // stays accurate when layout changes — panel resizes, filter
    // toggles between full/changed-only block sets, file swaps).
    const ro = new ResizeObserver(schedule);
    ro.observe(scrollContainer);
    const mo = new MutationObserver(schedule);
    mo.observe(scrollContainer, { childList: true, subtree: true });
    return () => {
      scrollContainer.removeEventListener('scroll', schedule);
      ro.disconnect();
      mo.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scrollContainer]);

  // "You are here" qname for the TOC sidebar: the function whose
  // source-line range straddles the viewport center. Falls back to
  // the function whose startLine is the largest still ≤ viewport.start
  // (covers the case where the viewport center is between two
  // functions, e.g. inside a top-level `import` block). `null` means
  // no chip is in view — TOC renders without a current-row highlight.
  //
  // Reads `state.data.functions` directly (NOT the diff-filtered
  // `workingFunctions`, which is computed below the early-returns and
  // can't be used in a hook). When diff mode trims the chip canvas,
  // `currentFocalQname` may resolve to a filtered-out function — the
  // TOC just won't render a highlight for it (no harm).
  //
  // viewportRange is already tracked at O(blocks)/scroll for the diff
  // minimap; this is a free read.
  const currentFocalQname = useMemo(() => {
    if (state.state !== 'ready' || !viewportRange) return null;
    const fns = state.data.functions;
    if (fns.length === 0) return null;
    const center = (viewportRange.start + viewportRange.end) / 2;
    for (const fn of fns) {
      if (fn.startLine <= center && center <= fn.endLine) {
        return fn.qualifiedName;
      }
    }
    let best: (typeof fns)[number] | null = null;
    for (const fn of fns) {
      if (fn.startLine <= viewportRange.start) {
        if (!best || fn.startLine > best.startLine) best = fn;
      }
    }
    return best?.qualifiedName ?? null;
  }, [state, viewportRange]);

  // ====================================================================
  // Review comments — selection toolbar + per-line bubbles + popovers.
  // ====================================================================
  const commentsEnabled = enableComments && !!cwd && !!focalFile;
  const aiBridge = useAIBridge();

  // useComments needs a non-null filePath to do anything useful; we
  // pass empty string when there's no focal yet so the hook
  // short-circuits internally rather than firing a 400.
  const {
    comments,
    addComment,
    updateComment,
    deleteComment,
    refresh: refreshComments,
  } = useComments({ cwd, filePath: focalFile ?? '' });

  // Anchor element for FloatingToolbar / AddCommentInput / SendToAIInput
  // / ViewCommentCard. Must be a NON-scrolling box so absolute coords
  // computed from `clientX/Y - container.left` stay valid even after
  // the user scrolls — the inner overflow-auto would invalidate them
  // by changing scrollTop.
  //
  // Held as STATE (callback ref) rather than a useRef so that mounting
  // the element triggers a re-render: useBlockSelection's effect deps
  // include this value, so the listeners only attach once the element
  // actually exists. (Important because the early-return JSX paths for
  // loading / notFound / error don't include this div — a plain useRef
  // would stay null past the loading→ready transition without firing
  // the effect.)
  const [reviewAnchor, setReviewAnchor] = useState<HTMLDivElement | null>(null);

  const { toolbar: selectionToolbar, clearToolbar } = useBlockSelection({
    enabled: commentsEnabled,
    container: reviewAnchor,
  });

  // Three popover states — at most one is shown at a time, but we
  // model them independently so opening AddComment doesn't clobber a
  // half-open SendToAI input mid-typing (the user can still click
  // outside to dismiss).
  const [addCommentInput, setAddCommentInput] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
    codeContent: string;
  } | null>(null);
  const [sendToAIInput, setSendToAIInput] = useState<{
    x: number;
    y: number;
    range: { start: number; end: number };
    codeContent: string;
  } | null>(null);
  const [viewingComment, setViewingComment] = useState<{
    comment: CodeComment;
    x: number;
    y: number;
  } | null>(null);

  const handleToolbarAddComment = useCallback(() => {
    if (!selectionToolbar) return;
    setAddCommentInput({
      x: selectionToolbar.x,
      y: selectionToolbar.y,
      range: selectionToolbar.range,
      codeContent: selectionToolbar.selectedText,
    });
    clearToolbar();
  }, [selectionToolbar, clearToolbar]);

  const handleToolbarSendToAI = useCallback(() => {
    if (!selectionToolbar) return;
    setSendToAIInput({
      x: selectionToolbar.x,
      y: selectionToolbar.y,
      range: selectionToolbar.range,
      codeContent: selectionToolbar.selectedText,
    });
    clearToolbar();
  }, [selectionToolbar, clearToolbar]);

  // Search button: hand the trimmed selection off to the host
  // (typically wires to project-wide content search). Empty selections
  // are ignored — the toolbar's just been dismissed at that point so
  // pushing an empty query into search would clobber whatever the
  // user had there.
  const handleToolbarSearch = useCallback(() => {
    if (!selectionToolbar || !onContentSearch) return;
    const query = selectionToolbar.selectedText.trim();
    clearToolbar();
    if (query) onContentSearch(query);
  }, [selectionToolbar, onContentSearch, clearToolbar]);

  const handleCommentSubmit = useCallback(
    async (content: string) => {
      if (!addCommentInput) return;
      await addComment(
        addCommentInput.range.start,
        addCommentInput.range.end,
        content,
        addCommentInput.codeContent,
      );
      setAddCommentInput(null);
    },
    [addCommentInput, addComment],
  );

  // Send-to-AI bundles every existing comment's code + the current
  // selection into one prompt, then wipes the comments — this matches
  // CodeViewer/DiffView's "review session" pattern: jot a bunch of
  // comments, then "send the whole stack to the AI" as one transaction.
  const handleSendToAISubmit = useCallback(
    async (question: string) => {
      if (!sendToAIInput || !aiBridge || !cwd || !focalFile) return;
      try {
        const allComments = await fetchAllCommentsWithCode(cwd);
        const references: CodeReference[] = allComments.map((c) => ({
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          codeContent: c.codeContent,
          note: c.content || undefined,
        }));
        references.push({
          filePath: focalFile,
          startLine: sendToAIInput.range.start,
          endLine: sendToAIInput.range.end,
          codeContent: sendToAIInput.codeContent,
        });
        const message = buildAIMessage(references, question);
        aiBridge.sendMessage(message);
        await clearAllComments(cwd);
        refreshComments();
        setSendToAIInput(null);
      } catch (err) {
        console.error('[BlockViewer] send to AI failed:', err);
      }
    },
    [sendToAIInput, aiBridge, cwd, focalFile, refreshComments],
  );

  const handleCommentBubbleClick = useCallback(
    (comment: CodeComment, e: React.MouseEvent) => {
      e.stopPropagation();
      setViewingComment({ comment, x: e.clientX, y: e.clientY });
      clearToolbar();
      setAddCommentInput(null);
      setSendToAIInput(null);
    },
    [clearToolbar],
  );

  // Flash effect: once the focal file has loaded, the requested block
  // is in the DOM, AND every rendered block has reported a stable
  // height, scroll the target into view and pulse its header for
  // ~1.5s. The "all blocks settled" gate fixes the layout-shift race
  // where blocks above the target finish their Shiki highlight after
  // our scroll lands and push the target back off-screen. Scroll
  // itself is `behavior: 'instant'` (matches IDE convention — VSCode /
  // JetBrains / Cursor / Zed all jump without animation); the visible
  // "you arrived" feedback is the 1.5 s pulse, not the scroll.
  useEffect(() => {
    if (!flashTarget) return;
    // Each flash nonce gets at most one scroll. Without this, every
    // subsequent grow of highlightedQnames (or any other dep change)
    // after we've already scrolled would re-trigger a re-scroll.
    if (consumedFlashNonceRef.current >= flashTarget.nonce) return;

    if (state.state !== 'ready') return;
    if (!fileSource) return;
    if (state.data.filePath !== flashTarget.filePath) return;

    // Expected count = rows ACTUALLY RENDERED. Must mirror the filter
    // applied below in the render path — otherwise an active diff-mode
    // qnameFilter trims `workingFunctions` smaller than `data.functions`,
    // `highlightedQnames` (which only collects rendered blocks' signals)
    // never reaches the unfiltered total, and the gate stays closed
    // forever.
    let expected: number;
    const filterActiveForFlash =
      qnameFilterFile && qnameFilterFile === state.data.filePath;
    if (filterActiveForFlash && qnameFilter) {
      let n = 0;
      for (const f of state.data.functions) {
        if (qnameFilter.has(f.qualifiedName)) n++;
      }
      expected = Math.max(1, n);
    } else {
      expected = Math.max(1, state.data.functions.length);
    }
    if (highlightedQnames.size < expected) return;

    consumedFlashNonceRef.current = flashTarget.nonce;

    let timeoutId: number | null = null;
    const rafId = requestAnimationFrame(() => {
      // Nested qnames like `Cls>method` aren't rendered as their own
      // chip rows (the projection only emits top-level functions). When
      // a receiver-based resolution targets a nested member, roll up
      // to the top-level container so the click flashes the parent
      // block — user reads inside it to find the method.
      const gtIdx = flashTarget.qname.indexOf('>');
      const qnameForDom =
        gtIdx >= 0 ? flashTarget.qname.slice(0, gtIdx) : flashTarget.qname;
      const root = document.querySelector(
        `[data-block-qname="${CSS.escape(qnameForDom)}"]`,
      );
      if (!root) return;

      // Line-level flash branch — used by the diff overview ruler.
      // Scroll the SPECIFIC line into the viewport center (so the
      // surrounding context is visible too) and pulse just that row.
      // Falls through to block-level flash if the line element isn't
      // found in the DOM (defensive — shouldn't happen if `line` is
      // within the block's startLine/endLine range).
      if (typeof flashTarget.line === 'number') {
        const lineEl = root.querySelector(
          `[data-line="${flashTarget.line}"]`,
        );
        if (lineEl instanceof HTMLElement) {
          // Instant scroll matches IDE convention (VSCode / JetBrains
          // / Cursor / Zed all jump without animation on click-to-
          // jump). The user-visible "you arrived" feedback is the
          // 1.5 s `.line-flash` pulse below; the scroll itself is just
          // positioning, not a transition the user needs to watch.
          lineEl.scrollIntoView({ behavior: 'instant', block: 'center' });
          lineEl.classList.remove('line-flash');
          void lineEl.offsetWidth;
          lineEl.classList.add('line-flash');
          timeoutId = window.setTimeout(() => {
            lineEl.classList.remove('line-flash');
          }, 1700);
          return;
        }
      }

      root.scrollIntoView({ behavior: 'instant', block: 'start' });
      const header = root.querySelector('[data-block-header]');
      if (header instanceof HTMLElement) {
        // Restart the animation by stripping the class, forcing a
        // reflow, then re-adding — otherwise repeat clicks on the
        // same target wouldn't replay the pulse.
        header.classList.remove('block-flash');
        void header.offsetWidth;
        header.classList.add('block-flash');
        timeoutId = window.setTimeout(() => {
          header.classList.remove('block-flash');
        }, 1700);
      }
    });
    return () => {
      cancelAnimationFrame(rafId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [flashTarget, state, fileSource, highlightedQnames, qnameFilter, qnameFilterFile]);

  // -- Empty state ---------------------------------------------------------
  if (!focalFile) {
    return (
      <div className="h-full flex flex-col">
        <Header
          focalFile={null}
          fileCount={null}
          onSwitchToCode={onSwitchToCode}
          onSearch={() => setSearchOpen(true)}
          onRefresh={refresh}
          refreshDisabled
          extraLeft={headerExtraLeft}
          extraRight={headerExtraRight}
        />
        <div className="flex-1 flex flex-col items-center justify-center text-sm text-muted-foreground gap-2 px-4 text-center">
          <span>
            {t(
              'blockViewer.empty.body',
              'Select a file in the left tree to see its function call graph.',
            )}
          </span>
          <span className="text-xs">{t('blockViewer.empty.hint', 'or press ⌘K to search.')}</span>
        </div>
        {searchOpen && (
          <SearchPalette
            cwd={cwd}
            onSelect={handleSearchSelect}
            onClose={() => setSearchOpen(false)}
          />
        )}
      </div>
    );
  }

  // -- Loading / error / not-found ----------------------------------------
  if (state.state === 'idle' || state.state === 'loading') {
    return (
      <div className="h-full flex flex-col">
        <Header
          focalFile={focalFile}
          fileCount={null}
          onSwitchToCode={onSwitchToCode}
          onSearch={() => setSearchOpen(true)}
          onRefresh={refresh}
          refreshDisabled
          extraLeft={headerExtraLeft}
          extraRight={headerExtraRight}
        />
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          {t('blockViewer.fileMode.loading', 'Loading…')}
        </div>
      </div>
    );
  }
  if (state.state === 'notFound') {
    return (
      <div className="h-full flex flex-col">
        <Header
          focalFile={focalFile}
          fileCount={null}
          onSwitchToCode={onSwitchToCode}
          onSearch={() => setSearchOpen(true)}
          onRefresh={refresh}
          extraLeft={headerExtraLeft}
          extraRight={headerExtraRight}
        />
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground px-4 text-center">
          {t(
            'blockViewer.fileMode.notFound',
            'This file is not indexed (unsupported language or beyond the file cap).',
          )}
        </div>
        {searchOpen && (
          <SearchPalette
            cwd={cwd}
            onSelect={handleSearchSelect}
            onClose={() => setSearchOpen(false)}
          />
        )}
      </div>
    );
  }
  if (state.state === 'error') {
    return (
      <div className="h-full flex flex-col">
        <Header
          focalFile={focalFile}
          fileCount={null}
          onSwitchToCode={onSwitchToCode}
          onSearch={() => setSearchOpen(true)}
          onRefresh={refresh}
          extraLeft={headerExtraLeft}
          extraRight={headerExtraRight}
        />
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-sm">
          <span className="text-red-11">{state.message}</span>
          <button
            onClick={refresh}
            className="px-3 py-1 rounded bg-secondary hover:bg-secondary/80"
          >
            {t('blockViewer.retry', 'Retry')}
          </button>
        </div>
      </div>
    );
  }

  // -- Build per-function row data ----------------------------------------
  const data = state.data;

  // Fallback for files without extractable symbols (barrel files like
  // `index.ts` that only re-export, config files, .d.ts modules …):
  // synthesise a single "whole file" block so the chip still shows the
  // file's contents instead of an empty panel. Needs `fileSource` to
  // know the line count.
  let workingFunctions = data.functions;
  if (workingFunctions.length === 0 && fileSource) {
    const lineCount = Math.max(1, fileSource.content.split('\n').length);
    workingFunctions = [
      {
        filePath: data.filePath,
        qualifiedName: '__file__',
        name: basename(data.filePath),
        kind: 'unknown',
        startLine: 1,
        endLine: lineCount,
      },
    ];
  }

  // Diff-projection anchoring: each of the three projections
  // (qnameFilter / accentQnames / addedLines) only applies while the
  // user is looking at the file the projection was computed against.
  // Once they pin-jump to a different file, the anchors fall away and
  // BlockViewer reverts to its normal full-file rendering — that's how
  // we implement "fall back to plain BlockViewer when navigating out
  // of the diffed file" without any special casing on the wrapper side.
  const filterActive = qnameFilterFile && qnameFilterFile === data.filePath;
  const accentActive = accentFile && accentFile === data.filePath;
  const overlayActive = addedLinesFile && addedLinesFile === data.filePath;
  if (filterActive && qnameFilter) {
    // Strict filter: only render blocks whose qname is in changedQnames.
    // Synthetics (`__imports__`, `__heading_*__`, `__preamble__`) follow
    // the same rule — if the diff didn't touch the imports block, the
    // imports block doesn't render in chip-diff. Side effects:
    //   - EXT / method pin clicks flash `__imports__` → silent no-op
    //     when imports unchanged. Acceptable: visibility-only pin
    //     whose target was filtered out doesn't hijack the screen.
    //   - self pin clicks targeting an unchanged sibling function
    //     → silent no-op. Same rationale.
    workingFunctions = workingFunctions.filter((f) =>
      qnameFilter.has(f.qualifiedName),
    );
  }
  const effectiveAccent = accentActive ? accentQnames : undefined;
  const effectiveAddedLines = overlayActive ? addedLines : undefined;

  // Group cross-file edges by focal-fn qname (de-duped by the external
  // function on each side, so multiple call sites from `db.query` to
  // `loginHandler` collapse to one chip with `lines: [N, M, ...]`).
  const upstreamCrossByQname = groupEdgesByFocal(data.upstreamCalls);
  const downstreamCrossByQname = groupEdgesByFocal(data.downstreamCalls);

  // Same-file calls fan out into pins too, just visually muted.
  // For each intra edge `from → to`:
  //   - it contributes a CALLEE pin to `from`'s right column (target = to)
  //   - it contributes a CALLER pin to `to`'s left column   (target = from)
  // Lines are in the focal file, so the right-column pin can use them
  // for line-alignment; the left-column pin doesn't, but we keep them
  // for the tooltip.
  const fnByQname = new Map(workingFunctions.map((f) => [f.qualifiedName, f]));
  const intraOutByFrom = new Map<string, RowPin[]>();
  const intraInByTo = new Map<string, RowPin[]>();
  for (const e of data.intraCalls) {
    const callee = fnByQname.get(e.to);
    const caller = fnByQname.get(e.from);
    if (callee) {
      const list = intraOutByFrom.get(e.from);
      const pin: RowPin = { kind: 'self', external: callee, lines: e.lines };
      if (list) list.push(pin);
      else intraOutByFrom.set(e.from, [pin]);
    }
    if (caller) {
      const list = intraInByTo.get(e.to);
      const pin: RowPin = { kind: 'self', external: caller, lines: e.lines };
      if (list) list.push(pin);
      else intraInByTo.set(e.to, [pin]);
    }
  }

  // External calls — group by focal qname so each row's right column
  // can pull "its" external dependencies. Server already deduped per
  // (focalQname, packageSpec, importedName), so no extra dedup needed.
  const extOutByFrom = new Map<string, RowPin[]>();
  for (const e of data.externalCalls ?? []) {
    const list = extOutByFrom.get(e.focalQname);
    const pin: RowPin = {
      kind: 'ext',
      name: e.external.name,
      packageSpec: e.external.packageSpec,
      lines: e.lines,
    };
    if (list) list.push(pin);
    else extOutByFrom.set(e.focalQname, [pin]);
  }

  // Method-call fallback pins — receiver was a project import but the
  // method couldn't be located. Visibility-only.
  const methodOutByFrom = new Map<string, RowPin[]>();
  for (const e of data.methodCalls ?? []) {
    const list = methodOutByFrom.get(e.focalQname);
    const pin: RowPin = {
      kind: 'method',
      receiverName: e.receiverName,
      methodName: e.methodName,
      lines: e.lines,
    };
    if (list) list.push(pin);
    else methodOutByFrom.set(e.focalQname, [pin]);
  }

  // Merge cross-file + intra-file (+ ext + method on the out side)
  // into the unified RowPin shape FunctionRow expects. Order within
  // each side:
  //   cross → self → method → ext
  // — architectural priority chips lead, then same-file, then the
  // visibility-only fallbacks (method = receiver-resolved-but-method-
  // missing, ext = external package). Both fallback kinds are muted
  // gray; ext goes last because it sits at the visual periphery
  // (npm name, not a project name).
  const buildRowPinsIn = (
    cross: CrossFileCallEdge[] | undefined,
    intra: RowPin[] | undefined,
  ): RowPin[] => [
    ...(cross ?? []).map<RowPin>((e) => ({
      kind: 'cross',
      external: e.external,
      lines: e.lines,
    })),
    ...(intra ?? []),
  ];
  const buildRowPinsOut = (
    cross: CrossFileCallEdge[] | undefined,
    intra: RowPin[] | undefined,
    method: RowPin[] | undefined,
    ext: RowPin[] | undefined,
  ): RowPin[] => [
    ...(cross ?? []).map<RowPin>((e) => ({
      kind: 'cross',
      external: e.external,
      lines: e.lines,
    })),
    ...(intra ?? []),
    ...(method ?? []),
    ...(ext ?? []),
  ];

  const focalFileChanged = changedFiles.has(data.filePath);

  return (
    <div className="h-full flex flex-col relative">
      <Header
        focalFile={focalFile}
        fileCount={data.fileCount}
        functionCount={data.functions.length}
        upstreamCount={data.upstreamCalls.length}
        downstreamCount={data.downstreamCalls.length}
        onSwitchToCode={onSwitchToCode}
        onSearch={() => setSearchOpen(true)}
        onRefresh={refresh}
        extraLeft={headerExtraLeft}
        extraRight={headerExtraRight}
      />
      {/* `reviewAnchor` here (NOT on the inner overflow-auto) so
          FloatingToolbar / popovers compute positions against a
          non-scrolling reference frame; otherwise their `clientX -
          container.left` math drifts the moment the user scrolls.
          Callback ref keeps the value as state so useBlockSelection's
          effect re-runs the moment the element mounts.

          Layout is a flex ROW: FileTOCSection on the LEFT (file
          structure / "you are here"), scroll container in the MIDDLE
          claiming flex-1, optional BlockDiffMinimap to its right
          (chip-diff mode only), FunctionHistoryDrawer on the RIGHT
          (cross-file navigation trail). This puts the scroll
          container's right edge at the minimap/drawer's left edge,
          so the native browser scrollbar (styled by globals.css to
          match `slate-7` 8px) renders FULLY VISIBLE — same as
          CodeViewer. Previously the scroll container spanned the
          full panel and the drawer's `absolute right-0 w-56` covered
          the scrollbar, which is why we needed a custom overview
          ruler in the first place. */}
      <div ref={setReviewAnchor} className="flex-1 relative min-h-0 flex">
        {/* TOC: file structure index on the left. Always rendered
            (even when empty) so the chip canvas's left edge is
            visually stable as files swap. */}
        <FileTOCSection
          functions={workingFunctions}
          currentQname={currentFocalQname}
          onSelect={handleRulerJump}
        />
        {/* Scroll container — `flex-1` claims the space the TOC,
            minimap, and drawer leave. `min-w-0` so flex children
            with long content (here: row pins + horizontally scrolling
            code bodies) shrink correctly instead of pushing the row
            out. Ref'd via callback so BlockDiffMinimap's viewport-
            tracking effect re-binds the moment the element mounts;
            useRef would silently skip the loading→ready transition. */}
        <div
          ref={setScrollContainer}
          className="flex-1 min-w-0 overflow-auto"
        >
          <div className="flex flex-col gap-3 p-3">
            {workingFunctions.map((fn) => (
              <FunctionRow
                key={fn.qualifiedName}
                symbol={fn}
                fileSource={fileSource?.content ?? null}
                hasChange={focalFileChanged}
                upstream={buildRowPinsIn(
                  upstreamCrossByQname.get(fn.qualifiedName),
                  intraInByTo.get(fn.qualifiedName),
                )}
                downstream={buildRowPinsOut(
                  downstreamCrossByQname.get(fn.qualifiedName),
                  intraOutByFrom.get(fn.qualifiedName),
                  methodOutByFrom.get(fn.qualifiedName),
                  extOutByFrom.get(fn.qualifiedName),
                )}
                onPinClick={handlePinClick}
                onHighlighted={handleBlockHighlighted}
                comments={commentsEnabled ? comments : undefined}
                onCommentClick={
                  commentsEnabled ? handleCommentBubbleClick : undefined
                }
                accentQnames={effectiveAccent}
                addedLines={effectiveAddedLines}
              />
            ))}
          </div>
        </div>
        {/* Selection toolbar + comment popovers. All four are anchored
            to reviewAnchor so positions are computed against the
            stable non-scrolling viewport frame. */}
        {commentsEnabled && selectionToolbar && reviewAnchor && (
          <FloatingToolbar
            x={selectionToolbar.x}
            y={selectionToolbar.y}
            visible
            container={reviewAnchor}
            onAddComment={handleToolbarAddComment}
            onSendToAI={handleToolbarSendToAI}
            onSearch={onContentSearch ? handleToolbarSearch : undefined}
            isChatLoading={aiBridge?.isLoading}
          />
        )}
        {commentsEnabled && addCommentInput && (
          <AddCommentInput
            x={addCommentInput.x}
            y={addCommentInput.y}
            range={addCommentInput.range}
            codeContent={addCommentInput.codeContent}
            container={reviewAnchor}
            onSubmit={handleCommentSubmit}
            onClose={() => setAddCommentInput(null)}
          />
        )}
        {commentsEnabled && sendToAIInput && focalFile && (
          <SendToAIInput
            x={sendToAIInput.x}
            y={sendToAIInput.y}
            range={sendToAIInput.range}
            filePath={focalFile}
            codeContent={sendToAIInput.codeContent}
            container={reviewAnchor}
            onSubmit={handleSendToAISubmit}
            onClose={() => setSendToAIInput(null)}
            isChatLoading={aiBridge?.isLoading}
          />
        )}
        {commentsEnabled && viewingComment && (
          <ViewCommentCard
            x={viewingComment.x}
            y={viewingComment.y}
            comment={viewingComment.comment}
            container={reviewAnchor}
            onClose={() => setViewingComment(null)}
            onUpdateComment={updateComment}
            onDeleteComment={deleteComment}
          />
        )}
        {/* Diff minimap — chip-diff sibling of `DiffMinimap`. Mounts
            ONLY in chip-diff mode (when an active overlay supplies
            addedLines). Plain chip mode skips this column entirely
            and relies on the native browser scrollbar that's now
            visible at the scroll container's right edge — same as
            CodeViewer. */}
        {effectiveAddedLines &&
          effectiveAddedLines.size > 0 &&
          workingFunctions.length > 0 && (
            <BlockDiffMinimap
              addedLines={effectiveAddedLines}
              blockRanges={workingFunctions.map((fn) => ({
                qname: fn.qualifiedName,
                startLine: fn.startLine,
                endLine: fn.endLine,
              }))}
              viewportRange={viewportRange}
              onJumpToLine={handleRulerJump}
            />
          )}
        <FunctionHistoryDrawer
          entries={history}
          onSelect={handleHistorySelect}
          onClear={() => setHistory([])}
        />
        {searchOpen && (
          <SearchPalette
            cwd={cwd}
            onSelect={handleSearchSelect}
            onClose={() => setSearchOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Group cross-file edges by their focal-function qualifiedName so each
 * function row can pull "its" callers / callees in O(1). External
 * functions are de-duped per group: if the same external is recorded
 * twice for the same focal (different call sites), the chip only
 * appears once.
 */
function groupEdgesByFocal(
  edges: readonly CrossFileCallEdge[],
): Map<string, CrossFileCallEdge[]> {
  const out = new Map<string, CrossFileCallEdge[]>();
  for (const e of edges) {
    const list = out.get(e.focalQname);
    if (!list) {
      out.set(e.focalQname, [e]);
      continue;
    }
    const dup = list.some(
      (x) =>
        x.external.filePath === e.external.filePath &&
        x.external.qualifiedName === e.external.qualifiedName,
    );
    if (!dup) list.push(e);
  }
  return out;
}

// ============================================================================
// Header
// ============================================================================

/**
 * State passed to the host's render-prop slots so they can build
 * focal-aware UI (e.g., a copy-path button that always copies the
 * CURRENT focal — not the path the host knew about at mount time, which
 * goes stale the moment the user pin-jumps to another file).
 */
export interface BlockViewerHeaderState {
  /** Currently displayed file path. Tracks pin navigation. Null only
   *  in the empty state (before any file is selected). */
  focalFile: string | null;
  /** Top-level block count for the focal file. 0 in the empty state. */
  blockCount: number;
  upstreamCount: number;
  downstreamCount: number;
}

type HeaderSlot = (state: BlockViewerHeaderState) => React.ReactNode;

interface HeaderProps {
  focalFile: string | null;
  fileCount: number | null;
  functionCount?: number;
  upstreamCount?: number;
  downstreamCount?: number;
  /** When omitted the "Code" toggle button is hidden — useful for
   *  hosts that don't have a sibling "code mode" to flip to (e.g. the
   *  diff wrapper `BlockDiffViewer`, which lives inside its own
   *  file/block toolbar). */
  onSwitchToCode?: () => void;
  onSearch: () => void;
  onRefresh: () => void;
  refreshDisabled?: boolean;
  /** Host-injected content rendered at the END of the left half (after
   *  focal path + stats). Render-prop so the host can react to focal
   *  changes that happen INSIDE BlockViewer (pin navigation). */
  extraLeft?: HeaderSlot;
  /** Host-injected content rendered at the START of the right half
   *  (before search / refresh / code toggle). */
  extraRight?: HeaderSlot;
}

function Header({
  focalFile,
  fileCount,
  functionCount,
  upstreamCount,
  downstreamCount,
  onSwitchToCode,
  onSearch,
  onRefresh,
  refreshDisabled,
  extraLeft,
  extraRight,
}: HeaderProps) {
  const { t } = useTranslation();
  // Snapshot the state passed to slots — keeps the render-prop signature
  // stable and means slot authors can rely on every field being defined
  // even when the focal file is empty (focalFile is just null in that case).
  const slotState: BlockViewerHeaderState = {
    focalFile,
    blockCount: functionCount ?? 0,
    upstreamCount: upstreamCount ?? 0,
    downstreamCount: downstreamCount ?? 0,
  };
  return (
    <div className="flex-shrink-0 px-3 py-2 border-b border-border flex items-center justify-between bg-secondary/30 gap-2">
      <div className="flex items-center gap-2 min-w-0 text-xs text-muted-foreground font-mono">
        <span className="truncate min-w-0">
          {focalFile ? (
            <>
              <span className="text-foreground">{focalFile}</span>
              {typeof functionCount === 'number' && (
                <span className="ml-2">· {functionCount} blocks</span>
              )}
              {typeof upstreamCount === 'number' && typeof downstreamCount === 'number' && (
                <span className="ml-2">
                  · {upstreamCount} in · {downstreamCount} out
                </span>
              )}
            </>
          ) : (
            <span>{fileCount !== null ? `${fileCount} files` : '…'}</span>
          )}
        </span>
        {extraLeft && (
          <span className="flex items-center gap-1 flex-shrink-0">
            {extraLeft(slotState)}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {extraRight && (
          <span className="flex items-center gap-1">{extraRight(slotState)}</span>
        )}
        <button
          onClick={onSearch}
          className="text-xs px-2 py-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground flex items-center gap-1"
          data-tooltip={t('blockViewer.search.tooltip', 'Search (⌘K)')}
        >
          <Search className="w-3 h-3" /> ⌘K
        </button>
        <button
          onClick={onRefresh}
          disabled={refreshDisabled}
          className="text-xs px-2 py-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent"
          data-tooltip={t('blockViewer.refresh', 'Rebuild project graph')}
        >
          <RefreshCw className="w-3 h-3" />
        </button>
        {onSwitchToCode && (
          <button
            onClick={onSwitchToCode}
            className="text-xs px-2 py-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
          >
            Code
          </button>
        )}
      </div>
    </div>
  );
}
