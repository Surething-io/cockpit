'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { ChatMessage, ToolCallInfo, ImageInfo, MessageImage, TokenUsage } from '@/types/chat';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { SessionBrowser } from './SessionBrowser';
import { ProjectSessionsModal } from './ProjectSessionsModal';
import { SettingsModal } from './SettingsModal';

interface ChatProps {
  initialCwd?: string;
  initialSessionId?: string;
  hideHeader?: boolean;
  hideSidebar?: boolean;
  onLoadingChange?: (isLoading: boolean) => void;
  onSessionIdChange?: (sessionId: string) => void;
  onTitleChange?: (title: string) => void;
  onShowGitStatus?: () => void;
}

export function Chat({ initialCwd, initialSessionId, hideHeader, hideSidebar, onLoadingChange, onSessionIdChange, onTitleChange, onShowGitStatus }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [currentTurnIndex, setCurrentTurnIndex] = useState<number | undefined>(undefined);
  const [totalTurns, setTotalTurns] = useState(0);
  const [isSessionBrowserOpen, setIsSessionBrowserOpen] = useState(false);
  const [isProjectSessionsOpen, setIsProjectSessionsOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 分页参数
  const TURNS_PER_PAGE = 10;

  // 根据 cwd + sessionId 加载历史消息
  // incremental: 是否增量更新（只更新变化的部分，不触发滚动）
  // limit: 每次加载的 turn 数量
  // beforeTurnIndex: 加载此 turn 之前的消息
  const loadHistoryByCwdAndSessionId = async (
    cwd: string,
    sid: string,
    incremental = false,
    limit?: number,
    beforeTurnIndex?: number
  ) => {
    if (!incremental) {
      setIsLoadingHistory(true);
    }
    try {
      const response = await fetch('/api/session-by-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, sessionId: sid, limit, beforeTurnIndex }),
      });
      if (response.ok) {
        const data = await response.json();

        // 更新分页状态
        if (data.totalTurns !== undefined) {
          setTotalTurns(data.totalTurns);
        }
        if (data.hasMore !== undefined) {
          setHasMoreHistory(data.hasMore);
        }

        if (data.messages && data.messages.length > 0) {
          if (incremental) {
            // 增量更新模式：只更新变化的消息
            setMessages((prevMessages) => {
              const newMessages = data.messages as ChatMessage[];
              // 如果消息数量相同且最后一条消息相同，不更新
              if (
                prevMessages.length === newMessages.length &&
                prevMessages.length > 0 &&
                prevMessages[prevMessages.length - 1].content === newMessages[newMessages.length - 1].content
              ) {
                return prevMessages;
              }
              // 找到第一个不同的消息索引
              let diffIndex = 0;
              for (let i = 0; i < Math.min(prevMessages.length, newMessages.length); i++) {
                if (
                  prevMessages[i].id !== newMessages[i].id ||
                  prevMessages[i].content !== newMessages[i].content
                ) {
                  break;
                }
                diffIndex = i + 1;
              }
              // 保留相同的前缀，替换后面的部分
              if (diffIndex === prevMessages.length && diffIndex < newMessages.length) {
                // 只有新增消息，追加即可
                return [...prevMessages, ...newMessages.slice(diffIndex)];
              }
              // 有更新或删除，需要替换
              return newMessages;
            });
          } else {
            setMessages(data.messages);
          }
        }
        if (data.sessionId) {
          setSessionId(data.sessionId);
        }
        // 通知父组件标题变化
        if (data.title) {
          onTitleChange?.(data.title);
        }
        // 设置 token 使用信息（从历史记录的最后一条 assistant 消息获取）
        if (data.usage) {
          setTokenUsage({
            inputTokens: data.usage.input_tokens || 0,
            outputTokens: data.usage.output_tokens || 0,
            cacheCreationInputTokens: data.usage.cache_creation_input_tokens || 0,
            cacheReadInputTokens: data.usage.cache_read_input_tokens || 0,
            totalCostUsd: 0, // 历史记录中没有费用信息
          });
        }
      }
    } catch (error) {
      console.error('Failed to load history by cwd and sessionId:', error);
    } finally {
      if (!incremental) {
        setIsLoadingHistory(false);
      }
    }
  };

  // 加载更多历史消息（向上滚动时调用）
  const loadMoreHistory = useCallback(async () => {
    if (!initialCwd || !sessionId || isLoadingMore || !hasMoreHistory) return;

    setIsLoadingMore(true);
    try {
      // 计算当前已加载的 turn 数量
      // 从 totalTurns 减去已加载的范围来确定 beforeTurnIndex
      const beforeIndex = currentTurnIndex !== undefined
        ? currentTurnIndex
        : totalTurns - Math.ceil(messages.filter(m => m.role === 'user').length);

      const response = await fetch('/api/session-by-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd: initialCwd,
          sessionId,
          limit: TURNS_PER_PAGE,
          beforeTurnIndex: beforeIndex > 0 ? beforeIndex : undefined
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.messages && data.messages.length > 0) {
          // 将新消息添加到现有消息前面
          setMessages(prev => [...data.messages, ...prev]);
          // 更新当前 turn 索引
          const loadedTurns = data.messages.filter((m: ChatMessage) => m.role === 'user').length;
          setCurrentTurnIndex(beforeIndex - loadedTurns);
        }
        if (data.hasMore !== undefined) {
          setHasMoreHistory(data.hasMore);
        }
      }
    } catch (error) {
      console.error('Failed to load more history:', error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [initialCwd, sessionId, isLoadingMore, hasMoreHistory, currentTurnIndex, totalTurns, messages]);

  // 页面加载时加载历史消息（只运行一次）
  useEffect(() => {
    // 如果有 initialCwd + initialSessionId，加载指定的会话历史（只加载最新 10 个 turn）
    if (initialCwd && initialSessionId) {
      loadHistoryByCwdAndSessionId(initialCwd, initialSessionId, false, TURNS_PER_PAGE);
      return;
    }

    // 如果有 initialCwd 但没有 initialSessionId，说明是新建空白会话，不加载任何历史
    if (initialCwd) {
      return;
    }

    // 如果没有 initialCwd（独立模式），从后端读取状态
    const loadState = async () => {
      try {
        const response = await fetch('/api/state');
        if (response.ok) {
          const state = await response.json();
          if (state.sessionId) {
            setSessionId(state.sessionId);
            loadHistory(state.sessionId);
          }
        }
      } catch (error) {
        console.error('Failed to load state:', error);
      }
    };
    loadState();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 只在组件挂载时运行一次

  // 当 sessionId 变化时通知父组件
  useEffect(() => {
    if (sessionId) {
      onSessionIdChange?.(sessionId);
    }
  }, [sessionId, onSessionIdChange]);

  // 当 sessionId 变化时保存到后端（仅在独立模式下）
  useEffect(() => {
    // 如果有 initialCwd，说明是在 TabManager 中管理，不需要保存到后端
    if (initialCwd) return;
    if (!sessionId) return;

    fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch((error) => {
      console.error('Failed to save state:', error);
    });
  }, [sessionId, initialCwd]);

  // 当 isLoading 变化时通知父组件
  useEffect(() => {
    onLoadingChange?.(isLoading);
  }, [isLoading, onLoadingChange]);

  // 加载历史消息
  const loadHistory = async (sid: string) => {
    setIsLoadingHistory(true);
    try {
      const response = await fetch(`/api/session/${sid}/history`);
      if (response.ok) {
        const data = await response.json();
        if (data.messages && data.messages.length > 0) {
          setMessages(data.messages);
        }
      }
    } catch (error) {
      console.error('Failed to load history:', error);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  // 停止生成
  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

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

  const handleSend = useCallback(
    async (content: string, images?: ImageInfo[]) => {
      // 转换图片格式
      const messageImages: MessageImage[] | undefined = images?.map((img) => ({
        type: 'base64' as const,
        media_type: 'image/png' as const,
        data: img.data,
      }));

      // 添加用户消息
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content,
        images: messageImages,
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);

      // 创建助手消息占位
      const assistantMessageId = `assistant-${Date.now()}`;
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        isStreaming: true,
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // 创建 AbortController 用于中断请求
      abortControllerRef.current = new AbortController();

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: content,
            sessionId,
            images: messageImages,
            // 传递 cwd 用于设置工作目录
            cwd: initialCwd,
          }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error('请求失败');
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('无法读取响应流');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;

              try {
                const event = JSON.parse(data);
                handleStreamEvent(event, assistantMessageId);
              } catch {
                // 忽略解析错误
              }
            }
          }
        }
      } catch (error) {
        // 如果是用户主动中断，不显示错误信息
        if (error instanceof Error && error.name === 'AbortError') {
          // 保留已生成的内容，仅结束流式状态
        } else {
          console.error('Chat error:', error);
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? { ...msg, content: '发生错误，请重试', isStreaming: false }
                : msg
            )
          );
        }
      } finally {
        abortControllerRef.current = null;
        setIsLoading(false);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? { ...msg, isStreaming: false }
              : msg
          )
        );
      }
    },
    [sessionId, initialCwd]
  );

  const handleStreamEvent = (event: Record<string, unknown>, messageId: string) => {
    const eventType = event.type as string;

    // 处理 session_id
    if (eventType === 'system' && event.subtype === 'init') {
      setSessionId(event.session_id as string);
      return;
    }

    // 处理流式文本块（打字机效果）
    if (eventType === 'stream_event') {
      const streamEvent = event.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (streamEvent?.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
        const deltaText = streamEvent.delta.text || '';
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId
              ? { ...msg, content: (msg.content || '') + deltaText }
              : msg
          )
        );
      }
      return;
    }

    // 处理文本内容（完整消息）
    if (eventType === 'assistant') {
      const message = event.message as { content?: Array<{ text?: string; name?: string; id?: string; input?: Record<string, unknown> }> } | undefined;
      if (message?.content) {
        for (const block of message.content) {
          // 处理工具调用
          if ('name' in block && block.name) {
            const toolCall: ToolCallInfo = {
              id: (block.id as string) || `tool-${Date.now()}`,
              name: block.name as string,
              input: (block.input as Record<string, unknown>) || {},
              isLoading: true,
            };
            setMessages((prev) =>
              prev.map((msg) => {
                if (msg.id !== messageId) return msg;
                // 避免重复添加
                const exists = msg.toolCalls?.some((tc) => tc.id === toolCall.id);
                if (exists) return msg;
                return {
                  ...msg,
                  toolCalls: [...(msg.toolCalls || []), toolCall],
                };
              })
            );
          }
        }
      }
    }

    // 处理工具结果
    if (eventType === 'user') {
      const message = event.message as { content?: Array<{ tool_use_id?: string; content?: string }> } | undefined;
      if (message?.content) {
        for (const block of message.content) {
          if ('tool_use_id' in block && block.tool_use_id) {
            const toolUseId = block.tool_use_id;
            const result = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);

            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === messageId
                  ? {
                      ...msg,
                      toolCalls: msg.toolCalls?.map((tc) =>
                        tc.id === toolUseId
                          ? { ...tc, result, isLoading: false }
                          : tc
                      ),
                    }
                  : msg
              )
            );
          }
        }
      }
    }

    // 处理最终结果
    if (eventType === 'result') {
      // 捕获 token 使用信息
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

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                isStreaming: false,
                toolCalls: msg.toolCalls?.map((tc) => ({
                  ...tc,
                  isLoading: false,
                })),
              }
            : msg
        )
      );
    }
  };

  // 处理侧边栏点击 session - 打开新标签页
  const handleSelectSession = useCallback((sid: string, _title?: string) => {
    if (initialCwd) {
      const url = `/?cwd=${encodeURIComponent(initialCwd)}&sessionId=${sid}`;
      window.open(url, '_blank');
    }
  }, [initialCwd]);

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
          <div className="border-b border-border px-4 py-3 bg-card">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <img src="/icons/icon-72x72.png" alt="Cockpit" className="w-6 h-6" />
                <div className="flex items-baseline gap-2">
                  <h1 className="text-lg font-semibold text-foreground">
                    Cockpit
                  </h1>
                  <span className="text-xs text-muted-foreground">
                    One seat. One AI. Everything under control.
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {/* 显示项目路径 */}
                {initialCwd && (
                  <span
                    className="text-sm text-foreground max-w-md truncate cursor-help"
                    title={`CWD: ${initialCwd}`}
                  >
                    {initialCwd}
                  </span>
                )}
                {/* 如果没有 initialCwd 但有 sessionId，则显示 sessionId */}
                {!initialCwd && sessionId && (
                  <span className="text-xs text-muted-foreground">
                    Session: {sessionId.slice(0, 8)}...
                  </span>
                )}
                {/* 当前项目 Sessions 按钮（仅当有 cwd 时显示） */}
                {initialCwd && (
                  <button
                    onClick={() => setIsProjectSessionsOpen(true)}
                    className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                    title="项目会话"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </button>
                )}
                {/* 全局 Session Browser 按钮 */}
                <button
                  onClick={() => setIsSessionBrowserOpen(true)}
                  className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                  title="浏览所有会话"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                  </svg>
                </button>
                {/* 设置按钮 */}
                <button
                  onClick={() => setIsSettingsOpen(true)}
                  className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                  title="设置"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Messages */}
        {isLoadingHistory ? (
          <div className="flex-1 flex items-center justify-center">
            <span className="text-muted-foreground">加载历史消息...</span>
          </div>
        ) : (
          <MessageList
            messages={messages}
            isLoading={isLoading}
            cwd={initialCwd}
            hasMoreHistory={hasMoreHistory}
            isLoadingMore={isLoadingMore}
            onLoadMore={loadMoreHistory}
          />
        )}

        {/* Token Usage Display */}
        {tokenUsage && (
          <div className="px-4 py-1.5 border-t border-border bg-secondary">
            <div className="flex items-center justify-end gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
                </svg>
                <span>上下文: <strong className="text-foreground">{(tokenUsage.inputTokens + tokenUsage.cacheReadInputTokens + tokenUsage.cacheCreationInputTokens).toLocaleString()}</strong></span>
              </span>
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
                <span>输出: <strong className="text-foreground">{tokenUsage.outputTokens.toLocaleString()}</strong></span>
              </span>
              {(tokenUsage.cacheReadInputTokens > 0 || tokenUsage.cacheCreationInputTokens > 0) && (
                <span className="flex items-center gap-1 text-brand">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                  </svg>
                  <span>Cache: {((tokenUsage.cacheReadInputTokens / (tokenUsage.inputTokens + tokenUsage.cacheReadInputTokens + tokenUsage.cacheCreationInputTokens)) * 100).toFixed(0)}%</span>
                </span>
              )}
              {tokenUsage.totalCostUsd > 0 && (
                <span className="flex items-center gap-1 text-green-11">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>${tokenUsage.totalCostUsd.toFixed(4)}</span>
                </span>
              )}
            </div>
          </div>
        )}

        {/* Input */}
        <ChatInput
          onSend={handleSend}
          disabled={isLoading}
          cwd={initialCwd}
          onShowGitStatus={onShowGitStatus}
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
    </div>
  );
}
