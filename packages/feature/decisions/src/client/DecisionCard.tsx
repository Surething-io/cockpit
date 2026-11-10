'use client';

/**
 * One decision with its actions (docs/DECISION_MODE.md §8). Used by the code
 * viewer's file banner and the project decision list.
 *
 * Nothing here rewrites history: an edit is a recorded revision, superseding
 * creates a linked replacement, retiring needs a reason and can be undone.
 */
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { toast } from '@cockpit/shared-ui';
import type { Decision, DecisionSource, DerivedDecisionState } from '../shared/types';
import { editDecisionContent, setDecisionLifecycle, supersedeDecision } from './effect/decisionsClient';

const STATE_DEFAULT: Record<DerivedDecisionState, string> = {
  applicable: 'Applies here',
  'other-branch': 'On another branch',
  'not-landed': 'Not committed yet',
  'link-lost': 'Link lost',
  superseded: 'Superseded',
  retired: 'Retired',
};
const STATE_STYLE: Record<DerivedDecisionState, string> = {
  applicable: 'text-green-11',
  'other-branch': 'text-muted-foreground',
  'not-landed': 'text-amber-11',
  'link-lost': 'text-red-11',
  superseded: 'text-muted-foreground',
  retired: 'text-muted-foreground',
};
const SOURCE_DEFAULT: Record<DecisionSource['kind'], string> = {
  user: 'User chose',
  agent: 'Agent decided',
  inferred: 'Inferred',
  manual: 'Added by hand',
};

/** The text "bring into chat" puts in the composer. */
export function decisionAsPrompt(d: Decision): string {
  const lines = [`Earlier decision: ${d.choice}`];
  if (d.rationale) lines.push(`Why: ${d.rationale}`);
  if (d.premises.length) lines.push(`Holds while: ${d.premises.join('; ')}`);
  if (d.links.length) lines.push(`About: ${d.links.map((l) => (l.symbol ? `${l.path} (${l.symbol})` : l.path)).join(', ')}`);
  return lines.join('\n');
}

type Mode = 'view' | 'edit' | 'supersede' | 'retire';

