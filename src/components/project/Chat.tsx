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

interface ChatProps {
  tabId?: string; // Tab ID，用于注册到 ChatContext
  initialCwd?: string;
  initialSessionId?: string;
  hideHeader?: boolean;
  hideSidebar?: boolean;
  isActive?: boolean; // Tab 是否激活（用于处理隐藏 Tab 的滚动问题）
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
  onOpenSession?: (sessionId: string, title?: string) => void; // 打开新的 session（用于 Fork）
}

export function Chat({ tabId, initialCwd, initialSessionId, hideHeader, hideSidebar, isActive = true, onLoadingChange, onSessionIdChange, onTitleChange, onShowGitStatus, onOpenNote, onCreateScheduledTask, onOpenSession }: ChatProps) {
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

  // 获取 session 标题
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

  // ! 前缀或 cock/cock-dev 开头：第一行是命令，后续行是用户补充说明，支持图片
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
        let message = `执行了 \`${command}\`${exitInfo}，输出：\n\`\`\`\n${output}\n\`\`\``;
        if (userNote) message += `\n\n${userNote}`;
        handleSend(message, images);
      } catch (err) {
        handleSend(`执行 \`${command}\` 失败：${err}`, images);
      }
      return;
    }
    handleSend(content, images);
  }, [handleSend, initialCwd]);

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

  // 切到前台时增量拉取消息（覆盖定时任务等外部写入场景）
  // 带 limit 只拉最近 N 轮 + fingerprint 检查 + 时间节流（useChatHistory 内部）
  const prevActiveRef = useRef(isActive);
  useEffect(() => {
    if (isActive && !prevActiveRef.current && sessionId && initialCwd && !isLoading) {
      loadHistoryByCwdAndSessionId(initialCwd, sessionId, true, 10);
    }
    prevActiveRef.current = isActive;
  }, [isActive, sessionId, initialCwd, isLoading, loadHistoryByCwdAndSessionId]);

  // 合并 token usage：stream 优先，否则用 history 的
  const tokenUsage = streamTokenUsage || historyTokenUsage;

  // 当 sessionId 变化时通知父组件
  useEffect(() => {
    if (sessionId) {
      onSessionIdChange?.(sessionId);
    }
  }, [sessionId, onSessionIdChange]);

  // 当 isLoading 变化时通知父组件
  const prevIsLoadingRef = useRef(false);
  useEffect(() => {
    onLoadingChange?.(isLoading);

    // 当会话完成时（从 loading 变为 非 loading），通知父级 Workspace 弹 toast
    if (prevIsLoadingRef.current && !isLoading && initialCwd && sessionId) {
      // 提取最后一条用户消息作为 toast 预览
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

  // 同步 loading 状态到 ChatContext：只有 active tab 才同步
  // 切换 tab 时 isActive 变化也会触发，确保新 active tab 的状态覆盖旧值
  useEffect(() => {
    if (isActive) {
      chatContext?.setIsLoading(isLoading);
    }
  }, [isLoading, isActive, chatContext]);

  // 注册到 ChatContext（用于从 CodeViewer 发送消息）
  useEffect(() => {
    if (!tabId || !chatContext) return;

    chatContext.registerChat((message: string) => {
      handleSendRef.current?.(message);
    }, tabId);

    return () => {
      chatContext.unregisterChat(tabId);
    };
  }, [tabId, chatContext]);

  // 当 Tab 激活时，通知 ChatContext
  useEffect(() => {
    if (tabId && isActive && chatContext) {
      chatContext.setActiveTab(tabId);
    }
  }, [tabId, isActive, chatContext]);

  // 更新 handleSendRef，供 ChatContext 调用
  useEffect(() => {
    handleSendRef.current = wrappedHandleSend;
  }, [wrappedHandleSend]);

  // ESC 键监听：鼠标悬停在聊天区域时按 ESC 停止生成
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isHovered && isLoading) {
        handleStop();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isHovered, isLoading, handleStop]);

  // 处理侧边栏点击 session - 通知父级 Workspace 打开
  const handleSelectSession = useCallback((sid: string, _title?: string) => {
    if (initialCwd) {
      window.parent.postMessage({
        type: 'OPEN_PROJECT',
        cwd: initialCwd,
        sessionId: sid,
      }, '*');
    }
  }, [initialCwd]);

  // 从指定消息点分叉会话
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

  // 稳定 ChatInput 的回调 props，配合 React.memo 避免不必要的重渲染
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
        {/* Header - 可选隐藏 */}
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
            <span className="text-muted-foreground">加载历史消息...</span>
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

      {/* Session Browser Modal - 仅在不隐藏 header 时显示 */}
      {!hideHeader && (
        <SessionBrowser
          isOpen={isSessionBrowserOpen}
          onClose={() => setIsSessionBrowserOpen(false)}
        />
      )}

      {/* Project Sessions Modal - 仅在不隐藏 header 时显示 */}
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
