'use client';

/**
 * The AI half of the task review (docs/DECISION_MODE.md §9): model picker,
 * result summary and candidate decisions. Everything shown here already passed
 * the server's deterministic checks; what is shown as "no evidence" or
 * "inferred" is exactly what failed them.
 */
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Effect } from 'effect';
import { useEffectQuery } from '@cockpit/effect-react';
import {
  LOW_END_MODEL,
  type DecisionCandidate,
  type DecisionContent,
  type DecisionSource,
  type EvidenceRef,
  type ExtractionEngine,
  type ExtractionResult,
} from '@cockpit/feature-decisions';
import { loadModelIds } from '../effect/extractionClient';

export const EXTRACTION_ENGINES: ExtractionEngine[] = ['claude', 'codex', 'deepseek', 'kimi', 'glm', 'ollama'];

const ENGINE_LABEL: Record<ExtractionEngine, string> = {
  claude: 'Claude',
  codex: 'Codex',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  glm: 'GLM',
  ollama: 'Ollama',
};

/** Model suggestions for the CLI engines (their pickers keep the catalog client-side). */
const STATIC_MODELS: Partial<Record<ExtractionEngine, string[]>> = {
  claude: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  codex: ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'],
};

export interface ModelChoice {
  engine: ExtractionEngine;
  model: string;
}

/**
 * Default per §9: the project's last pick, else the session engine's low-end
 * model, else the session's own model. Grok has no one-shot channel → Claude.
 */
export function defaultModelChoice(
  saved: { engine: string; model: string } | undefined,
  sessionEngine: string | undefined,
  sessionModel: string | undefined,
): ModelChoice {
  if (saved && EXTRACTION_ENGINES.includes(saved.engine as ExtractionEngine) && saved.model) {
    return { engine: saved.engine as ExtractionEngine, model: saved.model };
  }
  const engine = EXTRACTION_ENGINES.includes(sessionEngine as ExtractionEngine) ? (sessionEngine as ExtractionEngine) : 'claude';
  const model = LOW_END_MODEL[engine] ?? (engine === sessionEngine ? sessionModel : undefined) ?? '';
  return { engine, model };
}

export const ExtractionModelPicker = memo(function ExtractionModelPicker({
  value,
  sessionEngine,
  onChange,
}: {
  value: ModelChoice;
  sessionEngine: string | undefined;
  onChange: (next: ModelChoice) => void;
}) {
  const { t } = useTranslation();
  const idsQ = useEffectQuery(STATIC_MODELS[value.engine] ? Effect.succeed(STATIC_MODELS[value.engine]!) : loadModelIds(value.engine), [value.engine]);
  const ids = idsQ.status === 'success' ? idsQ.data : [];
  const [draft, setDraft] = useState(value.model);
  useEffect(() => setDraft(value.model), [value.model]);
  const otherProvider = sessionEngine !== undefined && value.engine !== sessionEngine;
  const listId = `extraction-models-${value.engine}`;

  return (
    <div className="flex items-center gap-1 text-xs" title={otherProvider ? t('decisions.review.privacyNote', { defaultValue: 'The conversation of this range will be sent to {{engine}}, a different provider than this session uses.', engine: ENGINE_LABEL[value.engine] }) : undefined}>
      <select
        value={value.engine}
        onChange={(e) => {
          const engine = e.target.value as ExtractionEngine;
          onChange({ engine, model: LOW_END_MODEL[engine] ?? '' });
        }}
        className="rounded border border-border bg-background px-1 py-0.5 text-foreground"
        aria-label={t('decisions.review.extractionEngine', { defaultValue: 'Extraction engine' })}
      >
        {EXTRACTION_ENGINES.map((e) => (
          <option key={e} value={e}>{ENGINE_LABEL[e]}</option>
        ))}
      </select>
      <input
        list={listId}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() && draft.trim() !== value.model && onChange({ engine: value.engine, model: draft.trim() })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) onChange({ engine: value.engine, model: draft.trim() });
        }}
        placeholder={t('decisions.review.modelPlaceholder', { defaultValue: 'model' })}
        className="w-40 rounded border border-border bg-background px-1 py-0.5 text-foreground"
        aria-label={t('decisions.review.extractionModel', { defaultValue: 'Extraction model' })}
      />
      <datalist id={listId}>
        {ids.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
      {otherProvider && <span className="text-amber-11">{t('decisions.review.otherProvider', { defaultValue: 'other provider' })}</span>}
    </div>
  );
});

