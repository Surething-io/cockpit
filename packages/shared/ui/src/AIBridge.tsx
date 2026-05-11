'use client';

import { createContext, useContext, type ReactNode } from 'react';

// AIBridge — IoC slot exposing the host's "send a message to the agent"
// capability to non-chat features (file browser, diff viewer, etc.) without
// pulling them into a dependency on @cockpit/feature-agent.
//
// Why: components like DiffView, BlockViewer, and InteractiveMarkdownPreview
// have a "Send selection to AI" button. They want to forward selected text
// to the active chat session, but they live in feature-explorer (or stay in
// the main shell), which by MODULES.md cannot import from feature-agent
// (feature → feature is forbidden).
//
// Solution: feature-agent's ChatProvider also renders <AIBridgeProvider>
// with a value that bridges to its internal chat sender + loading flag.
// Consumers use useAIBridge() and stay decoupled.
//
// If no provider wraps the tree (e.g. review page, workspace panel), the
// hook returns null and components disable the "send to AI" affordance.

export interface AIBridge {
  /** Send a message to the host's currently active AI session. */
  sendMessage: (message: string) => void;
  /** Whether the host is currently streaming an AI response. */
  isLoading: boolean;
}

const AIBridgeContext = createContext<AIBridge | null>(null);

export function AIBridgeProvider({
  value,
  children,
}: {
  value: AIBridge | null;
  children: ReactNode;
}) {
  return <AIBridgeContext.Provider value={value}>{children}</AIBridgeContext.Provider>;
}

/** Returns the active AI bridge or null if no provider wraps the tree. */
export function useAIBridge(): AIBridge | null {
  return useContext(AIBridgeContext);
}
