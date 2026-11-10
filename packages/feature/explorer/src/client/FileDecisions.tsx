'use client';

/**
 * Decisions linked to the open file (docs/DECISION_MODE.md §8.1): a one-line
 * banner that expands into cards, plus the lines where linked symbols start
 * (gutter markers in CodeViewer). Only while decision mode is on for the
 * project; nothing on the file tree.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Scale } from 'lucide-react';
import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { useAIBridge } from '@cockpit/shared-ui';
import { DecisionCard, useDecisionMode, type Decision, type DerivedDecisionState } from '@cockpit/feature-decisions';

export interface FileDecision {
  decision: Decision;
  state: DerivedDecisionState;
  /** Current start lines of linked symbols in this file. */
  lines: number[];
}

const loadFileDecisions = (cwd: string, path: string): Effect.Effect<{ enabled: boolean; decisions: FileDecision[] }, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`/api/decisions/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { enabled: boolean; decisions: FileDecision[] };
    },
    catch: (cause) => new AppError({ message: 'GET /api/decisions/file failed', cause }),
  });

/** Decisions of `filePath`, re-read when decision mode flips or after a card changes one. */
export function useFileDecisions(cwd: string | undefined, filePath: string, active: boolean) {
  const { enabled } = useDecisionMode(active ? cwd : undefined);
  const [items, setItems] = useState<FileDecision[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active || !cwd || !enabled || !filePath) {
      setItems([]);
      return;
    }
    let cancelled = false;
    void BrowserRuntime.runPromiseExit(loadFileDecisions(cwd, filePath)).then((exit) => {
      if (!cancelled && exit._tag === 'Success') setItems(exit.value.decisions);
    });
    return () => {
      cancelled = true;
    };
  }, [active, cwd, enabled, filePath, tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { items, refresh };
}

export const FileDecisionsBanner = memo(function FileDecisionsBanner({
  cwd,
  items,
  onChanged,
  focusLine,
}: {
  cwd: string;
  items: FileDecision[];
  onChanged: () => void;
  /** A gutter marker was clicked: open and bring that line's decision into view. */
  focusLine: { line: number; tick: number } | null;
}) {
  const { t } = useTranslation();
  const aiBridge = useAIBridge();
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusLine) return;
    setOpen(true);
    const target = items.find((x) => x.lines.includes(focusLine.line));
    if (!target) return;
    requestAnimationFrame(() => {
      listRef.current?.querySelector(`[data-decision-id="${target.decision.id}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  }, [focusLine, items]);

  if (items.length === 0) return null;
  return (
    <div className="flex-shrink-0 border-b border-border bg-card text-xs" data-testid="file-decisions">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1 px-3 py-1 text-left text-muted-foreground hover:bg-hover hover:text-foreground">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Scale className="h-3.5 w-3.5" />
        {t('decisions.file.banner', { defaultValue: 'This file has {{count}} related decisions', count: items.length })}
      </button>
      {open && (
        <div ref={listRef} className="max-h-64 space-y-2 overflow-y-auto px-3 pb-2">
          {items.map((x) => (
            <DecisionCard key={`${x.decision.id}:${x.decision.updatedAt}`} cwd={cwd} decision={x.decision} state={x.state} onChanged={onChanged} onFillInput={aiBridge?.fillInput} compact />
          ))}
        </div>
      )}
    </div>
  );
});
