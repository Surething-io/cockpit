'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Effect } from 'effect';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useEffectQuery } from '@cockpit/effect-react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { Portal, blurActiveElement, toast } from '@cockpit/shared-ui';
import { DiffView } from '@cockpit/feature-explorer';
import {
  acceptReview,
  loadAcceptedTask,
  loadReview,
  type AcceptedTask,
  type FileCategory,
  type ReviewFile,
  type ReviewResult,
  type ReviewTurn,
} from '@cockpit/feature-decisions';

/**
 * Decision-mode task review (docs/DECISION_MODE.md §4.2) — the deterministic
 * part: range, goal, attributed changes, accept. Later steps add result
 * summary, decisions, verification and impact sections to the left column.
 *
 * Full-window Portal, like DiffViewerModal's standalone wrapper: a review
 * spans the whole task, so it does not belong to any one of the three panels.
 */

export type ReviewModalMode = { kind: 'live'; turns: ReviewTurn[]; initialStart: number } | { kind: 'accepted'; taskId: string };

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

  const groups = useMemo(() => {
    const files = review && !review.empty ? review.files : [];
    return CATEGORY_ORDER.map((c) => ({ category: c, files: files.filter((f) => f.category === c) })).filter((g) => g.files.length > 0);
  }, [review]);
  const reviewedCount = useMemo(
    () => groups.filter((g) => g.category !== 'other-session').reduce((n, g) => n + g.files.length, 0),
    [groups],
  );

  const [activePath, setActivePath] = useState<string | null>(null);
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
    const exit = await BrowserRuntime.runPromiseExit(acceptReview(cwd, sessionId, goal, selected));
    setAccepting(false);
    if (exit._tag !== 'Success') {
      toast(t('decisions.review.acceptFailed', { defaultValue: 'Could not accept this review' }), 'error');
      return;
    }
    toast(t('decisions.review.accepted', { defaultValue: 'Review accepted' }), 'success');
    onAccepted?.(exit.value.task);
    onClose();
  }, [live, selected, cwd, sessionId, goal, onAccepted, onClose, t]);

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
                onChange={(e) => setGoal(e.target.value)}
                placeholder={t('decisions.review.goalPlaceholder', { defaultValue: 'Goal of this task' })}
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {task ? `${task.goal || '—'} · ${new Date(task.acceptedAt).toLocaleString()}` : ''}
              </span>
            )}
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
                            onClick={() => setActivePath(f.path)}
                            title={f.otherSessions.length ? `${f.path}\n${f.otherSessions.join(', ')}` : f.path}
                            className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left ${f.path === activePath ? 'bg-accent text-foreground' : 'text-foreground hover:bg-hover'}`}
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

            {/* Right: diff of the selected file */}
            <div className="flex min-w-0 flex-1 flex-col">
              {active ? (
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
