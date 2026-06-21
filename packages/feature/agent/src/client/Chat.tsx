'use client';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ClipboardList } from 'lucide-react';
import { toast } from '@cockpit/shared-ui';
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
import { XtermFloatingWindow, XtermFloatingHandle } from './XtermFloatingWindow';
import type { ChatMessage, TokenUsage, ImageInfo, ChatEngine, DeepseekModel, ChatMode } from './types';
// In-package siblings (chat-only)
import { ProjectSessionsModal } from './ProjectSessionsModal';
import { OllamaModelPicker } from './OllamaModelPicker';
import { DeepseekConfigPicker } from './DeepseekConfigPicker';
import { CommentsListModal } from '@cockpit/feature-comments';
import { useTranslation } from 'react-i18next';

// Migrated from src/components/project/Chat.tsx.

interface ChatProps {
  tabId?: string; // Tab ID, used to register with ChatContext
  initialCwd?: string;
  initialSessionId?: string;
  engine?: ChatEngine;
  ollamaModel?: string;
  onOllamaModelChange?: (model: string) => void;
  deepseekModel?: DeepseekModel;
  onDeepseekModelChange?: (model: DeepseekModel) => void;
  chatMode?: ChatMode;
  onChatModeChange?: (chatMode: ChatMode) => void;
  planMode?: boolean;
  onPlanModeChange?: (planMode: boolean) => void;
  hideHeader?: boolean;
  hideSidebar?: boolean;
  isActive?: boolean; // Whether the tab is active (used to handle scroll issues for hidden tabs)
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
    message: string;
    type: 'once' | 'interval' | 'cron';
    delayMinutes?: number;
    intervalMinutes?: number;
    activeFrom?: string;
    activeTo?: string;
    cron?: string;
  }) => void;
  onOpenSession?: (sessionId: string, title?: string) => void; // Open a new session (used for Fork)
  onContentSearch?: (query: string) => void; // Selected text → project-wide search
  onOpenSessionBrowser?: () => void; // Host-handled: open the cross-engine session browser
  onOpenSettings?: () => void; // Host-handled: open the app settings modal
}

