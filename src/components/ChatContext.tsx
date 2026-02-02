'use client';

import { createContext, useContext, useState, useCallback, useRef, useMemo, ReactNode } from 'react';

interface ChatContextType {
  // 发送消息到当前激活的 Chat
  sendMessage: (message: string) => void;
  // 当前 Chat 是否正在加载（流式响应中）
  isLoading: boolean;
  // 注册 Chat 的 sendMessage 方法（由 Chat 组件调用）
  registerChat: (sendFn: (message: string) => void, tabId: string) => void;
  // 注销 Chat
  unregisterChat: (tabId: string) => void;
  // 设置当前激活的 Tab
  setActiveTab: (tabId: string) => void;
  // 设置加载状态
  setIsLoading: (loading: boolean) => void;
}

const ChatContext = createContext<ChatContextType | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  // 使用 ref 存储 senders，避免状态更新导致无限循环
  const chatSendersRef = useRef<Map<string, (message: string) => void>>(new Map());
  // 当前激活的 Tab ID
  const activeTabIdRef = useRef<string | null>(null);
  // 当前是否在加载中（这个需要触发 UI 更新，所以用 state）
  const [isLoading, setIsLoading] = useState(false);

  // 注册 Chat 的 sendMessage 方法（不触发重新渲染）
  const registerChat = useCallback((sendFn: (message: string) => void, tabId: string) => {
    chatSendersRef.current.set(tabId, sendFn);
  }, []);

  // 注销 Chat（不触发重新渲染）
  const unregisterChat = useCallback((tabId: string) => {
    chatSendersRef.current.delete(tabId);
  }, []);

  // 设置当前激活的 Tab（不触发重新渲染）
  const setActiveTab = useCallback((tabId: string) => {
    activeTabIdRef.current = tabId;
  }, []);

  // 发送消息到当前激活的 Chat
  const sendMessage = useCallback((message: string) => {
    const activeTabId = activeTabIdRef.current;
    if (!activeTabId) {
      console.warn('No active tab to send message');
      return;
    }
    const sender = chatSendersRef.current.get(activeTabId);
    if (sender) {
      sender(message);
    } else {
      console.warn(`No chat sender registered for tab ${activeTabId}`);
    }
  }, []);

  // 使用 useMemo 稳定 context value，避免不必要的重新渲染
  const contextValue = useMemo(() => ({
    sendMessage,
    isLoading,
    registerChat,
    unregisterChat,
    setActiveTab,
    setIsLoading,
  }), [sendMessage, isLoading, registerChat, unregisterChat, setActiveTab]);

  return (
    <ChatContext.Provider value={contextValue}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChatContext() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChatContext must be used within a ChatProvider');
  }
  return context;
}

// 可选的 hook，在 Provider 外部使用时返回 null
export function useChatContextOptional() {
  return useContext(ChatContext);
}
