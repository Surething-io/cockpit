'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Effect } from 'effect';
import { ChevronDown, ChevronRight, FileText, Scale, ShieldCheck, X } from 'lucide-react';
import { useEffectQuery } from '@cockpit/effect-react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { Portal, blurActiveElement, toast } from '@cockpit/shared-ui';
import { DiffView } from '@cockpit/feature-explorer';
import {
  acceptReview,
  loadAcceptedTask,
  loadReview,
  saveExtractionModel,
  setCheckOverride,
  type AcceptedTask,
  type VerificationResult,
  type VerificationState,
  type FileCategory,
  type ReviewFile,
  type ReviewResult,
  type ReviewTurn,
} from '@cockpit/feature-decisions';
import type { ChatMessage } from '../types';
import { loadVerification } from '../effect/verificationClient';
import { extractionMessages, rangeEvidence } from './reviewTurns';
import { loadExtraction } from '../effect/extractionClient';
import {
  DecisionsView,
  ExtractionModelPicker,
  SummaryView,
  defaultKept,
  defaultModelChoice,
  type KeptDraft,
  type ModelChoice,
} from './ReviewExtraction';

/**
 * Decision-mode task review (docs/DECISION_MODE.md §4.2) — the deterministic
 * part: range, goal, attributed changes, accept. Later steps add result
 * summary, decisions, verification and impact sections to the left column.
 *
 * Full-window Portal, like DiffViewerModal's standalone wrapper: a review
 * spans the whole task, so it does not belong to any one of the three panels.
 */

export type ReviewModalMode =
  | {
      kind: 'live';
      turns: ReviewTurn[];
      initialStart: number;
      messages: ChatMessage[];
      sessionEngine?: string;
      sessionModel?: string;
      /** The project's remembered extraction model, if any. */
      savedModel?: { engine: string; model: string };
    }
  | { kind: 'accepted'; taskId: string };

interface ReviewModalProps {
  cwd: string;
  sessionId: string;
  mode: ReviewModalMode;
  onClose: () => void;
  onAccepted?: (task: AcceptedTask) => void;
}

const CATEGORY_ORDER: FileCategory[] = ['task', 'mixed', 'task-maybe', 'non-agent', 'other-session'];

const CATEGORY_STYLE: Record<FileCategory, string> = {
  task: 'text-foreground',
  mixed: 'text-amber-11',
  'task-maybe': 'text-muted-foreground',
  'non-agent': 'text-muted-foreground',
  'other-session': 'text-foreground-subtle',
};

const EMPTY_TOOL_IDS: string[] = [];

/** Colour of a verification state badge. */
export const STATE_STYLE: Record<VerificationState, string> = {
  verified: 'text-green-11',
  failed: 'text-red-11',
  'needs-rerun': 'text-amber-11',
  'no-tests': 'text-amber-11',
  unknown: 'text-muted-foreground',
  running: 'text-muted-foreground',
  unverified: 'text-amber-11',
  claimed: 'text-red-11',
};

const STATE_DEFAULT: Record<VerificationState, string> = {
  verified: 'Verified',
  failed: 'Failed',
  'needs-rerun': 'Needs rerun',
  'no-tests': 'No test actually ran',
  unknown: 'Result unknown',
  running: 'Running',
  unverified: 'Not run',
  claimed: 'Claimed, no record',
};
const KIND_DEFAULT = { test: 'Tests', typecheck: 'Type check', lint: 'Lint', custom: 'Custom check' } as const;

