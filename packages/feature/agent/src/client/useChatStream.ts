'use client';

import { useState, useCallback, useRef } from 'react';
import { applyStreamEvent, type StreamEvent } from './applyStreamEvent';
import type {
  ChatMessage,
  ImageInfo,
  MessageImage,
  TokenUsage,
  RateLimitInfo,
  ApiRetryInfo,
  ChatEngine,
  DeepseekModel,
  ChatMode,
} from './types';
import i18n from '@cockpit/shared-i18n';
import { useWebSocket } from '@cockpit/shared-ui';
import { PTY_COLS, PTY_ROWS } from './XtermFloatingWindow';

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
  /** 'pty' → subscription-billing mode (interactive claude CLI); defaults to 'sdk'. Only effective for claude/claude2 */
  chatMode?: ChatMode;
  /** Plan mode (SDK + claude engine only): read-only exploration that produces a plan without editing */
  planMode?: boolean;
  ollamaModel?: string;
  deepseekModel?: DeepseekModel;
  onSessionId: (sid: string) => void;
  onFetchTitle: (sid: string) => void;
  /** PTY mode: raw terminal output (forwarded to the floating-window xterm) */
  onPtyOutput?: (data: string) => void;
}

interface UseChatStreamReturn {
  isLoading: boolean;
  tokenUsage: TokenUsage | null;
  rateLimitInfo: RateLimitInfo | null;
  apiRetryInfo: ApiRetryInfo | null;
  ptyNotice: string | null;
  handleSend: (content: string, images?: ImageInfo[]) => Promise<void>;
  handleStop: () => void;
  abortControllerRef: React.RefObject<AbortController | null>;
}

// ============================================
// Hook
// ============================================

