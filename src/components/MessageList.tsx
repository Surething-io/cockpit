'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { ChatMessage } from '@/types/chat';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading?: boolean;
  cwd?: string;
}

export function MessageList({ messages, isLoading, cwd }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [showTopButton, setShowTopButton] = useState(false);
  const [showBottomButton, setShowBottomButton] = useState(false);

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
    setShowTopButton(!atTop);
    setShowBottomButton(!atBottom);
  }, [checkIfAtBottom, checkIfAtTop]);

  // 跳转到顶部
  const scrollToTop = useCallback(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // 跳转到底部
  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // 记录上一次消息数量，用于判断是否有新消息
  const prevMessageCountRef = useRef(0);
  // 标记是否是初次加载
  const isInitialLoadRef = useRef(true);

  // 消息变化时滚动逻辑
  useEffect(() => {
    const prevCount = prevMessageCountRef.current;
    const currentCount = messages.length;
    prevMessageCountRef.current = currentCount;

    // 初次加载（从 0 变为有消息）：直接滚动到底部
    if (isInitialLoadRef.current && currentCount > 0) {
      isInitialLoadRef.current = false;
      // 使用 instant 而不是 smooth，避免加载时的滚动动画
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
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
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} cwd={cwd} />
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
}
