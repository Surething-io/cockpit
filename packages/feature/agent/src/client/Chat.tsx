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
import { createPortal } from 'react-dom';
import { TokenUsageBar } from './TokenUsageBar';
import { useComposerSlot } from './ComposerSlot';
import { UserMessagesModal } from './UserMessagesModal';
import { useChatContextOptional } from './ChatContext';
import { useChatHistory } from './useChatHistory';
import { useChatStream, NO_BG_TASKS } from './useChatStream';
import { TaskStoreContext, createTaskStore } from './taskStore';
import { MessageList, MessageListHandle } from './MessageList';
import { ChatInput } from './ChatInput';
import type { ChatMessage, TokenUsage, LiveOutputTokens, BackgroundTaskInfo, ImageInfo, ChatEngine, EngineModelId, ToolCallInfo, ClaudeModelId, ClaudeEffort, ClaudeContextWindow, CodexModelId, CodexReasoningEffort } from './types';
// In-package siblings (chat-only)
import { ProjectSessionsModal } from './ProjectSessionsModal';
import { OllamaModelPicker } from './OllamaModelPicker';
import { EngineConfigPicker } from './EngineConfigPicker';
import {
  AgentModelTraitsPicker,
  DEFAULT_CLAUDE_CONTEXT_WINDOW,
  DEFAULT_CLAUDE_EFFORT,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  resolveClaudeContextWindowForModel,
  resolveClaudeEffortForModel,
  resolveCodexReasoningEffortForModel,
} from './AgentModelTraitsPicker';
import { DeepseekBalanceButton } from './DeepseekBalanceButton';
import { EngineQuotaButton } from './EngineQuotaButton';
import { COLUMN_HEADER_ROW } from './columnHeaderRow';
import type { ApiKeyEngine, UserMessageIndexEntry } from './effect/agentClient';
import { CommentsListModal } from '@cockpit/feature-comments';
import { useTranslation } from 'react-i18next';

// Migrated from src/components/project/Chat.tsx.

const HISTORY_RECONCILE_TURNS = 10;

// Frames a user-message jump waits for its target bubble after paging in the
// turns around it. requestAnimationFrame runs after the commit's layout effects,
// so the first frame that renders the target is the first frame that can scroll
// to it — the budget only has to cover how long React takes, and overshooting
// costs nothing since the loop exits on the first hit.
const JUMP_RENDER_FRAMES = 30;


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
  claudeModel?: ClaudeModelId;
  onClaudeModelChange?: (model: ClaudeModelId) => void;
  claudeEffort?: ClaudeEffort;
  onClaudeEffortChange?: (effort: ClaudeEffort) => void;
  claudeContextWindow?: ClaudeContextWindow;
  onClaudeContextWindowChange?: (contextWindow: ClaudeContextWindow) => void;
  claudeFastMode?: boolean;
  onClaudeFastModeChange?: (fastMode: boolean) => void;
  claudeThinking?: boolean;
  onClaudeThinkingChange?: (thinking: boolean) => void;
  codexModel?: CodexModelId;
  onCodexModelChange?: (model: CodexModelId) => void;
  codexReasoningEffort?: CodexReasoningEffort;
  onCodexReasoningEffortChange?: (effort: CodexReasoningEffort) => void;
  planMode?: boolean;
  onPlanModeChange?: (planMode: boolean) => void;
  noHistory?: boolean;
  onNoHistoryChange?: (noHistory: boolean) => void;
  hideHeader?: boolean;
  hideSidebar?: boolean;
  isActive?: boolean; // Whether the tab is active (used to handle scroll issues for hidden tabs)
  /** Whether this pane owns externally-routed messages. Defaults to isActive;
   *  only side-by-side ever passes it explicitly, to break the tie. */
  isFocused?: boolean;
  /** Side-by-side only: the tab id of the other column, and which side it is on.
   *  Undefined in single-pane mode, which is what hides the message footer's
   *  "send to the other column" button. Chat never derives these itself — panes
   *  are a workspace concern (see peerProps in TabManager). */
  peerTabId?: string;
  peerSide?: 'left' | 'right';
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
  onShowFileDiff?: (messageId: string, toolCalls: ToolCallInfo[], cwd?: string, sessionId?: string, runId?: string, live?: boolean) => void; // Message file changes → Explorer panel + auto-swipe
  onOpenFileLink?: (target: { path: string; lineNumber?: number }) => void; // AI reply file link → Explorer
  onOpenSessionBrowser?: () => void; // Host-handled: open the cross-engine session browser
  onOpenSettings?: () => void; // Host-handled: open the app settings modal
}

