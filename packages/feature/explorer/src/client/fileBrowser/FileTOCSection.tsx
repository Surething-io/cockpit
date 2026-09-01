'use client';

/**
 * FileTOCSection — narrow left-side column of the Code Map that lists
 * every function in the focal file in source order.
 *
 * "Table of contents" for the focal file: click any row to flash +
 * scroll-into-view. The function whose lines straddle the viewport
 * center renders highlighted ("you are here"), doubling as a passive
 * scroll indicator.
 *
 * Why this exists: when you first open an unfamiliar file, the chip
 * scroll-canvas IS the function list, but it can be 50 chips long.
 * Cmd+K is a typed search, not a scan. The TOC is the "scan" surface
 * — orientation in one glance, no typing.
 *
 * Layout: one of the two tab panels in the `w-56` left rail (the other
 * is `FunctionHistoryDrawer`), claiming the full column height when
 * selected. The rail's width, right border and tab bar live on the
 * wrapper in `BlockViewer`; this component owns its own header + list.
 * The inactive panel is hidden, not unmounted, so scroll position
 * survives a switch.
 *
 * The two used to be stacked 50/50, which left half the rail empty on a
 * file with three functions.
 *
 * History used to be a mirror column on the RIGHT of the canvas. It
 * was moved here to give the chip canvas back those 224px — the
 * canvas is the surface that actually needs width (code bodies +
 * caller/callee pin columns), while both rails are short text lists.
 *
 * Data is free — `data.functions` from `useFileFunctions` already has
 * every function with name / qualifiedName / startLine / endLine /
 * kind / params; no extra fetch.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { FunctionNode } from '@cockpit/feature-explorer/server/codeMap/projectGraph/types';
import { isFunctionLike } from '@cockpit/feature-explorer/server/codeMap/types';
import { Tooltip } from '@cockpit/shared-ui';
import { SymbolIcon } from './symbolIcon';

/**
 * Per-function edge tally shown under the name. Same vocabulary as the
 * canvas pins so the two surfaces read as one system:
 *   - `in`  / `out` : CROSS-FILE callers / callees. Same measure as the
 *                     viewer header's `· 3 in · 3 out`, so the numbers on
 *                     screen agree with each other.
 *   - `self`        : same-file edges, incoming and outgoing merged — the
 *                     rail is too narrow to split them and "this function
 *                     is wired into its own file" is the signal that matters.
 * `ext` / `method` pins are deliberately absent: a helper that calls three
 * npm functions is not a hub, and counting them would say it is.
 */
export interface TocEdgeCounts {
  in: number;
  out: number;
  self: number;
}

interface FileTOCSectionProps {
  /** Every function in the focal file, source order (sorted by startLine). */
  functions: readonly FunctionNode[];
  /** Per-qualifiedName edge tally, keyed exactly like `functions`. Rows
   *  with no entry (or an all-zero one) render as a single line. */
  counts?: ReadonlyMap<string, TocEdgeCounts>;
  /** Line count of the whole focal file, for the header's `· 311 lines`
   *  suffix. `null` while the source blob is still loading. */
  totalLines?: number | null;
  /** qualifiedName of the function whose lines straddle the viewport
   *  center, or `null` if no function is currently in view. Drives the
   *  "you are here" highlight. */
  currentQname: string | null;
  /** Click handler — receives qname + startLine, expected to flash +
   *  scroll-into-view via the same mechanism as the diff minimap. */
  onSelect: (qname: string, line: number) => void;
  /** When true, the empty state renders the "file not indexed" branch
   *  (with a rebuild affordance) instead of the generic
   *  "no functions detected" message. Set by the server when fallback
   *  was hit because addFocalFile rejected the path (unsupported
   *  language / not in project fileset / MAX_FILES reached / parse fail).
   *  See `FileFunctionsResponse.notIndexed`. */
  notIndexed?: boolean;
  /** Click handler for the "Rebuild project graph" button shown in the
   *  notIndexed empty state. Typically wired to `useFileFunctions.refresh`
   *  which triggers a forceRefresh full rebuild. Required when
   *  `notIndexed` is true. */
  onRebuild?: () => void;
}

