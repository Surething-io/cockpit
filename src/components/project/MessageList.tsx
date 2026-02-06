'use client';

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle, useMemo } from 'react';
import { ChatMessage } from '@/types/chat';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading?: boolean;
  cwd?: string;
  sessionId?: string | null;
  hasMoreHistory?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onFork?: (messageId: string) => void;
  isActive?: boolean; // Tab 是否激活（用于处理隐藏 Tab 的滚动问题）
}

// 暴露给父组件的方法
export interface MessageListHandle {
  scrollToMessage: (messageId: string) => void;
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { messages, isLoading, cwd, sessionId, hasMoreHistory, isLoadingMore, onLoadMore, onFork, isActive = true },
  ref
) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [showTopButton, setShowTopButton] = useState(false);
  const [showBottomButton, setShowBottomButton] = useState(false);

  // 去重消息（防止重复 key 警告）
  const uniqueMessages = useMemo(() => {
    const seen = new Set<string>();
    return messages.filter((msg) => {
      if (seen.has(msg.id)) return false;
      seen.add(msg.id);
      return true;
    });
  }, [messages]);

  // 记录加载更多前的滚动位置，用于保持滚动位置
  const scrollHeightBeforeLoadRef = useRef(0);
  const shouldRestoreScrollRef = useRef(false);

  // 检查是否在底部附近（距离底部 < 50px）
  const checkIfAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    const threshold = 50;
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }, []);

  // 检查是否在顶部附近（距离顶部 < 50px）
  const checkIfAtTop = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    const threshold = 50;
    return container.scrollTop < threshold;
  }, []);

  // 监听滚动事件
  const handleScroll = useCallback(() => {
    const atBottom = checkIfAtBottom();
    const atTop = checkIfAtTop();
    setShouldAutoScroll(atBottom);
    setShowTopButton(!atTop); // 不在顶部时显示跳顶按钮
    setShowBottomButton(!atBottom);

    // 当滚动到顶部且有更多历史时，触发加载更多
    if (atTop && hasMoreHistory && !isLoadingMore && onLoadMore) {
      // 记录当前滚动高度，用于加载后恢复位置
      const container = containerRef.current;
      if (container) {
        scrollHeightBeforeLoadRef.current = container.scrollHeight;
        shouldRestoreScrollRef.current = true;
      }
      onLoadMore();
    }
  }, [checkIfAtBottom, checkIfAtTop, hasMoreHistory, isLoadingMore, onLoadMore]); // hasMoreHistory still needed for loading more logic

  // 跳转到顶部
  const scrollToTop = useCallback(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // 跳转到底部
  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // 滚动到指定消息
  const scrollToMessage = useCallback((messageId: string) => {
    const container = containerRef.current;
    if (!container) return;

    // 查找消息对应的 DOM 元素
    const messageElement = container.querySelector(`[data-message-id="${messageId}"]`);
    if (messageElement) {
      messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // 添加高亮效果
      messageElement.classList.add('ring-2', 'ring-brand', 'ring-offset-2');
      setTimeout(() => {
        messageElement.classList.remove('ring-2', 'ring-brand', 'ring-offset-2');
      }, 2000);
    }
  }, []);

  // 暴露方法给父组件
  useImperativeHandle(ref, () => ({
    scrollToMessage,
  }), [scrollToMessage]);

  // 记录上一次消息数量，用于判断是否有新消息
  const prevMessageCountRef = useRef(0);
  // 标记是否是初次加载
  const isInitialLoadRef = useRef(true);

  // 消息变化时滚动逻辑（仅处理新消息，初次加载由下面的 useEffect 处理）
  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    const currentCount = messages.length;
    prevMessageCountRef.current = currentCount;

    // 初次加载由单独的 useEffect 处理
    if (isInitialLoadRef.current) {
      return;
    }

    // 有新消息且在底部：平滑滚动
    if (shouldAutoScroll && currentCount > prevCount) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, shouldAutoScroll]);

  // isLoading 变化时也检查是否需要滚动（显示/隐藏思考中提示）
  useEffect(() => {
    if (shouldAutoScroll && isLoading) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isLoading, shouldAutoScroll]);

  // 加载更多历史后恢复滚动位置
  useEffect(() => {
    if (shouldRestoreScrollRef.current && !isLoadingMore) {
      const container = containerRef.current;
      if (container) {
        // 计算新增内容的高度差，保持视觉位置不变
        const heightDiff = container.scrollHeight - scrollHeightBeforeLoadRef.current;
        container.scrollTop = heightDiff;
        shouldRestoreScrollRef.current = false;
      }
    }
  }, [messages, isLoadingMore]);

  // 标记是否需要在激活时滚动到底部
  const needsScrollOnActivateRef = useRef(false);

  // 当 Tab 激活时，如果之前因为隐藏而无法滚动，现在补偿滚动
  useEffect(() => {
    if (isActive && needsScrollOnActivateRef.current && messages.length > 0) {
      needsScrollOnActivateRef.current = false;
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [isActive, messages.length]);

  // 修改初次加载逻辑：如果 Tab 隐藏，标记需要在激活时滚动
  useEffect(() => {
    if (isInitialLoadRef.current && messages.length > 0) {
      isInitialLoadRef.current = false;
      if (isActive) {
        bottomRef.current?.scrollIntoView({ behavior: 'instant' });
      } else {
        // Tab 隐藏时，标记需要在激活时滚动
        needsScrollOnActivateRef.current = true;
      }
    }
  }, [messages.length, isActive]);

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto p-4"
      >
        {messages.length === 0 && !isLoading ? (
          <div className="flex items-center justify-center h-full text-slate-9">
            <div className="text-center">
              <div className="text-4xl mb-4">💬</div>
              <div>开始对话吧</div>
            </div>
          </div>
        ) : (
          <>
            <div ref={topRef} />
            {/* 加载更多历史的提示 */}
            {hasMoreHistory && (
              <div className="flex justify-center py-3">
                {isLoadingMore ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                    <span>加载更多...</span>
                  </div>
                ) : (
                  <button
                    onClick={onLoadMore}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    ↑ 向上滚动加载更多历史
                  </button>
                )}
              </div>
            )}
            {uniqueMessages.map((message) => (
              <div key={message.id} data-message-id={message.id} className="transition-all duration-300">
                <MessageBubble
                  message={message}
                  cwd={cwd}
                  sessionId={sessionId}
                  onFork={onFork}
                />
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start mb-4">
                <div className="bg-accent rounded-2xl rounded-bl-md px-4 py-3">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <span className="inline-block w-5 h-5 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm">Claude 正在思考...</span>
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* 跳转到顶部按钮 */}
      {showTopButton && messages.length > 0 && (
        <button
          onClick={scrollToTop}
          className="absolute top-2 left-1/2 -translate-x-1/2 p-2 bg-card text-muted-foreground hover:text-foreground shadow-md rounded-full transition-all hover:shadow-lg active:scale-95"
          title="跳转到开始"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}

      {/* 跳转到底部按钮 */}
      {showBottomButton && messages.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-2 left-1/2 -translate-x-1/2 p-2 bg-card text-muted-foreground hover:text-foreground shadow-md rounded-full transition-all hover:shadow-lg active:scale-95"
          title="跳转到最新"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      )}
    </div>
  );
});