export function Chat({ tabId, initialCwd, initialSessionId, engine, ollamaModel, onOllamaModelChange, deepseekModel, onDeepseekModelChange, chatMode: chatModeProp, onChatModeChange, planMode: planModeProp, onPlanModeChange, hideHeader, hideSidebar, isActive = true, onLoadingChange, onSessionIdChange, onTitleChange, onShowGitStatus, onOpenNote, onCreateScheduledTask, onOpenSession, onContentSearch, onOpenSessionBrowser, onOpenSettings }: ChatProps) {
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
  const chatMode = chatModeProp ?? localChatMode;
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
  const isClaudeEngine = !engine || engine === 'claude' || engine === 'claude2';
  // PTY floating window: receives raw terminal output
  const ptyWindowRef = useRef<XtermFloatingHandle>(null);
  const handlePtyOutput = useCallback((data: string) => {
    ptyWindowRef.current?.write(data);
  }, []);
  // Manual fallback: floating-window keys → written into the running PTY's stdin
  const handlePtyInput = useCallback((data: string) => {
    if (!sessionId) return;
    fetch('/api/chat/pty-input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, data }),
    }).catch(() => {});
  }, [sessionId]);
  const prevPtyLoadingRef = useRef(false);
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

  // Stream hook
  const {
    isLoading,
    tokenUsage: streamTokenUsage,
    rateLimitInfo,
    apiRetryInfo,
    ptyNotice,
    handleSend,
    handleStop,
  } = useChatStream(messages, setMessages, {
    sessionId,
    cwd: initialCwd,
    engine,
    chatMode,
    planMode,
    ollamaModel,
    deepseekModel,
    onSessionId: setSessionId,
    onFetchTitle: fetchSessionTitle,
    onPtyOutput: handlePtyOutput,
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
          handleSend(rest, images);
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

  // History hook
  const {
    isLoadingHistory,
    isLoadingMore,
    hasMoreHistory,
    loadMoreHistory,
    loadHistoryByCwdAndSessionId,
    loadedSessionId,
  } = useChatHistory(messages, setMessages, sessionId, {
    cwd: initialCwd,
    initialSessionId,
    onSessionId: setSessionId,
    onTitleChange,
    onTokenUsage: setHistoryTokenUsage,
  });

  // Incrementally fetch messages when becoming active (handles external writes like scheduled tasks)
  // With limit to fetch only the last N rounds + fingerprint check + time throttle (inside useChatHistory)
  const prevActiveRef = useRef(isActive);
  useEffect(() => {
    if (isActive && !prevActiveRef.current && sessionId && initialCwd && !isLoading) {
      loadHistoryByCwdAndSessionId(initialCwd, sessionId, true, 10);
    }
    prevActiveRef.current = isActive;
  }, [isActive, sessionId, initialCwd, isLoading, loadHistoryByCwdAndSessionId]);

  // PTY floating window: clear the screen at the start of a new turn (isLoading rising edge)
  useEffect(() => {
    if (chatMode === 'pty' && isLoading && !prevPtyLoadingRef.current) {
      ptyWindowRef.current?.clear();
    }
    prevPtyLoadingRef.current = isLoading;
  }, [isLoading, chatMode]);

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

  // ESC key listener: stop generation when mouse hovers over chat area and ESC is pressed
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isHovered && isLoading) {
        handleStop();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isHovered, isLoading, handleStop]);

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
  const handleFork = useCallback(async (messageId: string) => {
    const forkSid = loadedSessionId ?? sessionId;
    if (!initialCwd || !forkSid) return;

    const exit = await BrowserRuntime.runPromiseExit(
      forkSession<{ newSessionId?: string }>(forkSid, {
        cwd: initialCwd,
        fromMessageUuid: messageId,
      })
    );
    if (exit._tag === 'Success' && exit.value.newSessionId) {
      const newSessionId = exit.value.newSessionId;
      if (onOpenSession) {
        onOpenSession(newSessionId, 'Fork');
      } else {
        publishTopic(Topics.OpenProject, {
          cwd: initialCwd,
          sessionId: newSessionId,
        });
      }
    } else if (exit._tag === 'Failure') {
      console.error('Fork failed:', exit.cause);
    }
  }, [initialCwd, loadedSessionId, sessionId, onOpenSession]);

  // Stabilize ChatInput callback props, combined with React.memo to avoid unnecessary re-renders
  const handleShowComments = useCallback(() => {
    setIsCommentsListOpen(true);
  }, []);

  const handleShowUserMessages = useCallback(() => {
    setIsUserMessagesOpen(true);
  }, []);

  const handleCreateScheduledTask = useMemo(() => {
    if (!onCreateScheduledTask || !initialCwd || !tabId || !sessionId) return undefined;
    return (params: { message: string; type: 'once' | 'interval' | 'cron'; delayMinutes?: number; intervalMinutes?: number; activeFrom?: string; activeTo?: string; cron?: string }) => {
      onCreateScheduledTask({
        ...params,
        cwd: initialCwd,
        tabId,
        sessionId,
        engine,
        ...(engine === 'ollama' && ollamaModel && { model: ollamaModel }),
        ...(engine === 'deepseek' && deepseekModel && { model: deepseekModel }),
      });
    };
  }, [onCreateScheduledTask, initialCwd, tabId, sessionId, engine, ollamaModel, deepseekModel]);

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
            onOpenProjectSessions={() => setIsProjectSessionsOpen(true)}
            onOpenSessionBrowser={onOpenSessionBrowser}
            onOpenSettings={onOpenSettings}
          />
        )}

        {/* Execution mode (claude/claude2 only): SDK ↔ PTY (subscription billing). Switchable dynamically at any time.
            After switching to PTY, subsequent messages resume via `claude -r`; if the session contains SDK edit history,
            upstream rendering may crash — covered by the driver's crash detection (errors instead of hanging), and the
            user can switch back to SDK. */}
        {isClaudeEngine && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card/50">
            <span className="text-xs text-muted-foreground">{t('chat.executionMode', { defaultValue: 'Execution mode' })}</span>
            <div className="inline-flex rounded-md border border-border overflow-hidden text-xs" role="group" data-testid="chatmode-toggle">
              <button
                type="button"
                data-testid="chatmode-sdk"
                onClick={() => setChatMode('sdk')}
                className={`px-2 py-0.5 ${chatMode === 'sdk' ? 'bg-brand text-white' : 'bg-transparent text-muted-foreground hover:bg-accent'}`}
              >
                Claude Agent SDK
              </button>
              <button
                type="button"
                data-testid="chatmode-pty"
                onClick={() => setChatMode('pty')}
                className={`px-2 py-0.5 ${chatMode === 'pty' ? 'bg-brand text-white' : 'bg-transparent text-muted-foreground hover:bg-accent'}`}
                title={t('chat.ptyModeHint', { defaultValue: 'Subscription-billing mode: driven by the interactive claude CLI' })}
              >
                Claude Code CLI
              </button>
            </div>
            {/* Plan mode (SDK only): read-only exploration → produces a plan without editing.
                Plan-only — uncheck and resend to actually implement. */}
            {chatMode === 'sdk' && (
              <label
                className="flex items-center gap-1.5 ml-2 pl-3 border-l border-border text-xs cursor-pointer select-none"
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
          </div>
        )}

        {/* Ollama model picker */}
        {engine === 'ollama' && onOllamaModelChange && (
          <div className="flex items-center px-3 py-1.5 border-b border-border bg-card/50">
            <OllamaModelPicker currentModel={ollamaModel} onModelChange={onOllamaModelChange} />
          </div>
        )}

        {/* DeepSeek API key + model picker */}
        {engine === 'deepseek' && onDeepseekModelChange && (
          <div className="flex items-center px-3 py-1.5 border-b border-border bg-card/50">
            <DeepseekConfigPicker currentModel={deepseekModel} onModelChange={onDeepseekModelChange} />
          </div>
        )}

        {/* Messages */}
        {isLoadingHistory ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-muted-foreground">{t('sessions.loadingHistory')}</span>
          </div>
        ) : (
          <MessageList
            ref={messageListRef}
            messages={messages}
            isLoading={isLoading}
            cwd={initialCwd}
            sessionId={sessionId}
            engine={engine}
            apiRetryInfo={apiRetryInfo}
            ptyNotice={ptyNotice}
            hasMoreHistory={hasMoreHistory}
            isLoadingMore={isLoadingMore}
            onLoadMore={loadMoreHistory}
            onFork={handleFork}
            isActive={isActive}
            onContentSearch={onContentSearch}
          />
        )}

        {/* Token Usage Display */}
        {tokenUsage && <TokenUsageBar tokenUsage={tokenUsage} rateLimitInfo={rateLimitInfo} />}

        {/* Input */}
        <ChatInput
          onSend={wrappedHandleSend}
          disabled={isLoading}
          cwd={initialCwd}
          engine={engine}
          onShowGitStatus={onShowGitStatus}
          onShowComments={initialCwd ? handleShowComments : undefined}
          onShowUserMessages={handleShowUserMessages}
          onOpenNote={onOpenNote}
          onCreateScheduledTask={handleCreateScheduledTask}
        />

        {/* PTY-mode floating window (dual-view: live terminal) */}
        <XtermFloatingWindow
          ref={ptyWindowRef}
          visible={isClaudeEngine && chatMode === 'pty'}
          running={isLoading}
          onInput={handlePtyInput}
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
