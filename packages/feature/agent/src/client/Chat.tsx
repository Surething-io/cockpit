'use client';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ClipboardList, Scissors } from 'lucide-react';
import { toast } from '@cockpit/shared-ui';
import { useLiveStream } from './useLiveStream';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  querySessionByPath,
  runBashCommand,
  forkSession,
} from './effect/agentClient';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { ChatHeader } from './ChatHeader';
import { TokenUsageBar } from './TokenUsageBar';
import { UserMessagesModal } from './UserMessagesModal';
import { useChatContextOptional } from './ChatContext';
import { useChatHistory } from './useChatHistory';
import { useChatStream } from './useChatStream';
import { MessageList, MessageListHandle } from './MessageList';
import { ChatInput } from './ChatInput';
import type { ChatMessage, TokenUsage, ImageInfo, ChatEngine, EngineModelId, ChatMode, ToolCallInfo } from './types';
// In-package siblings (chat-only)
import { ProjectSessionsModal } from './ProjectSessionsModal';
import { OllamaModelPicker } from './OllamaModelPicker';
import { EngineConfigPicker } from './EngineConfigPicker';
import { DeepseekBalanceButton } from './DeepseekBalanceButton';
import { EngineQuotaButton } from './EngineQuotaButton';
import type { ApiKeyEngine } from './effect/agentClient';
import { CommentsListModal } from '@cockpit/feature-comments';
import { useTranslation } from 'react-i18next';

// Migrated from src/components/project/Chat.tsx.

const HISTORY_RECONCILE_TURNS = 10;

interface ChatProps {
  tabId?: string; // Tab ID, used to register with ChatContext
  initialCwd?: string;
  initialSessionId?: string;
  engine?: ChatEngine;
  /**
   * Backfill: fired once when this session's engine was NOT supplied by the host (a tab
   * reopened from a session list carries no engine) and history resolved the authoritative
   * one. Lets the host record it so the next open doesn't need the round-trip.
   */
  onEngineChange?: (engine: ChatEngine) => void;
  ollamaModel?: string;
  onOllamaModelChange?: (model: string) => void;
  deepseekModel?: EngineModelId;
  onDeepseekModelChange?: (model: EngineModelId) => void;
  kimiModel?: EngineModelId;
  onKimiModelChange?: (model: EngineModelId) => void;
  glmModel?: EngineModelId;
  onGlmModelChange?: (model: EngineModelId) => void;
  chatMode?: ChatMode;
  onChatModeChange?: (chatMode: ChatMode) => void;
  planMode?: boolean;
  onPlanModeChange?: (planMode: boolean) => void;
  noHistory?: boolean;
  onNoHistoryChange?: (noHistory: boolean) => void;
  hideHeader?: boolean;
  hideSidebar?: boolean;
  isActive?: boolean; // Whether the tab is active (used to handle scroll issues for hidden tabs)
  // Forced history refresh: the host bumps `nonce` when the user explicitly jumps to
  // `sessionId` (scheduled-tasks panel / recent / pinned sessions). Needed because jumping
  // to a tab that is ALREADY active produces no isActive rising edge, so messages appended
  // externally (e.g. a scheduled-task run) would otherwise never be fetched.
  refreshSignal?: { sessionId: string; nonce: number } | null;
  onLoadingChange?: (isLoading: boolean) => void;
  onSessionIdChange?: (sessionId: string) => void;
  onTitleChange?: (title: string) => void;
  onShowGitStatus?: () => void;
  onOpenNote?: () => void;
  onCreateScheduledTask?: (params: {
    cwd: string;
    tabId: string;
    sessionId: string;
    engine?: string;
    model?: string;
    language?: string;
    message: string;
    taskFile?: string;
    type: 'once' | 'interval' | 'cron';
    delayMinutes?: number;
    intervalMinutes?: number;
    activeFrom?: string;
    activeTo?: string;
    cron?: string;
  }) => void;
  onOpenSession?: (sessionId: string, title?: string) => void; // Open a new session (used for Fork)
  onContentSearch?: (query: string) => void; // Selected text → project-wide search
  onShowFileDiff?: (toolCalls: ToolCallInfo[], cwd?: string, sessionId?: string) => void; // Message file changes → Explorer panel + auto-swipe
  onOpenFileLink?: (target: { path: string; lineNumber?: number }) => void; // AI reply file link → Explorer
  onOpenSessionBrowser?: () => void; // Host-handled: open the cross-engine session browser
  onOpenSettings?: () => void; // Host-handled: open the app settings modal
}

