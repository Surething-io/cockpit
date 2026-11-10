'use client';

/**
 * Decision context for the next message (docs/DECISION_MODE.md §7.2): which
 * existing decisions will be attached, visible BEFORE sending and removable
 * one by one. Desktop chat only — the mobile composer never injects.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Scale, X } from 'lucide-react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadRelevantDecisions, useDecisionMode, type RelevantDecision } from '@cockpit/feature-decisions';
import type { ChatMessage } from '../types';
import { injectedKeys, type DecisionContextItem } from '../../shared/decisionContext';

/** Recent turns whose edited files count as "changed in this range". */
const RECENT_TURNS = 20;
const DEBOUNCE_MS = 400;

function recentEditedFiles(messages: readonly ChatMessage[]): string[] {
  const files = new Set<string>();
  let turns = 0;
  for (let i = messages.length - 1; i >= 0 && turns < RECENT_TURNS; i--) {
    const m = messages[i];
    if (m.role === 'user') turns++;
    for (const tc of m.toolCalls ?? []) {
      const p = tc.input.file_path ?? tc.input.notebook_path ?? tc.input.path;
      if (typeof p === 'string' && p) files.add(p);
    }
  }
  return [...files];
}

/**
 * Debounced relevance lookup for the draft. Returns a ref-stable getter so
 * the send path never re-renders on keystrokes.
 */
export function useDecisionContext(cwd: string | undefined, draft: string, messages: readonly ChatMessage[]) {
  const { enabled } = useDecisionMode(cwd);
  const [found, setFound] = useState<RelevantDecision[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    if (!enabled || !cwd || !draft.trim()) {
      setFound([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      const msgs = messagesRef.current;
      const exclude = [...injectedKeys(msgs.filter((m) => m.role === 'user').map((m) => m.content))];
      void BrowserRuntime.runPromiseExit(loadRelevantDecisions(cwd, draft, recentEditedFiles(msgs), exclude)).then((exit) => {
        if (!cancelled && exit._tag === 'Success') setFound(exit.value.decisions);
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [enabled, cwd, draft]);

  const shown = useMemo(() => found.filter((d) => !removed.has(d.id)), [found, removed]);
  const picks = useMemo<DecisionContextItem[]>(() => shown.map((d) => ({ id: d.id, rev: d.rev, choice: d.choice, premises: d.premises })), [shown]);
  const picksRef = useRef(picks);
  picksRef.current = picks;

  const remove = useCallback((id: string) => setRemoved((s) => new Set(s).add(id)), []);
  /** After a send: removals apply to one message only. */
  const reset = useCallback(() => {
    setRemoved(new Set());
    setFound([]);
  }, []);

  return {
    enabled,
    shown,
    remove,
    /** Read at send time; never a dependency of the send callback. */
    picksRef,
    reset,
  };
}

export const DecisionContextBar = memo(function DecisionContextBar({
  shown,
  onRemove,
}: {
  shown: RelevantDecision[];
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (shown.length === 0) return null;
  const reason = (r: RelevantDecision['reasons'][number]) =>
    t(`decisions.context.reason.${r}`, { defaultValue: { mentioned: 'file named', changed: 'file changed in this task', keywords: 'related words' }[r] });
  return (
    <div className="mx-3 mb-1 text-xs text-muted-foreground" data-testid="decision-context-bar">
      <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 rounded px-1 hover:bg-hover hover:text-foreground">
        <Scale className="h-3.5 w-3.5" />
        {t('decisions.context.willAttach', { defaultValue: '{{count}} related decisions will be attached', count: shown.length })}
      </button>
      {open && (
        <div className="mt-1 rounded border border-border bg-card">
          {shown.map((d) => (
            <div key={d.id} className="flex items-start gap-2 px-2 py-1">
              <div className="min-w-0 flex-1">
                <div className="text-foreground">{d.choice}</div>
                {d.premises.length > 0 && <div>{t('decisions.review.premises', { defaultValue: 'Holds while:' })} {d.premises.join('; ')}</div>}
                <div className="text-foreground-subtle">{d.reasons.map(reason).join(' · ')}</div>
              </div>
              <button
                onClick={() => onRemove(d.id)}
                className="shrink-0 rounded p-0.5 hover:bg-hover hover:text-foreground"
                aria-label={t('decisions.context.remove', { defaultValue: 'Do not attach' })}
                title={t('decisions.context.remove', { defaultValue: 'Do not attach' })}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