function EvidenceChips({ evidence, onOpenFile, onOpenRun }: { evidence: EvidenceRef[]; onOpenFile: (p: string) => void; onOpenRun: () => void }) {
  const { t } = useTranslation();
  if (evidence.length === 0) {
    return <span className="ml-1 rounded bg-red-3 px-1 text-red-11">{t('decisions.review.noEvidence', { defaultValue: 'no evidence' })}</span>;
  }
  return (
    <>
      {evidence.map((e) => (
        <button
          key={`${e.kind}:${e.id}`}
          onClick={e.kind === 'file' ? () => onOpenFile(e.id) : e.kind === 'run' ? onOpenRun : undefined}
          title={e.kind === 'file' ? e.id : e.kind === 'run' ? t('decisions.review.verification', { defaultValue: 'Verification' }) : t('decisions.review.messageRef', { defaultValue: 'A message in the conversation' })}
          className={`ml-1 rounded border border-border px-1 text-foreground-subtle ${e.kind === 'message' ? 'cursor-default' : 'hover:bg-hover hover:text-foreground'}`}
        >
          {e.kind === 'file' ? e.id.split('/').pop() : e.label}
        </button>
      ))}
    </>
  );
}

export function SummaryView({
  result,
  onOpenFile,
  onOpenRun,
}: {
  result: ExtractionResult;
  onOpenFile: (p: string) => void;
  onOpenRun: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 overflow-y-auto p-3 text-sm">
      {result.goal && <div className="mb-3 text-muted-foreground">{result.goal}</div>}
      {result.summary.length === 0 && <div className="text-muted-foreground">{t('decisions.review.noSummary', { defaultValue: 'The model returned no result summary.' })}</div>}
      <ul className="space-y-2">
        {result.summary.map((s, i) => (
          <li key={i} className="text-foreground">
            {s.text}
            <span className="text-xs">
              <EvidenceChips evidence={s.evidence} onOpenFile={onOpenFile} onOpenRun={onOpenRun} />
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 text-xs text-foreground-subtle">
        {result.engine} · {result.model}
        {result.chunks > 1 && ` · ${t('decisions.review.chunks', { defaultValue: 'read in {{count}} parts', count: result.chunks })}`}
        {result.cached && ` · ${t('decisions.review.cached', { defaultValue: 'cached' })}`}
      </div>
    </div>
  );
}

/** A decision the user keeps: a candidate as extracted, or one typed by hand. */
export interface KeptDraft {
  key: string;
  content: DecisionContent;
  source: DecisionSource;
  files: string[];
}

const SOURCE_STYLE: Record<DecisionSource['kind'], string> = {
  user: 'text-green-11',
  agent: 'text-brand',
  inferred: 'text-amber-11',
  manual: 'text-muted-foreground',
};

const SOURCE_DEFAULT: Record<DecisionSource['kind'], string> = {
  user: 'User chose',
  agent: 'Agent decided',
  inferred: 'Inferred (no verbatim quote)',
  manual: 'Added by you',
};

/** Candidates the user keeps by default (§4.4): only what the user said themselves. */
export const defaultKept = (cs: DecisionCandidate[]): Set<string> => new Set(cs.filter((c) => c.source.kind === 'user').map((c) => c.key));

export function DecisionsView({
  candidates,
  kept,
  onToggle,
  manual,
  onAddManual,
  onRemoveManual,
  onOpenFile,
}: {
  candidates: DecisionCandidate[];
  kept: ReadonlySet<string>;
  onToggle: (key: string) => void;
  manual: KeptDraft[];
  onAddManual: (d: KeptDraft) => void;
  onRemoveManual: (key: string) => void;
  onOpenFile: (p: string) => void;
}) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState('');
  const [rationale, setRationale] = useState('');
  const add = useCallback(() => {
    if (!choice.trim()) return;
    onAddManual({
      key: `m${Date.now()}`,
      content: { choice: choice.trim(), alternatives: [], rationale: rationale.trim(), tradeoffs: '', premises: [] },
      source: { kind: 'manual' },
      files: [],
    });
    setChoice('');
    setRationale('');
  }, [choice, rationale, onAddManual]);
  const sourceLabel = (k: DecisionSource['kind']) => t(`decisions.review.source.${k}`, { defaultValue: SOURCE_DEFAULT[k] });
  const rows = useMemo(() => [...candidates.map((c) => ({ c, manual: false })), ...manual.map((c) => ({ c, manual: true }))], [candidates, manual]);

  return (
    <div className="flex-1 overflow-y-auto p-3 text-xs">
      <div className="mb-2 text-muted-foreground">
        {t('decisions.review.decisionsHint', { defaultValue: 'Checked decisions are kept when you accept. Unchecked ones are discarded.' })}
      </div>
      {rows.length === 0 && <div className="mb-2 text-muted-foreground">{t('decisions.review.noCandidates', { defaultValue: 'No decisions found in these turns.' })}</div>}
      {rows.map(({ c, manual: isManual }) => (
        <div key={c.key} className="mb-2 flex gap-2 rounded border border-border p-2">
          {isManual ? (
            <button onClick={() => onRemoveManual(c.key)} className="h-fit rounded px-1 text-muted-foreground hover:bg-hover" aria-label={t('common.remove', { defaultValue: 'Remove' })}>×</button>
          ) : (
            <input type="checkbox" checked={kept.has(c.key)} onChange={() => onToggle(c.key)} className="mt-0.5" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{c.content.choice}</span>
              <span className={`ml-auto shrink-0 ${SOURCE_STYLE[c.source.kind]}`}>{sourceLabel(c.source.kind)}</span>
            </div>
            {c.content.alternatives.length > 0 && (
              <div className="text-muted-foreground">{t('decisions.review.instead', { defaultValue: 'Instead of:' })} {c.content.alternatives.join('; ')}</div>
            )}
            {c.content.rationale && <div className="text-foreground">{c.content.rationale}</div>}
            {c.content.tradeoffs && <div className="text-muted-foreground">{t('decisions.review.cost', { defaultValue: 'Cost:' })} {c.content.tradeoffs}</div>}
            {c.content.premises.length > 0 && (
              <div className="text-muted-foreground">{t('decisions.review.premises', { defaultValue: 'Holds while:' })} {c.content.premises.join('; ')}</div>
            )}
            {c.source.quote && <blockquote className="mt-1 border-l-2 border-border pl-2 text-foreground-subtle">{c.source.quote}</blockquote>}
            {c.files.length > 0 && (
              <div className="mt-1">
                {c.files.map((f) => (
                  <button key={f} onClick={() => onOpenFile(f)} className="mr-1 rounded border border-border px-1 text-foreground-subtle hover:bg-hover hover:text-foreground" title={f}>
                    {f.split('/').pop()}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
      <div className="mt-3 rounded border border-dashed border-border p-2">
        <div className="mb-1 text-muted-foreground">{t('decisions.review.addManual', { defaultValue: 'Add a decision yourself' })}</div>
        <input value={choice} onChange={(e) => setChoice(e.target.value)} placeholder={t('decisions.review.choicePlaceholder', { defaultValue: 'What was chosen' })} className="mb-1 w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        <input value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder={t('decisions.review.rationalePlaceholder', { defaultValue: 'Why (optional)' })} className="mb-1 w-full rounded border border-border bg-background px-2 py-1 text-foreground" />
        <button onClick={add} disabled={!choice.trim()} className="rounded border border-border px-2 py-0.5 text-foreground hover:bg-hover disabled:opacity-50">
          {t('decisions.review.add', { defaultValue: 'Add' })}
        </button>
      </div>
    </div>
  );
}
