'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { MessageBubble } from './MessageBubble';
import { postSessionByPath } from './useChatHistory';
import { getProjectName, getTaskSummary } from './useScheduledTasks';
import type { ScheduledTask } from './useScheduledTasks';
import type { ChatMessage } from './types';

/**
 * Right-hand pane of the scheduled-task board: the transcript of the session a
 * task fires into.
 *
 * A scheduled task persists no per-run output — the dispatcher writes back only
 * `lastFiredAt` / `lastResult`, and everything the agent actually said lands in
 * the chat session jsonl. So "the task's messages" can only be read back through
 * /api/session-by-path, exactly as SubagentTranscriptModal does for a subagent.
 *
 * Consequences worth stating, because they are data-layer facts and not choices
 * made here:
 * - Only the CURRENT session shows up. On a missing resume target the scheduler
 *   opens a fresh session and rebinds `task.sessionId` (server/scheduledTasks.ts),
 *   so earlier runs live in a session this task no longer points at.
 * - The tail is all that is loaded (`limit: PREVIEW_TURNS` paginates backwards by
 *   turn); a long-running session is not fetched in full for a peek.
 *
 * Mounted with `key={task.id}` by the board, so switching tasks remounts this
 * component — there is no in-component "selection changed" reset to keep honest.
 */

const POLL_INTERVAL_MS = 5_000;
/** Turns fetched from the tail — enough to cover the last fire, cheap to poll. */
const PREVIEW_TURNS = 20;

interface ScheduledTaskPreviewProps {
  task: ScheduledTask;
  onOpenSession: () => void;
}

export function ScheduledTaskPreview({ task, onOpenSession }: ScheduledTaskPreviewProps) {
  const { t } = useTranslation();
  const { cwd, sessionId } = task;
  // null = still loading; [] = loaded and there is nothing to show
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const fingerprintRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const fetchTranscript = async () => {
      const exit = await BrowserRuntime.runPromiseExit(
        postSessionByPath({
          cwd,
          sessionId,
          limit: PREVIEW_TURNS,
          ifFingerprint: fingerprintRef.current,
        })
      );
      if (cancelled) return;
      // A failed read resolves the loading state to "nothing"; a failed poll
      // after a good read keeps what is already on screen.
      if (exit._tag !== 'Success' || !exit.value) { setMessages((prev) => prev ?? []); return; }
      const data = exit.value as {
        notModified?: boolean;
        fingerprint?: string;
        messages?: ChatMessage[];
      };
      if (data.fingerprint) fingerprintRef.current = data.fingerprint;
      if (data.notModified) return;
      if (data.messages) setMessages(data.messages);
    };

    fetchTranscript();
    // A task can fire while the board is open, so poll unconditionally — the
    // fingerprint makes every unchanged poll a no-op on both sides.
    const timer = setInterval(fetchTranscript, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [cwd, sessionId]);

  // Stick to bottom (the newest run) unless the user has scrolled up to read.
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  };
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    // flex-1 (not just h-full): the parent is a flex ROW, so without it the pane
    // shrinks to its content width and the transcript wraps into a sliver.
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Header — the only place that still navigates to the session, since a
          card click now just selects (board click behaviour changed with the
          split layout). */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border flex-shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground truncate" data-tooltip={cwd}>
            {getProjectName(cwd)}
          </div>
          <div className="text-[11px] text-muted-foreground truncate" data-tooltip={getTaskSummary(task)}>
            {getTaskSummary(task)}
          </div>
        </div>
        <button
          onClick={onOpenSession}
          className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-hover transition-colors"
          title={t('scheduledTasks.openSession')}
        >
          <span>{t('scheduledTasks.openSession')}</span>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
          </svg>
        </button>
      </div>

      {/* Transcript — fills the pane. The board is already width-limited by
          MODAL_SHELL_CLASS, so an extra measure cap here only left a dead strip
          down the right-hand side. */}
      <div ref={bodyRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-3">
        {messages === null || messages.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-6">
            {messages === null ? t('common.loading') : t('scheduledTasks.noTaskMessages')}
          </div>
        ) : (
          // `disableOverlays` drops only the controls that would open a window on
          // top of the app (diff viewer, file/image previews, subagent + workflow
          // transcripts, tool input/result viewers) — each of those is a Portal on
          // <body> at z-50, i.e. behind this board (z-[70]). Everything in-place
          // stays live: expand/collapse a tool call, copy a path, select text.
          //
          // Links are killed separately, and for a different reason: this pane
          // passes no `onOpenFileLink`, so MarkdownRenderer leaves the anchor to
          // the browser and a click would navigate the whole Cockpit window away.
          <div className="[&_a]:pointer-events-none">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} cwd={cwd} disableOverlays />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