export const DecisionCard = memo(function DecisionCard({
  cwd,
  decision: d,
  state,
  onChanged,
  onFillInput,
  onShowHistory,
  onOpenDecision,
  compact = false,
}: {
  cwd: string;
  decision: Decision;
  state?: DerivedDecisionState;
  /** Called after any change, with the decision to show next (the replacement after a supersede). */
  onChanged: () => void;
  onFillInput?: (text: string) => void;
  onShowHistory?: (id: string) => void;
  /** Jump to a linked decision (supersede chain). */
  onOpenDecision?: (id: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('view');
  const [choice, setChoice] = useState(d.choice);
  const [rationale, setRationale] = useState(d.rationale);
  const [premises, setPremises] = useState(d.premises.join('\n'));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (effect: Parameters<typeof BrowserRuntime.runPromiseExit>[0]) => {
      setBusy(true);
      const exit = await BrowserRuntime.runPromiseExit(effect);
      setBusy(false);
      if (exit._tag !== 'Success') {
        toast(t('decisions.card.failed', { defaultValue: 'Could not save' }), 'error');
        return;
      }
      setMode('view');
      onChanged();
    },
    [onChanged, t],
  );
  const premiseList = () => premises.split('\n').map((p) => p.trim()).filter(Boolean);

  const live = d.status === 'active';
  const shownState = state ?? (d.status === 'active' ? undefined : d.status);
  const btn = 'rounded border border-border px-2 py-0.5 text-foreground hover:bg-hover disabled:opacity-50';
  const input = 'mb-1 w-full rounded border border-border bg-background px-2 py-1 text-foreground';

  return (
    <div className="rounded border border-border p-2 text-xs" data-decision-id={d.id}>
      <div className="flex items-start gap-2">
        <span className="font-medium text-foreground">{d.choice}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {d.revisions > 0 && (
            <button className="text-foreground-subtle underline-offset-2 hover:underline" onClick={() => onShowHistory?.(d.id)} disabled={!onShowHistory}>
              {t('decisions.card.edited', { defaultValue: 'edited' })}
            </button>
          )}
          {shownState && <span className={STATE_STYLE[shownState]}>{t(`decisions.card.state.${shownState}`, { defaultValue: STATE_DEFAULT[shownState] })}</span>}
        </span>
      </div>
      {!compact && d.alternatives.length > 0 && (
        <div className="text-muted-foreground">{t('decisions.review.instead', { defaultValue: 'Instead of:' })} {d.alternatives.join('; ')}</div>
      )}
      {d.rationale && <div className="text-foreground">{d.rationale}</div>}
      {!compact && d.tradeoffs && <div className="text-muted-foreground">{t('decisions.review.cost', { defaultValue: 'Cost:' })} {d.tradeoffs}</div>}
      {d.premises.length > 0 && <div className="text-muted-foreground">{t('decisions.review.premises', { defaultValue: 'Holds while:' })} {d.premises.join('; ')}</div>}
      <div className="mt-0.5 text-foreground-subtle">
        {t(`decisions.card.source.${d.source.kind}`, { defaultValue: SOURCE_DEFAULT[d.source.kind] })}
        {' · '}
        {new Date(d.createdAt).toLocaleDateString()}
        {d.lastReview && ` · ${t('decisions.card.lastReview', { defaultValue: 'last reviewed {{date}}: {{verdict}}', date: new Date(d.lastReview.at).toLocaleDateString(), verdict: d.lastReview.verdict })}`}
        {!compact && d.links.length > 0 && ` · ${d.links.map((l) => (l.symbol ? `${l.path}#${l.symbol}` : l.path)).join(', ')}`}
      </div>
      {d.source.quote && !compact && <blockquote className="mt-1 border-l-2 border-border pl-2 text-foreground-subtle">{d.source.quote}</blockquote>}
      {d.statusReason && <div className="mt-0.5 text-muted-foreground">{t('decisions.card.reason', { defaultValue: 'Reason:' })} {d.statusReason}</div>}
      {(d.supersedes || d.supersededBy) && onOpenDecision && (
        <div className="mt-0.5 flex gap-2">
          {d.supersedes && (
            <button className="text-brand hover:underline" onClick={() => onOpenDecision(d.supersedes!)}>
              {t('decisions.card.replaces', { defaultValue: '← replaces an earlier decision' })}
            </button>
          )}
          {d.supersededBy && (
            <button className="text-brand hover:underline" onClick={() => onOpenDecision(d.supersededBy!)}>
              {t('decisions.card.replacedBy', { defaultValue: 'replaced by → ' })}
            </button>
          )}
        </div>
      )}

      {mode === 'view' && (
        <div className="mt-1 flex flex-wrap gap-1">
          {onFillInput && live && (
            <button className={btn} onClick={() => onFillInput(decisionAsPrompt(d))}>
              {t('decisions.card.bringToChat', { defaultValue: 'Bring into chat' })}
            </button>
          )}
          {live && (
            <>
              {!compact && <button className={btn} onClick={() => setMode('edit')}>{t('decisions.card.edit', { defaultValue: 'Edit' })}</button>}
              <button className={btn} onClick={() => { setChoice(''); setRationale(''); setPremises(''); setMode('supersede'); }}>
                {t('decisions.review.verdictSuperseded', { defaultValue: 'Superseded' })}
              </button>
              <button className={btn} onClick={() => setMode('retire')}>{t('decisions.card.retire', { defaultValue: 'Retire' })}</button>
            </>
          )}
          {d.status === 'retired' && (
            <button className={btn} disabled={busy} onClick={() => void run(setDecisionLifecycle(cwd, d.id, 'active'))}>
              {t('decisions.card.reactivate', { defaultValue: 'Reactivate' })}
            </button>
          )}
        </div>
      )}

      {(mode === 'edit' || mode === 'supersede') && (
        <div className="mt-1">
          <input value={choice} onChange={(e) => setChoice(e.target.value)} className={input}
            placeholder={mode === 'supersede' ? t('decisions.review.replacementChoice', { defaultValue: 'What replaces it' }) : t('decisions.review.choicePlaceholder', { defaultValue: 'What was chosen' })} />
          <input value={rationale} onChange={(e) => setRationale(e.target.value)} className={input}
            placeholder={mode === 'supersede' ? t('decisions.review.replacementWhy', { defaultValue: 'Why the premise changed' }) : t('decisions.review.rationalePlaceholder', { defaultValue: 'Why (optional)' })} />
          <textarea value={premises} onChange={(e) => setPremises(e.target.value)} rows={2} className={input}
            placeholder={t('decisions.card.premisesPlaceholder', { defaultValue: 'Holds while… (one per line)' })} />
          <div className="flex gap-1">
            <button
              className={btn}
              disabled={busy || !choice.trim()}
              onClick={() =>
                void run(
                  mode === 'edit'
                    ? editDecisionContent(cwd, d.id, { choice: choice.trim(), rationale: rationale.trim(), premises: premiseList() })
                    : supersedeDecision(cwd, d, { choice: choice.trim(), rationale: rationale.trim(), premises: premiseList(), alternatives: [d.choice], tradeoffs: '' }),
                )
              }
            >
              {t('decisions.card.save', { defaultValue: 'Save' })}
            </button>
            <button className={btn} onClick={() => setMode('view')}>{t('common.cancel', { defaultValue: 'Cancel' })}</button>
          </div>
        </div>
      )}

      {mode === 'retire' && (
        <div className="mt-1">
          <input value={reason} onChange={(e) => setReason(e.target.value)} className={input}
            placeholder={t('decisions.card.retireReason', { defaultValue: 'Why it no longer applies (required)' })} />
          <div className="flex gap-1">
            <button className={btn} disabled={busy || !reason.trim()} onClick={() => void run(setDecisionLifecycle(cwd, d.id, 'retired', reason.trim()))}>
              {t('decisions.card.retire', { defaultValue: 'Retire' })}
            </button>
            <button className={btn} onClick={() => setMode('view')}>{t('common.cancel', { defaultValue: 'Cancel' })}</button>
          </div>
        </div>
      )}
    </div>
  );
});
