'use client';

/**
 * Project decision list (docs/DECISION_MODE.md §8.2): every decision of the
 * project with its derived state, filters, the supersede chain, revision
 * history, and export. Full-window Portal like the comments list.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, X } from 'lucide-react';
import { Effect } from 'effect';
import { useEffectQuery } from '@cockpit/effect-react';
import { Portal, blurActiveElement } from '@cockpit/shared-ui';
import type { Decision, DecisionContent, DecisionEvent, DerivedDecisionState } from '../shared/types';
import { decisionsExportUrl, loadCandidates, loadDecisionHistory, loadDecisionsWithState } from './effect/decisionsClient';
import { CandidateInbox } from './CandidateInbox';
import { DecisionCard } from './DecisionCard';

type StateFilter = 'current' | 'all' | DerivedDecisionState;
const CURRENT = new Set<DerivedDecisionState>(['applicable', 'not-landed', 'link-lost']);

/** Revisions as "field: before → after", replayed from the event log. */
export function revisionLines(events: DecisionEvent[]): Array<{ at: number; lines: string[] }> {
  const out: Array<{ at: number; lines: string[] }> = [];
  let cur: Partial<DecisionContent> = {};
  for (const ev of events) {
    if (ev.type === 'created') cur = { ...ev.content };
    else if (ev.type === 'edited' && ev.content) {
      const lines = Object.entries(ev.content).map(([k, v]) => {
        const before = (cur as Record<string, unknown>)[k];
        const fmt = (x: unknown) => (Array.isArray(x) ? x.join('; ') : String(x ?? ''));
        return `${k}: ${fmt(before) || '∅'} → ${fmt(v) || '∅'}`;
      });
      cur = { ...cur, ...ev.content };
      out.push({ at: ev.at, lines });
    }
  }
  return out;
}

