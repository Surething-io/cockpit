'use client';

import { isRecoverySettlement, type RecoveryDeletion } from '../shared/recoveryCopy';
import { useRef, useCallback, useId } from 'react';
import { useWebSocket } from '@cockpit/shared-ui';
import { estimateOutputUnits } from '@cockpit/shared-utils/outputProgress';
import type { ChatMessage, ChatEngine, LiveOutputTokens, BackgroundTaskInfo } from './types';
import { isSubagentFrame, isTaskEvent, settleRunningTasks, type StreamEvent } from './applyStreamEvent';
import { buildNoticeMessage } from './systemNotice';
import type { TaskStore } from './taskStore';
import type { LiveHistoryRun, RunMessageUpdate, HistoryMessageUpdate } from './chatHistoryState';

// #10 viewer hook: tail /ws/session-stream for `sessionId` and render live through the
// SAME reducer the originator uses (applyStreamEvent) → engine-agnostic, zero per-engine
// code. The registry stores the SSE events every route emits; the viewer creates the
// assistant bubble on `system.init` (universal turn-start) and feeds the rest through
// applyStreamEvent. The user bubble is the synthetic `_human` event the run seeds.
//
// The session-stream SNAPSHOT is the source of truth for "is a run live", NOT the
// global-state broadcast (which races a freshly-loaded tab and is delivered once over a
// shared connection): connect whenever this tab is viewing the session, and let the
// snapshot's `status` decide. An idle snapshot → render nothing (disk history is
// authoritative); a running snapshot → replay + tail. opts.onRunningChange drives the
// "thinking" indicator / input lock; opts.onRunEnd reports writer ownership
// so the caller can replace live content with a final disk read.
// The returned callback replays archived snapshots; null session + disabled uses
// the same projection without a transport or live-progress callbacks.
export function useLiveStream(
  sessionId: string | null,
  updateRunMessages: RunMessageUpdate,
  enabled: boolean,
  engine?: ChatEngine,
  opts?: {
    onlyRunId?: string;
    onRecoveryDeleted?: (deletion: RecoveryDeletion) => void;
    onRunningChange?: (running: boolean) => void;
    onSnapshotStart?: (run: LiveHistoryRun) => void;
    onWriterIdle?: (sessionId: string) => void;
    onRunEnd?: (writerActive: boolean, runId: string, failed?: boolean) => void;
    onLiveOutputTokens?: (tokens: LiveOutputTokens | null) => void;
    onRunStartedAt?: (startedAt: number | null) => void;
    /** Live set of non-ambient background tasks (REPLACE semantics), mirroring useChatStream. */
    onBackgroundTasks?: (tasks: BackgroundTaskInfo[]) => void;
    /** Sink for `system/task_*` events at every spawn depth — see taskStore.ts. */
    taskStore?: TaskStore;
  }
): (snapshot: object) => void {
  // Each subscriber needs its own initial snapshot, including a sender/viewer handoff.
  const subscriptionId = useId();
  const curAssistantId = useRef<string | null>(null);
  const seq = useRef(0);
  const liveRun = useRef<(LiveHistoryRun & { active: boolean }) | null>(null);
  const setMessages = useCallback<(update: HistoryMessageUpdate) => void>((update) => {
    if (liveRun.current) updateRunMessages(liveRun.current.id, update);
  }, [updateRunMessages]);
  const waitingForWriter = useRef(false);
  const taskNumber = useRef(0);
  const taskTime = useRef(0);
  const taskSeeded = useRef(false);
  const sourceTaskId = useRef<string | undefined>(undefined);
  const liveMetadata = () => ({
    liveRunId: liveRun.current?.id,
    sourceTaskId: sourceTaskId.current,
    turnStartedAt: new Date(taskTime.current || liveRun.current?.startedAt || Date.now()).toISOString(),
    ...(engine === 'codex' ? { turnId: `live-task-${liveRun.current?.id}-${taskNumber.current}` } : {}),
  });
  const fallbackOutputTokens = useRef(0);
  const sawServerUsageUpdate = useRef(false);
  const sawResult = useRef(false);
  // Whether a turn is actively producing (between system.init and its result). Used to tell a
  // BACKGROUND task's notification (arrives while idle, after a result) from a foreground
  // subagent's (arrives mid-turn, already shown as its tool call).
  const turnActive = useRef(false);

  // Set by a message sent into the run after it started (mid-turn, or while resident on
  // background tasks): the model's next message opens a fresh bubble below that user bubble.
  const splitPending = useRef(false);
  const consumptionBound = useRef(false);

  // Snapshot replay and event-only handoff both start a fresh run projection.
  const beginRun = (run: LiveHistoryRun) => {
    liveRun.current = { ...run, active: true };
    waitingForWriter.current = false;
    sourceTaskId.current = undefined;
    taskNumber.current = 0;
    taskTime.current = run.startedAt;
    taskSeeded.current = false;
    curAssistantId.current = null;
    seq.current = 0;
    fallbackOutputTokens.current = 0;
    sawServerUsageUpdate.current = false;
    sawResult.current = false;
    turnActive.current = false;
    splitPending.current = false;
    consumptionBound.current = false;
    opts?.onSnapshotStart?.(run);
    opts?.onLiveOutputTokens?.(null);
    opts?.onRunStartedAt?.(run.startedAt);
    opts?.onBackgroundTasks?.([]);
  };

  const newPlaceholder = (): string => {
    const id = `live-asst-${liveRun.current?.id}-${++seq.current}`;
    curAssistantId.current = id;
    const metadata = liveMetadata();
    setMessages((prev) => [
      ...prev,
      { id, role: 'assistant', content: '', isStreaming: true, timestamp: metadata.turnStartedAt, ...metadata } as ChatMessage,
    ]);
    return id;
  };

  const apply = (ev: StreamEvent) => {
    // A subagent's frames are not this turn's — see isSubagentFrame. Returned before the
    // `curAssistantId ?? newPlaceholder()` at the bottom, so a viewer whose first event happens
    // to be a subagent tick does not open an empty bubble for it either.
    if (isSubagentFrame(ev)) return;
    const publishOutputProgress = (tokens: number) => {
      opts?.onLiveOutputTokens?.({
        outputTokens: Math.max(0, Math.round(tokens)),
      });
    };
    const bumpOutputProgress = (text: unknown) => {
      if (sawServerUsageUpdate.current || typeof text !== 'string' || !text) return;
      fallbackOutputTokens.current += estimateOutputUnits(text);
      publishOutputProgress(fallbackOutputTokens.current);
    };

    if (ev.type === 'system' && ev.subtype === 'init') {
      const isFollowUpTurn = sawResult.current;
      if (engine === 'codex' && isFollowUpTurn && !taskSeeded.current) taskNumber.current++;
      if (typeof ev._ts === 'number' && Number.isFinite(ev._ts)) taskTime.current = ev._ts;
      taskSeeded.current = false;
      turnActive.current = true;
      if (!isFollowUpTurn) {
        fallbackOutputTokens.current = 0;
        sawServerUsageUpdate.current = false;
        opts?.onLiveOutputTokens?.(null);
        opts?.onRunStartedAt?.(Date.now());
      }
      splitPending.current = false;
      newPlaceholder(); // turn-start → new assistant bubble
      return;
    }
    if (ev.type === 'usage_update') {
      if (typeof ev.output_tokens === 'number' && Number.isFinite(ev.output_tokens)) {
        sawServerUsageUpdate.current = true;
        fallbackOutputTokens.current = Math.max(fallbackOutputTokens.current, Math.round(ev.output_tokens));
        publishOutputProgress(fallbackOutputTokens.current);
      }
      return;
    }
    if (ev.type === 'stream_event') {
      const raw = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (splitPending.current && raw?.type === 'message_start') {
        splitPending.current = false;
        const prevId = curAssistantId.current;
        if (prevId) setMessages((prev) => prev.map((m) => (m.id === prevId ? { ...m, isStreaming: false } : m)));
        newPlaceholder();
      }
      if (raw?.type === 'content_block_delta' && raw.delta?.type === 'text_delta') {
        bumpOutputProgress(raw.delta.text);
      }
    }
    // The live background-task set (REPLACE semantics — swap, never pair start/stop edges).
    // The originator gets this through useChatStream; without it here the viewer's loading
    // bubble cannot say what a resident run is still waiting on.
    if (ev.type === 'system' && ev.subtype === 'input_started' && ev.inputId) {
      consumptionBound.current = true;
      splitPending.current = false;
      const id = `input-asst-${ev.inputId}`;
      curAssistantId.current = id;
      setMessages({ event: ev, engine, assistantId: id });
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'input_binding') {
      setMessages({ event: ev, engine, assistantId: '' });
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'task_binding' && typeof ev.taskId === 'string') {
      sourceTaskId.current = ev.taskId;
      setMessages((prev) => prev.map((message) => message.liveRunId === liveRun.current?.id
        ? { ...message, sourceTaskId: sourceTaskId.current } : message));
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'background_tasks_changed') {
      const live = ev.tasks ?? [];
      opts?.onBackgroundTasks?.(
        live.filter((t) => !t.ambient).map((t) => ({ task_id: t.task_id, description: t.description }))
      );
      return;
    }
    // A spawned task narrating its own life → fold into the tool call that launched it (the
    // reducer keys on `tool_use_id`, so it lands on the launching row whichever bubble that is
    // by now). task_notification falls through: it ALSO renders a system row below.
    if (isTaskEvent(ev)) {
      // Both sinks — see the same call in useChatStream.
      opts?.taskStore?.applyEvent(ev);
      setMessages({ event: ev, engine, assistantId: curAssistantId.current ?? '' });
      if (ev.subtype !== 'task_notification') return;
    }
    // Background task reporting back. When it arrives while idle (after a result, before the next
    // turn) it's a real background completion → render a muted system-event bar live, matching the
    // disk-reload view. A notification that arrives mid-turn is a foreground subagent (already
    // shown as its tool call) → skip.
    if (ev.type === 'system' && ev.subtype === 'task_notification') {
      if (!turnActive.current) {
        const id = `live-tasknotif-${ev.task_id || ++seq.current}`;
        const detail =
          `<task-notification>\n` +
          (ev.task_id ? `<task-id>${ev.task_id}</task-id>\n` : '') +
          (ev.tool_use_id ? `<tool-use-id>${ev.tool_use_id}</tool-use-id>\n` : '') +
          (ev.status ? `<status>${ev.status}</status>\n` : '') +
          (ev.summary ? `<summary>${ev.summary}</summary>\n` : '') +
          (ev.output_file ? `<output-file>${ev.output_file}</output-file>\n` : '') +
          `</task-notification>`;
        const metadata = liveMetadata();
        setMessages((prev) => [
          ...prev,
          {
            ...metadata,
            id,
            role: 'system',
            content: ev.summary || '',
            systemEvent: { kind: 'task-notification', ...(ev.status ? { status: ev.status } : {}), detail },
          } as ChatMessage,
        ]);
      }
      return;
    }
    // Engine-level advisory about the run (see systemNotice.ts). The originator renders the
    // same row through useChatStream; a tab merely WATCHING the session needs it just as much,
    // because the session id it is tailing is exactly what such a notice reports on.
    if (ev.type === 'system' && ev.subtype === 'notice') {
      const row = buildNoticeMessage(ev, `live-notice-${++seq.current}`);
      const metadata = liveMetadata();
      if (row) setMessages((prev) => [...prev, { ...row, ...metadata }]);
      return;
    }
    // A run projection owns its complete input sequence. Deduplicate only this
    // input's identity; disk/live reconciliation belongs to the history owner.
    if (ev.type === 'user' && ev._human) {
      const c = ev.message?.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((b) => (b as { text?: string })?.text || '').join('')
          : '';
      const turnId = typeof ev._turnId === 'string' ? ev._turnId : null;
      // A turn of this run already happened → this message was sent into the live run.
      if (!consumptionBound.current && (turnActive.current || sawResult.current)) splitPending.current = true;
      const startedAt = typeof ev._ts === 'number' && Number.isFinite(ev._ts) ? ev._ts : null;
      if (engine === 'codex' && !turnActive.current && sawResult.current) taskNumber.current++;
      if (engine !== 'codex' || !turnActive.current) taskTime.current = startedAt ?? liveRun.current?.startedAt ?? Date.now();
      taskSeeded.current = true;
      const metadata = liveMetadata();
      const id = turnId ? `live-user-${turnId}` : `live-user-${liveRun.current?.id}-${++seq.current}`;
      setMessages((prev) => {
        // Layer 1 — identity: this turn's live bubble was already rendered.
        if (turnId && prev.some((m) => m.id === id || m.liveInputId === turnId)) return prev;
        return [...prev, { id, role: 'user', content: text, ...metadata, liveInputId: turnId ?? undefined, ...(startedAt !== null ? { timestamp: new Date(startedAt).toISOString() } : {}), ...(ev._images?.length ? { images: ev._images } : {}) } as ChatMessage];
      });
      return;
    }
    // A result ends the active turn — after it, an incoming task_notification is a background one.
    if (ev.type === 'result') {
      turnActive.current = false;
      sawResult.current = true;
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content as Array<{ text?: string; name?: string; input?: unknown }>) {
        if (block.text) bumpOutputProgress(block.text);
        else if (block.name) bumpOutputProgress(`${block.name} ${JSON.stringify(block.input ?? {})}`);
      }
    }
    if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content as Array<{ content?: unknown }>) {
        bumpOutputProgress(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''));
      }
    }
    // content events need a current bubble (init normally comes first; be safe)
    const assistantId = curAssistantId.current ?? newPlaceholder();
    setMessages({ event: ev, engine, assistantId });
  };

  const detachedFinished = useRef(false);
  const receive = (data: unknown) => {
    if (opts?.onlyRunId && detachedFinished.current) return;
    const msg = data as {
      type?: string;
      status?: string;
      startedAt?: number;
      runId?: string;
      events?: unknown[];
      outputTokens?: number;
      writerActive?: boolean;
      recovery?: boolean;
      recoveryDeletions?: RecoveryDeletion[];
      message?: Record<string, unknown>;
    };
    if (opts?.onlyRunId && msg.type === 'run-snapshot' && msg.runId !== opts.onlyRunId) {
      if (msg.recovery) return;
      detachedFinished.current = true;
      opts.onRunEnd?.(false, opts.onlyRunId);
      return;
    }
    if (msg.type === 'run-snapshot' && Array.isArray(msg.events)) {
      // This ordered subscription has moved to another run. Its preceding
      // writer must have released, even if every intervening terminal event
      // was missed. Retire only the run this viewer actually observed: a
      // separate optimistic/accepted sender must keep its own ownership.
      if (!msg.recovery && liveRun.current && msg.runId && msg.runId !== liveRun.current.id) {
        opts?.onRunEnd?.(false, liveRun.current.id);
      }
      // An idle run may still be flushing. Reconcile an observed run only
      // after release, including release learned through a reconnect snapshot.
      const draining = msg.status !== 'running' && msg.writerActive === true && msg.events.length > 0;
      // Failed runs may never reach persistence (for example, init/auth errors).
      // Replay their retained events even after release so reconnect sees the error.
      const failed = msg.status === 'error';
      if (msg.status !== 'running' && !draining && !(failed && msg.events.length)) {
        waitingForWriter.current = msg.writerActive === true;
        if (liveRun.current) liveRun.current.active = false;
        const endedId = typeof msg.runId === "string" ? msg.runId : liveRun.current?.id;
        if (endedId) opts?.onRunEnd?.(waitingForWriter.current, endedId, failed);
        if (!waitingForWriter.current && sessionId) opts?.onWriterIdle?.(sessionId);
        opts?.onRunningChange?.(false);
        opts?.onLiveOutputTokens?.(null);
        opts?.onRunStartedAt?.(null);
        opts?.onBackgroundTasks?.([]);
        setMessages(settleRunningTasks);
        opts?.taskStore?.settleRunning();
        fallbackOutputTokens.current = 0;
        sawServerUsageUpdate.current = false;
        sawResult.current = false;
        for (const deletion of msg.recoveryDeletions ?? []) opts?.onRecoveryDeleted?.(deletion);
        return;
      }
      const startedAt = typeof msg.startedAt === 'number' ? msg.startedAt : null;
      const run = { id: msg.runId || `${sessionId}:${startedAt}`, startedAt: startedAt ?? Date.now(), recovery: msg.recovery };
      beginRun(run);
      const snapshotOutputTokens = typeof msg.outputTokens === 'number' && Number.isFinite(msg.outputTokens)
        ? Math.max(0, Math.round(msg.outputTokens))
        : null;
      if (snapshotOutputTokens !== null) {
        fallbackOutputTokens.current = snapshotOutputTokens;
        sawServerUsageUpdate.current = true;
        opts?.onLiveOutputTokens?.({ outputTokens: snapshotOutputTokens });
      }
      for (const ev of msg.events) {
        apply(ev as StreamEvent);
      }
      if (draining || failed) {
        waitingForWriter.current = msg.writerActive === true;
        liveRun.current!.active = false;
        opts?.onRunEnd?.(waitingForWriter.current, run.id, failed);
        setMessages(settleRunningTasks);
      }
      for (const deletion of msg.recoveryDeletions ?? []) opts?.onRecoveryDeleted?.(deletion);
      opts?.onRunningChange?.(!draining && !failed);
      opts?.onRunStartedAt?.(failed ? null : typeof msg.startedAt === 'number' ? msg.startedAt : Date.now());
    } else if (msg.type === 'run-event' && msg.message) {
      if (msg.message.type === 'recovery-deleted') {
        opts?.onRecoveryDeleted?.(msg.message.deletion as RecoveryDeletion);
        return;
      }
      // 'run-ended' is the single definitive end signal — engines may emit several
      // intermediate 'result's (codex = one per turn), so end only on run-ended.
      if (msg.message.type === 'run-ended' || msg.message.type === 'run-settled') {
        if (typeof msg.message.runId === 'string' && liveRun.current && msg.message.runId !== liveRun.current.id) return;
        waitingForWriter.current = msg.message.type === 'run-ended' && msg.message.writerActive === true;
        if (liveRun.current) liveRun.current.active = false;
        const endedId = typeof msg.message.runId === "string" ? msg.message.runId : liveRun.current?.id;
        if (endedId) opts?.onRunEnd?.(waitingForWriter.current, endedId, msg.message.status === 'error');
        opts?.onRunningChange?.(false);
        opts?.onLiveOutputTokens?.(null);
        opts?.onRunStartedAt?.(null);
        opts?.onBackgroundTasks?.([]);
        setMessages(settleRunningTasks);
        opts?.taskStore?.settleRunning();
        fallbackOutputTokens.current = 0;
        sawServerUsageUpdate.current = false;
        sawResult.current = false;
        return;
      }
      if (waitingForWriter.current) {
        if (isRecoverySettlement(msg.message)) apply(msg.message as StreamEvent);
        return;
      }
      const event = msg.message as StreamEvent;
      const startsRun = !liveRun.current?.active;
      if (startsRun) {
        const run = { id: typeof event._turnId === 'string' ? event._turnId : `${sessionId}:${event._ts ?? Date.now()}`, startedAt: event._ts ?? Date.now() };
        beginRun(run);
      }
      apply(event);
      opts?.onRunningChange?.(true);
    } else if (msg.type === 'run-idle') {
      for (const deletion of msg.recoveryDeletions ?? []) opts?.onRecoveryDeleted?.(deletion);
      if (sessionId) opts?.onWriterIdle?.(sessionId);
      waitingForWriter.current = false;
      if (liveRun.current) liveRun.current.active = false;
      if (liveRun.current) opts?.onRunEnd?.(false, liveRun.current.id);
      opts?.onRunningChange?.(false);
      opts?.onLiveOutputTokens?.(null);
      opts?.onRunStartedAt?.(null);
      opts?.onBackgroundTasks?.([]);
      setMessages(settleRunningTasks);
      opts?.taskStore?.settleRunning();
      fallbackOutputTokens.current = 0;
      sawServerUsageUpdate.current = false;
      sawResult.current = false;
    }
    // ping: nothing to do
  };

  useWebSocket({
    url: sessionId ? `/ws/session-stream?sessionId=${encodeURIComponent(sessionId)}&subscriber=${encodeURIComponent(subscriptionId)}` : '/ws/session-stream',
    enabled: enabled && !!sessionId,
    onMessage: (data) => {
      // One transport frame contains recovery and current ownership, so React commits
      // the current run's indicators rather than an intermediate archived failure.
      for (const recovery of (data as { recoveries?: unknown[] }).recoveries ?? []) receive(recovery);
      receive(data);
      if (opts?.onlyRunId && liveRun.current?.id === opts.onlyRunId && !waitingForWriter.current && !liveRun.current.active) detachedFinished.current = true;
    },
  });
  return (snapshot) => receive({ ...snapshot, recovery: true });
}
