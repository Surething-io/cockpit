'use client';

import { createContext, useContext, useState, useCallback, useRef, useMemo, ReactNode } from 'react';

interface ChatContextType {
  // Send a message to the currently active Chat
  sendMessage: (message: string) => void;
  // Whether the current Chat is loading (streaming response)
  isLoading: boolean;
  // Register the Chat's sendMessage method (called by Chat component)
  registerChat: (sendFn: (message: string) => void, tabId: string) => void;
  // Unregister a Chat
  unregisterChat: (tabId: string) => void;
  // Set the currently active Tab
  setActiveTab: (tabId: string) => void;
  // Set loading state
  setIsLoading: (loading: boolean) => void;
}

const ChatContext = createContext<ChatContextType | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  // Use ref to store senders, avoiding infinite loops from state updates
  const chatSendersRef = useRef<Map<string, (message: string) => void>>(new Map());
  // Currently active Tab ID
  const activeTabIdRef = useRef<string | null>(null);
  // Whether currently loading (needs to trigger UI updates, so use state)
  const [isLoading, setIsLoading] = useState(false);

  // Register Chat's sendMessage method (does not trigger re-render)
  const registerChat = useCallback((sendFn: (message: string) => void, tabId: string) => {
    chatSendersRef.current.set(tabId, sendFn);
  }, []);

  // Unregister Chat (does not trigger re-render)
  const unregisterChat = useCallback((tabId: string) => {
    chatSendersRef.current.delete(tabId);
  }, []);

  // Set the currently active Tab (does not trigger re-render)
  const setActiveTab = useCallback((tabId: string) => {
    activeTabIdRef.current = tabId;
  }, []);

  // Send message to the currently active Chat
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

  // Use useMemo to stabilize context value, avoiding unnecessary re-renders
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

// Optional hook, returns null when used outside Provider
export function useChatContextOptional() {
  return useContext(ChatContext);
}