export const DecisionListModal = memo(function DecisionListModal({
  cwd,
  onClose,
  onFillInput,
}: {
  cwd: string;
  onClose: () => void;
  onFillInput?: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [tick, setTick] = useState(0);
  const q = useEffectQuery(loadDecisionsWithState(cwd), [cwd, tick]);
  const data = q.status === 'success' ? q.data : null;
  const [stateFilter, setStateFilter] = useState<StateFilter>('current');
  // Candidate inbox: handled keys are dropped locally so the list does not re-fetch per click.
  const inboxQ = useEffectQuery(loadCandidates(cwd), [cwd]);
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const pending = useMemo(
    () => (inboxQ.status === 'success' ? inboxQ.data.candidates.filter((c) => !handled.has(c.key)) : []),
    [inboxQ, handled],
  );
  const [tab, setTab] = useState<'pending' | 'kept' | null>(null);
  // Open on the inbox when there is something waiting, else on the decisions.
  const activeTab = tab ?? (pending.length > 0 ? 'pending' : 'kept');
  const onCandidateHandled = useCallback((key: string, kept: boolean) => {
    setHandled((s) => new Set(s).add(key));
    if (kept) setTick((n) => n + 1);
  }, []);
  const [keyword, setKeyword] = useState('');
  const [file, setFile] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const historyQ = useEffectQuery(historyId ? loadDecisionHistory(cwd, historyId) : Effect.succeed(null), [cwd, historyId, tick]);
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const fill = useCallback(
    (text: string) => {
      onFillInput?.(text);
      onClose();
    },
    [onFillInput, onClose],
  );

  const shown = useMemo(() => {
    if (!data) return [];
    const kw = keyword.trim().toLowerCase();
    const fl = file.trim().toLowerCase();
    return data.decisions.filter((d: Decision) => {
      if (focusId) return d.id === focusId;
      const st = data.states[d.id];
      if (stateFilter === 'current' ? !CURRENT.has(st) : stateFilter !== 'all' && st !== stateFilter) return false;
      if (kw && ![d.choice, d.rationale, d.tradeoffs, ...d.premises, ...d.alternatives].join(' ').toLowerCase().includes(kw)) return false;
      if (fl && !d.links.some((l) => l.path.toLowerCase().includes(fl))) return false;
      return true;
    });
  }, [data, keyword, file, stateFilter, focusId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      blurActiveElement();
      if (historyId) setHistoryId(null);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, historyId]);

  const history = historyQ.status === 'success' && historyQ.data ? revisionLines(historyQ.data.events) : [];
  const STATES: StateFilter[] = ['current', 'all', 'applicable', 'not-landed', 'other-branch', 'link-lost', 'superseded', 'retired'];
  const stateDefault: Record<StateFilter, string> = {
    current: 'Current', all: 'All', applicable: 'Applies here', 'not-landed': 'Not committed yet', 'other-branch': 'On another branch',
    'link-lost': 'Link lost', superseded: 'Superseded', retired: 'Retired',
  };

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim" onClick={onClose}>
        <div className="flex h-[85vh] w-[90vw] max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lv2" onClick={(e) => e.stopPropagation()} role="dialog">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-sm">
            <h3 className="font-medium text-foreground">{t('decisions.list.title', { defaultValue: 'Project decisions' })}</h3>
            <span className="text-foreground-subtle">{data ? data.decisions.length : ''}</span>
            <a href={decisionsExportUrl(cwd)} download className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-hover hover:text-foreground">
              <Download className="h-3.5 w-3.5" />
              {t('decisions.list.export', { defaultValue: 'Export' })}
            </a>
            <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-hover hover:text-foreground" aria-label={t('common.close', { defaultValue: 'Close' })}>
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center gap-1 border-b border-border px-4 pt-2 text-xs">
            {(['pending', 'kept'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`rounded-t px-3 py-1 ${activeTab === k ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-hover'}`}
              >
                {k === 'pending'
                  ? t('decisions.inbox.tab', { defaultValue: 'Waiting {{count}}', count: pending.length })
                  : t('decisions.inbox.keptTab', { defaultValue: 'Kept {{count}}', count: data?.decisions.length ?? 0 })}
              </button>
            ))}
          </div>
          {activeTab === 'pending' ? (
            <div className="flex-1 space-y-2 overflow-y-auto p-3">
              {inboxQ.status === 'loading' && <div className="text-xs text-muted-foreground">{t('common.loading', { defaultValue: 'Loading…' })}</div>}
              {inboxQ.status === 'error' && <div className="text-xs text-red-11">{t('decisions.list.loadFailed', { defaultValue: 'Could not load decisions' })}</div>}
              {inboxQ.status === 'success' && <CandidateInbox cwd={cwd} candidates={pending} onHandled={onCandidateHandled} />}
            </div>
          ) : (
          <>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
            <select value={stateFilter} onChange={(e) => { setFocusId(null); setStateFilter(e.target.value as StateFilter); }} className="rounded border border-border bg-background px-1 py-0.5 text-foreground">
              {STATES.map((s) => (
                <option key={s} value={s}>{t(`decisions.list.filter.${s}`, { defaultValue: stateDefault[s] })}</option>
              ))}
            </select>
            <input value={keyword} onChange={(e) => { setFocusId(null); setKeyword(e.target.value); }} placeholder={t('decisions.list.keyword', { defaultValue: 'Search text' })} className="w-48 rounded border border-border bg-background px-2 py-0.5 text-foreground" />
            <input value={file} onChange={(e) => { setFocusId(null); setFile(e.target.value); }} placeholder={t('decisions.list.file', { defaultValue: 'File or folder' })} className="w-48 rounded border border-border bg-background px-2 py-0.5 text-foreground" />
            {focusId && (
              <button onClick={() => setFocusId(null)} className="rounded border border-border px-2 py-0.5 text-foreground hover:bg-hover">
                {t('decisions.list.showAll', { defaultValue: 'Back to the list' })}
              </button>
            )}
          </div>
          <div className="flex min-h-0 flex-1">
            <div ref={listRef} className="flex-1 space-y-2 overflow-y-auto p-3">
              {q.status === 'loading' && <div className="text-xs text-muted-foreground">{t('common.loading', { defaultValue: 'Loading…' })}</div>}
              {q.status === 'error' && <div className="text-xs text-red-11">{t('decisions.list.loadFailed', { defaultValue: 'Could not load decisions' })}</div>}
              {data && shown.length === 0 && <div className="text-xs text-muted-foreground">{t('decisions.list.empty', { defaultValue: 'No decisions match.' })}</div>}
              {shown.map((d) => (
                <DecisionCard
                  key={`${d.id}:${d.updatedAt}`}
                  cwd={cwd}
                  decision={d}
                  state={data?.states[d.id]}
                  onChanged={refresh}
                  onFillInput={onFillInput ? fill : undefined}
                  onShowHistory={setHistoryId}
                  onOpenDecision={setFocusId}
                />
              ))}
            </div>
            {historyId && (
              <div className="w-80 shrink-0 overflow-y-auto border-l border-border p-3 text-xs">
                <div className="mb-2 flex items-center">
                  <span className="font-medium text-foreground">{t('decisions.list.history', { defaultValue: 'Revisions' })}</span>
                  <button onClick={() => setHistoryId(null)} className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-hover"><X className="h-3 w-3" /></button>
                </div>
                {history.map((h, i) => (
                  <div key={i} className="mb-2">
                    <div className="text-foreground-subtle">{new Date(h.at).toLocaleString()}</div>
                    {h.lines.map((l, j) => <div key={j} className="break-words text-foreground">{l}</div>)}
                  </div>
                ))}
              </div>
            )}
          </div>
          </>
          )}
        </div>
      </div>
    </Portal>
  );
});