/**
 * The engine options row. One per engine family and exactly one ever renders,
 * so inside a pane — where the header is hidden — this is the topmost thing in
 * the column, and the top-right corner it ends in is not its own.
 *
 * Height comes from COLUMN_HEADER_ROW so this bar and the diff viewer's title
 * bar stay the same height when they are side by side; see that file for why it
 * is declared rather than derived from padding.
 *
 * The 28px reserved on the right is this bar's alone. PaneShell floats the
 * close-this-column ✕ at `right-1` with `w-6`, so it covers the first 24.5px of
 * that edge — not the numbers the class names suggest, because `--spacing` is
 * .25rem and this app sets `html { font-size: 14px }`, making one Tailwind unit
 * 3.5px here rather than 4px. At `px-3` (10.5px) the row's rightmost control sat
 * squarely under the ✕ and the two icons drew on top of each other. `pr-8` = 28px
 * clears it with 3.5px to spare.
 *
 * Reserved unconditionally, not only when the pane is split. Making it
 * conditional means telling Chat which column it is in, and Chat deliberately
 * does not know that — see PaneShell, which owns the ✕ for exactly that reason.
 * The cost is 17.5px of empty right edge on one toolbar row when there is no ✕
 * to clear, and nothing competes for that space.
 */
const ENGINE_OPTIONS_ROW = `${COLUMN_HEADER_ROW} pl-3 pr-8 bg-card/50`;

