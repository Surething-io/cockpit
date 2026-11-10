'use client';

import { isRecoverySettlement, type RecoveryDeletion } from '../shared/recoveryCopy';
import { useState, useCallback, useRef, useId, useEffect, createElement, type ReactNode } from 'react';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { GROK_DEFAULT_MODEL, GROK_DEFAULT_REASONING } from '../shared/grokModels';
import { injectChatMessage, stopChat } from './effect/agentClient';
import { estimateOutputUnits } from '@cockpit/shared-utils/outputProgress';
import { isSubagentFrame, isTaskEvent, settleRunningTasks, type StreamEvent } from './applyStreamEvent';
import type {
  ChatMessage,
  ImageInfo,
  MessageImage,
  TokenUsage,
  LiveOutputTokens,
  RateLimitInfo,
  ApiRetryInfo,
  BackgroundTaskInfo,
  ChatEngine,
  EngineModelId,
  ClaudeModelId,
  ClaudeEffort,
  CodexModelId,
  CodexReasoningEffort,
} from './types';
import type { TaskStore } from './taskStore';
import { buildNoticeMessage } from './systemNotice';
import { useLiveStream } from './useLiveStream';
import i18n from '@cockpit/shared-i18n';
import { useWebSocket, toast } from '@cockpit/shared-ui';

// Stable identity for "no background tasks" so clearing never churns the prop and defeats memo.
// Exported so the viewer path (Chat/MobileChat, fed by useLiveStream) clears to the SAME
// reference — two "empty" arrays would each defeat MessageList's memo on every run end.
export const NO_BG_TASKS: BackgroundTaskInfo[] = [];

