'use client';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { ChatMessage, TokenUsage, ImageInfo } from '@/types/chat';
import { MessageList, MessageListHandle } from './MessageList';
import { ChatInput } from './ChatInput';
import { SessionBrowser } from '../shared/SessionBrowser';
import { ProjectSessionsModal } from './ProjectSessionsModal';
import { SettingsModal } from '../shared/SettingsModal';
import { CommentsListModal } from './CommentsListModal';
import { UserMessagesModal } from './UserMessagesModal';
import { useChatContextOptional } from './ChatContext';
import { ChatHeader, TokenUsageBar } from './ChatHeader';
import { useChatStream } from './useChatStream';
import { useChatHistory } from './useChatHistory';
import { useTranslation } from 'react-i18next';

interface ChatProps {
  tabId?: string; // Tab ID, used to register with ChatContext
  initialCwd?: string;
  initialSessionId?: string;
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
}

export function Chat({ tabId, initialCwd, initialSessionId, hideHeader, hideSidebar, isActive = true, onLoadingChange, onSessionIdChange, onTitleChange, onShowGitStatus, onOpenNote, onCreateScheduledTask, onOpenSession, onContentSearch }: ChatProps) {
  const { t } = useTranslation();
  const chatContext = useChatContextOptional();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isSessionBrowserOpen, setIsSessionBrowserOpen] = useState(false);
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCommentsListOpen, setIsCommentsListOpen] = useState(false);
  const [isUserMessagesOpen, setIsUserMessagesOpen] = useState(false);
  const [historyTokenUsage, setHistoryTokenUsage] = useState<TokenUsage | null>(null);
  const messageListRef = useRef<MessageListHandle>(null);
  const handleSendRef = useRef<((message: string) => void) | null>(null);

  // Fetch session title
  const fetchSessionTitle = useCallback(async (sid: string) => {
    if (!initialCwd) return;
    try {
      const response = await fetch('/api/session-by-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: initialCwd, sessionId: sid }),
      });
      if (response.ok) {
        const data = await response.json();
        if (data.title) {
          onTitleChange?.(data.title);
        }
      }
    } catch (error) {
      console.error('Failed to fetch session title:', error);
    }
  }, [initialCwd, onTitleChange]);

  // Stream hook
  const {
    isLoading,
    tokenUsage: streamTokenUsage,
    handleSend,
    handleStop,
  } = useChatStream(messages, setMessages, {
    sessionId,
    cwd: initialCwd,
    onSessionId: setSessionId,
    onFetchTitle: fetchSessionTitle,
  });

  // ! prefix or cock/cock-dev prefix: first line is command, subsequent lines are user notes, supports images
  const wrappedHandleSend = useCallback(async (content: string, images?: ImageInfo[]) => {
    const firstLine = content.split('\n')[0];
    const isBangCmd = firstLine.startsWith('!') && firstLine.length > 1;
    const isCockCmd = firstLine.startsWith('cock ') || firstLine.startsWith('cock-dev ');
    if (isBangCmd || isCockCmd) {
      const command = isBangCmd ? firstLine.slice(1).trim() : firstLine;
      if (!command) { handleSend(content, images); return; }

      const userNote = content.split('\n').slice(1).join('\n').trim();

      try {
        const res = await fetch('/api/bash', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, cwd: initialCwd }),
        });
        const data = await res.json();
        const output = [data.stdout, data.stderr].filter(Boolean).join('\n') || '(no output)';
        const exitInfo = data.exitCode ? ` (exit code: ${data.exitCode})` : '';
        let message = t('chat.executedCommand', { command, exitInfo, output });
        if (userNote) message += `\n\n${userNote}`;
        handleSend(message, images);
      } catch (err) {
        handleSend(t('chat.executedCommandFailed', { command, error: err }), images);
      }
      return;
    }
    handleSend(content, images);
  }, [handleSend, initialCwd, t]);

  // History hook
  const {
    isLoadingHistory,
    isLoadingMore,
    hasMoreHistory,
    loadMoreHistory,
    loadHistoryByCwdAndSessionId,
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
      window.parent.postMessage({
        type: 'SESSION_COMPLETE',
        cwd: initialCwd,
        sessionId,
        lastUserMessage,
      }, '*');
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

  // Handle sidebar session click - notify parent Workspace to open
  const handleSelectSession = useCallback((sid: string, _title?: string) => {
    if (initialCwd) {
      window.parent.postMessage({
        type: 'OPEN_PROJECT',
        cwd: initialCwd,
        sessionId: sid,
      }, '*');
    }
  }, [initialCwd]);

  // Fork session from a specified message point
  const handleFork = useCallback(async (messageId: string) => {
    if (!initialCwd || !sessionId) return;

    try {
      const response = await fetch(`/api/session/${sessionId}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: initialCwd,
          fromMessageUuid: messageId,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (onOpenSession) {
          onOpenSession(data.newSessionId, 'Fork');
        } else {
          window.parent.postMessage({
            type: 'OPEN_PROJECT',
            cwd: initialCwd,
            sessionId: data.newSessionId,
          }, '*');
        }
      } else {
        console.error('Fork failed:', await response.text());
      }
    } catch (error) {
      console.error('Fork error:', error);
    }
  }, [initialCwd, sessionId, onOpenSession]);

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
      });
    };
  }, [onCreateScheduledTask, initialCwd, tabId, sessionId]);

  return (
    <div className={`flex ${hideHeader && hideSidebar ? 'h-full' : 'h-screen'} bg-card`}>
      {/* Main Content */}
      <div
        id="chat-screen"
        className="flex-1 flex flex-col min-w-0 relative"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Header - optionally hidden */}
        {!hideHeader && (
          <ChatHeader
            cwd={initialCwd}
            sessionId={sessionId}
            onOpenProjectSessions={() => setIsProjectSessionsOpen(true)}
            onOpenSessionBrowser={() => setIsSessionBrowserOpen(true)}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
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
            hasMoreHistory={hasMoreHistory}
            isLoadingMore={isLoadingMore}
            onLoadMore={loadMoreHistory}
            onFork={handleFork}
            isActive={isActive}
            onContentSearch={onContentSearch}
          />
        )}

        {/* Token Usage Display */}
        {tokenUsage && <TokenUsageBar tokenUsage={tokenUsage} />}

        {/* Input */}
        <ChatInput
          onSend={wrappedHandleSend}
          disabled={isLoading}
          cwd={initialCwd}
          onShowGitStatus={onShowGitStatus}
          onShowComments={initialCwd ? handleShowComments : undefined}
          onShowUserMessages={handleShowUserMessages}
          onOpenNote={onOpenNote}
          onCreateScheduledTask={handleCreateScheduledTask}
        />
      </div>

      {/* Session Browser Modal - only shown when header is not hidden */}
      {!hideHeader && (
        <SessionBrowser
          isOpen={isSessionBrowserOpen}
          onClose={() => setIsSessionBrowserOpen(false)}
        />
      )}

      {/* Project Sessions Modal - only shown when header is not hidden */}
      {!hideHeader && initialCwd && (
        <ProjectSessionsModal
          isOpen={isProjectSessionsOpen}
          onClose={() => setIsProjectSessionsOpen(false)}
          cwd={initialCwd}
        />
      )}

      {/* Settings Modal */}
      {!hideHeader && (
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
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
