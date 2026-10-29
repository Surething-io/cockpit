'use client';

import { useTranslation } from 'react-i18next';
import { SessionTranscriptPreview } from './SessionTranscriptPreview';
import { getTaskSummary } from './useScheduledTasks';
import type { ScheduledTask } from './useScheduledTasks';

/**
 * Right-hand pane of the scheduled-task board: the transcript of the session a
 * task fires into.
 *
 * A scheduled task persists no per-run output — the dispatcher writes back only
 * `lastFiredAt` / `lastResult`, and everything the agent actually said lands in
 * the chat session jsonl. So "the task's messages" are that session's messages.
 *
 * Only the CURRENT session shows up — a data-layer fact, not a choice made here.
 * On a missing resume target the scheduler opens a fresh session and rebinds
 * `task.sessionId` (server/scheduledTasks.ts), so earlier runs live in a session
 * this task no longer points at.
 *
 * Mounted with `key={task.id}` by the board, so switching tasks remounts the
 * transcript.
 */
interface ScheduledTaskPreviewProps {
  task: ScheduledTask;
  onOpenSession: () => void;
}

export function ScheduledTaskPreview({ task, onOpenSession }: ScheduledTaskPreviewProps) {
  const { t } = useTranslation();
  return (
    <SessionTranscriptPreview
      cwd={task.cwd}
      sessionId={task.sessionId}
      subtitle={getTaskSummary(task)}
      emptyText={t('scheduledTasks.noTaskMessages')}
      onOpenSession={onOpenSession}
    />
  );
}
