'use client';

/**
 * Decision check and impact & gaps in the task review (docs/DECISION_MODE.md §6, §7.2).
 *
 * Touched decisions BLOCK accept until each has a verdict; impact is
 * information only. "Let the agent handle it" fills the chat input and never
 * sends — the user decides.
 */
import { useTranslation } from 'react-i18next';
import type { DecisionContent, ImpactResult, TestState, TouchedDecisionWire } from '@cockpit/feature-decisions';
import { STATE_STYLE } from './reviewStyles';

export type VerdictDraft =
  | { verdict: 'holds' | 'unrelated' }
  | { verdict: 'superseded'; choice: string; rationale: string };

export const verdictComplete = (v: VerdictDraft | undefined): boolean =>
  !!v && (v.verdict !== 'superseded' || v.choice.trim().length > 0);

export const verdictPayload = (decisionId: string, v: VerdictDraft) =>
  v.verdict === 'superseded'
    ? {
        decisionId,
        verdict: 'superseded' as const,
        replacement: { choice: v.choice.trim(), alternatives: [], rationale: v.rationale.trim(), tradeoffs: '', premises: [] } satisfies DecisionContent,
      }
    : { decisionId, verdict: v.verdict };

export function TouchedDecisions({
  touched,
  verdicts,
  onVerdict,
}: {
  touched: TouchedDecisionWire[];
  verdicts: ReadonlyMap<string, VerdictDraft>;
  onVerdict: (id: string, v: VerdictDraft) => void;
}) {
  const { t } = useTranslation();
  if (touched.length === 0) return null;
  const btn = (active: boolean) =>
    `rounded border px-2 py-0.5 ${active ? 'border-brand bg-brand text-white' : 'border-border text-foreground hover:bg-hover'}`;
  return (
    <div className="mb-4">
      <div className="mb-1 font-medium text-amber-11">
        {t('decisions.review.touchedTitle', { defaultValue: 'Existing decisions this change touches — answer each before accepting' })}
      </div>
      {touched.map(({ decision: d, reason, paths, state }) => {
        const v = verdicts.get(d.id);
        return (
          <div key={d.id} className={`mb-2 rounded border p-2 ${verdictComplete(v) ? 'border-border' : 'border-amber-9'}`}>
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{d.choice}</span>
              <span className="ml-auto shrink-0 text-foreground-subtle">
                {reason === 'direct'
                  ? t('decisions.review.touchedDirect', { defaultValue: 'changed: {{paths}}', paths: paths.join(', ') })
                  : t('decisions.review.touchedNeighbor', { defaultValue: 'calls into / called by: {{paths}}', paths: paths.join(', ') })}
              </span>
            </div>
            {d.rationale && <div className="text-foreground">{d.rationale}</div>}
            {d.premises.length > 0 && <div className="text-muted-foreground">{t('decisions.review.premises', { defaultValue: 'Holds while:' })} {d.premises.join('; ')}</div>}
            {state === 'not-landed' && <div className="text-foreground-subtle">{t('decisions.review.notLanded', { defaultValue: 'Not committed yet' })}</div>}
            {d.lastReview?.verdict === 'unrelated' && (
              <div className="text-foreground-subtle">{t('decisions.review.lastUnrelated', { defaultValue: 'Marked unrelated last time' })}</div>
            )}
            <div className="mt-1 flex flex-wrap gap-1">
              <button className={btn(v?.verdict === 'holds')} onClick={() => onVerdict(d.id, { verdict: 'holds' })}>
                {t('decisions.review.verdictHolds', { defaultValue: 'Still holds' })}
              </button>
              <button className={btn(v?.verdict === 'superseded')} onClick={() => onVerdict(d.id, { verdict: 'superseded', choice: '', rationale: '' })}>
                {t('decisions.review.verdictSuperseded', { defaultValue: 'Superseded' })}
              </button>
              <button className={btn(v?.verdict === 'unrelated')} onClick={() => onVerdict(d.id, { verdict: 'unrelated' })}>
                {t('decisions.review.verdictUnrelated', { defaultValue: 'Not related to this change' })}
              </button>
            </div>
            {v?.verdict === 'superseded' && (
              <div className="mt-1">
                <input
                  value={v.choice}
                  onChange={(e) => onVerdict(d.id, { ...v, choice: e.target.value })}
                  placeholder={t('decisions.review.replacementChoice', { defaultValue: 'What replaces it' })}
                  className="mb-1 w-full rounded border border-border bg-background px-2 py-1 text-foreground"
                />
                <input
                  value={v.rationale}
                  onChange={(e) => onVerdict(d.id, { ...v, rationale: e.target.value })}
                  placeholder={t('decisions.review.replacementWhy', { defaultValue: 'Why the premise changed' })}
                  className="w-full rounded border border-border bg-background px-2 py-1 text-foreground"
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const TEST_DEFAULT: Record<TestState, string> = {
  verified: 'Verified', failed: 'Failed', 'needs-rerun': 'Needs rerun', 'no-tests': 'No test actually ran', unknown: 'Result unknown',
  running: 'Running', unverified: 'Not run', claimed: 'Claimed, no record', 'not-run': 'Not run',
};

export function ImpactView({ impact, onFillInput, onOpenFile }: { impact: ImpactResult; onFillInput?: (text: string) => void; onOpenFile: (p: string) => void }) {
  const { t } = useTranslation();
  const more = (shown: number, total: number) =>
    total > shown ? <div className="text-foreground-subtle">{t('decisions.review.andMore', { defaultValue: 'and {{count}} more', count: total - shown })}</div> : null;
  const handle = (text: string) =>
    onFillInput ? (
      <button onClick={() => onFillInput(text)} className="ml-auto shrink-0 rounded px-1 text-muted-foreground hover:bg-hover hover:text-foreground">
        {t('decisions.review.letAgent', { defaultValue: 'Let the agent handle it' })}
      </button>
    ) : null;
  const notRun = impact.tests.filter((x) => x.state !== 'verified').map((x) => x.test);
  const testLabel = (s: TestState) => t(`decisions.review.state.${s === 'not-run' ? 'unverified' : s}`, { defaultValue: TEST_DEFAULT[s] });
  const blindLabel: Record<string, string> = {
    'index-building': t('decisions.review.blind.indexBuilding', { defaultValue: 'The code index is still building — callers and affected tests are not analysed yet. Reopen the review in a moment.' }),
    'index-truncated': t('decisions.review.blind.indexTruncated', { defaultValue: 'The project is larger than the index limit; some files are not analysed.' }),
    'unsupported-language': t('decisions.review.blind.unsupported', { defaultValue: 'Languages the analysis cannot read:' }),
    'unresolved-import': t('decisions.review.blind.unresolved', { defaultValue: 'Imports that could not be resolved:' }),
    'parse-failed': t('decisions.review.blind.parseFailed', { defaultValue: 'Files that could not be parsed (binary, too large or invalid):' }),
  };

  return (
    <div className="flex-1 overflow-y-auto p-3 text-xs">
      <section className="mb-4">
        <div className="mb-1 font-medium text-foreground">{t('decisions.review.gapsTitle', { defaultValue: 'Interface changed, callers not updated' })}</div>
        {impact.interfaceGaps.length === 0 && <div className="text-muted-foreground">{t('decisions.review.none', { defaultValue: 'None found.' })}</div>}
        {impact.interfaceGaps.map((g) => (
          <div key={`${g.file}:${g.qname}`} className="mb-2 rounded border border-border p-2">
            <div className="flex items-center gap-2">
              <button onClick={() => onOpenFile(g.file)} className="font-mono text-foreground hover:underline">{g.qname}</button>
              <span className="text-foreground-subtle">{g.file}</span>
              <span className={g.change === 'removed' ? 'text-red-11' : 'text-amber-11'}>
                {g.change === 'removed' ? t('decisions.review.removedStillUsed', { defaultValue: 'removed, still referenced' }) : t('decisions.review.interfaceChanged', { defaultValue: 'interface changed' })}
              </span>
              {handle(
                t('decisions.review.askCallers', {
                  defaultValue: 'Check whether these callers of `{{qname}}` in {{file}} need updating after its interface change: {{callers}}',
                  qname: g.qname,
                  file: g.file,
                  callers: g.callers.map((c) => `${c.file} (${c.qname}, line ${c.lines.join('/')})`).join('; '),
                }),
              )}
            </div>
            {g.callers.map((c) => (
              <div key={`${c.file}:${c.qname}`} className="pl-3 text-muted-foreground">
                ← {c.file} · {c.qname} · {c.lines.join(', ')}
              </div>
            ))}
          </div>
        ))}
        {more(impact.interfaceGaps.length, impact.totals.interfaceGaps)}
      </section>

      <section className="mb-4">
        <div className="mb-1 flex items-center font-medium text-foreground">
          {t('decisions.review.testsTitle', { defaultValue: 'Affected tests' })}
          {notRun.length > 0 && handle(t('decisions.review.askTests', { defaultValue: 'Run these affected tests and report the results: {{tests}}', tests: notRun.join(' ') }))}
        </div>
        {impact.tests.length === 0 && <div className="text-muted-foreground">{t('decisions.review.none', { defaultValue: 'None found.' })}</div>}
        {impact.tests.map((x) => (
          <div key={x.test} className="flex items-center gap-2 py-0.5">
            <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={x.test}>{x.test}</span>
            <span className={x.state === 'not-run' ? 'text-amber-11' : STATE_STYLE[x.state]}>{testLabel(x.state)}</span>
          </div>
        ))}
        {more(impact.tests.length, impact.totals.tests)}
      </section>

      <section className="mb-4">
        <div className="mb-1 font-medium text-foreground">{t('decisions.review.bodyTitle', { defaultValue: 'Changed inside only (callers not expanded)' })}</div>
        {impact.bodyOnly.length === 0 && <div className="text-muted-foreground">{t('decisions.review.none', { defaultValue: 'None found.' })}</div>}
        {impact.bodyOnly.map((b) => (
          <div key={`${b.file}:${b.qname}`} className="flex items-center gap-2 py-0.5">
            <button onClick={() => onOpenFile(b.file)} className="font-mono text-foreground hover:underline">{b.qname}</button>
            <span className="text-foreground-subtle">{b.file}</span>
            <span className="ml-auto text-foreground-subtle">{t('decisions.review.testCount', { defaultValue: '{{count}} tests', count: b.tests.length })}</span>
          </div>
        ))}
        {more(impact.bodyOnly.length, impact.totals.bodyOnly)}
      </section>

      <section>
        <div className="mb-1 font-medium text-foreground">{t('decisions.review.blindTitle', { defaultValue: 'Blind spots' })}</div>
        {impact.blindSpots.map((b) => (
          <div key={b.kind} className="mb-1 text-amber-11">
            {blindLabel[b.kind]} {b.files.length > 0 && <span className="text-muted-foreground">{b.files.slice(0, 20).join(', ')}{b.files.length > 20 ? ` …(+${b.files.length - 20})` : ''}</span>}
          </div>
        ))}
        <div className="text-muted-foreground">
          {t('decisions.review.blindDynamic', { defaultValue: 'Static analysis cannot see dynamic calls (computed method names, reflection, string-built routes). "Nothing found" is not "no impact".' })}
        </div>
      </section>
    </div>
  );
}
