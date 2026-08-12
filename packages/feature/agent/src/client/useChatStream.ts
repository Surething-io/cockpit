'use client';

import { useState, useCallback, useRef } from 'react';
import { estimateOutputUnits } from '@cockpit/shared-utils/outputProgress';
import { applyStreamEvent, type StreamEvent } from './applyStreamEvent';
import type {
  ChatMessage,
  ImageInfo,
  MessageImage,
  TokenUsage,
  LiveOutputTokens,
  RateLimitInfo,
  ApiRetryInfo,
  ChatEngine,
  EngineModelId,
  ChatMode,
  ClaudeModelId,
  ClaudeEffort,
  ClaudeContextWindow,
  CodexModelId,
  CodexReasoningEffort,
} from './types';
import i18n from '@cockpit/shared-i18n';
import { useWebSocket } from '@cockpit/shared-ui';

// Provisional run id the client generates per send so it can subscribe to the run's
// /ws/session-stream immediately — before the engine reveals its real sessionId.
function genRunId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `run-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

// Migrated from src/components/project/useChatStream.ts.

// ============================================
// Types
// ============================================

interface UseChatStreamOptions {
  sessionId: string | null;
  cwd?: string;
  engine?: ChatEngine;
  /** Execution mode. Only API-key engines use 'builtin'; Claude/Codex always use SDK. */
  chatMode?: ChatMode;
  /** Plan mode (SDK + claude engine only): read-only exploration that produces a plan without editing */
  planMode?: boolean;
  /** Independent-task mode: send each user message with no prior history */
  noHistory?: boolean;
  ollamaModel?: string;
  /** Model for the API-key engines (deepseek / kimi) — whichever of them is running. */
  engineModel?: EngineModelId;
  claudeModel?: ClaudeModelId;
  claudeEffort?: ClaudeEffort;
  claudeContextWindow?: ClaudeContextWindow;
  claudeFastMode?: boolean;
  claudeThinking?: boolean;
  codexModel?: CodexModelId;
  codexReasoningEffort?: CodexReasoningEffort;
  onSessionId: (sid: string) => void;
  onFetchTitle: (sid: string) => void;
  /**
   * A run (launch turn + any #bg follow-up turns) just ended. The originator should reconcile
   * from disk here so its live `user-*` / `assistant-*` / `auto-*` bubbles converge to the
   * canonical persisted UUID messages — mirroring what the viewer path already does on
   * completion, and what a page reload produces. Kept symmetric so in-session state never
   * lingers as ephemeral ids until the next refresh.
   */
  onRunComplete?: () => void;
}

interface UseChatStreamReturn {
  isLoading: boolean;
  tokenUsage: TokenUsage | null;
  liveOutputTokens: LiveOutputTokens | null;
  runningStartedAt: number | null;
  rateLimitInfo: RateLimitInfo | null;
  apiRetryInfo: ApiRetryInfo | null;
  handleSend: (
    content: string,
    images?: ImageInfo[],
    overrides?: { permissionMode?: 'plan' | null }
  ) => Promise<void>;
  handleStop: () => void;
  abortControllerRef: React.RefObject<AbortController | null>;
}

// ============================================
// Hook
// ============================================

export function useChatStream(
  messages: ChatMessage[],
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  { sessionId, cwd, engine, chatMode, planMode, noHistory, ollamaModel, engineModel, claudeModel, claudeEffort, claudeContextWindow, claudeFastMode, claudeThinking, codexModel, codexReasoningEffort, onSessionId, onFetchTitle, onRunComplete }: UseChatStreamOptions
): UseChatStreamReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [liveOutputTokens, setLiveOutputTokens] = useState<LiveOutputTokens | null>(null);
  const [runningStartedAt, setRunningStartedAt] = useState<number | null>(null);
  const [rateLimitInfo, setRateLimitInfo] = useState<RateLimitInfo | null>(null);
  const [apiRetryInfo, setApiRetryInfo] = useState<ApiRetryInfo | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // #10 ws-converge: the active detached run the originator is tailing over
  // /ws/session-stream (runKey to subscribe by + the assistant bubble its events fill).
  const [activeRun, setActiveRun] = useState<{ runKey: string; assistantId: string } | null>(null);
  const activeRunRef = useRef(activeRun);
  activeRunRef.current = activeRun;
  const sawServerUsageUpdateRef = useRef(false);

  // Latest onRunComplete via ref so endRun can fire it without taking it as a dependency
  // (the callback identity changes each render; threading it through endRun's deps would churn
  // handleSend too). endRun runs long after mount, so the ref is always populated by then.
  const onRunCompleteRef = useRef(onRunComplete);
  onRunCompleteRef.current = onRunComplete;

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

  // Flush buffer to state (batched text delta → shared reducer)
  const flushStreamBuffer = useCallback(() => {
    const buffer = streamBufferRef.current;
    if (buffer && buffer.text) {
      const { messageId, text } = buffer;
      setMessages((prev) =>
        applyStreamEvent(
          prev,
          { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
          { engine, assistantId: messageId }
        )
      );
      streamBufferRef.current = { messageId, text: '' };
    }
    streamFlushTimerRef.current = null;
  }, [setMessages, engine]);

  // End the originator's view of the current run (turn finished / stopped / failed).
  const endRun = useCallback(() => {
    if (streamFlushTimerRef.current) {
      clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    if (wsWatchdogRef.current) {
      clearTimeout(wsWatchdogRef.current);
      wsWatchdogRef.current = null;
    }
    flushStreamBuffer();
    setIsLoading(false);
    setLiveOutputTokens(null);
    setRunningStartedAt(null);
    const ar = activeRunRef.current;
    const curId = curAsstIdRef.current;
    if (ar) {
      setMessages((prev) =>
        prev.map((m) => (m.id === ar.assistantId || m.id === curId ? { ...m, isStreaming: false } : m))
      );
    }
    setActiveRun(null);
    // Converge the just-finished run's live bubbles to canonical persisted UUIDs (incremental +
    // fingerprint-guarded on the callee, so a no-op when disk is unchanged / the viewer already
    // reconciled). This closes the ephemeral-id lifecycle within the run and keeps in-session
    // state identical to a page reload.
    onRunCompleteRef.current?.();
  }, [flushStreamBuffer, setMessages]);

  // Stop generation: the run is detached server-side, so closing a socket won't stop it —
  // hit the explicit stop endpoint. Send both keys (sessionId once known, else runId).
  const handleStop = useCallback(() => {
    const ar = activeRunRef.current;
    fetch('/api/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionIdRef.current, runId: ar?.runKey }),
    }).catch(() => {});
    endRun();
  }, [endRun]);

  // SSE event handling
  const handleStreamEvent = useCallback((event: Record<string, unknown>, messageId: string) => {
    const eventType = event.type as string;
    const bumpOutputProgress = (text: unknown) => {
      if (sawServerUsageUpdateRef.current || typeof text !== 'string' || !text) return;
      const delta = estimateOutputUnits(text);
      setLiveOutputTokens((prev) => ({
        outputTokens: (prev?.outputTokens || 0) + delta,
      }));
    };

    // Handle session_id + turn boundary. Each turn (including a follow-up turn the SDK auto-runs
    // after a background task completes) starts with a system.init.
    if (eventType === 'system' && event.subtype === 'init') {
      const newSessionId = event.session_id as string;
      const isFollowUpTurn = sawResultRef.current;
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
        const autoId = `auto-asst-${++bgSeqRef.current}`;
        curAsstIdRef.current = autoId;
        setMessages((prev) => [
          ...prev,
          { id: autoId, role: 'assistant', content: '', toolCalls: [], isStreaming: true, runKey: activeRunRef.current?.runKey } as ChatMessage,
        ]);
      }
      turnActiveRef.current = true;
      return;
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
            runKey: activeRunRef.current?.runKey,
          } as ChatMessage,
        ]);
      }
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
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                content: msg.content ? `${msg.content}\n\n⚠️ ${errText}` : `⚠️ ${errText}`,
                isStreaming: false,
              }
            : msg
        )
      );
      return;
    }

    // Handle streaming text chunk (typewriter effect) - use buffer throttle
    if (eventType === 'stream_event') {
      // Any actual stream content means the retry / stuck state (if any) has cleared
      setApiRetryInfo(prev => prev ? null : prev);
      const streamEvent = event.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
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
      setMessages((prev) => applyStreamEvent(prev, event as unknown as StreamEvent, { engine, assistantId: messageId }));
    }

    // Tool result (user turn) → merge into the matching toolCall
    if (eventType === 'user') {
      const content = (event.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Array<{ content?: unknown }>) {
          bumpOutputProgress(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''));
        }
      }
      setMessages((prev) => applyStreamEvent(prev, event as unknown as StreamEvent, { engine, assistantId: messageId }));
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
      setMessages((prev) => applyStreamEvent(prev, event as unknown as StreamEvent, { engine, assistantId: messageId }));
    }
  }, [setMessages, flushStreamBuffer, onSessionId, onFetchTitle, cwd, engine]);

  // #10 ws-converge: tail the active detached run over /ws/session-stream and feed every
  // event through the SAME handleStreamEvent the SSE path used — so token usage, title,
  // retry indicators, deltas, tools, result and errors are all reused unchanged.
  // At most one socket per hook (enabled only while a run is active).
  useWebSocket({
    url: activeRun
      ? `/ws/session-stream?sessionId=${encodeURIComponent(activeRun.runKey)}`
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
      const msg = data as {
        type?: string;
        status?: string;
        events?: unknown[];
        outputTokens?: number;
        message?: Record<string, unknown>;
      };
      if (msg.type === 'run-snapshot' && Array.isArray(msg.events)) {
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
        // #bg: reset per-run turn tracking and drop any live-created follow-up bubbles / event
        // bars (id `auto-*`) so this authoritative replay rebuilds them cleanly. Scope the drop
        // to THIS run's own bubbles (runKey === ar.runKey): the snapshot replays only the current
        // run's turns, so wiping a PRIOR run's `auto-*` bubbles here would delete continuation
        // bubbles the replay never rebuilds — they'd vanish until a page reload restored them.
        curAsstIdRef.current = ar.assistantId;
        sawResultRef.current = false;
        turnActiveRef.current = false;
        sawServerUsageUpdateRef.current = false;
        setLiveOutputTokens(null);
        const snapshotOutputTokens = typeof msg.outputTokens === 'number' && Number.isFinite(msg.outputTokens)
          ? Math.max(0, Math.round(msg.outputTokens))
          : null;
        if (snapshotOutputTokens !== null) {
          sawServerUsageUpdateRef.current = true;
          setLiveOutputTokens({ outputTokens: snapshotOutputTokens });
        }
        setMessages((prev) =>
          prev
            .filter((m) => !(typeof m.id === 'string' && m.id.startsWith('auto-') && m.runKey === ar.runKey))
            .map((m) => (m.id === ar.assistantId ? { ...m, content: '', toolCalls: [] } : m))
        );
        for (const ev of msg.events) handleStreamEvent(ev as Record<string, unknown>, curAsstIdRef.current ?? ar.assistantId);
        // Run already finished before we connected (status idle/error in the snapshot).
        if (msg.status && msg.status !== 'running') endRun();
      } else if (msg.type === 'run-event' && msg.message) {
        // 'run-ended' is the single definitive end signal (engines may emit several
        // intermediate 'result's — codex = one per turn — so we must NOT end on result).
        if (msg.message.type === 'run-ended') { endRun(); return; }
        handleStreamEvent(msg.message, curAsstIdRef.current ?? ar.assistantId);
      } else if (msg.type === 'run-idle') {
        endRun();
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
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content,
        images: messageImages,
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);
      setLiveOutputTokens(null);
      sawServerUsageUpdateRef.current = false;
      setRunningStartedAt(Date.now());
      // Fresh send: clear stale retry notice from a previous turn
      setApiRetryInfo(null);

      // Create assistant message placeholder
      const assistantMessageId = `assistant-${Date.now()}`;
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        isStreaming: true,
      };
      setMessages((prev) => [...prev, assistantMessage]);
      // #bg: bind live rendering to this launching bubble and reset per-run turn tracking.
      curAsstIdRef.current = assistantMessageId;
      sawResultRef.current = false;
      turnActiveRef.current = false;

      const isClaudeEngine = !engine || engine === 'claude';
      // The engines configured by API key. Both offer Built-in Agent mode — server runs
      // engines/builtinAgent against their OpenAI-compatible endpoint instead of the Agent SDK.
      const isApiKeyEngine = engine === 'deepseek' || engine === 'kimi' || engine === 'glm';
      const useBuiltin = chatMode === 'builtin' && isApiKeyEngine;
      // Independent task: the Built-in Agent loop honours it directly (ollama,
      // deepseek/kimi/glm + builtin). Claude and Codex stash their vendor
      // transcript/rollout for the turn.
      const canDropHistory = engine === 'ollama' || useBuiltin || isClaudeEngine || engine === 'codex';

      const runId = genRunId();

      try {
        // Ollama requires a model to be selected
        if (engine === 'ollama' && !ollamaModel) {
          throw new Error('Please select an Ollama model first (click the model picker above)');
        }

        const apiUrl = engine === 'codex' ? '/api/chat/codex' : engine === 'kimi' ? '/api/chat/kimi' : engine === 'ollama' ? '/api/chat/ollama' : engine === 'deepseek' ? '/api/chat/deepseek' : engine === 'glm' ? '/api/chat/glm' : '/api/chat';
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
            ...(isClaudeEngine && claudeModel && { model: claudeModel }),
            ...(isClaudeEngine && claudeEffort && { claudeEffort }),
            ...(isClaudeEngine && claudeContextWindow && { claudeContextWindow }),
            ...(isClaudeEngine && claudeFastMode !== undefined && { claudeFastMode }),
            ...(isClaudeEngine && claudeThinking !== undefined && { claudeThinking }),
            ...(engine === 'codex' && codexModel && { model: codexModel }),
            ...(engine === 'codex' && codexReasoningEffort && { codexReasoningEffort }),
            ...(useBuiltin && { mode: 'builtin' }),
            // Plan mode: only meaningful in SDK mode on a claude engine (PTY has its own
            // Shift+Tab plan). When unchecked, omit → server defaults to bypassPermissions.
            ...(usePlanMode && isClaudeEngine && { permissionMode: 'plan' }),
            // Independent task (see canDropHistory). Omitted when off.
            ...(canDropHistory && noHistory && { noHistory: true }),
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

        const startBody = (await response.json().catch(() => ({}))) as { runKey?: string };
        // Hand off to the ws consumer; it ends the run on result / run-idle.
        setActiveRun({ runKey: startBody.runKey || runId, assistantId: assistantMessageId });
        // Arm the connection watchdog: if /ws/session-stream never delivers a message (it sends
        // a snapshot immediately on connect), the socket failed to connect → unstick the turn.
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
            endRun();
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
              ? { ...msg, content: errorMsg, isStreaming: false }
              : msg
          )
        );
        setIsLoading(false);
        setActiveRun(null);
      }
    },
    [cwd, engine, chatMode, planMode, noHistory, ollamaModel, engineModel, claudeModel, claudeEffort, claudeContextWindow, claudeFastMode, claudeThinking, codexModel, codexReasoningEffort, setMessages, endRun]
  );

  return {
    isLoading,
    tokenUsage,
    liveOutputTokens,
    runningStartedAt,
    rateLimitInfo,
    apiRetryInfo,
    handleSend,
    handleStop,
    abortControllerRef,
  };
}