// Provisional run id the client generates per send so it can subscribe to the run's
// /ws/session-stream immediately — before the engine reveals its real sessionId.
function genRunId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `run-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

import type { RunMessageUpdate, LiveHistoryRun, HistoryFailure, HistoryMessageUpdate } from './chatHistoryState';

// Migrated from src/components/project/useChatStream.ts.

// ============================================
// Types
// ============================================

interface UseChatStreamOptions {
  sessionId: string | null;
  cwd?: string;
  engine?: ChatEngine;
  /** Plan mode (claude engine only): read-only exploration that produces a plan without editing */
  planMode?: boolean;
  /** Independent-task mode: send each user message with no prior history */
  noHistory?: boolean;
  /** Output style id; '' / undefined = none. Resolved to text server-side. */
  outputStyleId?: string;
  ollamaModel?: string;
  /** Model for the API-key engines (deepseek / kimi) — whichever of them is running. */
  engineModel?: EngineModelId;
  claudeModel?: ClaudeModelId;
  claudeEffort?: ClaudeEffort;
  claudeFastMode?: boolean;
  claudeThinking?: boolean;
  codexModel?: CodexModelId;
  codexReasoningEffort?: CodexReasoningEffort;
  grokModel?: string;
  grokReasoningEffort?: string;
  piThinkingLevel?: import('../shared/piThinking').PiThinkingLevel;
  onSessionId: (sid: string) => void;
  onFetchTitle: (sid: string) => void;
  /** Transfer message ownership before creating the originator's bubbles. */
  onSendStart?: (run: { id: string; startedAt: number }) => void;
  /** Generation can end before its writer releases the transcript. */
  onRecoveryDeleted?: (deletion: RecoveryDeletion) => void;
  onRunEnd?: (writerActive: boolean, runId: string, failed?: boolean) => void;
  onRunAccepted?: (run: LiveHistoryRun) => void;
  onSendFailure?: (runId: string) => void;
  onInputRejected?: (sessionId: string, copy: HistoryFailure) => void;
  /**
   * Sink for `system/task_*` events, recorded beside the message tree so a task whose spawning
   * call is not in this message list at all — a sub-agent's own sub-agent — still has live
   * state somewhere. See taskStore.ts.
   */
  taskStore?: TaskStore;
}

interface UseChatStreamReturn {
  drainingSubscriptions: ReactNode;
  isLoading: boolean;
  tokenUsage: TokenUsage | null;
  liveOutputTokens: LiveOutputTokens | null;
  runningStartedAt: number | null;
  rateLimitInfo: RateLimitInfo | null;
  apiRetryInfo: ApiRetryInfo | null;
  backgroundTasks: BackgroundTaskInfo[];
  /** The engine's predicted next prompt for the current session (claude `prompt_suggestion`), or
   *  null. Cleared on send; never restored from disk. */
  promptSuggestion: string | null;
  handleSend: (
    content: string,
    images?: ImageInfo[],
    overrides?: { permissionMode?: 'plan' | null }
  ) => Promise<void>;
  handleStop: () => void;
  /** Send a message into the session's live run (claude only) instead of starting one. The
   *  bubble arrives over the run stream like any other event. Rejects with the server's reason. */
  injectMessage: (content: string, images: ImageInfo[] | undefined, sessionId: string) => Promise<void>;
  abortControllerRef: React.RefObject<AbortController | null>;
}

// ============================================
// Hook
// ============================================

// Each stopped writer retains its own projection until settlement. It can update
// history, but has no authority over the successor's loading, session or tokens.
function DrainingRun({ run, update, engine, onAccepted, onEnd, onDeleted, onSettled }: {
  run: { id: string; runKey: string }; update: RunMessageUpdate; engine?: ChatEngine;
  onAccepted: UseChatStreamOptions['onRunAccepted']; onEnd: UseChatStreamOptions['onRunEnd'];
  onDeleted: UseChatStreamOptions['onRecoveryDeleted']; onSettled: (id: string) => void;
}) {
  useLiveStream(run.runKey, update, true, engine, {
    onlyRunId: run.id,
    onSnapshotStart: value => { onAccepted?.(value); update(value.id, []); },
    onRunEnd: (writer, id, failed) => {
      onEnd?.(writer, id, failed);
      if (!writer) onSettled(run.id);
    },
    onRecoveryDeleted: onDeleted,
    onWriterIdle: () => { onEnd?.(false, run.id); onSettled(run.id); },
  });
  return null;
}

export function useChatStream(
  messages: ChatMessage[],
  updateRunMessages: RunMessageUpdate,
  { sessionId, cwd, engine, planMode, noHistory, outputStyleId, ollamaModel, engineModel, piThinkingLevel, claudeModel, claudeEffort, claudeFastMode, claudeThinking, codexModel, codexReasoningEffort, grokModel, grokReasoningEffort, onSessionId, onFetchTitle, onSendStart, onRunEnd, onRunAccepted, onSendFailure, onInputRejected, onRecoveryDeleted, taskStore }: UseChatStreamOptions
): UseChatStreamReturn {
  // Each subscriber needs its own initial snapshot, including a sender/viewer handoff.
  const subscriptionId = useId();
  const expectedSession = useRef(sessionId);
  const viewIdentity = useRef({ cwd, sessionId });
  const [drainingRuns, setDrainingRuns] = useState<Array<{ id: string; runKey: string }>>([]);
  useEffect(() => {
    const previous = viewIdentity.current;
    if (previous.cwd !== cwd || (previous.sessionId !== sessionId && expectedSession.current !== sessionId)) setDrainingRuns([]);
    viewIdentity.current = { cwd, sessionId };
    expectedSession.current = sessionId;
  }, [cwd, sessionId]);
  const forgetDraining = useCallback((id: string) => setDrainingRuns(runs => runs.filter(run => run.id !== id)), []);
  // Reuse the viewer's full snapshot projection without opening another socket or
  // changing this sender's progress. A resend can miss the old writer's settlement.
  const replayRecovery = useLiveStream(null, updateRunMessages, false, engine, {
    onSnapshotStart: run => { onRunAccepted?.(run); updateRunMessages(run.id, []); },
    onRunEnd, onRecoveryDeleted,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [liveOutputTokens, setLiveOutputTokens] = useState<LiveOutputTokens | null>(null);
  const [runningStartedAt, setRunningStartedAt] = useState<number | null>(null);
  const [rateLimitInfo, setRateLimitInfo] = useState<RateLimitInfo | null>(null);
  const [apiRetryInfo, setApiRetryInfo] = useState<ApiRetryInfo | null>(null);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTaskInfo[]>(NO_BG_TASKS);
  // Tagged with the session it was predicted for, so switching this tab to another session hides
  // it without an effect to reset it.
  const [suggestion, setSuggestion] = useState<{ sessionId: string; text: string } | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // #10 ws-converge: the active detached run the originator is tailing over
  // /ws/session-stream (runKey to subscribe by + the assistant bubble its events fill).
  const [activeRun, setActiveRun] = useState<{ runKey: string; assistantId: string } | null>(null);
  const activeRunRef = useRef(activeRun);
  activeRunRef.current = activeRun;
  const waitingForWriterRef = useRef(false);
  const sawServerUsageUpdateRef = useRef(false);

  // Keep endRun stable while reading the latest lifecycle callback.
  const onRunEndRef = useRef(onRunEnd);
  onRunEndRef.current = onRunEnd;
  const taskStoreRef = useRef(taskStore);
  taskStoreRef.current = taskStore;

  // #10 R5/#7: connection watchdog. The detached run is driven entirely by /ws/session-stream;
  // if that socket never connects (ws server down, upgrade rejected), no event ever arrives and
  // the originator would hang with isLoading=true forever (the old SSE finally that reset it is
  // gone). A connected socket sends its snapshot within ms, so "no message at all for 15s" ⇒
  // the connection failed → unstick.
  const wsAliveRef = useRef(false);
  const wsWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Used to get latest sessionId in handleStreamEvent
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;

  // Streaming text buffer - used to throttle setState
  const streamBufferRef = useRef<{ messageId: string; text: string } | null>(null);
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // #bg multi-turn (background persistence): a single resident run can now span the launch turn
  // plus follow-up turns the SDK auto-runs when a background task reports back. `curAsstIdRef` is
  // the assistant bubble live events fill (updated per turn so a follow-up turn gets its own
  // bubble); `sawResultRef` marks that this run already produced a result (so the next init is a
  // follow-up); `turnActiveRef` distinguishes a background notification (arrives while idle) from
  // a foreground subagent's (mid-turn).
  const curAsstIdRef = useRef<string | null>(null);
  const sawResultRef = useRef(false);
  const turnActiveRef = useRef(false);
  const bgSeqRef = useRef(0);
  // Mid-run sends: `launchTurnIdRef` is the runId this tab launched the run with, so its seeded
  // `_human` event is told apart from a message injected later. `splitPendingRef` is set by such
  // a message: the model's next message opens a fresh bubble below it rather than continuing the
  // one above.
  const launchTurnIdRef = useRef<string | null>(null);
  const launchMessagesRef = useRef<ChatMessage[]>([]);
  const splitPendingRef = useRef(false);
  const consumptionBoundRef = useRef(false);
  const setMessages = useCallback<(update: HistoryMessageUpdate) => void>((update) => {
    const id = launchTurnIdRef.current;
    if (id) updateRunMessages(id, update);
  }, [updateRunMessages]);

  // Flush buffer to state (batched text delta → shared reducer)
  const flushStreamBuffer = useCallback(() => {
    const buffer = streamBufferRef.current;
    if (buffer && buffer.text) {
      const { messageId, text } = buffer;
      setMessages({
        event: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
        engine, assistantId: messageId,
      });
      streamBufferRef.current = { messageId, text: '' };
    }
    streamFlushTimerRef.current = null;
  }, [setMessages, engine]);

  // End the originator's view of the current run (turn finished / stopped / failed).
  const endRun = useCallback((writerActive = false, failed = false) => {
    if (launchTurnIdRef.current) onRunEndRef.current?.(writerActive, launchTurnIdRef.current, failed);
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    if (wsWatchdogRef.current) {
      clearTimeout(wsWatchdogRef.current);
      wsWatchdogRef.current = null;
    }
    flushStreamBuffer();
    // Stop finalizes UI task state even while the writer finishes flushing.
    // This fires per run, not between a resident run's follow-up turns.
    setMessages(settleRunningTasks);
    taskStoreRef.current?.settleRunning();
    setIsLoading(false);
    setLiveOutputTokens(null);
    setRunningStartedAt(null);
    setBackgroundTasks(NO_BG_TASKS);
    const ar = activeRunRef.current;
    const curId = curAsstIdRef.current;
    if (ar) {
      setMessages((prev) =>
        prev.map((m) => (m.id === ar.assistantId || m.id === curId ? { ...m, isStreaming: false } : m))
      );
    }
    waitingForWriterRef.current = writerActive && !!ar;
    if (!waitingForWriterRef.current) {
      activeRunRef.current = null;
      setActiveRun(null);
    }

  }, [flushStreamBuffer, setMessages]);

  // Stop generation: the run is detached server-side, so closing a socket won't stop it —
  // hit the explicit stop endpoint. Send both keys (sessionId once known, else runId).
  const handleStop = useCallback(async () => {
    const ar = activeRunRef.current;
    const result = await BrowserRuntime.runPromiseExit(stopChat({ sessionId: sessionIdRef.current, runId: ar?.runKey }));
    if (result._tag === 'Failure') {
      toast(i18n.t('chat.stopFailed', { defaultValue: 'Could not stop the run. Try again.' }), 'error');
      return;
    }
    if (result.value.ok && ar && activeRunRef.current === ar) endRun(true);
  }, [endRun]);

  // SSE event handling
  const handleStreamEvent = useCallback((event: Record<string, unknown>, messageId: string) => {
    const eventType = event.type as string;
    // A subagent's frames (tool_use/tool_result the SDK forwards from a nested run, and its text
    // under forwardSubagentText) are not this turn's — see isSubagentFrame. Dropped before ANY
    // handling, so they also stop inflating the fallback output-token estimate.
    if (isSubagentFrame(event as StreamEvent)) return;
    const bumpOutputProgress = (text: unknown) => {
      if (sawServerUsageUpdateRef.current || typeof text !== 'string' || !text) return;
      const delta = estimateOutputUnits(text);
      setLiveOutputTokens((prev) => ({
        outputTokens: (prev?.outputTokens || 0) + delta,
      }));
    };

    // Handle session_id + turn boundary. Each turn (including a follow-up turn the SDK auto-runs
    // after a background task completes) starts with a system.init.
    if (eventType === 'system' && event.subtype === 'input_started' && typeof event.inputId === 'string') {
      flushStreamBuffer();
      consumptionBoundRef.current = true;
      splitPendingRef.current = false;
      const id = `input-asst-${event.inputId}`;
      curAsstIdRef.current = id;
      setMessages({ event: event as StreamEvent, engine, assistantId: id });
      return;
    }
    if (eventType === 'system' && event.subtype === 'input_binding') {
      setMessages({ event: event as StreamEvent, engine, assistantId: '' });
      return;
    }
    if (eventType === 'system' && event.subtype === 'task_binding' && typeof event.taskId === 'string') {
      setMessages((prev) => prev.map((message) => message.liveRunId === launchTurnIdRef.current
        ? { ...message, sourceTaskId: event.taskId as string } : message));
      return;
    }
    if (eventType === 'system' && event.subtype === 'init') {
      const newSessionId = event.session_id as string;
      const isFollowUpTurn = sawResultRef.current;
      expectedSession.current = newSessionId;
      onSessionId(newSessionId);
      sessionIdRef.current = newSessionId;
      if (!isFollowUpTurn) {
        setRunningStartedAt((prev) => prev ?? Date.now());
        setLiveOutputTokens(null);
        sawServerUsageUpdateRef.current = false;
      }
      setApiRetryInfo(null); // successful init means any prior retry chain resolved
      // #bg: a turn that starts AFTER this run already produced a result is a follow-up (e.g. the
      // auto-run when a background task reports back) → give it its own assistant bubble instead
      // of merging into the launcher's.
      if (isFollowUpTurn) {
        splitPendingRef.current = false;
        const autoId = `auto-asst-${launchTurnIdRef.current}-${++bgSeqRef.current}`;
        curAsstIdRef.current = autoId;
        setMessages((prev) => [
          ...prev,
          { id: autoId, role: 'assistant', content: '', toolCalls: [], isStreaming: true, liveRunId: launchTurnIdRef.current ?? undefined, turnId: engine === "codex" ? `live-task-${launchTurnIdRef.current}` : undefined, runKey: activeRunRef.current?.runKey } as ChatMessage,
        ]);
      }
      turnActiveRef.current = true;
      return;
    }

    // A message sent into this live run (from this tab or any other): the run seeds it as a
    // `_human` event. The launch prompt's own event is skipped — its bubble already exists.
    if (eventType === 'user' && event._human) {
      const turnId = typeof event._turnId === 'string' ? event._turnId : null;
      if (!turnId) return;
      if (turnId === launchTurnIdRef.current) {
        const timestamp = typeof event._ts === 'number' ? new Date(event._ts).toISOString() : undefined;
        setMessages((prev) => prev.map((message) => message.liveRunId === turnId ? { ...message, turnStartedAt: timestamp } : message));
        return;
      }
      const text = (event.message as { content?: unknown } | undefined)?.content;
      const id = `auto-user-${turnId}`;
      setMessages((prev) =>
        prev.some((m) => m.id === id)
          ? prev
          : [...prev, {
              id,
              liveInputId: turnId,
              role: 'user',
              content: typeof text === 'string' ? text : '',
              ...(Array.isArray(event._images) && event._images.length ? { images: event._images as MessageImage[] } : {}),
              liveRunId: launchTurnIdRef.current ?? undefined, turnId: engine === "codex" ? `live-task-${launchTurnIdRef.current}` : undefined, runKey: activeRunRef.current?.runKey,
            } as ChatMessage]
      );
      if (!consumptionBoundRef.current) splitPendingRef.current = true;
      return;
    }

    // #bg: the live set of background tasks, so the loading bubble can name what the turn is
    // waiting on. A turn whose `result` already landed stays resident until every task reports
    // back (sdkLoop holds the input stream open) — without this the spinner is indistinguishable
    // from the model still thinking, which is exactly how a wedged task reads as a hung session.
    // REPLACE semantics: swap the whole set, never pair task_started/task_notification edges.
    if (eventType === 'system' && event.subtype === 'background_tasks_changed') {
      const live = (event.tasks as Array<BackgroundTaskInfo & { ambient?: boolean }> | undefined) ?? [];
      const shown = live.filter((t) => !t.ambient).map((t) => ({ task_id: t.task_id, description: t.description }));
      setBackgroundTasks(shown.length ? shown : NO_BG_TASKS);
      return;
    }

    // A spawned task narrating its own life (task_started / task_progress / task_notification,
    // all carrying `tool_use_id`) → fold into the tool call that launched it. Deliberately not
    // scoped to this turn's bubble; see applyTaskEvent. task_notification falls through, because
    // it ALSO renders a system row below.
    if (isTaskEvent(event as StreamEvent)) {
      // Both sinks, always: the message tree settles the row when the spawning call is on
      // screen, the store covers every depth including the ones that have no row here.
      taskStoreRef.current?.applyEvent(event as unknown as StreamEvent);
      setMessages({ event: event as unknown as StreamEvent, engine, assistantId: messageId });
      if (event.subtype !== 'task_notification') return;
    }

    // #bg: a background task reporting back while idle (after a result, before the next turn) →
    // render a muted system-event bar live, matching the disk-reload view. A notification during
    // an active turn is a foreground subagent (already shown as its tool call) → skip.
    if (eventType === 'system' && event.subtype === 'task_notification') {
      if (!turnActiveRef.current) {
        const status = event.status as 'completed' | 'failed' | 'stopped' | undefined;
        const summary = (event.summary as string) || '';
        const taskId = event.task_id as string | undefined;
        const detail =
          `<task-notification>\n` +
          (taskId ? `<task-id>${taskId}</task-id>\n` : '') +
          (event.tool_use_id ? `<tool-use-id>${event.tool_use_id as string}</tool-use-id>\n` : '') +
          (status ? `<status>${status}</status>\n` : '') +
          (summary ? `<summary>${summary}</summary>\n` : '') +
          (event.output_file ? `<output-file>${event.output_file as string}</output-file>\n` : '') +
          `</task-notification>`;
        const id = `auto-tasknotif-${taskId || ++bgSeqRef.current}`;
        setMessages((prev) => [
          ...prev,
          {
            id,
            role: 'system',
            content: summary,
            systemEvent: { kind: 'task-notification', ...(status ? { status } : {}), detail },
            liveRunId: launchTurnIdRef.current ?? undefined, turnId: engine === "codex" ? `live-task-${launchTurnIdRef.current}` : undefined, runKey: activeRunRef.current?.runKey,
          } as ChatMessage,
        ]);
      }
      return;
    }

    // An engine-level advisory about this run (e.g. codex could not resume the session and
    // started a fresh one) → muted system row. Emitted right after the init that rebound the
    // session id, so it reads as an explanation of the change the user is about to notice.
    if (eventType === 'system' && event.subtype === 'notice') {
      const row = buildNoticeMessage(event as unknown as StreamEvent, `auto-notice-${++bgSeqRef.current}`);
      if (row) setMessages((prev) => [...prev, { ...row, liveRunId: launchTurnIdRef.current ?? undefined, turnId: engine === "codex" ? `live-task-${launchTurnIdRef.current}` : undefined, runKey: activeRunRef.current?.runKey }]);
      return;
    }

    // Handle SDK api_retry event (e.g. transient 401/5xx). Show in loading bubble.
    if (eventType === 'system' && event.subtype === 'api_retry') {
      setApiRetryInfo({
        attempt: (event.attempt as number) ?? 0,
        maxRetries: (event.max_retries as number) ?? 0,
        delayMs: (event.retry_delay_ms as number) ?? 0,
        errorStatus: event.error_status as number | undefined,
        error: event.error as string | undefined,
      });
      return;
    }

    // Handle rate limit event (claude.ai subscription users only)
    if (eventType === 'rate_limit_event') {
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      if (info) {
        setRateLimitInfo({
          status: (info.status as RateLimitInfo['status']) || 'allowed',
          resetsAt: info.resetsAt as number | undefined,
          rateLimitType: info.rateLimitType as string | undefined,
          utilization: info.utilization as number | undefined,
          overageStatus: info.overageStatus as string | undefined,
          overageDisabledReason: info.overageDisabledReason as string | undefined,
          isUsingOverage: info.isUsingOverage as boolean | undefined,
          surpassedThreshold: info.surpassedThreshold as number | undefined,
        });
      }
      return;
    }

    if (eventType === 'usage_update') {
      const outputTokens = event.output_tokens as number | undefined;
      if (typeof outputTokens === 'number' && Number.isFinite(outputTokens)) {
        sawServerUsageUpdateRef.current = true;
        const nextOutputTokens = Math.max(0, Math.round(outputTokens));
        setLiveOutputTokens((prev) => ({
          outputTokens: Math.max(prev?.outputTokens || 0, nextOutputTokens),
        }));
      }
      return;
    }

    // Handle in-stream error events ({type:'error', error}) emitted by the
    // codex/kimi/ollama/deepseek routes. Without this branch they are silently
    // dropped and the turn ends as an empty bubble.
    if (eventType === 'error') {
      const errText = (event.error as string) || i18n.t('chat.errorRetry', { defaultValue: 'An error occurred. Please try again.' });
      setApiRetryInfo(null);
      // Flush any buffered text first so the error appears after streamed content.
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      flushStreamBuffer();
      setMessages({ event: { ...(event as StreamEvent), type: 'error', error: errText }, engine, assistantId: messageId });
      return;
    }

    // Handle streaming text chunk (typewriter effect) - use buffer throttle
    if (eventType === 'stream_event') {
      // Any actual stream content means the retry / stuck state (if any) has cleared
      setApiRetryInfo(prev => prev ? null : prev);
      const streamEvent = event.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      // The first model message after a mid-turn send → its own bubble, below the user's.
      if (splitPendingRef.current && streamEvent?.type === 'message_start') {
        splitPendingRef.current = false;
        if (streamFlushTimerRef.current) {
          clearTimeout(streamFlushTimerRef.current);
          streamFlushTimerRef.current = null;
        }
        flushStreamBuffer();
        const prevId = messageId;
        const autoId = `auto-asst-${launchTurnIdRef.current}-${++bgSeqRef.current}`;
        curAsstIdRef.current = autoId;
        messageId = autoId;
        setMessages((prev) => [
          ...prev.map((m) => (m.id === prevId ? { ...m, isStreaming: false } : m)),
          { id: autoId, role: 'assistant', content: '', toolCalls: [], isStreaming: true, liveRunId: launchTurnIdRef.current ?? undefined, turnId: engine === "codex" ? `live-task-${launchTurnIdRef.current}` : undefined, runKey: activeRunRef.current?.runKey } as ChatMessage,
        ]);
      }
      if (streamEvent?.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
        const deltaText = streamEvent.delta.text || '';
        bumpOutputProgress(deltaText);

        // Accumulate to buffer
        if (!streamBufferRef.current || streamBufferRef.current.messageId !== messageId) {
          streamBufferRef.current = { messageId, text: deltaText };
        } else {
          streamBufferRef.current.text += deltaText;
        }

        // Throttle: flush every 50ms
        if (!streamFlushTimerRef.current) {
          streamFlushTimerRef.current = setTimeout(flushStreamBuffer, 50);
        }
      }
      return;
    }

    // Handle text content (complete message)
    // Complete assistant message (codex/ollama/synthetic text + tool_use blocks)
    if (eventType === 'assistant') {
      const content = (event.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ text?: string; name?: string; input?: unknown }>) {
          if (block.text) bumpOutputProgress(block.text);
          else if (block.name) bumpOutputProgress(`${block.name} ${JSON.stringify(block.input ?? {})}`);
        }
      }
      setMessages({ event: event as unknown as StreamEvent, engine, assistantId: messageId });
    }

    if (eventType === 'tool_progress') {
      setMessages({ event: event as unknown as StreamEvent, engine, assistantId: messageId });
      return;
    }

    // Tool result (user turn) → merge into the matching toolCall
    if (eventType === 'user') {
      const content = (event.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ content?: unknown }>) {
          bumpOutputProgress(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''));
        }
      }
      setMessages({ event: event as unknown as StreamEvent, engine, assistantId: messageId });
    }

    // Arrives after the turn's result, before the run ends.
    if (eventType === 'prompt_suggestion') {
      const text = typeof event.suggestion === 'string' ? event.suggestion.trim() : '';
      const sid = sessionIdRef.current;
      setSuggestion(text && sid ? { sessionId: sid, text } : null);
    }

    // Handle final result
    if (eventType === 'result') {
      // #bg: a result ends the active turn — after it a task_notification is a background one, and
      // the next init is a follow-up turn that needs its own bubble.
      turnActiveRef.current = false;
      sawResultRef.current = true;
      // Stream ended → drop any retry indicator
      setApiRetryInfo(null);
      // Stream ended, flush buffer immediately
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      flushStreamBuffer();

      // After first message in new session completes, fetch title
      const currentSessionId = sessionIdRef.current;
      if (currentSessionId && cwd) {
        setMessages((prev) => {
          if (prev.length === 2) {
            onFetchTitle(currentSessionId);
          }
          return prev;
        });
      }

      // Capture token usage info
      const usage = event.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
      const totalCostUsd = event.total_cost_usd as number | undefined;

      if (usage) {
        setTokenUsage({
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
          cacheReadInputTokens: usage.cache_read_input_tokens || 0,
          totalCostUsd: totalCostUsd || 0,
        });
      }

      // Fallback: if the bubble is still empty when the turn ends, surface whatever text the
      // result event carries (result.result). Covers synthetic errors that never streamed deltas
      // — note these arrive as subtype:'success'/is_error:false, so we can't gate on the error flag —
      // and result-only turns with no assistant message at all. Without this it renders as an empty bubble.
      // Finalize the assistant bubble (resultText fallback + isStreaming off + toolCalls done)
      setMessages({ event: event as unknown as StreamEvent, engine, assistantId: messageId });
    }
  }, [setMessages, flushStreamBuffer, onSessionId, onFetchTitle, cwd, engine]);

  // #10 ws-converge: tail the active detached run over /ws/session-stream and feed every
  // event through the SAME handleStreamEvent the SSE path used — so token usage, title,
  // retry indicators, deltas, tools, result and errors are all reused unchanged.
  // A stopped run keeps this subscription until its writer releases the transcript.
  useWebSocket({
    url: activeRun
      ? `/ws/session-stream?sessionId=${encodeURIComponent(activeRun.runKey)}&subscriber=${encodeURIComponent(subscriptionId)}`
      : '/ws/session-stream',
    enabled: !!activeRun,
    onMessage: (data) => {
      // Any message (snapshot / event / ping) proves the socket connected → cancel the watchdog.
      wsAliveRef.current = true;
      if (wsWatchdogRef.current) {
        clearTimeout(wsWatchdogRef.current);
        wsWatchdogRef.current = null;
      }
      const ar = activeRunRef.current;
      if (!ar) return;
      // A successor may have started while this sender was offline. Finish its
      // own retained failure first; the viewer will then follow the successor.
      const envelope = data as { recoveries?: Array<{ runId?: string; startedAt?: number; events?: StreamEvent[]; recoveryDeletions?: RecoveryDeletion[] }> };
      for (const copy of envelope.recoveries ?? []) {
        if (copy.runId && copy.runId !== launchTurnIdRef.current) replayRecovery(copy);
      }
      const ownRecovery = envelope.recoveries?.find((copy) => copy.runId === launchTurnIdRef.current);
      const msg = (ownRecovery ?? data) as {
        type?: string;
        status?: string;
        events?: unknown[];
        outputTokens?: number;
        writerActive?: boolean;
        recovery?: boolean;
        recoveryDeletions?: RecoveryDeletion[];
        runId?: string;
        startedAt?: number;
        message?: Record<string, unknown>;
      };
      if (msg.type === 'run-snapshot' && Array.isArray(msg.events)) {
        if (msg.runId && msg.runId !== launchTurnIdRef.current) {
          // This subscription's authoritative successor proves our writer released.
          // End only our projection; the viewer subscribes and replays the current run.
          endRun();
          return;
        }
        if (typeof msg.startedAt === 'number' && launchTurnIdRef.current) {
          onRunAccepted?.({ id: launchTurnIdRef.current, startedAt: msg.startedAt, recovery: msg.recovery });
        }
        // A snapshot is an authoritative replay of the ENTIRE in-flight turn. On a mid-turn
        // ws reconnect (HMR / network blip / server restart) the server re-sends the whole
        // turn, so reset this assistant bubble before replaying — handleStreamEvent APPENDS
        // text, and replaying onto an already-populated bubble would duplicate it. Also drop
        // any buffered delta that belongs to the pre-reconnect content.
        if (streamFlushTimerRef.current) {
          clearTimeout(streamFlushTimerRef.current);
          streamFlushTimerRef.current = null;
        }
        streamBufferRef.current = null;
        // Rebuild this run from its launch messages and the authoritative replay.
        // The viewer may have rendered the same run before admission reached this
        // sender; its IDs must not replace the originator's replay targets.
        curAsstIdRef.current = ar.assistantId;
        consumptionBoundRef.current = false;
        sawResultRef.current = false;
        turnActiveRef.current = false;
        splitPendingRef.current = false;
        sawServerUsageUpdateRef.current = false;
        setLiveOutputTokens(null);
        const snapshotOutputTokens = typeof msg.outputTokens === 'number' && Number.isFinite(msg.outputTokens)
          ? Math.max(0, Math.round(msg.outputTokens))
          : null;
        if (snapshotOutputTokens !== null) {
          sawServerUsageUpdateRef.current = true;
          setLiveOutputTokens({ outputTokens: snapshotOutputTokens });
        }
        const timestamp = typeof msg.startedAt === 'number' ? new Date(msg.startedAt).toISOString() : undefined;
        setMessages(launchMessagesRef.current.map((message) => ({ ...message, turnStartedAt: timestamp ?? message.turnStartedAt })));
        for (const ev of msg.events) handleStreamEvent(ev as Record<string, unknown>, curAsstIdRef.current ?? ar.assistantId);
        // Run already finished before we connected (status idle/error in the snapshot).
        if (msg.status && msg.status !== 'running') endRun(msg.writerActive === true, msg.status === 'error');
        for (const deletion of msg.recoveryDeletions ?? []) onRecoveryDeleted?.(deletion);
      } else if (msg.type === 'run-event' && msg.message) {
        if (msg.message.type === 'recovery-deleted') {
          onRecoveryDeleted?.(msg.message.deletion as RecoveryDeletion);
          return;
        }
        // 'run-ended' is the single definitive end signal (engines may emit several
        // intermediate 'result's — codex = one per turn — so we must NOT end on result).
        if (msg.message.type === 'run-ended' || msg.message.type === 'run-settled') {
          if (typeof msg.message.runId === 'string' && msg.message.runId !== launchTurnIdRef.current) return;
          endRun(msg.message.type === 'run-ended' && msg.message.writerActive === true, msg.message.status === 'error');
          return;
        }
        if (waitingForWriterRef.current) {
          if (isRecoverySettlement(msg.message)) {
            handleStreamEvent(msg.message, curAsstIdRef.current ?? ar.assistantId);
          }
          return;
        }
        handleStreamEvent(msg.message, curAsstIdRef.current ?? ar.assistantId);
      } else if (msg.type === 'run-idle') {
        endRun();
        for (const deletion of msg.recoveryDeletions ?? []) onRecoveryDeleted?.(deletion);
      }
      // 'ping': ignore
    },
  });

  // Send message
  const handleSend = useCallback(
    async (
      content: string,
      images?: ImageInfo[],
      overrides?: { permissionMode?: 'plan' | null }
    ) => {
      // Per-send permission override. `overrides` is an ARGUMENT (not closure state),
      // so it is always current — unlike `planMode`, which a same-tick setPlanMode(false)
      // does not yet reflect (React state is async). The plan-card "approve & run" button
      // relies on this to force a non-plan resend in the same event that turns the toggle
      // off. When no override is passed, fall back to the live planMode toggle.
      const usePlanMode =
        overrides && 'permissionMode' in overrides
          ? overrides.permissionMode === 'plan'
          : planMode;
      // Convert image format
      const messageImages: MessageImage[] | undefined = images?.map((img) => ({
        type: 'base64' as const,
        media_type: img.media_type,
        data: img.data,
      }));

      // Add user message
      // A new send can start while the stopped run is still flushing. Its final
      // notification must not finalize or reconcile this new sender's bubbles.
      if (waitingForWriterRef.current && activeRunRef.current && launchTurnIdRef.current) {
        const retained = { id: launchTurnIdRef.current, runKey: activeRunRef.current.runKey };
        setDrainingRuns(runs => [...runs.filter(run => run.id !== retained.id), retained]);
      }
      activeRunRef.current = null;
      setActiveRun(null);
      waitingForWriterRef.current = false;
      const runId = genRunId();
      launchTurnIdRef.current = runId;
      onSendStart?.({ id: runId, startedAt: Date.now() });
      const userMessage: ChatMessage = {
        id: `user-${runId}`,
        liveInputId: runId,
        liveRunId: runId,
        turnId: engine === "codex" ? `live-task-${runId}` : undefined,
        role: 'user',
        content,
        images: messageImages,
      };
      setMessages((prev) => [...prev, userMessage]);
      setSuggestion(null);
      setIsLoading(true);
      setLiveOutputTokens(null);
      sawServerUsageUpdateRef.current = false;
      setRunningStartedAt(Date.now());
      // Fresh send: clear stale retry notice / background-task set from a previous turn
      setApiRetryInfo(null);
      setBackgroundTasks(NO_BG_TASKS);

      // This turn's identity on the wire. The server stamps it onto the seeded
      // `_human` event as `_turnId`, which is how a viewer pane dedups the live
      // user bubble by identity instead of by text — required for a repeated
      // prompt ("继续"), where text comparison suppresses the new turn's bubble.
      // It is also the idempotency key for the run registry's test-and-set.
      // Create assistant message placeholder
      const assistantMessageId = `assistant-${runId}`;
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        liveRunId: runId,
        turnId: engine === "codex" ? `live-task-${runId}` : undefined,
        role: 'assistant',
        content: '',
        toolCalls: [],
        isStreaming: true,
      };
      launchMessagesRef.current = [userMessage, assistantMessage];
      setMessages((prev) => [...prev, assistantMessage]);
      // #bg: bind live rendering to this launching bubble and reset per-run turn tracking.
      consumptionBoundRef.current = false;
      curAsstIdRef.current = assistantMessageId;
      sawResultRef.current = false;
      turnActiveRef.current = false;
      splitPendingRef.current = false;

      const isClaudeEngine = !engine || engine === 'claude';
      // API-key providers share the embedded Pi runtime.
      const isApiKeyEngine = engine === 'deepseek' || engine === 'kimi' || engine === 'glm';
      // Independent task: Pi filters prior context (ollama, deepseek,
      // kimi, glm). Claude and Codex stash their vendor transcript/rollout for the turn.
      // Grok runs an isolated native branch and merges its new turn back afterwards.
      // Keep the supported engines explicit as the contract for future providers.
      const canDropHistory = engine === 'ollama' || isApiKeyEngine || isClaudeEngine || engine === 'codex' || engine === 'grok';

      try {
        // No client-side model guard for ollama. Dispatch resolves one itself — this session's,
        // else the last used, else the first installed — and when it cannot, it answers with
        // the reason (server unreachable, nothing pulled), which is the message worth showing.
        // The old guard shadowed all of that with "select a model first" even when the real
        // problem was that ollama wasn't running.
        const apiUrl = engine && engine !== 'claude' ? `/api/chat/${engine}` : '/api/chat';
        // POST only STARTS the detached run and returns its runKey — no SSE body to read.
        // The ws consumer (above) tails /ws/session-stream and drives the UI from here.
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: content,
            sessionId: sessionIdRef.current,
            runId,
            images: messageImages,
            cwd,
            language: i18n.language,
            ...(engine === 'ollama' && ollamaModel && { model: ollamaModel }),
            ...(isApiKeyEngine && engineModel && { model: engineModel }),
            ...((isApiKeyEngine || engine === 'ollama') && piThinkingLevel !== undefined && { piThinkingLevel }),
            ...(isClaudeEngine && claudeModel && { model: claudeModel }),
            ...(isClaudeEngine && claudeEffort && { claudeEffort }),
            ...(isClaudeEngine && claudeFastMode !== undefined && { claudeFastMode }),
            ...(isClaudeEngine && claudeThinking !== undefined && { claudeThinking }),
            ...(engine === 'codex' && codexModel && { model: codexModel }),
            ...(engine === 'codex' && codexReasoningEffort && { codexReasoningEffort }),
            ...(engine === 'grok' && { model: grokModel && grokModel !== 'grok-build' ? grokModel : GROK_DEFAULT_MODEL }),
            ...(engine === 'grok' && { grokReasoningEffort: grokReasoningEffort || GROK_DEFAULT_REASONING }),
            // Plan mode: only meaningful on a claude engine.
            // When unchecked, omit → server defaults to bypassPermissions.
            ...(usePlanMode && isClaudeEngine && { permissionMode: 'plan' }),
            // Independent task (see canDropHistory). Omitted when off.
            ...(canDropHistory && noHistory && { noHistory: true }),
            // Output style: every engine appends it (orchestrator resolves id → text).
            ...(outputStyleId && { outputStyleId }),
          }),
        });

        if (!response.ok) {
          // Every dispatch rejection carries a readable `error` ("API key is not configured",
          // "session is already running", …). Surface it for ALL engines: this branch used to be
          // limited to the api-key ones, so any other engine's 4xx collapsed into a bare
          // "Request failed" and the actual reason was only visible in the server log.
          const errBody = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(
            errBody?.error || i18n.t('chat.requestFailed', { defaultValue: 'Request failed' })
          );
        }

        const startBody = (await response.json().catch(() => ({}))) as { runKey?: string; startedAt?: number };
        onRunAccepted?.({ id: runId, startedAt: startBody.startedAt ?? Date.now() });
        // Hand off to the ws consumer; it ends the run on result / run-idle.
        if (typeof startBody.startedAt === 'number') {
          const timestamp = new Date(startBody.startedAt).toISOString();
          setMessages((prev) => prev.map((message) => message.liveRunId === runId ? { ...message, turnStartedAt: timestamp } : message));
        }
        setActiveRun({ runKey: startBody.runKey || runId, assistantId: assistantMessageId });
        // Arm the connection watchdog: if /ws/session-stream never delivers a message (it sends
        // a snapshot immediately on connect), surface the transport failure without claiming
        // that the server writer released its lease. Keep the subscription and Stop available.
        wsAliveRef.current = false;
        if (wsWatchdogRef.current) clearTimeout(wsWatchdogRef.current);
        wsWatchdogRef.current = setTimeout(() => {
          if (activeRunRef.current && !wsAliveRef.current) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMessageId && !m.content
                  ? { ...m, content: i18n.t('chat.errorRetry', { defaultValue: 'An error occurred. Please try again.' }) }
                  : m
              )
            );
          }
        }, 15000);
      } catch (error) {
        // POST failed to even start the run → surface in the bubble and end the turn.
        // (Once the run has started, completion/stop/errors all arrive over the ws stream.)
        console.error('Chat error:', error);
        const errorMsg = error instanceof Error ? error.message : i18n.t('chat.errorRetry', { defaultValue: 'An error occurred. Please try again.' });
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? { ...msg, content: errorMsg, streamError: errorMsg, isStreaming: false }
              : msg
          )
        );
        onSendFailure?.(runId);
        setIsLoading(false);
        setActiveRun(null);
      }
    },
    [cwd, engine, planMode, noHistory, outputStyleId, ollamaModel, engineModel, piThinkingLevel, claudeModel, claudeEffort, claudeFastMode, claudeThinking, codexModel, codexReasoningEffort, grokModel, grokReasoningEffort, setMessages, endRun, onSendStart, onRunAccepted, onSendFailure]
  );

  const injectMessage = useCallback(
    async (content: string, images: ImageInfo[] | undefined, targetSessionId: string) => {
      setSuggestion(null);
      const inputId = genRunId();
      const startedAt = Date.now();
      const messageImages = images?.map((image) => ({ type: 'base64' as const, media_type: image.media_type, data: image.data }));
      const isPiProvider = engine === 'ollama' || engine === 'deepseek' || engine === 'kimi' || engine === 'glm';
      await BrowserRuntime.runPromise(injectChatMessage(engine, {
        prompt: content,
        sessionId: targetSessionId,
        runId: inputId,
        images: messageImages,
        cwd,
        language: i18n.language,
        inject: true,
        ...(isPiProvider ? { model: engine === 'ollama' ? ollamaModel : engineModel, piThinkingLevel, noHistory, outputStyleId } : {}),
        ...(engine === 'codex' ? { model: codexModel, codexReasoningEffort, noHistory, outputStyleId } : {}),
        ...(engine === 'grok' ? { model: grokModel && grokModel !== 'grok-build' ? grokModel : GROK_DEFAULT_MODEL, grokReasoningEffort: grokReasoningEffort || GROK_DEFAULT_REASONING, noHistory, outputStyleId } : {}),
      }).pipe(Effect.tapError((error) => Effect.sync(() => {
        // Rejection owns a copy, never the active run or its writer lifecycle.
        onInputRejected?.(targetSessionId, { id: inputId, startedAt, messages: [
          { id: `user-${inputId}`, role: 'user', content, images: messageImages },
          { id: `error-${inputId}`, role: 'assistant', content: error.message, streamError: error.message },
        ] });
      }))));
    },
    [cwd, engine, ollamaModel, engineModel, piThinkingLevel, codexModel, codexReasoningEffort, grokModel, grokReasoningEffort, noHistory, outputStyleId, onInputRejected]
  );

  return {
    drainingSubscriptions: drainingRuns.map(run => createElement(DrainingRun, {
      key: run.id, run, update: updateRunMessages, engine, onAccepted: onRunAccepted,
      onEnd: onRunEnd, onDeleted: onRecoveryDeleted, onSettled: forgetDraining,
    })),
    isLoading,
    tokenUsage,
    liveOutputTokens,
    runningStartedAt,
    rateLimitInfo,
    apiRetryInfo,
    backgroundTasks,
    promptSuggestion: suggestion && suggestion.sessionId === sessionId ? suggestion.text : null,
    handleSend,
    handleStop,
    injectMessage,
    abortControllerRef,
  };
}
