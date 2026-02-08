'use client';

import { useCallback } from 'react';
import { Chat } from './Chat';

// ============================================
// ChatPanel - 简化的 Chat 面板，不包含 header 和 sidebar
// ============================================

interface ChatPanelProps {
  tabId: string;
  cwd?: string;
  sessionId?: string;
  isActive?: boolean;
  onStateChange: (tabId: string, updates: { isLoading?: boolean; sessionId?: string; title?: string }) => void;
  onShowGitStatus?: () => void;
  onOpenNote?: () => void;
  onOpenSession?: (sessionId: string, title?: string) => void;
}

export function ChatPanel({ tabId, cwd, sessionId, isActive, onStateChange, onShowGitStatus, onOpenNote, onOpenSession }: ChatPanelProps) {
  const handleLoadingChange = useCallback((isLoading: boolean) => {
    onStateChange(tabId, { isLoading });
  }, [tabId, onStateChange]);

  const handleSessionIdChange = useCallback((newSessionId: string) => {
    onStateChange(tabId, { sessionId: newSessionId });
  }, [tabId, onStateChange]);

  const handleTitleChange = useCallback((title: string) => {
    onStateChange(tabId, { title });
  }, [tabId, onStateChange]);

  return (
    <Chat
      tabId={tabId}
      initialCwd={cwd}
      initialSessionId={sessionId}
      hideHeader
      hideSidebar
      isActive={isActive}
      onLoadingChange={handleLoadingChange}
      onSessionIdChange={handleSessionIdChange}
      onTitleChange={handleTitleChange}
      onShowGitStatus={onShowGitStatus}
      onOpenNote={onOpenNote}
      onOpenSession={onOpenSession}
    />
  );
}