export function useChatStream(
  messages: ChatMessage[],
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  { sessionId, cwd, engine, chatMode, planMode, ollamaModel, deepseekModel, onSessionId, onFetchTitle, onPtyOutput }: UseChatStreamOptions
): UseChatStreamReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [rateLimitInfo, setRateLimitInfo] = useState<RateLimitInfo | null>(null);
  const [apiRetryInfo, setApiRetryInfo] = useState<ApiRetryInfo | null>(null);
  // PTY notice (stuck / timed-out): shown in the loading bubble, like apiRetryInfo
  const [ptyNotice, setPtyNotice] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // #10 ws-converge: the active detached run the originator is tailing over
  // /ws/session-stream (runKey to subscribe by + the assistant bubble its events fill).
  const [activeRun, setActiveRun] = useState<{ runKey: string; assistantId: string } | null>(null);
  const activeRunRef = useRef(activeRun);
  activeRunRef.current = activeRun;

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
    const ar = activeRunRef.current;
    if (ar) {
      setMessages((prev) => prev.map((m) => (m.id === ar.assistantId ? { ...m, isStreaming: false } : m)));
    }
    setActiveRun(null);
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

    // PTY mode: raw terminal output → floating window (does not enter the message stream)
    if (eventType === 'pty_output') {
      onPtyOutput?.(event.data as string);
      return;
    }

    // PTY notice: easy-to-notice, in the message area (not a corner toast).
    // - transient (stuck): shown in the loading bubble (like apiRetryInfo); user can take over in the terminal.
    // - terminal (timed-out): written as the assistant message content so it persists after the turn ends.
    if (eventType === 'pty_notice') {
      // Server sends a messageKey (+ optional params); resolve via i18n on the client.
      const m = event.messageKey
        ? i18n.t(event.messageKey as string, (event.params as Record<string, unknown>) || {})
        : (event.message as string | undefined);
      if (!m) return;
      if (event.terminal) {
        setMessages((prev) => prev.map((msg) => (msg.id === messageId ? { ...msg, content: m, isStreaming: false } : msg)));
      } else {
        setPtyNotice(m);
      }
      return;
    }

    // Handle session_id
    if (eventType === 'system' && event.subtype === 'init') {
      const newSessionId = event.session_id as string;
      onSessionId(newSessionId);
      sessionIdRef.current = newSessionId;
      // Successful init means any prior retry chain has resolved
      setApiRetryInfo(null);
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
      setPtyNotice(prev => prev ? null : prev);
      const streamEvent = event.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (streamEvent?.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
        const deltaText = streamEvent.delta.text || '';

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
    // Complete assistant message (codex/kimi/ollama/synthetic text + tool_use blocks)
    if (eventType === 'assistant') {
      setMessages((prev) => applyStreamEvent(prev, event as unknown as StreamEvent, { engine, assistantId: messageId }));
    }

    // Tool result (user turn) → merge into the matching toolCall
    if (eventType === 'user') {
      setMessages((prev) => applyStreamEvent(prev, event as unknown as StreamEvent, { engine, assistantId: messageId }));
    }

    // Handle final result
    if (eventType === 'result') {
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
  }, [setMessages, flushStreamBuffer, onSessionId, onFetchTitle, cwd, engine, onPtyOutput]);

  // #10 ws-converge: tail the active detached run over /ws/session-stream and feed every
  // event through the SAME handleStreamEvent the SSE path used — so token usage, title,
  // retry/pty indicators, deltas, tools, result and errors are all reused unchanged.
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
        setMessages((prev) =>
          prev.map((m) =>
            m.id === ar.assistantId ? { ...m, content: '', toolCalls: [] } : m
          )
        );
        for (const ev of msg.events) handleStreamEvent(ev as Record<string, unknown>, ar.assistantId);
        // Run already finished before we connected (status idle/error in the snapshot).
        if (msg.status && msg.status !== 'running') endRun();
      } else if (msg.type === 'run-event' && msg.message) {
        // 'run-ended' is the single definitive end signal (engines may emit several
        // intermediate 'result's — codex = one per turn — so we must NOT end on result).
        if (msg.message.type === 'run-ended') { endRun(); return; }
        handleStreamEvent(msg.message, ar.assistantId);
      } else if (msg.type === 'run-idle') {
        endRun();
      }
      // 'ping': ignore
    },
  });

  // Send message
  const handleSend = useCallback(
    async (content: string, images?: ImageInfo[]) => {
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
      // Fresh send: clear stale retry / pty notice from a previous turn
      setApiRetryInfo(null);
      setPtyNotice(null);

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

      // PTY mode (claude/claude2 only). Images are written to temp files by the backend driver + the prompt carries the paths for claude to read.
      const isClaudeEngine = !engine || engine === 'claude' || engine === 'claude2';
      const usePty = chatMode === 'pty' && isClaudeEngine;

      const runId = genRunId();

      try {
        // Ollama requires a model to be selected
        if (engine === 'ollama' && !ollamaModel) {
          throw new Error('Please select an Ollama model first (click the model picker above)');
        }

        const apiUrl = engine === 'codex' ? '/api/chat/codex' : engine === 'kimi' ? '/api/chat/kimi' : engine === 'ollama' ? '/api/chat/ollama' : engine === 'deepseek' ? '/api/chat/deepseek' : '/api/chat';
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
            ...(engine === 'deepseek' && deepseekModel && { model: deepseekModel }),
            ...(engine === 'claude2' && { engine: 'claude2' }),
            ...(usePty && { mode: 'pty', ptyCols: PTY_COLS, ptyRows: PTY_ROWS }),
            // Plan mode: only meaningful in SDK mode on a claude engine (PTY has its own
            // Shift+Tab plan). When unchecked, omit → server defaults to bypassPermissions.
            ...(planMode && !usePty && isClaudeEngine && { permissionMode: 'plan' }),
          }),
        });

        if (response.status === 400 && engine === 'deepseek') {
          // Surface the readable error (likely "API key is not configured")
          const errBody = await response.json().catch(() => null);
          throw new Error(errBody?.error || 'DeepSeek request failed');
        }

        if (!response.ok) {
          throw new Error(i18n.t('chat.requestFailed', { defaultValue: 'Request failed' }));
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
    [cwd, engine, chatMode, planMode, ollamaModel, deepseekModel, setMessages, endRun]
  );

  return {
    isLoading,
    tokenUsage,
    rateLimitInfo,
    apiRetryInfo,
    ptyNotice,
    handleSend,
    handleStop,
    abortControllerRef,
  };
}