export const ReviewModal = memo(function ReviewModal({ cwd, sessionId, mode, onClose, onAccepted }: ReviewModalProps) {
  const { t } = useTranslation();
  const live = mode.kind === 'live';

  // ── Range (live mode): a contiguous span of turns, edited by checkboxes ──
  const turns = live ? mode.turns : null;
  const [span, setSpan] = useState<[number, number]>(() =>
    live ? [Math.min(mode.initialStart, Math.max(mode.turns.length - 1, 0)), mode.turns.length - 1] : [0, -1],
  );
  const selected = useMemo(() => (turns ? turns.slice(span[0], span[1] + 1) : []), [turns, span]);
  const [goal, setGoal] = useState(() => (live ? mode.turns[mode.initialStart]?.text ?? '' : ''));
  const [goalEdited, setGoalEdited] = useState(false);

  const toggleTurn = useCallback(
    (i: number) => {
      setSpan(([a, b]) => {
        if (i < a) return [i, b];
        if (i > b) return [a, i];
        if (i === a && a < b) return [a + 1, b];
        if (i === b && a < b) return [a, b - 1];
        return [a, b]; // middle turns stay: the range is one contiguous diff
      });
    },
    [],
  );

  // ── Accepted mode: the frozen task ──
  const taskQ = useEffectQuery(
    mode.kind === 'accepted' ? loadAcceptedTask(cwd, mode.taskId) : Effect.succeed(null),
    [cwd, mode.kind === 'accepted' ? mode.taskId : ''],
  );
  const task = taskQ.status === 'success' ? taskQ.data?.task ?? null : null;

  const toolIds = useMemo(
    () => (live ? selected.flatMap((tr) => tr.toolIds) : task?.toolIds ?? EMPTY_TOOL_IDS),
    [live, selected, task],
  );
  const toolKey = toolIds.join(',');
  const reviewQ = useEffectQuery(
    toolIds.length > 0 ? loadReview(cwd, toolIds, false) : Effect.succeed({ empty: true } as ReviewResult),
    [cwd, toolKey],
  );
  const review = reviewQ.status === 'success' ? reviewQ.data : null;

  // ── Verification (live only: accepted tasks keep no transcript evidence) ──
  const [checksTick, setChecksTick] = useState(0);
  const evidence = useMemo(
    () => (live ? rangeEvidence(mode.messages, new Set(selected.map((tr) => tr.id))) : null),
    [live, mode, selected],
  );
  const verificationQ = useEffectQuery(
    evidence ? loadVerification(cwd, evidence.orderedToolIds, evidence.runs, evidence.claimedPass) : Effect.succeed(null as VerificationResult | null),
    [cwd, evidence, checksTick],
  );
  const verification = verificationQ.status === 'success' ? verificationQ.data : null;
  const correctCheck = useCallback(
    async (command: string, isCheck: boolean) => {
      const exit = await BrowserRuntime.runPromiseExit(setCheckOverride(cwd, command, isCheck));
      if (exit._tag === 'Success') setChecksTick((n) => n + 1);
      else toast(t('decisions.review.checkOverrideFailed', { defaultValue: 'Could not save the correction' }), 'error');
    },
    [cwd, t],
  );
  // ── AI extraction (§9): summary + candidate decisions + goal ──
  const [choice, setChoice] = useState<ModelChoice>(() =>
    live ? defaultModelChoice(mode.savedModel, mode.sessionEngine, mode.sessionModel) : { engine: 'claude', model: '' },
  );
  const changeChoice = useCallback(
    (next: ModelChoice) => {
      setChoice(next);
      void BrowserRuntime.runPromiseExit(saveExtractionModel(cwd, next.engine, next.model)); // remembered per project
    },
    [cwd],
  );
  const [extractTick, setExtractTick] = useState(0);
  const extractionInput = useMemo(
    () => (live && evidence && choice.model ? { messages: extractionMessages(mode.messages, new Set(selected.map((tr) => tr.id))), evidence } : null),
    [live, mode, selected, evidence, choice.model],
  );
  const extractionQ = useEffectQuery(
    extractionInput
      ? loadExtraction({
          cwd,
          sessionId,
          engine: choice.engine,
          model: choice.model,
          messages: extractionInput.messages,
          orderedToolIds: extractionInput.evidence.orderedToolIds,
          runs: extractionInput.evidence.runs,
          claimedPass: extractionInput.evidence.claimedPass,
        })
      : Effect.succeed(null),
    [cwd, sessionId, choice.engine, choice.model, extractionInput, extractTick],
  );
  const extraction = extractionQ.status === 'success' ? extractionQ.data : null;
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState<KeptDraft[]>([]);
  useEffect(() => {
    if (!extraction) return;
    setKept(defaultKept(extraction.candidates));
    if (!goalEdited && extraction.goal) setGoal(extraction.goal);
    // goalEdited is read, not tracked: a later edit must not re-run this.
  }, [extraction]);
  const toggleKept = useCallback((key: string) => setKept((k) => {
    const n = new Set(k);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    return n;
  }), []);
  const addManual = useCallback((d: KeptDraft) => setManual((m) => [...m, d]), []);
  const removeManual = useCallback((key: string) => setManual((m) => m.filter((x) => x.key !== key)), []);

  const stateLabel = useCallback((st: VerificationState) => t(`decisions.review.state.${st}`, { defaultValue: STATE_DEFAULT[st] }), [t]);
  const kindLabel = useCallback((k: keyof typeof KIND_DEFAULT) => t(`decisions.review.kind.${k}`, { defaultValue: KIND_DEFAULT[k] }), [t]);

  const groups = useMemo(() => {
    const files = review && !review.empty ? review.files : [];
    return CATEGORY_ORDER.map((c) => ({ category: c, files: files.filter((f) => f.category === c) })).filter((g) => g.files.length > 0);
  }, [review]);
  const reviewedCount = useMemo(
    () => groups.filter((g) => g.category !== 'other-session').reduce((n, g) => n + g.files.length, 0),
    [groups],
  );

  const [activePath, setActivePath] = useState<string | null>(null);
  type View = 'file' | 'verification' | 'summary' | 'decisions';
  const [view, setView] = useState<View>(live ? 'summary' : 'file');
  const showVerification = view === 'verification';
  const setShowVerification = useCallback((v: boolean) => setView(v ? 'verification' : 'file'), []);
  const openFile = useCallback((p: string) => {
    setView('file');
    setActivePath(p);
  }, []);
  const openVerification = useCallback(() => setView('verification'), []);
  const [showOthers, setShowOthers] = useState(false);
  useEffect(() => {
    const first = groups.find((g) => g.category !== 'other-session')?.files[0];
    setActivePath((p) => (p && groups.some((g) => g.files.some((f) => f.path === p)) ? p : first?.path ?? null));
  }, [groups]);
  const active: ReviewFile | undefined = useMemo(
    () => groups.flatMap((g) => g.files).find((f) => f.path === activePath),
    [groups, activePath],
  );

  // ── Accept ──
  const [accepting, setAccepting] = useState(false);
  const accept = useCallback(async () => {
    if (!live || selected.length === 0) return;
    setAccepting(true);
    const keptDecisions = [
      ...(extraction?.candidates.filter((c) => kept.has(c.key)) ?? []),
      ...manual,
    ].map(({ content, source, files }) => ({ content, source, files }));
    const exit = await BrowserRuntime.runPromiseExit(acceptReview(cwd, sessionId, goal, selected, keptDecisions));
    setAccepting(false);
    if (exit._tag !== 'Success') {
      toast(t('decisions.review.acceptFailed', { defaultValue: 'Could not accept this review' }), 'error');
      return;
    }
    toast(t('decisions.review.accepted', { defaultValue: 'Review accepted' }), 'success');
    onAccepted?.(exit.value.task);
    onClose();
  }, [live, selected, cwd, sessionId, goal, extraction, kept, manual, onAccepted, onClose, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      blurActiveElement();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const categoryLabel = (c: FileCategory) =>
    t(`decisions.review.category.${c}`, {
      defaultValue: { task: 'This task', mixed: 'Mixed with another session', 'task-maybe': 'Produced by Bash (may include outside changes)', 'non-agent': 'Not by the agent', 'other-session': 'Other sessions' }[c],
    });

  const snapshotsGone = !live && task && review?.empty;

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim" onClick={onClose}>
        <div
          className="flex h-[90vh] w-[95vw] max-w-[1600px] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lv2"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label={t('decisions.review.title', { defaultValue: 'Task review' })}
        >
          {/* Header: range + goal */}
          <div className="flex items-center gap-3 border-b border-border px-4 py-2">
            <h3 className="shrink-0 text-sm font-medium text-foreground">
              {live
                ? t('decisions.review.title', { defaultValue: 'Task review' })
                : t('decisions.review.acceptedTitle', { defaultValue: 'Accepted review' })}
            </h3>
            {live ? (
              <input
                value={goal}
                onChange={(e) => {
                  setGoal(e.target.value);
                  setGoalEdited(true);
                }}
                placeholder={t('decisions.review.goalPlaceholder', { defaultValue: 'Goal of this task' })}
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {task ? `${task.goal || '—'} · ${new Date(task.acceptedAt).toLocaleString()}` : ''}
              </span>
            )}
            {live && <ExtractionModelPicker value={choice} sessionEngine={mode.sessionEngine} onChange={changeChoice} />}
            <button onClick={onClose} aria-label={t('common.close', { defaultValue: 'Close' })} className="rounded p-1 text-muted-foreground hover:bg-hover hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex min-h-0 flex-1">
            {/* Left column: range + attributed files */}
            <div className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-border text-xs">
              {live && turns && (
                <div className="border-b border-border p-2">
                  <div className="mb-1 font-medium text-muted-foreground">
                    {t('decisions.review.range', { defaultValue: 'Turns {{a}}–{{b}}', a: span[0] + 1, b: span[1] + 1 })}
                  </div>
                  {turns.map((tr, i) => {
                    const inside = i >= span[0] && i <= span[1];
                    const locked = inside && i !== span[0] && i !== span[1];
                    return (
                      <label key={tr.id} className={`flex items-start gap-2 rounded px-1 py-0.5 ${locked ? 'opacity-70' : 'cursor-pointer hover:bg-hover'}`}>
                        <input type="checkbox" checked={inside} disabled={locked} onChange={() => toggleTurn(i)} className="mt-0.5" />
                        <span className="text-foreground-subtle">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-foreground">{tr.text || '—'}</span>
                        {tr.toolIds.length === 0 && <span className="text-foreground-subtle">·</span>}
                      </label>
                    );
                  })}
                </div>
              )}

              {live && (
                <div className="border-b border-border p-2">
                  <button
                    onClick={() => setView('summary')}
                    className={`mb-1 flex w-full items-center gap-1 rounded px-1 text-left font-medium ${view === 'summary' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-hover'}`}
                  >
                    <FileText className="h-3.5 w-3.5" />
                    {t('decisions.review.result', { defaultValue: 'Result' })}
                    <span className="ml-auto font-normal text-foreground-subtle">
                      {extractionQ.status === 'loading' && choice.model ? t('decisions.review.generating', { defaultValue: 'generating…' }) : extraction ? extraction.summary.length : ''}
                    </span>
                  </button>
                  <button
                    onClick={() => setView('decisions')}
                    className={`flex w-full items-center gap-1 rounded px-1 text-left font-medium ${view === 'decisions' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-hover'}`}
                  >
                    <Scale className="h-3.5 w-3.5" />
                    {t('decisions.review.decisions', { defaultValue: 'Decisions' })}
                    <span className="ml-auto font-normal text-foreground-subtle">
                      {extraction
                        ? t('decisions.review.keptCount', { defaultValue: '{{kept}} of {{count}} kept', kept: kept.size + manual.length, count: extraction.candidates.length + manual.length })
                        : ''}
                    </span>
                  </button>
                </div>
              )}

              {live && (
                <div className="border-b border-border p-2">
                  <button
                    onClick={() => setShowVerification(true)}
                    className={`mb-1 flex w-full items-center gap-1 rounded px-1 text-left font-medium ${showVerification ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-hover'}`}
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {t('decisions.review.verification', { defaultValue: 'Verification' })}
                  </button>
                  {verificationQ.status === 'loading' && <div className="px-1 text-muted-foreground">{t('common.loading', { defaultValue: 'Loading…' })}</div>}
                  {verificationQ.status === 'error' && <div className="px-1 text-red-11">{t('decisions.review.loadFailed', { defaultValue: 'Could not load the review' })}</div>}
                  {verification && verification.kinds.length === 0 && (
                    <div className="px-1 text-muted-foreground">{t('decisions.review.noChecks', { defaultValue: 'No checks defined or run' })}</div>
                  )}
                  {verification?.kinds.map((k) => (
                    <button key={k.kind} onClick={() => setShowVerification(true)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-hover">
                      <span className="text-foreground">{kindLabel(k.kind)}</span>
                      <span className={`ml-auto ${STATE_STYLE[k.state]}`}>{stateLabel(k.state)}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="p-2">
                <div className="mb-1 font-medium text-muted-foreground">
                  {t('decisions.review.changes', { defaultValue: 'Changes' })}
                  {review && !review.empty && ` · ${reviewedCount}`}
                </div>
                {reviewQ.status === 'loading' && <div className="text-muted-foreground">{t('common.loading', { defaultValue: 'Loading…' })}</div>}
                {reviewQ.status === 'error' && <div className="text-red-11">{t('decisions.review.loadFailed', { defaultValue: 'Could not load the review' })}</div>}
                {review?.empty && !snapshotsGone && <div className="text-muted-foreground">{t('decisions.review.noChanges', { defaultValue: 'No file changes in these turns' })}</div>}
                {snapshotsGone && task && (
                  <>
                    <div className="mb-1 text-muted-foreground">{t('decisions.review.snapshotsExpired', { defaultValue: 'The original snapshots have expired; only the file list is kept.' })}</div>
                    {task.files.map((f) => (
                      <div key={f.path} className="truncate py-0.5 text-foreground" title={f.path}>{f.path}</div>
                    ))}
                  </>
                )}
                {groups.map((g) => {
                  const collapsed = g.category === 'other-session' && !showOthers;
                  return (
                    <div key={g.category} className="mb-2">
                      <button
                        className={`flex w-full items-center gap-1 py-0.5 text-left ${CATEGORY_STYLE[g.category]}`}
                        onClick={g.category === 'other-session' ? () => setShowOthers((v) => !v) : undefined}
                      >
                        {g.category === 'other-session' && (collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
                        <span className="font-medium">{categoryLabel(g.category)}</span>
                        <span className="text-foreground-subtle">{g.files.length}</span>
                      </button>
                      {!collapsed &&
                        g.files.map((f) => (
                          <button
                            key={f.path}
                            onClick={() => openFile(f.path)}
                            title={f.otherSessions.length ? `${f.path}\n${f.otherSessions.join(', ')}` : f.path}
                            className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left ${f.path === activePath && view === 'file' ? 'bg-accent text-foreground' : 'text-foreground hover:bg-hover'}`}
                          >
                            <span className="min-w-0 flex-1 truncate">{f.path}</span>
                            <span className="shrink-0 text-green-11">+{f.additions}</span>
                            <span className="shrink-0 text-red-11">-{f.deletions}</span>
                          </button>
                        ))}
                    </div>
                  );
                })}
                {review && !review.empty && review.truncated && (
                  <div className="text-muted-foreground">{t('decisions.review.truncated', { defaultValue: 'Too many files — the list is capped.' })}</div>
                )}
              </div>
            </div>

            {/* Right: verification details, or the diff of the selected file */}
            <div className="flex min-w-0 flex-1 flex-col">
              {view === 'summary' || view === 'decisions' ? (
                !choice.model ? (
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {t('decisions.review.pickModel', { defaultValue: 'Choose a model above to generate the summary and candidate decisions.' })}
                  </div>
                ) : extractionQ.status === 'loading' ? (
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {t('decisions.review.generatingLong', { defaultValue: 'Reading the conversation… the deterministic sections are ready on the left.' })}
                  </div>
                ) : extractionQ.status === 'error' ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                    <span>{t('decisions.review.extractionFailed', { defaultValue: 'Generation failed. You can still accept; no decisions will be kept unless you add them.' })}</span>
                    <button onClick={() => setExtractTick((n) => n + 1)} className="rounded border border-border px-2 py-0.5 text-foreground hover:bg-hover">
                      {t('decisions.review.retry', { defaultValue: 'Retry' })}
                    </button>
                    {view === 'decisions' && (
                      <DecisionsView candidates={[]} kept={kept} onToggle={toggleKept} manual={manual} onAddManual={addManual} onRemoveManual={removeManual} onOpenFile={openFile} />
                    )}
                  </div>
                ) : extraction && view === 'summary' ? (
                  <SummaryView result={extraction} onOpenFile={openFile} onOpenRun={openVerification} />
                ) : extraction ? (
                  <DecisionsView candidates={extraction.candidates} kept={kept} onToggle={toggleKept} manual={manual} onAddManual={addManual} onRemoveManual={removeManual} onOpenFile={openFile} />
                ) : null
              ) : showVerification ? (
                <div className="flex-1 overflow-y-auto p-3 text-xs">
                  {verification?.runs.length === 0 && (
                    <div className="mb-2 text-muted-foreground">{t('decisions.review.noRuns', { defaultValue: 'The agent ran no checks in these turns.' })}</div>
                  )}
                  {verification?.runs.map((r) => (
                    <div key={r.toolId} className="mb-3 rounded border border-border p-2">
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 font-medium ${STATE_STYLE[r.state]}`}>{stateLabel(r.state)}</span>
                        <span className="shrink-0 text-foreground-subtle">{kindLabel(r.kind)}</span>
                        {r.exitCode !== undefined && <span className="shrink-0 text-foreground-subtle">exit {r.exitCode}</span>}
                        {r.filtered && <span className="shrink-0 text-foreground-subtle">{t('decisions.review.partial', { defaultValue: 'partial run' })}</span>}
                        <button
                          onClick={() => void correctCheck(r.command, false)}
                          className="ml-auto shrink-0 rounded px-1 text-muted-foreground hover:bg-hover hover:text-foreground"
                        >
                          {t('decisions.review.notACheck', { defaultValue: 'Not a check' })}
                        </button>
                      </div>
                      <code className="mt-1 block break-all font-mono text-foreground">{r.command}</code>
                      {r.changedAfter.length > 0 && (
                        <div className="mt-1 text-amber-11">
                          {t('decisions.review.changedAfter', { defaultValue: 'Changed afterwards:' })} {r.changedAfter.join(', ')}
                          {r.approximate && ` (${t('decisions.review.approximate', { defaultValue: 'code index not ready — assumed relevant' })})`}
                        </div>
                      )}
                      {r.tail && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-muted-foreground">{t('decisions.review.output', { defaultValue: 'Output' })}</summary>
                          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-foreground">{r.tail}</pre>
                        </details>
                      )}
                    </div>
                  ))}
                  {verification && verification.otherCommands.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-muted-foreground">
                        {t('decisions.review.otherCommands', { defaultValue: 'Other commands ({{count}})', count: verification.otherCommands.length })}
                      </summary>
                      {verification.otherCommands.map((c) => (
                        <div key={c.toolId} className="flex items-center gap-2 py-0.5">
                          <code className="min-w-0 flex-1 truncate font-mono text-foreground" title={c.command}>{c.command}</code>
                          <button onClick={() => void correctCheck(c.command, true)} className="shrink-0 rounded px-1 text-muted-foreground hover:bg-hover hover:text-foreground">
                            {t('decisions.review.isACheck', { defaultValue: 'This is a check' })}
                          </button>
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              ) : active ? (
                active.oldContent === null && active.newContent === null ? (
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    {t('decisions.review.notViewable', { defaultValue: 'Binary or too large to show' })}
                  </div>
                ) : (
                  <DiffView
                    key={active.path}
                    oldContent={active.oldContent ?? ''}
                    newContent={active.newContent ?? ''}
                    filePath={active.path}
                    isNew={active.status === 'added'}
                    isDeleted={active.status === 'deleted'}
                    cwd={cwd}
                  />
                )
              ) : (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  {t('decisions.review.pickFile', { defaultValue: 'Select a file' })}
                </div>
              )}
            </div>
          </div>

          {live && (
            <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-2">
              <span className="mr-auto text-xs text-muted-foreground">
                {t('decisions.review.acceptHint', { defaultValue: 'Accepting freezes this range and the content of its files.' })}
              </span>
              <button
                onClick={() => void accept()}
                disabled={accepting || !review || review.empty || selected.length === 0}
                className="rounded bg-brand px-3 py-1 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t('decisions.review.accept', { defaultValue: 'Accept this range' })}
              </button>
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
});
