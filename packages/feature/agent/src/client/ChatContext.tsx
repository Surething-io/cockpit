'use client';

import { createContext, useContext, useState, useCallback, useRef, useMemo, ReactNode } from 'react';
import { AIBridgeProvider, type AIBridge } from '@cockpit/shared-ui';

// Migrated from src/components/project/ChatContext.tsx. Fully self-contained
// (only depends on React + shared-ui's AIBridge IoC).
//
// ChatProvider also renders <AIBridgeProvider> with a value derived from this
// chat context, so non-chat features (file browser, diff viewer, etc.) can
// reach the active chat sender via shared-ui's useAIBridge() — without
// importing @cockpit/feature-agent.

interface ChatContextType {
  // Send a message to the currently active Chat
  sendMessage: (message: string) => void;
  // Send a message to ONE named tab, regardless of which is active. This is
  // what the "send to the other pane" button on a message uses: side-by-side
  // deliberately routes external sends to the focused pane only, so forwarding
  // to the neighbour needs an addressed send rather than the routed one.
  // Works for any mounted tab (TabManager renders every tab, hiding the ones
  // that are not on screen), so the target keeps streaming even if the layout
  // changes. Returns false when no Chat is registered under that id.
  sendToTab: (tabId: string, message: string) => boolean;
  // Whether the current Chat is loading (streaming response)
  isLoading: boolean;
  // Register the Chat's sendMessage method (called by Chat component)
  registerChat: (sendFn: (message: string) => void, tabId: string) => void;
  // Unregister a Chat
  unregisterChat: (tabId: string) => void;
  // Set the tab that externally-routed messages go to (the FOCUSED pane in
  // side-by-side; the only visible tab otherwise).
  setActiveTab: (tabId: string) => void;
  // Report one tab's loading state. Keyed by tabId because side-by-side puts
  // two live Chats on screen at once: a single boolean made them race, and
  // whichever rendered last won, so a streaming pane could be reported idle by
  // its neighbour. `isLoading` above is the OR across reporters — "is any
  // visible chat busy", which is the question AIBridge actually asks.
  setChatLoading: (tabId: string, loading: boolean) => void;
}

const ChatContext = createContext<ChatContextType | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  // Use ref to store senders, avoiding infinite loops from state updates
  const chatSendersRef = useRef<Map<string, (message: string) => void>>(new Map());
  // Currently active Tab ID
  const activeTabIdRef = useRef<string | null>(null);
  // Per-tab loading, reduced to one boolean for consumers. State (not a ref)
  // because it drives UI.
  const [loadingTabIds, setLoadingTabIds] = useState<ReadonlySet<string>>(() => new Set());
  const isLoading = loadingTabIds.size > 0;

  const setChatLoading = useCallback((tabId: string, loading: boolean) => {
    setLoadingTabIds((prev) => {
      if (loading === prev.has(tabId)) return prev;
      const next = new Set(prev);
      if (loading) next.add(tabId); else next.delete(tabId);
      return next;
    });
  }, []);

  // Register Chat's sendMessage method (does not trigger re-render)
  const registerChat = useCallback((sendFn: (message: string) => void, tabId: string) => {
    chatSendersRef.current.set(tabId, sendFn);
  }, []);

  // Unregister Chat (does not trigger re-render)
  const unregisterChat = useCallback((tabId: string) => {
    chatSendersRef.current.delete(tabId);
    // A tab that goes away while streaming would otherwise pin isLoading true
    // forever — there is no longer anyone to report it false.
    setLoadingTabIds((prev) => {
      if (!prev.has(tabId)) return prev;
      const next = new Set(prev);
      next.delete(tabId);
      return next;
    });
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

  // Send a message to a specific Chat by tab id (see the interface comment)
  const sendToTab = useCallback((tabId: string, message: string) => {
    const sender = chatSendersRef.current.get(tabId);
    if (!sender) {
      console.warn(`No chat sender registered for tab ${tabId}`);
      return false;
    }
    sender(message);
    return true;
  }, []);

  // Use useMemo to stabilize context value, avoiding unnecessary re-renders
  const contextValue = useMemo(() => ({
    sendMessage,
    sendToTab,
    isLoading,
    registerChat,
    unregisterChat,
    setActiveTab,
    setChatLoading,
  }), [sendMessage, sendToTab, isLoading, registerChat, unregisterChat, setActiveTab, setChatLoading]);

  // Bridge the chat sender + loading flag through shared-ui's AIBridge so
  // non-chat features can reach the active chat without depending on
  // feature-agent. See packages/shared/ui/src/AIBridge.tsx for the rationale.
  const aiBridge = useMemo<AIBridge>(() => ({
    sendMessage,
    isLoading,
  }), [sendMessage, isLoading]);

  return (
    <ChatContext.Provider value={contextValue}>
      <AIBridgeProvider value={aiBridge}>
        {children}
      </AIBridgeProvider>
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
