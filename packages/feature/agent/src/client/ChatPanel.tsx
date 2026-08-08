'use client';

import { useCallback } from 'react';
import { Chat } from './Chat';
import type { ChatEngine, EngineModelId, ChatMode, ToolCallInfo } from './types';

// Migrated from src/components/project/ChatPanel.tsx.

// ============================================
// ChatPanel - Simplified Chat panel without header and sidebar
// ============================================

interface ChatPanelProps {
  tabId: string;
  cwd?: string;
  sessionId?: string;
  engine?: ChatEngine;
  /** Backfill from the loaded transcript's store when this tab carries no engine (see ChatProps). */
  onEngineChange?: (tabId: string, engine: ChatEngine) => void;
  ollamaModel?: string;
  onOllamaModelChange?: (tabId: string, model: string) => void;
  deepseekModel?: EngineModelId;
  onDeepseekModelChange?: (tabId: string, model: EngineModelId) => void;
  kimiModel?: EngineModelId;
  onKimiModelChange?: (tabId: string, model: EngineModelId) => void;
  glmModel?: EngineModelId;
  onGlmModelChange?: (tabId: string, model: EngineModelId) => void;
  chatMode?: ChatMode;
  onChatModeChange?: (tabId: string, chatMode: ChatMode) => void;
  planMode?: boolean;
  onPlanModeChange?: (tabId: string, planMode: boolean) => void;
  noHistory?: boolean;
  onNoHistoryChange?: (tabId: string, noHistory: boolean) => void;
  isActive?: boolean;
  // Forwarded to Chat: forced history refresh on explicit session jump (see ChatProps.refreshSignal)
  refreshSignal?: { sessionId: string; nonce: number } | null;
  onStateChange: (tabId: string, updates: { isLoading?: boolean; sessionId?: string; title?: string }) => void;
  onShowGitStatus?: () => void;
  onOpenNote?: () => void;
  onCreateScheduledTask?: (params: {
    cwd: string;
    tabId: string;
    sessionId: string;
    engine?: string;
    model?: string;
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
  onShowFileDiff?: (toolCalls: ToolCallInfo[], cwd?: string) => void;
  onOpenFileLink?: (target: { path: string; lineNumber?: number }) => void;
}

export function ChatPanel({ tabId, cwd, sessionId, engine, onEngineChange, ollamaModel, onOllamaModelChange, deepseekModel, onDeepseekModelChange, kimiModel, onKimiModelChange, glmModel, onGlmModelChange, chatMode, onChatModeChange, planMode, onPlanModeChange, noHistory, onNoHistoryChange, isActive, refreshSignal, onStateChange, onShowGitStatus, onOpenNote, onCreateScheduledTask, onOpenSession, onContentSearch, onShowFileDiff, onOpenFileLink }: ChatPanelProps) {
  const handleLoadingChange = useCallback((isLoading: boolean) => {
    onStateChange(tabId, { isLoading });
  }, [tabId, onStateChange]);

  const handleSessionIdChange = useCallback((newSessionId: string) => {
    onStateChange(tabId, { sessionId: newSessionId });
  }, [tabId, onStateChange]);

  const handleTitleChange = useCallback((title: string) => {
    onStateChange(tabId, { title });
  }, [tabId, onStateChange]);

  const handleEngineChange = useCallback((e: ChatEngine) => {
    onEngineChange?.(tabId, e);
  }, [tabId, onEngineChange]);

  const handleOllamaModelChange = useCallback((model: string) => {
    onOllamaModelChange?.(tabId, model);
  }, [tabId, onOllamaModelChange]);

  const handleDeepseekModelChange = useCallback((model: EngineModelId) => {
    onDeepseekModelChange?.(tabId, model);
  }, [tabId, onDeepseekModelChange]);

  const handleKimiModelChange = useCallback((model: EngineModelId) => {
    onKimiModelChange?.(tabId, model);
  }, [tabId, onKimiModelChange]);

  const handleGlmModelChange = useCallback((model: EngineModelId) => {
    onGlmModelChange?.(tabId, model);
  }, [tabId, onGlmModelChange]);

  const handleChatModeChange = useCallback((m: ChatMode) => {
    onChatModeChange?.(tabId, m);
  }, [tabId, onChatModeChange]);

  const handlePlanModeChange = useCallback((p: boolean) => {
    onPlanModeChange?.(tabId, p);
  }, [tabId, onPlanModeChange]);

  const handleNoHistoryChange = useCallback((v: boolean) => {
    onNoHistoryChange?.(tabId, v);
  }, [tabId, onNoHistoryChange]);

  return (
    <Chat
      tabId={tabId}
      initialCwd={cwd}
      initialSessionId={sessionId}
      engine={engine}
      onEngineChange={handleEngineChange}
      ollamaModel={ollamaModel}
      onOllamaModelChange={handleOllamaModelChange}
      deepseekModel={deepseekModel}
      onDeepseekModelChange={handleDeepseekModelChange}
      kimiModel={kimiModel}
      onKimiModelChange={handleKimiModelChange}
      glmModel={glmModel}
      onGlmModelChange={handleGlmModelChange}
      chatMode={chatMode}
      onChatModeChange={handleChatModeChange}
      planMode={planMode}
      onPlanModeChange={handlePlanModeChange}
      noHistory={noHistory}
      onNoHistoryChange={handleNoHistoryChange}
      hideHeader
      hideSidebar
      isActive={isActive}
      refreshSignal={refreshSignal}
      onLoadingChange={handleLoadingChange}
      onSessionIdChange={handleSessionIdChange}
      onTitleChange={handleTitleChange}
      onShowGitStatus={onShowGitStatus}
      onOpenNote={onOpenNote}
      onCreateScheduledTask={onCreateScheduledTask}
      onOpenSession={onOpenSession}
      onContentSearch={onContentSearch}
      onShowFileDiff={onShowFileDiff}
      onOpenFileLink={onOpenFileLink}
    />
  );
}
