'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { History, Scale } from 'lucide-react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadReview, loadSessionTasks, useDecisionMode, type AcceptedTaskSummary } from '@cockpit/feature-decisions';
import type { ChatMessage } from '../types';
import { buildReviewTurns, defaultRangeStart, rangeEvidence } from './reviewTurns';
import { loadVerification } from '../effect/verificationClient';
import { ReviewModal, type ReviewModalMode } from './ReviewModal';

interface ReviewStatusBarProps {
  cwd: string | undefined;
  sessionId: string | null | undefined;
  messages: ChatMessage[];
  running: boolean;
  hasMoreHistory: boolean;
  /** Session engine + its current model: default for the extraction model (§9). */
  engine?: string;
  sessionModel?: string;
}

/**
 * Decision-mode status bar above the chat input (docs/DECISION_MODE.md §4.1):
 * what changed since the last accepted review, and the way into the review.
 * Renders nothing while decision mode is off or the range has no file changes.
 */
export const ReviewStatusBar = memo(function ReviewStatusBar({ cwd, sessionId, messages, running, hasMoreHistory, engine, sessionModel }: ReviewStatusBarProps) {
  const { t } = useTranslation();
  const { enabled, resolution } = useDecisionMode(cwd);
  const enabledAt = resolution?.status === 'resolved' ? resolution.enabledAt : undefined;
  const active = enabled && !!cwd && !!sessionId;

  // Accepted reviews of this session (re-read after each accept).
  const [tasks, setTasks] = useState<AcceptedTaskSummary[]>([]);
  const [tasksTick, setTasksTick] = useState(0);
  useEffect(() => {
    if (!active || !cwd || !sessionId) return;
    let cancelled = false;
    void BrowserRuntime.runPromiseExit(loadSessionTasks(cwd, sessionId)).then((exit) => {
      if (!cancelled && exit._tag === 'Success') setTasks(exit.value.tasks);
    });
    return () => {
      cancelled = true;
    };
  }, [active, cwd, sessionId, tasksTick]);

  const turns = useMemo(() => (active ? buildReviewTurns(messages) : []), [active, messages]);
  const acceptedToolIds = useMemo(() => new Set(tasks.flatMap((x) => x.toolIds)), [tasks]);
  const start = useMemo(() => defaultRangeStart(turns, acceptedToolIds, enabledAt), [turns, acceptedToolIds, enabledAt]);
  const rangeTurns = turns.length - start;
  const toolKey = useMemo(() => turns.slice(start).flatMap((x) => x.toolIds).join(','), [turns, start]);

  // File count of the default range. Recomputed when a run ends, not on every
  // streamed token; the previous count stays visible meanwhile.
  const [fileCount, setFileCount] = useState(0);
  // Verification summary of the same range: kinds verified / kinds that matter.
  const [verified, setVerified] = useState<{ ok: number; total: number }>({ ok: 0, total: 0 });
  // Read through a ref so a streamed token does not restart the queries; they
  // re-run when the range's tool calls change or a run ends.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  useEffect(() => {
    if (!active || !cwd || running) return;
    if (!toolKey) {
      setFileCount(0);
      setVerified({ ok: 0, total: 0 });
      return;
    }
    let cancelled = false;
    void BrowserRuntime.runPromiseExit(loadReview(cwd, toolKey.split(','), true)).then((exit) => {
      if (cancelled || exit._tag !== 'Success') return;
      const r = exit.value;
      setFileCount(r.empty ? 0 : r.files.filter((f) => f.category !== 'other-session').length);
    });
    const ev = rangeEvidence(messagesRef.current, new Set(turns.slice(start).map((x) => x.id)));
    void BrowserRuntime.runPromiseExit(loadVerification(cwd, ev.orderedToolIds, ev.runs, ev.claimedPass)).then((exit) => {
      if (cancelled || exit._tag !== 'Success') return;
      const kinds = exit.value.kinds;
      setVerified({ ok: kinds.filter((k) => k.state === 'verified').length, total: kinds.length });
    });
    return () => {
      cancelled = true;
    };
    // turns/start are captured with toolKey (same range), so they are not listed separately.
  }, [active, cwd, running, toolKey, tasksTick]);

  const [modal, setModal] = useState<ReviewModalMode | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const onAccepted = useCallback(() => setTasksTick((n) => n + 1), []);
  const openReview = useCallback(
    () =>
      setModal({
        kind: 'live',
        turns,
        initialStart: start,
        messages: messagesRef.current,
        sessionEngine: engine ?? 'claude',
        ...(sessionModel ? { sessionModel } : {}),
        ...(resolution?.status === 'resolved' && resolution.extractionModel ? { savedModel: resolution.extractionModel } : {}),
      }),
    [turns, start, engine, sessionModel, resolution],
  );
  const onModalClose = useCallback(() => {
    setModal(null);
    setTasksTick((n) => n + 1); // a check correction made in the modal changes the summary
  }, []);

  if (!active || !cwd || !sessionId) return null;
  if (fileCount === 0 && tasks.length === 0) return null;

  return (
    <>
      {showHistory && tasks.length > 0 && (
        <div className="mx-3 mb-1 max-h-40 overflow-y-auto rounded border border-border bg-card text-xs">
          {tasks.map((task) => (
            <button
              key={task.id}
              onClick={() => {
                setShowHistory(false);
                setModal({ kind: 'accepted', taskId: task.id });
              }}
              className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-hover"
            >
              <span className="shrink-0 text-foreground-subtle">{new Date(task.acceptedAt).toLocaleString()}</span>
              <span className="min-w-0 flex-1 truncate text-foreground">{task.goal || task.turns[0]?.text || '—'}</span>
              <span className="shrink-0 text-muted-foreground">{t('decisions.review.fileCount', { defaultValue: '{{count}} files', count: task.fileCount })}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mx-3 mb-1 flex items-center gap-2 text-xs text-muted-foreground" data-testid="review-status-bar">
        <Scale className="h-3.5 w-3.5 shrink-0" />
        {fileCount > 0 ? (
          <>
            <span className="min-w-0 truncate">
              {t('decisions.review.sinceAccepted', {
                defaultValue: 'Since last accepted: {{turns}} turns · {{files}} files',
                turns: rangeTurns,
                files: fileCount,
              })}
              {verified.total > 0 &&
                ` · ${t('decisions.review.verifiedCount', { defaultValue: 'verification {{ok}}/{{total}}', ok: verified.ok, total: verified.total })}`}
              {hasMoreHistory && start === 0 && ` ${t('decisions.review.loadedOnly', { defaultValue: '(loaded turns only)' })}`}
            </span>
            <button onClick={openReview} className="shrink-0 rounded border border-border px-2 py-0.5 text-foreground hover:bg-hover">
              {t('decisions.review.open', { defaultValue: 'Review' })}
            </button>
          </>
        ) : (
          <span>{t('decisions.review.upToDate', { defaultValue: 'Everything since the last accepted review is reviewed' })}</span>
        )}
        {tasks.length > 0 && (
          <button
            onClick={() => setShowHistory((v) => !v)}
            aria-pressed={showHistory}
            title={t('decisions.review.history', { defaultValue: 'Accepted reviews' })}
            className="ml-auto flex shrink-0 items-center gap-1 rounded px-1 hover:bg-hover hover:text-foreground"
          >
            <History className="h-3.5 w-3.5" />
            {tasks.length}
          </button>
        )}
      </div>
      {modal && <ReviewModal cwd={cwd} sessionId={sessionId} mode={modal} onClose={onModalClose} onAccepted={onAccepted} />}
    </>
  );
});