export function Chat({ tabId, initialCwd, initialSessionId, engine: engineProp, onEngineChange, ollamaModel, onOllamaModelChange, deepseekModel, onDeepseekModelChange, kimiModel, onKimiModelChange, glmModel, onGlmModelChange, chatMode: chatModeProp, onChatModeChange, planMode: planModeProp, onPlanModeChange, noHistory: noHistoryProp, onNoHistoryChange, hideHeader, hideSidebar, isActive = true, refreshSignal, onLoadingChange, onSessionIdChange, onTitleChange, onShowGitStatus, onOpenNote, onCreateScheduledTask, onOpenSession, onContentSearch, onShowFileDiff, onOpenFileLink, onOpenSessionBrowser, onOpenSettings }: ChatProps) {
  const { t } = useTranslation();
  const chatContext = useChatContextOptional();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  const [isCommentsListOpen, setIsCommentsListOpen] = useState(false);
  const [isUserMessagesOpen, setIsUserMessagesOpen] = useState(false);
  const [historyTokenUsage, setHistoryTokenUsage] = useState<TokenUsage | null>(null);
  // Execution mode (per-tab): controlled by TabInfo.chatMode (persisted); falls back to local state when no prop (standalone use)
  // Default 'sdk' (Claude Agent SDK) — tabs without an explicit choice run in SDK mode
  const [localChatMode, setLocalChatMode] = useState<ChatMode>('sdk');
  const setChatMode = useCallback((m: ChatMode) => {
    setLocalChatMode(m);
    onChatModeChange?.(m);
  }, [onChatModeChange]);
  // Plan mode (per-tab): controlled by TabInfo.planMode (persisted); falls back to
  // local state when no prop (standalone use). Read-only exploration that produces a
  // plan without editing — only meaningful in SDK mode on a claude engine.
  const [localPlanMode, setLocalPlanMode] = useState(false);
  const planMode = planModeProp ?? localPlanMode;
  const setPlanMode = useCallback((p: boolean) => {
    setLocalPlanMode(p);
    onPlanModeChange?.(p);
  }, [onPlanModeChange]);
  // Independent-task mode (per-tab): each user message is sent with no
  // prior history, so the model treats every turn as a standalone task. Same controlled-with-
  // local-fallback shape as planMode above; persisted via TabInfo.noHistory.
  const [localNoHistory, setLocalNoHistory] = useState(false);
  const noHistory = noHistoryProp ?? localNoHistory;
  const setNoHistory = useCallback((v: boolean) => {
    setLocalNoHistory(v);
    onNoHistoryChange?.(v);
  }, [onNoHistoryChange]);
  // Owned by EngineConfigPicker (the only component that reads/writes the credential
  // endpoint); lifted here so the balance/quota button on the execution-mode row above it
  // can gate on a live value rather than a copy that goes stale after a key is saved.
  const [engineHasKey, setEngineHasKey] = useState(false);
  const messageListRef = useRef<MessageListHandle>(null);
  const handleSendRef = useRef<((message: string) => void) | null>(null);

  // Fetch session title
  const fetchSessionTitle = useCallback(async (sid: string) => {
    if (!initialCwd) return;
    const exit = await BrowserRuntime.runPromiseExit(
      querySessionByPath({ cwd: initialCwd, sessionId: sid })
    );
    if (exit._tag === 'Success' && exit.value && typeof exit.value.title === 'string') {
      onTitleChange?.(exit.value.title);
    } else if (exit._tag === 'Failure') {
      console.error('Failed to fetch session title:', exit.cause);
    }
  }, [initialCwd, onTitleChange]);

  // Reconcile-on-run-end: `liveSessionId` is derived below useChatStream, so the actual
  // disk-reload closure is injected into this ref by an effect further down and invoked via
  // a stable thunk. Lets the originator converge its live bubbles to canonical UUIDs when a
  // run ends — symmetric with the viewer's onComplete reconcile.
  const reconcileFromDiskRef = useRef<(() => void) | null>(null);

  // History hook
  // #10: whether useLiveStream is actively rendering a live run for this tab. Declared
  // before useChatHistory so the initial history load can DEFER to the live stream — a viewer
  // that joins mid-run (auto-created tab for a new session) must not also disk-load the
  // in-flight turn, or it renders twice.
  const [liveRunning, setLiveRunning] = useState(false);
  const liveRunningRef = useRef(false);
  useEffect(() => { liveRunningRef.current = liveRunning; }, [liveRunning]);

  // History runs BEFORE the stream hook because it yields the authoritative engine + mode
  // (see the engine resolution right below): a session reopened from a list arrives with no
  // engine at all, and every downstream `!engine` reads as claude.
  const {
    isLoadingHistory,
    isLoadingMore,
    hasMoreHistory,
    loadMoreHistory,
    loadHistoryByCwdAndSessionId,
    loadedSessionId,
    loadedEngine,
    loadedMode,
  } = useChatHistory(messages, setMessages, sessionId, {
    cwd: initialCwd,
    initialSessionId,
    onSessionId: setSessionId,
    onTitleChange,
    onTokenUsage: setHistoryTokenUsage,
    liveRunningRef,
  });

  // Engine + execution mode of THIS session, most-trusted first:
  //   1. what the transcript's own store PROVES (echoed by /api/session-by-path) — a file
  //      sitting in ~/.cockpit/deepseek-sessions ran as deepseek/builtin, full stop;
  //   2. the host's per-tab value (session.json, or handed over by the session list) — the
  //      only source before any transcript exists, i.e. a brand-new tab;
  //   3. the local default.
  //
  // The store outranks the persisted value deliberately: session.json is a UI-written cache
  // that CAN be wrong (reopening a session used to stamp it with the default 'sdk', which is
  // exactly the bug this ordering fixes), while the store is where the bytes physically are.
  // Where the store cannot tell, it reports nothing and the persisted value survives untouched.
  //
  // Resolution must happen BEFORE any use: `undefined` means "not known yet", NOT "claude",
  // yet every downstream check (`!engine`, the apiUrl fallback) reads the two identically.
  const engine = loadedEngine ?? engineProp ?? undefined;
  const rawChatMode = loadedMode ?? chatModeProp ?? localChatMode;
  const chatMode: ChatMode = rawChatMode === 'builtin' ? 'builtin' : 'sdk';
  const isClaudeEngine = !engine || engine === 'claude';
  const isCodexEngine = engine === 'codex';
  // Engines configured by API key rather than by a local CLI login. They share one UI: a
  // key+model picker, an SDK ↔ Built-in Agent toggle, and a consumption readout.
  const apiKeyEngine: ApiKeyEngine | null =
    engine === 'deepseek' || engine === 'kimi' || engine === 'glm' ? engine : null;
  const engineModel =
    apiKeyEngine === 'kimi' ? kimiModel : apiKeyEngine === 'glm' ? glmModel : deepseekModel;
  const onEngineModelChange =
    apiKeyEngine === 'kimi'
      ? onKimiModelChange
      : apiKeyEngine === 'glm'
        ? onGlmModelChange
        : onDeepseekModelChange;
  // Their two modes do NOT share a transcript store (SDK → ~/.cockpit/<engine>/projects,
  // Built-in Agent → ~/.cockpit/<engine>-sessions), so switching mid-session would leave the
  // model blind to history the UI is still showing. The choice is therefore made while the
  // session is empty — a fresh tab — and locked afterwards. `initialSessionId` covers a
  // reopened session whose messages have not finished loading yet.
  const isBuiltinLoop = apiKeyEngine !== null && chatMode === 'builtin';
  const modeLocked = Boolean(initialSessionId) || messages.length > 0;
  // Independent task. The Built-in Agent engines get it by construction (they assemble the
  // message array). Claude/Codex get it by stashing their vendor transcript/rollout for
  // the turn — see server/engines/shared/noHistoryTranscript.ts and noHistoryRollout.ts.
  const supportsNoHistory = engine === 'ollama' || isBuiltinLoop || isClaudeEngine || isCodexEngine;

  // Write what the store proved back into the host's per-tab record — repair, not just
  // fill-in: session.json may hold no entry (a tab reopened from a session list never had
  // one) or a WRONG one (a previous reopen stamped it with the local default). Both converge
  // here, so the resolution above is needed only once per session. The host's updaters
  // no-op on an unchanged value, so this settles after one pass instead of looping.
  useEffect(() => {
    if (loadedEngine && engineProp !== loadedEngine) onEngineChange?.(loadedEngine);
  }, [engineProp, loadedEngine, onEngineChange]);
  useEffect(() => {
    if (!loadedMode) return;
    const normalized = loadedMode === 'builtin' ? 'builtin' : 'sdk';
    if (chatModeProp !== normalized) onChatModeChange?.(normalized);
  }, [chatModeProp, loadedMode, onChatModeChange]);

  // Stream hook
  const {
    isLoading,
    tokenUsage: streamTokenUsage,
    rateLimitInfo,
    apiRetryInfo,
    handleSend,
    handleStop,
  } = useChatStream(messages, setMessages, {
    sessionId,
    cwd: initialCwd,
    engine,
    chatMode,
    planMode,
    noHistory,
    ollamaModel,
    engineModel,
    onSessionId: setSessionId,
    onFetchTitle: fetchSessionTitle,
    onRunComplete: () => reconcileFromDiskRef.current?.(),
  });

  // ! prefix: first line is command, subsequent lines are user notes, supports images
  const wrappedHandleSend = useCallback(async (content: string, images?: ImageInfo[]) => {
    const firstLine = content.split('\n')[0];

    // /plan [task] — client-side plan-mode control (mirrors Claude Code's /plan).
    // Consumed locally; never sent to the agent as literal text. Only meaningful in
    // SDK mode on a claude engine (where the plan checkbox lives).
    //   /plan        → enable plan mode (no send)
    //   /plan off    → disable plan mode (no send; cockpit convenience — Claude Code uses Shift+Tab)
    //   /plan <task> → enable plan mode AND send <task> (runs in plan mode)
    if (isClaudeEngine && chatMode === 'sdk') {
      const planCmd = /^\/plan(?:\s+([\s\S]*))?$/.exec(content.trim());
      if (planCmd) {
        const rest = (planCmd[1] ?? '').trim();
        if (rest.toLowerCase() === 'off') {
          setPlanMode(false);
          toast(t('chat.planModeOff', { defaultValue: 'Plan mode off' }), 'info');
        } else if (rest === '') {
          setPlanMode(true);
          toast(t('chat.planModeOn', { defaultValue: 'Plan mode on' }), 'success');
        } else {
          setPlanMode(true);
          // Explicit override: setPlanMode(true) above won't be reflected in handleSend's
          // closure this tick (React state is async), so force plan mode for this send.
          handleSend(rest, images, { permissionMode: 'plan' });
        }
        return;
      }
    }

    const isBangCmd = firstLine.startsWith('!') && firstLine.length > 1;
    if (isBangCmd) {
      const command = firstLine.slice(1).trim();
      if (!command) { handleSend(content, images); return; }

      const userNote = content.split('\n').slice(1).join('\n').trim();

      const exit = await BrowserRuntime.runPromiseExit(
        runBashCommand({ command, cwd: initialCwd })
      );
      if (exit._tag === 'Success') {
        const data = exit.value;
        const output = [data.stdout, data.stderr].filter(Boolean).join('\n') || '(no output)';
        const exitInfo = data.exitCode ? ` (exit code: ${data.exitCode})` : '';
        let message = t('chat.executedCommand', { command, exitInfo, output });
        if (userNote) message += `\n\n${userNote}`;
        handleSend(message, images);
      } else {
        handleSend(t('chat.executedCommandFailed', { command, error: exit.cause }), images);
      }
      return;
    }
    handleSend(content, images);
  }, [handleSend, initialCwd, t, isClaudeEngine, chatMode, setPlanMode]);

  // Plan-card "approve & run": the user's approval for the presented plan. Persistent off —
  // the Plan toggle visibly turns off and stays off for subsequent turns (mirrors native
  // Claude Code's ExitPlanMode, and the documented "uncheck and resend" flow). The override
  // forces a non-plan execution THIS turn regardless of the async toggle update.
  const handleApprovePlan = useCallback(() => {
    setPlanMode(false);
    handleSend(
      t('chat.approvePlanPrompt', { defaultValue: '已批准，按上述计划开始执行。' }),
      undefined,
      { permissionMode: null }
    );
  }, [handleSend, setPlanMode, t]);

  // #10: live session sync.
  const liveSessionId = loadedSessionId || sessionId;
  // #10: connect the live tail whenever this tab is VIEWING the session (active, not the
  // originator currently sending). The session-stream snapshot's `status` — not the racy
  // global-state broadcast — decides whether a run is live. This is what lets a refreshed
  // originator (or any tab) reliably resume an in-flight run.
  const liveViewerEnabled = isActive && !isLoading && !!liveSessionId;
  useLiveStream(liveSessionId, setMessages, liveViewerEnabled, engine, {
    // Update the ref synchronously (not just via the effect on liveRunning) so the initial
    // history load, resolving moments later, reliably sees that the live stream owns this run.
    onRunningChange: (r) => { liveRunningRef.current = r; setLiveRunning(r); },
    onComplete: () => {
      // Turn finished → reconcile from disk (replaces temp `live-…` bubbles with canonical
      // real-uuid messages).
      if (initialCwd && liveSessionId) loadHistoryByCwdAndSessionId(initialCwd, liveSessionId, true, HISTORY_RECONCILE_TURNS);
    },
  });
  // When not viewing live, clear the running flag.
  useEffect(() => {
    if (!liveViewerEnabled) setLiveRunning(false);
  }, [liveViewerEnabled]);

  // Keep the originator's reconcile-on-run-end closure current (same disk reload the viewer's
  // onComplete uses). Injected into useChatStream via reconcileFromDiskRef so a finished run
  // converges its live bubbles to canonical UUIDs.
  useEffect(() => {
    reconcileFromDiskRef.current = () => {
      if (initialCwd && liveSessionId) loadHistoryByCwdAndSessionId(initialCwd, liveSessionId, true, HISTORY_RECONCILE_TURNS);
    };
  }, [initialCwd, liveSessionId, loadHistoryByCwdAndSessionId]);

  // Incrementally fetch messages when becoming active (handles external writes like scheduled tasks)
  // With limit to fetch only the last N rounds + fingerprint check + time throttle (inside useChatHistory)
  const prevActiveRef = useRef(isActive);
  useEffect(() => {
    // Skip while a live run is in progress — the live stream owns the tail; a lagging
    // disk fetch would momentarily regress it. Reconcile happens on completion instead.
    if (isActive && !prevActiveRef.current && sessionId && initialCwd && !isLoading && !liveRunning) {
      loadHistoryByCwdAndSessionId(initialCwd, sessionId, true, HISTORY_RECONCILE_TURNS);
    }
    prevActiveRef.current = isActive;
  }, [isActive, sessionId, initialCwd, isLoading, liveRunning, loadHistoryByCwdAndSessionId]);

  // Forced refresh on explicit jump (SWITCH_SESSION → scheduled tasks / recent / pinned).
  // The rising-edge fetch above never fires when the target tab is ALREADY active on the
  // agent view — the common case for a scheduled-task session — so the host bumps
  // `refreshSignal` and we fetch unconditionally, bypassing the incremental throttle.
  const refreshNonceRef = useRef(0);
  useEffect(() => {
    if (!refreshSignal || refreshSignal.nonce === refreshNonceRef.current) return;
    // Record the nonce even when this tab doesn't match, so a later unrelated
    // dependency change can't replay a stale signal.
    refreshNonceRef.current = refreshSignal.nonce;
    const sid = sessionId || loadedSessionId;
    if (!initialCwd || !sid) return;
    if (refreshSignal.sessionId !== sessionId && refreshSignal.sessionId !== loadedSessionId) return;
    // A live-streaming or in-flight run owns the tail; onComplete reconciles from disk.
    if (isLoading || liveRunning) return;
    loadHistoryByCwdAndSessionId(initialCwd, sid, true, 10, undefined, true);
  }, [refreshSignal, sessionId, loadedSessionId, initialCwd, isLoading, liveRunning, loadHistoryByCwdAndSessionId]);

  // Merge token usage: stream takes priority, fallback to history
  const tokenUsage = streamTokenUsage || historyTokenUsage;

  // Notify parent when sessionId changes
  useEffect(() => {
    if (sessionId) {
      onSessionIdChange?.(sessionId);
    }
  }, [sessionId, onSessionIdChange]);

  // Notify parent when isLoading changes
  const prevIsLoadingRef = useRef(false);
  useEffect(() => {
    onLoadingChange?.(isLoading);

    // When session completes (loading → not loading), notify parent Workspace to show toast
    if (prevIsLoadingRef.current && !isLoading && initialCwd && sessionId) {
      // Extract the last user message as toast preview
      let lastUserMessage: string | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' && messages[i].content) {
          lastUserMessage = messages[i].content.slice(0, 100);
          break;
        }
      }
      publishTopic(Topics.SessionComplete, {
        cwd: initialCwd,
        sessionId,
        lastUserMessage,
      });
    }
    prevIsLoadingRef.current = isLoading;
  }, [isLoading, onLoadingChange, initialCwd]);

  // Sync loading state to ChatContext: only sync for the active tab
  // isActive change on tab switch also triggers this, ensuring the new active tab overrides the old value
  useEffect(() => {
    if (isActive) {
      chatContext?.setIsLoading(isLoading);
    }
  }, [isLoading, isActive, chatContext]);

  // Register with ChatContext (used to send messages from CodeViewer)
  useEffect(() => {
    if (!tabId || !chatContext) return;

    chatContext.registerChat((message: string) => {
      handleSendRef.current?.(message);
    }, tabId);

    return () => {
      chatContext.unregisterChat(tabId);
    };
  }, [tabId, chatContext]);

  // Notify ChatContext when tab becomes active
  useEffect(() => {
    if (tabId && isActive && chatContext) {
      chatContext.setActiveTab(tabId);
    }
  }, [tabId, isActive, chatContext]);

  // Update handleSendRef for ChatContext to call
  useEffect(() => {
    handleSendRef.current = wrappedHandleSend;
  }, [wrappedHandleSend]);

  // ESC key listener: stop generation when hovering the chat area. Tabs are symmetric —
  // works whether THIS tab is the originator (isLoading) or a viewer of a run that's live
  // elsewhere (liveRunning). handleStop hits /api/chat/stop, which aborts the detached run
  // and emits a terminal event so every tab finalizes.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isHovered && (isLoading || liveRunning)) {
        handleStop();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isHovered, isLoading, liveRunning, handleStop]);

  // Fork session from a specified message point.
  //
  // IMPORTANT: route the fork through `loadedSessionId` (the sessionId of
  // the JSONL file the user is currently looking at), NOT through
  // `sessionId` (which the SDK overwrites on every `system.init` event).
  // The bubble id passed in is a uuid taken from the loaded file; using a
  // drifted sessionId would point the server at a different file where
  // that uuid may not exist, causing fork.ts to silently degrade to a
  // full-file copy. Fall back to `sessionId` only when no file has been
  // loaded yet (fresh tab with no history).
  //
  // scope='prefix' branches the conversation (everything up to this turn); scope='single'
  // lifts just this one turn into a session of its own.
  const handleForkImpl = useCallback(async (messageId: string, scope: 'prefix' | 'single') => {
    const forkSid = loadedSessionId ?? sessionId;
    if (!initialCwd || !forkSid) return;

    const exit = await BrowserRuntime.runPromiseExit(
      forkSession<{ newSessionId?: string }>(forkSid, {
        cwd: initialCwd,
        fromMessageUuid: messageId,
        scope,
      })
    );
    if (exit._tag === 'Success' && exit.value.newSessionId) {
      const newSessionId = exit.value.newSessionId;
      const label = scope === 'single' ? 'Excerpt' : 'Fork';
      if (onOpenSession) {
        onOpenSession(newSessionId, label);
      } else {
        publishTopic(Topics.OpenProject, {
          cwd: initialCwd,
          sessionId: newSessionId,
        });
      }
    } else if (exit._tag === 'Failure') {
      // Must be visible: this used to be console-only, so every failure (a session whose
      // store we cannot write to, a uuid missing from the file) looked to the user like a
      // dead button that did nothing at all.
      console.error('Fork failed:', exit.cause);
      toast(
        scope === 'single'
          ? t('toast.excerptFailed', { defaultValue: 'Failed to excerpt this turn' })
          : t('toast.forkFailed', { defaultValue: 'Failed to fork session' }),
        'error'
      );
    }
  }, [initialCwd, loadedSessionId, sessionId, onOpenSession, t]);

  // Stabilize the fork callback passed down to every (memoized) MessageBubble.
  // handleForkImpl's identity changes whenever loadedSessionId / sessionId churn
  // (each of the many re-renders a session switch fans out), which would break
  // MessageBubble's React.memo and re-parse react-markdown for the whole list on
  // every switch. A ref indirection keeps the passed-down identity constant while
  // still calling the latest implementation.
  const handleForkRef = useRef(handleForkImpl);
  handleForkRef.current = handleForkImpl;
  const handleFork = useRef((messageId: string, scope: 'prefix' | 'single') =>
    handleForkRef.current(messageId, scope)
  ).current;

  // Stabilize ChatInput callback props, combined with React.memo to avoid unnecessary re-renders
  const handleShowComments = useCallback(() => {
    setIsCommentsListOpen(true);
  }, []);

  const handleShowUserMessages = useCallback(() => {
    setIsUserMessagesOpen(true);
  }, []);

  const handleCreateScheduledTask = useMemo(() => {
    if (!onCreateScheduledTask || !initialCwd || !tabId || !sessionId) return undefined;
    return (params: { message: string; taskFile?: string; type: 'once' | 'interval' | 'cron'; delayMinutes?: number; intervalMinutes?: number; activeFrom?: string; activeTo?: string; cron?: string }) => {
      onCreateScheduledTask({
        ...params,
        cwd: initialCwd,
        tabId,
        sessionId,
        engine,
        ...(engine === 'ollama' && ollamaModel && { model: ollamaModel }),
        ...(apiKeyEngine && engineModel && { model: engineModel }),
      });
    };
  }, [onCreateScheduledTask, initialCwd, tabId, sessionId, engine, ollamaModel, apiKeyEngine, engineModel]);

  /* Independent task: each message is sent WITHOUT the prior turns. Stays on until unchecked —
     it's a session-level mode, not a one-shot. The transcript keeps recording, so the history
     above is unaffected.
     One shared node mounted into whichever engine's option row is visible (claude/codex /
     ollama / deepseek), rather than a copy per row — adding an engine here means adding a
     mount point, so keep `supportsNoHistory` and the mount points in step. */
  const independentTaskToggle = supportsNoHistory ? (
    <label
      className="flex items-center gap-1.5 text-xs cursor-pointer select-none"
      title={t('chat.noHistoryHint', { defaultValue: 'Independent task: each message is sent to the model on its own, with no prior conversation. The transcript above still records everything.' })}
    >
      <input
        type="checkbox"
        data-testid="nohistory-toggle"
        checked={noHistory}
        onChange={(e) => setNoHistory(e.target.checked)}
        className="accent-brand"
      />
      <span className="flex items-center gap-1 text-foreground">
        <Scissors className="w-3.5 h-3.5" />
        {t('chat.noHistory', { defaultValue: 'Independent task' })}
      </span>
      <span className="text-muted-foreground">{t('chat.noHistoryDesc', { defaultValue: 'no history sent' })}</span>
    </label>
  ) : null;

  return (
    <div className={`flex ${hideHeader && hideSidebar ? 'h-full' : 'h-screen'} bg-card`}>
      {/* Main Content */}
      <div
        id="chat-screen"
        className="flex-1 flex flex-col min-w-0 relative"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Header - optionally hidden. Session-browser/settings opens are
            delegated to the host (app layer) via callbacks; Chat itself
            does not own those modals. */}
        {!hideHeader && (
          <ChatHeader
            cwd={initialCwd}
            sessionId={sessionId}
            engine={engine}
            onOpenProjectSessions={() => setIsProjectSessionsOpen(true)}
            onOpenSessionBrowser={onOpenSessionBrowser}
            onOpenSettings={onOpenSettings}
          />
        )}

        {/* Execution mode (deepseek / kimi): Claude Agent SDK ↔ Built-in Agent (our own loop,
            engines/builtinAgent). Locked once the session has messages — the two modes keep
            separate transcript stores, so the choice belongs to a fresh tab. See `modeLocked`. */}
        {apiKeyEngine && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card/50">
            <span className="text-xs text-muted-foreground">{t('chat.executionMode', { defaultValue: 'Execution mode' })}</span>
            <div className="inline-flex rounded-md border border-border overflow-hidden text-xs" role="group" data-testid={`${apiKeyEngine}-mode-toggle`}>
              <button
                type="button"
                data-testid={`${apiKeyEngine}-mode-sdk`}
                disabled={modeLocked}
                onClick={() => setChatMode('sdk')}
                className={`px-2 py-0.5 ${chatMode !== 'builtin' ? 'bg-brand text-white' : 'bg-transparent text-muted-foreground hover:bg-accent'} ${modeLocked ? 'opacity-60 cursor-not-allowed' : ''}`}
              >
                Claude Agent SDK
              </button>
              <button
                type="button"
                data-testid={`${apiKeyEngine}-mode-builtin`}
                disabled={modeLocked}
                onClick={() => setChatMode('builtin')}
                className={`px-2 py-0.5 ${chatMode === 'builtin' ? 'bg-brand text-white' : 'bg-transparent text-muted-foreground hover:bg-accent'} ${modeLocked ? 'opacity-60 cursor-not-allowed' : ''}`}
                title={t('chat.builtinModeHint', { defaultValue: "Cockpit's own agent loop, talking to the provider's OpenAI-compatible endpoint" })}
              >
                Built-in Agent
              </button>
            </div>
            {modeLocked && (
              <span className="text-xs text-muted-foreground">
                {t('chat.modeLockedHint', { defaultValue: 'Locked for this session — open a new tab to switch' })}
              </span>
            )}
            {/* Right-aligned: what the key has left belongs to the key, not to the mode toggle it
                sits next to. DeepSeek reports a prepaid balance, Kimi a subscription quota. */}
            {apiKeyEngine === 'deepseek'
              ? <DeepseekBalanceButton hasKey={engineHasKey} />
              : <EngineQuotaButton engine={apiKeyEngine} hasKey={engineHasKey} />}
          </div>
        )}

        {/* Claude / Codex SDK options. CLI execution modes were intentionally removed. */}
        {(isClaudeEngine || isCodexEngine) && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card/50">
            {/* Plan mode: read-only exploration → produces a plan without editing.
                Plan-only — uncheck and resend to actually implement. */}
            {isClaudeEngine && (
              <label
                className="flex items-center gap-1.5 text-xs cursor-pointer select-none"
                title={t('chat.planModeHint', { defaultValue: 'Plan mode: read-only exploration that produces a plan without editing. Uncheck and resend to implement.' })}
              >
                <input
                  type="checkbox"
                  data-testid="planmode-toggle"
                  checked={planMode}
                  onChange={(e) => setPlanMode(e.target.checked)}
                  className="accent-brand"
                />
                <span className="flex items-center gap-1 text-foreground">
                  <ClipboardList className="w-3.5 h-3.5" />
                  {t('chat.planMode', { defaultValue: 'Plan mode' })}
                </span>
                <span className="text-muted-foreground">{t('chat.planModeDesc', { defaultValue: 'read-only · plan first, no edits' })}</span>
              </label>
            )}
            {independentTaskToggle}
          </div>
        )}

        {/* Ollama model picker + independent-task toggle */}
        {engine === 'ollama' && (
          <div className="flex items-center px-3 py-1.5 border-b border-border bg-card/50">
            {onOllamaModelChange && (
              <OllamaModelPicker currentModel={ollamaModel} onModelChange={onOllamaModelChange} />
            )}
            {independentTaskToggle}
          </div>
        )}

        {/* API key + model picker (+ independent task in Built-in Agent mode). The picker's
            model list and the settings key it persists to both follow the mode — the two
            endpoints can expose different model ids. */}
        {apiKeyEngine && onEngineModelChange && (
          <div className="flex items-center px-3 py-1.5 border-b border-border bg-card/50">
            <EngineConfigPicker
              engine={apiKeyEngine}
              currentModel={engineModel}
              onModelChange={onEngineModelChange}
              builtin={isBuiltinLoop}
              onHasKeyChange={setEngineHasKey}
            />
            {independentTaskToggle}
          </div>
        )}

        {/* Messages */}
        {isLoadingHistory ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-muted-foreground">{t('sessions.loadingHistory')}</span>
          </div>
        ) : (
          <MessageList
            // #10: as a viewer, drive the "thinking" bubble from the live run status too.
            ref={messageListRef}
            messages={messages}
            isLoading={isLoading || liveRunning}
            cwd={initialCwd}
            sessionId={sessionId}
            engine={engine}
            apiRetryInfo={apiRetryInfo}
            hasMoreHistory={hasMoreHistory}
            isLoadingMore={isLoadingMore}
            onLoadMore={loadMoreHistory}
            onFork={handleFork}
            isActive={isActive}
            onContentSearch={onContentSearch}
            onShowFileDiff={onShowFileDiff}
            onOpenFileLink={onOpenFileLink}
            onApprovePlan={handleApprovePlan}
          />
        )}

        {/* Token Usage Display */}
        {tokenUsage && <TokenUsageBar tokenUsage={tokenUsage} rateLimitInfo={rateLimitInfo} />}

        {/* Input */}
        <ChatInput
          onSend={wrappedHandleSend}
          // #10: disable while THIS tab streams, or while the session is running elsewhere
          // (viewer) — one active run per session; a concurrent send would 409.
          disabled={isLoading || liveRunning}
          cwd={initialCwd}
          engine={engine}
          onShowGitStatus={onShowGitStatus}
          onShowComments={initialCwd ? handleShowComments : undefined}
          onShowUserMessages={handleShowUserMessages}
          onOpenNote={onOpenNote}
          onCreateScheduledTask={handleCreateScheduledTask}
        />

      </div>

      {/* Project Sessions Modal — chat-domain modal (per-cwd session list).
          Session-browser (cross-engine) and Settings modals live in the host
          (app layer); Chat just emits onOpenSessionBrowser / onOpenSettings. */}
      {!hideHeader && initialCwd && (
        <ProjectSessionsModal
          isOpen={isProjectSessionsOpen}
          onClose={() => setIsProjectSessionsOpen(false)}
          cwd={initialCwd}
        />
      )}

      {/* Comments List Modal */}
      {initialCwd && (
        <CommentsListModal
          isOpen={isCommentsListOpen}
          onClose={() => setIsCommentsListOpen(false)}
          cwd={initialCwd}
        />
      )}

      {/* User Messages Modal */}
      <UserMessagesModal
        isOpen={isUserMessagesOpen}
        onClose={() => setIsUserMessagesOpen(false)}
        messages={messages}
        onSelectMessage={(messageId) => {
          messageListRef.current?.scrollToMessage(messageId);
        }}
      />
    </div>
  );
}