export function Chat({ tabId, initialCwd, initialSessionId, engine: engineProp, onEngineChange, ollamaModel, onOllamaModelChange, deepseekModel, onDeepseekModelChange, kimiModel, onKimiModelChange, glmModel, onGlmModelChange, claudeModel, onClaudeModelChange, claudeEffort, onClaudeEffortChange, claudeContextWindow, onClaudeContextWindowChange, claudeFastMode, onClaudeFastModeChange, claudeThinking, onClaudeThinkingChange, codexModel, onCodexModelChange, codexReasoningEffort, onCodexReasoningEffortChange, planMode: planModeProp, onPlanModeChange, noHistory: noHistoryProp, onNoHistoryChange, hideHeader, hideSidebar, isActive = true, isFocused = isActive, peerTabId, peerSide, refreshSignal, onLoadingChange, onSessionIdChange, onTitleChange, onShowGitStatus, onOpenNote, onCreateScheduledTask, onOpenSession, onContentSearch, onShowFileDiff, onOpenFileLink, onOpenSessionBrowser, onOpenSettings }: ChatProps) {
  const { t } = useTranslation();
  const composerSlot = useComposerSlot();
  // Owned here, not in ChatInput: the composer is portalled when this pane is
  // focused, and a portal container change remounts. Chat is what survives it.
  const [draft, setDraft] = useState('');
  const [draftImages, setDraftImages] = useState<ImageInfo[]>([]);
  const chatContext = useChatContextOptional();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  const [isCommentsListOpen, setIsCommentsListOpen] = useState(false);
  const [isUserMessagesOpen, setIsUserMessagesOpen] = useState(false);
  const [historyTokenUsage, setHistoryTokenUsage] = useState<TokenUsage | null>(null);
  // Plan mode (per-tab): controlled by TabInfo.planMode (persisted); falls back to
  // local state when no prop (standalone use). Read-only exploration that produces a
  // plan without editing — only meaningful on a claude engine.
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
  const [viewerLiveOutputTokens, setViewerLiveOutputTokens] = useState<LiveOutputTokens | null>(null);
  const [viewerRunStartedAt, setViewerRunStartedAt] = useState<number | null>(null);
  const [viewerBackgroundTasks, setViewerBackgroundTasks] = useState<BackgroundTaskInfo[]>(NO_BG_TASKS);
  // Live `system/task_*` state for this tab, keyed by spawning tool_use id. Held beside the
  // message tree because a nested agent's spawning call is not in it — see taskStore.ts. One
  // per Chat instance and never recreated, so a re-render cannot drop a running task's state.
  const taskStore = useMemo(() => createTaskStore(), []);
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
    ensureTurnLoaded,
    loadHistoryByCwdAndSessionId,
    loadedSessionId,
    loadedEngine,
  } = useChatHistory(messages, setMessages, sessionId, {
    cwd: initialCwd,
    initialSessionId,
    onSessionId: setSessionId,
    onTitleChange,
    onTokenUsage: setHistoryTokenUsage,
    liveRunningRef,
  });

  // Engine of THIS session, most-trusted first:
  //   1. what the transcript's own store PROVES (echoed by /api/session-by-path) — a file
  //      sitting in ~/.cockpit/deepseek-sessions ran as deepseek, full stop;
  //   2. the host's per-tab value (session.json, or handed over by the session list) — the
  //      only source before any transcript exists, i.e. a brand-new tab.
  //
  // The store outranks the persisted value deliberately: session.json is a UI-written cache
  // that CAN be wrong (reopening a session used to stamp it with a default), while the store
  // is where the bytes physically are.
  //
  // Resolution must happen BEFORE any use: `undefined` means "not known yet", NOT "claude",
  // yet every downstream check (`!engine`, the apiUrl fallback) reads the two identically.
  const engine = loadedEngine ?? engineProp ?? undefined;
  const isClaudeEngine = !engine || engine === 'claude';
  const isCodexEngine = engine === 'codex';
  const effectiveClaudeModel = claudeModel ?? DEFAULT_CLAUDE_MODEL;
  const effectiveClaudeEffort = resolveClaudeEffortForModel(effectiveClaudeModel, claudeEffort);
  const effectiveClaudeContextWindow = resolveClaudeContextWindowForModel(effectiveClaudeModel, claudeContextWindow);
  const effectiveCodexModel = codexModel ?? DEFAULT_CODEX_MODEL;
  const effectiveCodexReasoningEffort = resolveCodexReasoningEffortForModel(effectiveCodexModel, codexReasoningEffort);
  // Engines configured by API key rather than by a local CLI login. They share one UI: a
  // key+model picker and a consumption readout, and one loop (the Built-in Agent).
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
  // Independent task. The Built-in Agent engines get it by construction (they assemble the
  // message array). Claude/Codex get it by stashing their vendor transcript/rollout for
  // the turn — see server/engines/shared/noHistoryTranscript.ts and noHistoryRollout.ts.
  const supportsNoHistory =
    engine === 'ollama' || apiKeyEngine !== null || isClaudeEngine || isCodexEngine;

  // Write what the store proved back into the host's per-tab record — repair, not just
  // fill-in: session.json may hold no entry (a tab reopened from a session list never had
  // one) or a WRONG one (a previous reopen stamped it with the local default). Both converge
  // here, so the resolution above is needed only once per session. The host's updaters
  // no-op on an unchanged value, so this settles after one pass instead of looping.
  useEffect(() => {
    if (loadedEngine && engineProp !== loadedEngine) onEngineChange?.(loadedEngine);
  }, [engineProp, loadedEngine, onEngineChange]);
  // Stream hook
  const {
    isLoading,
    tokenUsage: streamTokenUsage,
    liveOutputTokens: streamLiveOutputTokens,
    runningStartedAt: streamRunningStartedAt,
    rateLimitInfo,
    apiRetryInfo,
    backgroundTasks,
    handleSend,
    handleStop,
  } = useChatStream(messages, setMessages, {
    sessionId,
    cwd: initialCwd,
    engine,
    planMode,
    noHistory,
    ollamaModel,
    engineModel,
    claudeModel: effectiveClaudeModel,
    claudeEffort: effectiveClaudeEffort,
    claudeContextWindow: effectiveClaudeContextWindow,
    claudeFastMode,
    claudeThinking,
    codexModel: effectiveCodexModel,
    codexReasoningEffort: effectiveCodexReasoningEffort,
    onSessionId: setSessionId,
    onFetchTitle: fetchSessionTitle,
    onRunComplete: () => reconcileFromDiskRef.current?.(),
    taskStore,
  });

  // ! prefix: first line is command, subsequent lines are user notes, supports images
  const wrappedHandleSend = useCallback(async (content: string, images?: ImageInfo[]) => {
    const firstLine = content.split('\n')[0];

    // /plan [task] — client-side plan-mode control (mirrors Claude Code's /plan).
    // Consumed locally; never sent to the agent as literal text. Only meaningful on a
    // claude engine (where the plan checkbox lives).
    //   /plan        → enable plan mode (no send)
    //   /plan off    → disable plan mode (no send; cockpit convenience — Claude Code uses Shift+Tab)
    //   /plan <task> → enable plan mode AND send <task> (runs in plan mode)
    if (isClaudeEngine) {
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
  }, [handleSend, initialCwd, t, isClaudeEngine, setPlanMode]);

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
    onLiveOutputTokens: setViewerLiveOutputTokens,
    onRunStartedAt: setViewerRunStartedAt,
    onBackgroundTasks: (tasks) => setViewerBackgroundTasks(tasks.length ? tasks : NO_BG_TASKS),
    taskStore,
    onComplete: () => {
      // Turn finished → reconcile from disk (replaces temp `live-…` bubbles with canonical
      // real-uuid messages).
      if (initialCwd && liveSessionId) loadHistoryByCwdAndSessionId(initialCwd, liveSessionId, true, HISTORY_RECONCILE_TURNS);
    },
  });
  // When not viewing live, clear the running flag.
  useEffect(() => {
    if (!liveViewerEnabled) {
      setLiveRunning(false);
      setViewerLiveOutputTokens(null);
      setViewerRunStartedAt(null);
      setViewerBackgroundTasks(NO_BG_TASKS);
    }
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
  const liveOutputTokens = isLoading ? streamLiveOutputTokens : liveRunning ? viewerLiveOutputTokens : null;
  const runningStartedAt = isLoading ? streamRunningStartedAt : liveRunning ? viewerRunStartedAt : null;
  // Same originator/viewer precedence: a tab that is not the sender still needs to know what a
  // resident run is waiting on (its background agents), which only the live tail reports.
  const liveBackgroundTasks = isLoading ? backgroundTasks : liveRunning ? viewerBackgroundTasks : NO_BG_TASKS;

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

  // Report this tab's loading state to ChatContext, keyed by tabId.
  //
  // Still gated on isActive, so background tabs stay out of the global answer
  // exactly as before. What changed is that "active" is no longer exclusive:
  // side-by-side has two active panes, and the context ORs their reports
  // instead of letting the last writer win. Going inactive retracts the report
  // rather than overwriting the other pane's.
  useEffect(() => {
    if (!tabId || !chatContext) return;
    chatContext.setChatLoading(tabId, isActive && isLoading);
    if (!isActive) return;
    return () => { chatContext.setChatLoading(tabId, false); };
  }, [tabId, isLoading, isActive, chatContext]);

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

  // Claim the destination for externally-routed messages (CodeViewer "send to
  // AI", comments, …). Gated on isFocused, not isActive: in side-by-side both
  // panes are active, but only one can be the target, and two claimants would
  // hand the route to whichever effect ran last. isFocused defaults to isActive,
  // so the single-pane case is unchanged.
  useEffect(() => {
    if (tabId && isActive && isFocused && chatContext) {
      chatContext.setActiveTab(tabId);
    }
  }, [tabId, isActive, isFocused, chatContext]);

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

  // Forward a message's text to the OTHER column (side-by-side only).
  //
  // An addressed send, not the routed one: ChatContext.sendMessage deliberately
  // goes to the FOCUSED pane, which is this one — the whole point here is to
  // reach the neighbour without stealing focus from it. Focus stays put, since
  // both panes are on screen and moving it would drag the shared composer along
  // (only the focused pane renders one, see the portal below).
  //
  // Sends the plain text only, exactly like the copy button beside it — no tool
  // calls, no thinking, no added framing. Any "forwarded from…" wrapper would be
  // us guessing at intent, and the receiving model reads it as instructions.
  const sendToPeerImpl = useCallback((content: string) => {
    if (!peerTabId || !chatContext) return;
    if (!chatContext.sendToTab(peerTabId, content)) {
      // The neighbour's Chat is not registered (unmounted mid-click). Silent
      // failure here looks exactly like a dead button, so say it.
      toast(t('toast.sendToPeerFailed', { defaultValue: 'Failed to send to the other pane' }), 'error');
      return;
    }
    toast(t('toast.sentToPeer', { defaultValue: 'Sent to the other pane' }), 'success');
  }, [peerTabId, chatContext, t]);

  // Same ref indirection as handleFork above, and for the same reason: this
  // closes over peerTabId + chatContext, and a new identity on every layout
  // change would re-render every memoized MessageBubble in the list.
  const sendToPeerRef = useRef(sendToPeerImpl);
  sendToPeerRef.current = sendToPeerImpl;
  const handleSendToPeer = useRef((content: string) => sendToPeerRef.current(content)).current;

  // Stabilize ChatInput callback props, combined with React.memo to avoid unnecessary re-renders
  const handleShowComments = useCallback(() => {
    setIsCommentsListOpen(true);
  }, []);

  const handleShowUserMessages = useCallback(() => {
    setIsUserMessagesOpen(true);
  }, []);

  // `messages` only holds the paged-in tail, while the user-message modal lists the
  // whole session — so a row may name a message with no DOM node yet. Page its turn
  // in first, then jump. Read through a ref: the callback is handed to a modal and
  // must not take a new identity on every streamed token.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const handleJumpToUserMessage = useCallback(async (entry: UserMessageIndexEntry) => {
    if (messagesRef.current.some((m) => m.id === entry.id)) {
      messageListRef.current?.scrollToMessage(entry.id);
      return;
    }
    await ensureTurnLoaded(entry.turnIndex);
    // The bubble exists only once React has committed the turns just loaded, and
    // that commit is not guaranteed to have happened by the time this promise
    // continuation runs. Retry per frame until it lands.
    for (let attempt = 0; attempt < JUMP_RENDER_FRAMES; attempt++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (messageListRef.current?.scrollToMessage(entry.id)) return;
    }
  }, [ensureTurnLoaded]);

  const handleCreateScheduledTask = useMemo(() => {
    if (!onCreateScheduledTask || !initialCwd || !tabId) return undefined;
    return (params: { message: string; taskFile?: string; type: 'once' | 'interval' | 'cron'; delayMinutes?: number; intervalMinutes?: number; activeFrom?: string; activeTo?: string; cron?: string }) => {
      onCreateScheduledTask({
        ...params,
        cwd: initialCwd,
        tabId,
        // A brand-new chat has no session yet. Rather than block scheduling, hand the
        // task a random id: it misses every engine's session-file lookup, so the first
        // fire takes the existing startFresh path (see scheduledTasks.ts) and rebinds
        // the task to the session the engine mints. Must NOT be '' — an empty id makes
        // findCodexSessionPath glob `*.jsonl` and resume an unrelated rollout.
        sessionId: sessionId ?? crypto.randomUUID(),
        engine,
        ...(engine === 'ollama' && ollamaModel && { model: ollamaModel }),
        ...(apiKeyEngine && engineModel && { model: engineModel }),
        ...(isClaudeEngine && { model: effectiveClaudeModel }),
        ...(isCodexEngine && { model: effectiveCodexModel }),
      });
    };
  }, [onCreateScheduledTask, initialCwd, tabId, sessionId, engine, ollamaModel, apiKeyEngine, engineModel, isClaudeEngine, effectiveClaudeModel, isCodexEngine, effectiveCodexModel]);

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
    // Provider, not props: every tool row needs the store, including the ones inside a
    // SubagentTranscriptModal nested arbitrarily deep. Portals inherit context, so the modal
    // stack is covered without threading a prop through each layer.
    <TaskStoreContext.Provider value={taskStore}>
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

        {/* Claude / Codex SDK options. CLI execution modes were intentionally removed. */}
        {(isClaudeEngine || isCodexEngine) && (
          <div className={ENGINE_OPTIONS_ROW}>
            <AgentModelTraitsPicker
              engine={isCodexEngine ? 'codex' : 'claude'}
              claudeModel={effectiveClaudeModel}
              onClaudeModelChange={onClaudeModelChange}
              claudeEffort={effectiveClaudeEffort}
              onClaudeEffortChange={onClaudeEffortChange}
              claudeContextWindow={effectiveClaudeContextWindow}
              onClaudeContextWindowChange={onClaudeContextWindowChange}
              claudeFastMode={claudeFastMode}
              onClaudeFastModeChange={onClaudeFastModeChange}
              claudeThinking={claudeThinking}
              onClaudeThinkingChange={onClaudeThinkingChange}
              codexModel={effectiveCodexModel}
              onCodexModelChange={onCodexModelChange}
              codexReasoningEffort={effectiveCodexReasoningEffort}
              onCodexReasoningEffortChange={onCodexReasoningEffortChange}
            />
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
          <div className={ENGINE_OPTIONS_ROW}>
            {onOllamaModelChange && (
              <OllamaModelPicker currentModel={ollamaModel} onModelChange={onOllamaModelChange} />
            )}
            {independentTaskToggle}
          </div>
        )}

        {/* API-key engines (deepseek / kimi / glm): key + model picker, independent task, and
            what the key has left — one row, mirroring ollama's. There is no execution-mode
            toggle any more (these run the Built-in Agent loop and nothing else), so the
            consumption readout moved in here rather than keeping a row to itself.
            DeepSeek reports a prepaid balance, Kimi and GLM a subscription quota. */}
        {apiKeyEngine && (
          <div className={ENGINE_OPTIONS_ROW}>
            {onEngineModelChange && (
              <EngineConfigPicker
                engine={apiKeyEngine}
                currentModel={engineModel}
                onModelChange={onEngineModelChange}
                onHasKeyChange={setEngineHasKey}
              />
            )}
            {independentTaskToggle}
            {/* Belongs to the key, not to the turn — pushed right so it reads as status
                rather than as one more control in the sequence. */}
            <div className="ml-auto pl-2">
              {apiKeyEngine === 'deepseek'
                ? <DeepseekBalanceButton hasKey={engineHasKey} />
                : <EngineQuotaButton engine={apiKeyEngine} hasKey={engineHasKey} />}
            </div>
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
            liveOutputTokens={liveOutputTokens}
            runningStartedAt={runningStartedAt}
            cwd={initialCwd}
            sessionId={sessionId}
            engine={engine}
            apiRetryInfo={apiRetryInfo}
            backgroundTasks={liveBackgroundTasks}
            hasMoreHistory={hasMoreHistory}
            isLoadingMore={isLoadingMore}
            onLoadMore={loadMoreHistory}
            onFork={handleFork}
            onSendToPeer={handleSendToPeer}
            peerSide={peerSide}
            isActive={isActive}
            onContentSearch={onContentSearch}
            onShowFileDiff={onShowFileDiff}
            onOpenFileLink={onOpenFileLink}
            onApprovePlan={handleApprovePlan}
            onShowUserMessages={handleShowUserMessages}
          />
        )}

        {/* Token Usage Display */}
        {tokenUsage && <TokenUsageBar tokenUsage={tokenUsage} rateLimitInfo={rateLimitInfo} />}

        {/* Input. In side-by-side the focused pane portals its composer into a
            slot below BOTH panes, so one composer spans the panel and neither
            pane carries its own — which is what keeps their token bars on the
            same line. The unfocused pane renders none at all; that is safe
            because the draft lives on Chat, not inside ChatInput. */}
        {composerSlot && !isFocused ? null : (() => {
          const composer = (
            <ChatInput
              onSend={wrappedHandleSend}
              // #10: disable while THIS tab streams, or while the session is running elsewhere
              // (viewer) — one active run per session; a concurrent send would 409.
              disabled={isLoading || liveRunning}
              cwd={initialCwd}
              engine={engine}
              onShowGitStatus={onShowGitStatus}
              onShowComments={initialCwd ? handleShowComments : undefined}
              onOpenNote={onOpenNote}
              onCreateScheduledTask={handleCreateScheduledTask}
              draft={draft}
              setDraft={setDraft}
              draftImages={draftImages}
              setDraftImages={setDraftImages}
            />
          );
          return composerSlot ? createPortal(composer, composerSlot) : composer;
        })()}

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
        cwd={initialCwd}
        sessionId={loadedSessionId ?? sessionId}
        onSelectMessage={handleJumpToUserMessage}
      />
    </div>
    </TaskStoreContext.Provider>
  );
}
