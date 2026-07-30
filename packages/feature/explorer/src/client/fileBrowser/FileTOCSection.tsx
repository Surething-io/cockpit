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
 * Layout: TOP half of the single `w-56` left rail, stacked above
 * `FunctionHistoryDrawer` (each `flex-1 min-h-0` → a fixed 50/50
 * split, independent scrollers). The rail's width + right border live
 * on the wrapper in `BlockViewer`; this component only owns its own
 * half. Both halves render unconditionally so the split never jumps
 * as files swap or history empties.
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

interface FileTOCSectionProps {
  /** Every function in the focal file, source order (sorted by startLine). */
  functions: readonly FunctionNode[];
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
        {realFunctions.length === 0
          ? t('blockViewer.toc.title')
          : `${t('blockViewer.toc.title')} · ${realFunctions.length}`}
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
            return (
              <Tooltip
                key={fn.qualifiedName}
                content={`${fn.qualifiedName} · L${fn.startLine}`}
              >
                <button
                  onClick={() => onSelect(fn.qualifiedName, fn.startLine)}
                  className={`w-full text-left px-2 py-1 transition-colors flex items-center gap-1.5 min-w-0 ${
                    isCurrent
                      ? 'bg-brand/15 hover:bg-brand/20'
                      : 'hover:bg-secondary/60'
                  }`}
                >
                  <SymbolIcon
                    kind={fn.kind}
                    qname={fn.qualifiedName}
                    className="w-3 h-3 flex-shrink-0"
                  />
                  <span
                    className={`text-xs font-mono truncate ${
                      isCurrent ? 'font-semibold text-brand' : ''
                    }`}
                  >
                    {fn.name}
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