export function FileTOCSection({
  functions,
  counts,
  totalLines,
  currentQname,
  onSelect,
  notIndexed,
  onRebuild,
}: FileTOCSectionProps) {
  const { t } = useTranslation();
  // Filter to call-graph nodes only — same `FUNCTION_LIKE_KINDS` set
  // (`function | class | method`) used by `codeIndex.ts` for cross-
  // file edge resolution. This excludes:
  //
  //   - Synthetic chunks (`__imports__`, `__code_*__`, `__file__`,
  //     `__heading_*__`, `__preamble__`) — kind: 'unknown', no
  //     runtime semantics.
  //   - Compile-time-only symbols (`interface | type | enum | const`)
  //     — they CAN render as chips on the canvas (no caller/callee
  //     pins), but listing them in the TOC dilutes "things you can
  //     trace through the call graph". The chip canvas still shows
  //     them; users who want to read a type definition can scroll.
  //
  // The chip canvas is intentionally MORE inclusive than the TOC:
  // canvas = "everything in the file"; TOC = "navigable call-graph
  // nodes". Two different jobs.
  const realFunctions = useMemo(
    () => functions.filter(isFunctionLike),
    [functions],
  );
  return (
    <div
      className="flex-1 min-h-0 bg-card flex flex-col"
      data-testid="file-toc-section"
    >
      <div className="flex-shrink-0 px-2 py-1.5 border-b border-border text-xs text-muted-foreground font-mono truncate">
        {t('blockViewer.toc.title')}
        {realFunctions.length > 0 && ` · ${realFunctions.length}`}
        {totalLines != null && ` · ${totalLines} ${t('common.lines')}`}
      </div>
      <div className="flex-1 overflow-y-auto">
        {realFunctions.length === 0 ? (
          notIndexed ? (
            <div className="px-3 py-4 text-[10px] text-muted-foreground/80 leading-relaxed flex flex-col gap-2">
              <span className="italic">{t('blockViewer.toc.notIndexed')}</span>
              {onRebuild && (
                <button
                  type="button"
                  onClick={onRebuild}
                  className="self-start px-2 py-1 rounded border border-border bg-secondary/60 hover:bg-secondary text-[10px] text-foreground transition-colors"
                >
                  {t('blockViewer.refresh')}
                </button>
              )}
            </div>
          ) : (
            <div className="px-3 py-4 text-[10px] text-muted-foreground/60 italic leading-relaxed">
              {t('blockViewer.toc.empty')}
            </div>
          )
        ) : (
          realFunctions.map((fn) => {
            const isCurrent = currentQname === fn.qualifiedName;
            const c = counts?.get(fn.qualifiedName);
            // Zero segments are dropped, not rendered as `0` — in a 26-row
            // list most functions are leaves, and a column of zeroes is
            // noise that pushes the real numbers out of view.
            const parts = c
              ? ([
                  c.in > 0 && ['in', c.in, 'text-amber-11/80'],
                  c.out > 0 && ['out', c.out, 'text-green-11/80'],
                  c.self > 0 && ['self', c.self, 'text-muted-foreground/60'],
                ].filter(Boolean) as [string, number, string][])
              : [];
            return (
              <Tooltip
                key={fn.qualifiedName}
                content={`${fn.qualifiedName} · L${fn.startLine}`}
              >
                <button
                  onClick={() => onSelect(fn.qualifiedName, fn.startLine)}
                  className={`w-full text-left px-2 py-1 transition-colors flex items-start gap-1.5 min-w-0 ${
                    isCurrent
                      ? 'bg-brand/15 hover:bg-brand/20'
                      : 'hover:bg-secondary/60'
                  }`}
                >
                  <SymbolIcon
                    kind={fn.kind}
                    qname={fn.qualifiedName}
                    className="w-3 h-3 flex-shrink-0 mt-0.5"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`flex-1 min-w-0 text-xs font-mono truncate ${
                          isCurrent ? 'font-semibold text-brand' : ''
                        }`}
                      >
                        {fn.name}
                      </span>
                      {/* Line COUNT, not the range: one number costs ~2 chars
                          of name width instead of ~7, and "how big is this
                          thing" is the question a file index answers — the
                          exact position is what clicking the row is for.
                          Tooltip carries the start line for anyone who
                          wants it. */}
                      <span className="flex-shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
                        {fn.endLine - fn.startLine + 1}
                      </span>
                    </span>
                    {parts.length > 0 && (
                      <span className="block text-[10px] font-mono truncate">
                        {parts.map(([label, n, color], i) => (
                          <span key={label} className={color}>
                            {i > 0 && (
                              <span className="text-muted-foreground/30"> · </span>
                            )}
                            {label} {n}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </button>
              </Tooltip>
            );
          })
        )}
      </div>
    </div>
  );
}
