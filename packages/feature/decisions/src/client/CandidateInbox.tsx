'use client';

/**
 * Candidate inbox (docs/DECISION_MODE.md §7): every candidate decision the
 * project's extractions produced, kept or dismissed one by one — without
 * accepting a whole review. Kept ones become decisions; both disappear.
 */
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { toast } from '@cockpit/shared-ui';
import type { DecisionSource } from '../shared/types';
import { dismissCandidate, keepCandidate, type InboxCandidate } from './effect/decisionsClient';

const SOURCE_DEFAULT: Record<DecisionSource['kind'], string> = {
  user: 'User chose',
  agent: 'Agent decided',
  inferred: 'Inferred (no verbatim quote)',
  manual: 'Added by you',
};
const SOURCE_STYLE: Record<DecisionSource['kind'], string> = {
  user: 'text-green-11',
  agent: 'text-brand',
  inferred: 'text-amber-11',
  manual: 'text-muted-foreground',
};

const CandidateRow = memo(function CandidateRow({
  cwd,
  c,
  onHandled,
}: {
  cwd: string;
  c: InboxCandidate;
  onHandled: (key: string, kept: boolean) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState(c.content.choice);
  const [rationale, setRationale] = useState(c.content.rationale);
  const [busy, setBusy] = useState(false);

  const act = useCallback(
    async (keep: boolean) => {
      setBusy(true);
      const edited = editing ? { ...c.content, choice: choice.trim(), rationale: rationale.trim() } : undefined;
      const exit = keep
        ? await BrowserRuntime.runPromiseExit(keepCandidate(cwd, c.key, edited))
        : await BrowserRuntime.runPromiseExit(dismissCandidate(cwd, c.key));
      setBusy(false);
      if (exit._tag !== 'Success') {
        toast(t('decisions.card.failed', { defaultValue: 'Could not save' }), 'error');
        return;
      }
      onHandled(c.key, keep);
    },
    [cwd, c, editing, choice, rationale, onHandled, t],
  );

  const btn = 'rounded border border-border px-2 py-0.5 text-foreground hover:bg-hover disabled:opacity-50';
  return (
    <div className="rounded border border-border p-2 text-xs" data-candidate-key={c.key}>
      <div className="flex items-start gap-2">
        {editing ? (
          <input value={choice} onChange={(e) => setChoice(e.target.value)} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-0.5 text-foreground" />
        ) : (
          <span className="font-medium text-foreground">{c.content.choice}</span>
        )}
        <span className={`ml-auto shrink-0 ${SOURCE_STYLE[c.source.kind]}`}>
          {t(`decisions.review.source.${c.source.kind}`, { defaultValue: SOURCE_DEFAULT[c.source.kind] })}
        </span>
      </div>
      {c.content.alternatives.length > 0 && (
        <div className="text-muted-foreground">{t('decisions.review.instead', { defaultValue: 'Instead of:' })} {c.content.alternatives.join('; ')}</div>
      )}
      {editing ? (
        <input value={rationale} onChange={(e) => setRationale(e.target.value)} className="mt-1 w-full rounded border border-border bg-background px-2 py-0.5 text-foreground"
          placeholder={t('decisions.review.rationalePlaceholder', { defaultValue: 'Why (optional)' })} />
      ) : (
        c.content.rationale && <div className="text-foreground">{c.content.rationale}</div>
      )}
      {c.content.tradeoffs && <div className="text-muted-foreground">{t('decisions.review.cost', { defaultValue: 'Cost:' })} {c.content.tradeoffs}</div>}
      {c.content.premises.length > 0 && (
        <div className="text-muted-foreground">{t('decisions.review.premises', { defaultValue: 'Holds while:' })} {c.content.premises.join('; ')}</div>
      )}
      {c.source.quote && <blockquote className="mt-1 border-l-2 border-border pl-2 text-foreground-subtle">{c.source.quote}</blockquote>}
      <div className="mt-0.5 text-foreground-subtle">
        {new Date(c.seenAt).toLocaleString()}
        {c.files.length > 0 && ` · ${c.files.join(', ')}`}
      </div>
      <div className="mt-1 flex gap-1">
        <button className={`${btn} border-brand`} disabled={busy || (editing && !choice.trim())} onClick={() => void act(true)}>
          {t('decisions.inbox.keep', { defaultValue: 'Keep' })}
        </button>
        <button className={btn} disabled={busy} onClick={() => void act(false)}>
          {t('decisions.inbox.dismiss', { defaultValue: 'Dismiss' })}
        </button>
        {!editing && (
          <button className={btn} disabled={busy} onClick={() => setEditing(true)}>
            {t('decisions.inbox.editFirst', { defaultValue: 'Edit, then keep' })}
          </button>
        )}
      </div>
    </div>
  );
});

export function CandidateInbox({
  cwd,
  candidates,
  onHandled,
}: {
  cwd: string;
  candidates: InboxCandidate[];
  onHandled: (key: string, kept: boolean) => void;
}) {
  const { t } = useTranslation();
  if (candidates.length === 0) {
    return <div className="text-xs text-muted-foreground">{t('decisions.inbox.empty', { defaultValue: 'No candidates waiting. They appear here whenever a review generates them.' })}</div>;
  }
  return (
    <>
      <div className="text-xs text-muted-foreground">
        {t('decisions.inbox.hint', { defaultValue: 'Candidate decisions found in past conversations. Keep the ones worth remembering; dismissed ones do not come back.' })}
      </div>
      {candidates.map((c) => (
        <CandidateRow key={c.key} cwd={cwd} c={c} onHandled={onHandled} />
      ))}
    </>
  );
}
