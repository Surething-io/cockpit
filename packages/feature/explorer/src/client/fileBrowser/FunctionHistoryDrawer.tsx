'use client';

/**
 * FunctionHistoryDrawer — the second tab panel of the Code Map's left
 * rail, tracking the functions the user has hopped through via
 * input/output pins. Sibling of `FileTOCSection`: TOC = "what's in this
 * file", History = "where I've been across files".
 *
 * Layout: the rail's `w-56`, right border and tab bar live on the
 * wrapper in `BlockViewer`; the selected panel claims the full column.
 * The two used to share the rail 50/50, which pinned history to the
 * bottom half whether or not anything was in it. This column used to
 * sit on the RIGHT of the chip canvas; moving it here gives the canvas
 * back 224px, which it needs far more than a text list does.
 *
 * Not auto-selected when a pin jump appends an entry — see the tab
 * state in `BlockViewer`.
 *
 * Why a trail and not a code preview: the BlockViewer already shows
 * every function's source inline, so a separate drawer displaying the
 * same code was redundant. What's actually useful in a cross-file
 * architecture review is a *trail of where I've been* — keeps the
 * navigation flow ("call sites I'm tracing") visible without making
 * the user remember it. Keep it small and text-only; the heavy code
 * rendering happens on the canvas.
 *
 * Capacity: 15 (FIFO with promote-on-revisit). Capacity logic lives
 * in the BlockViewer state owner — this component is purely
 * presentational.
 */

import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import type { SymbolKind } from '@cockpit/feature-explorer/server/codeMap/types';
import { Tooltip } from '@cockpit/shared-ui';
import { SymbolIcon } from './symbolIcon';

export interface HistoryEntry {
  /** Project-relative path of the file the function lives in. */
  filePath: string;
  /** Symbol qualifiedName — stable id across snapshots. */
  qname: string;
  /** Display label (the bare symbol name). */
  name: string;
  /** Optional kind tag — "function" / "method" / etc. Drives icon. */
  kind?: SymbolKind;
}

interface FunctionHistoryDrawerProps {
  entries: HistoryEntry[];
  onSelect: (entry: HistoryEntry) => void;
  onClear: () => void;
}

/**
 * Lazy basename — drawer entries display the file's last path segment
 * to keep them compact. Full path is in the tooltip via `title`.
 */
function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

export function FunctionHistoryDrawer({
  entries,
  onSelect,
  onClear,
}: FunctionHistoryDrawerProps) {
  const { t } = useTranslation();
  return (
    <div
      className="flex-1 min-h-0 bg-card flex flex-col"
      data-testid="function-history-drawer"
    >
      <div className="flex-shrink-0 px-2 py-1.5 border-b border-border flex items-center justify-between gap-1">
        <div className="flex items-center text-xs text-muted-foreground font-mono min-w-0">
          <span className="truncate">
            {entries.length === 0
              ? t('blockViewer.history.title')
              : `${t('blockViewer.history.title')} · ${entries.length}/15`}
          </span>
        </div>
        {entries.length > 0 && (
          <Tooltip content={t('blockViewer.history.clear')}>
            <button
              onClick={onClear}
              className="flex-shrink-0 text-muted-foreground hover:text-foreground p-0.5 rounded hover:bg-secondary"
            >
              <X className="w-3 h-3" />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="px-3 py-4 text-[10px] text-muted-foreground/60 italic leading-relaxed">
            {t('blockViewer.history.empty')}
          </div>
        ) : (
          entries.map((entry, i) => (
            <Tooltip
              key={`${entry.filePath}::${entry.qname}::${i}`}
              content={`${entry.qname} · ${entry.filePath}`}
            >
              <button
                onClick={() => onSelect(entry)}
                className="w-full text-left px-2 py-1.5 border-b border-border/50 hover:transition-colors group flex items-start gap-1.5"
              >
                <SymbolIcon
                  kind={entry.kind ?? 'unknown'}
                  qname={entry.qname}
                  className="w-3 h-3 mt-0.5 flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-mono font-medium truncate">
                    {entry.name}
                  </div>
                  <div className="text-[10px] text-muted-foreground/70 truncate">
                    {basename(entry.filePath)}
                    {entry.kind && (
                      <span className="ml-1 opacity-60">· {entry.kind}</span>
                    )}
                  </div>
                </div>
              </button>
            </Tooltip>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Pure helper: insert (or promote) `entry` at the head of `entries`,
 * deduplicating by (filePath, qname). Caps at `MAX` to prevent
 * unbounded growth.
 *
 * Exported so the parent component (BlockViewer) can manage history
 * state without having to import the whole drawer module's types.
 */
export const HISTORY_MAX = 15;

export function pushHistoryEntry(
  entries: readonly HistoryEntry[],
  next: HistoryEntry,
): HistoryEntry[] {
  const filtered = entries.filter(
    (e) => !(e.filePath === next.filePath && e.qname === next.qname),
  );
  const out = [next, ...filtered];
  return out.length > HISTORY_MAX ? out.slice(0, HISTORY_MAX) : out;
}
