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
 * Layout: own column on the LEFT of the chip canvas (sister of the
 * `FunctionHistoryDrawer` on the right). Tried stacking TOC + History
 * on the right first; the split-attention between two top-and-bottom
 * lists felt worse than a balanced two-column rail (left = file
 * structure, right = navigation trail). The chip canvas gets squeezed
 * a bit; that's the accepted tradeoff.
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
}

export function FileTOCSection({
  functions,
  currentQname,
  onSelect,
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
      className="w-56 flex-shrink-0 bg-card border-r border-border flex flex-col"
      data-testid="file-toc-section"
    >
      <div className="flex-shrink-0 px-2 py-1.5 border-b border-border text-xs text-muted-foreground font-mono truncate">
        {realFunctions.length === 0
          ? t('blockViewer.toc.title')
          : `${t('blockViewer.toc.title')} · ${realFunctions.length}`}
      </div>
      <div className="flex-1 overflow-y-auto">
        {realFunctions.length === 0 ? (
          <div className="px-3 py-4 text-[10px] text-muted-foreground/60 italic leading-relaxed">
            {t('blockViewer.toc.empty')}
          </div>
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
