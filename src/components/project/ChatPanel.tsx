'use client';

import { useCallback } from 'react';
import { Chat } from './Chat';

// ============================================
// ChatPanel - Simplified Chat panel without header and sidebar
// ============================================

interface ChatPanelProps {
  tabId: string;
  cwd?: string;
  sessionId?: string;
  isActive?: boolean;
  onStateChange: (tabId: string, updates: { isLoading?: boolean; sessionId?: string; title?: string }) => void;
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
  onOpenSession?: (sessionId: string, title?: string) => void;
  onContentSearch?: (query: string) => void;
}

export function ChatPanel({ tabId, cwd, sessionId, isActive, onStateChange, onShowGitStatus, onOpenNote, onCreateScheduledTask, onOpenSession, onContentSearch }: ChatPanelProps) {
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
      onCreateScheduledTask={onCreateScheduledTask}
      onOpenSession={onOpenSession}
      onContentSearch={onContentSearch}
    />
  );
}
