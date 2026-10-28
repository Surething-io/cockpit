'use client';

import { useCallback } from 'react';
import { Chat } from './Chat';
import type { ChatEngine, EngineModelId, ToolCallInfo, ClaudeModelId, ClaudeEffort, CodexModelId, CodexReasoningEffort } from './types';

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
  claudeModel?: ClaudeModelId;
  onClaudeModelChange?: (tabId: string, model: ClaudeModelId) => void;
  claudeEffort?: ClaudeEffort;
  onClaudeEffortChange?: (tabId: string, effort: ClaudeEffort) => void;
  claudeFastMode?: boolean;
  onClaudeFastModeChange?: (tabId: string, fastMode: boolean) => void;
  claudeThinking?: boolean;
  onClaudeThinkingChange?: (tabId: string, thinking: boolean) => void;
  codexModel?: CodexModelId;
  onCodexModelChange?: (tabId: string, model: CodexModelId) => void;
  codexReasoningEffort?: CodexReasoningEffort;
  onCodexReasoningEffortChange?: (tabId: string, effort: CodexReasoningEffort) => void;
  planMode?: boolean;
  onPlanModeChange?: (tabId: string, planMode: boolean) => void;
  noHistory?: boolean;
  onNoHistoryChange?: (tabId: string, noHistory: boolean) => void;
  outputStyle?: string;
  onOutputStyleChange?: (tabId: string, outputStyle: string) => void;
  isActive?: boolean;
  /** Side-by-side: which of the two live panes owns externally-routed
   *  messages. Forwarded verbatim; see Chat's own prop doc. */
  isFocused?: boolean;
  /** Side-by-side: the tab id of the OTHER column, and which side it is on.
   *  Undefined in single-pane mode. Forwarded verbatim; see Chat's prop doc. */
  peerTabId?: string;
  peerSide?: 'left' | 'right';
  // Forwarded to Chat: forced history refresh on explicit session jump (see ChatProps.refreshSignal)
  refreshSignal?: { sessionId: string; nonce: number } | null;
  /** Composer draft presence for this tab (see ChatProps.onDraftPresenceChange). */
  onDraftChange?: (tabId: string, hasDraft: boolean) => void;
  onStateChange: (tabId: string, updates: { isLoading?: boolean; sessionId?: string; title?: string; bot?: string }) => void;
  onShowGitStatus?: () => void;
  onOpenNote?: () => void;
  isFavorite?: boolean;
  onToggleFavorite?: (tabId: string) => void;
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
    startAt?: number | null;
    cron?: string;
  }) => void;
  onOpenSession?: (sessionId: string, title?: string) => void;
  onContentSearch?: (query: string) => void;
  onShowFileDiff?: (messageId: string, toolCalls: ToolCallInfo[], cwd?: string, sessionId?: string, live?: boolean) => void;
  onOpenFileLink?: (target: { path: string; lineNumber?: number }) => void;
}

export function ChatPanel({ tabId, cwd, sessionId, engine, onEngineChange, ollamaModel, onOllamaModelChange, deepseekModel, onDeepseekModelChange, kimiModel, onKimiModelChange, glmModel, onGlmModelChange, claudeModel, onClaudeModelChange, claudeEffort, onClaudeEffortChange, claudeFastMode, onClaudeFastModeChange, claudeThinking, onClaudeThinkingChange, codexModel, onCodexModelChange, codexReasoningEffort, onCodexReasoningEffortChange, planMode, onPlanModeChange, noHistory, onNoHistoryChange, outputStyle, onOutputStyleChange, isActive, isFocused, peerTabId, peerSide, refreshSignal, onDraftChange, onStateChange, onShowGitStatus, onOpenNote, isFavorite, onToggleFavorite, onCreateScheduledTask, onOpenSession, onContentSearch, onShowFileDiff, onOpenFileLink }: ChatPanelProps) {
  const handleLoadingChange = useCallback((isLoading: boolean) => {
    onStateChange(tabId, { isLoading });
  }, [tabId, onStateChange]);

  const handleDraftPresenceChange = useCallback((hasDraft: boolean) => {
    onDraftChange?.(tabId, hasDraft);
  }, [tabId, onDraftChange]);

  const handleSessionIdChange = useCallback((newSessionId: string) => {
    onStateChange(tabId, { sessionId: newSessionId });
  }, [tabId, onStateChange]);

  const handleTitleChange = useCallback((title: string) => {
    onStateChange(tabId, { title });
  }, [tabId, onStateChange]);

  // `undefined` is sent on purpose when the session has no Bot: the tab may have
  // been reused for another session, and the robot has to come off with it.
  const handleBotChange = useCallback((bot: string | null) => {
    onStateChange(tabId, { bot: bot ?? undefined });
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

  const handleClaudeModelChange = useCallback((model: ClaudeModelId) => {
    onClaudeModelChange?.(tabId, model);
  }, [tabId, onClaudeModelChange]);

  const handleClaudeEffortChange = useCallback((effort: ClaudeEffort) => {
    onClaudeEffortChange?.(tabId, effort);
  }, [tabId, onClaudeEffortChange]);

  const handleClaudeFastModeChange = useCallback((fastMode: boolean) => {
    onClaudeFastModeChange?.(tabId, fastMode);
  }, [tabId, onClaudeFastModeChange]);

  const handleClaudeThinkingChange = useCallback((thinking: boolean) => {
    onClaudeThinkingChange?.(tabId, thinking);
  }, [tabId, onClaudeThinkingChange]);

  const handleCodexModelChange = useCallback((model: CodexModelId) => {
    onCodexModelChange?.(tabId, model);
  }, [tabId, onCodexModelChange]);

  const handleCodexReasoningEffortChange = useCallback((effort: CodexReasoningEffort) => {
    onCodexReasoningEffortChange?.(tabId, effort);
  }, [tabId, onCodexReasoningEffortChange]);


  const handlePlanModeChange = useCallback((p: boolean) => {
    onPlanModeChange?.(tabId, p);
  }, [tabId, onPlanModeChange]);

  const handleNoHistoryChange = useCallback((v: boolean) => {
    onNoHistoryChange?.(tabId, v);
  }, [tabId, onNoHistoryChange]);
  const handleOutputStyleChange = useCallback((v: string) => {
    onOutputStyleChange?.(tabId, v);
  }, [tabId, onOutputStyleChange]);

  const handleToggleFavorite = useCallback(() => {
    onToggleFavorite?.(tabId);
  }, [tabId, onToggleFavorite]);

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
      claudeModel={claudeModel}
      onClaudeModelChange={handleClaudeModelChange}
      claudeEffort={claudeEffort}
      onClaudeEffortChange={handleClaudeEffortChange}
      claudeFastMode={claudeFastMode}
      onClaudeFastModeChange={handleClaudeFastModeChange}
      claudeThinking={claudeThinking}
      onClaudeThinkingChange={handleClaudeThinkingChange}
      codexModel={codexModel}
      onCodexModelChange={handleCodexModelChange}
      codexReasoningEffort={codexReasoningEffort}
      onCodexReasoningEffortChange={handleCodexReasoningEffortChange}
      planMode={planMode}
      onPlanModeChange={handlePlanModeChange}
      noHistory={noHistory}
      onNoHistoryChange={handleNoHistoryChange}
      outputStyle={outputStyle}
      onOutputStyleChange={handleOutputStyleChange}
      hideHeader
      hideSidebar
      isActive={isActive}
      isFocused={isFocused}
      peerTabId={peerTabId}
      peerSide={peerSide}
      refreshSignal={refreshSignal}
      onLoadingChange={handleLoadingChange}
      onDraftPresenceChange={onDraftChange ? handleDraftPresenceChange : undefined}
      onSessionIdChange={handleSessionIdChange}
      onTitleChange={handleTitleChange}
      onBotChange={handleBotChange}
      onShowGitStatus={onShowGitStatus}
      onOpenNote={onOpenNote}
      isFavorite={isFavorite}
      onToggleFavorite={sessionId && onToggleFavorite ? handleToggleFavorite : undefined}
      onCreateScheduledTask={onCreateScheduledTask}
      onOpenSession={onOpenSession}
      onContentSearch={onContentSearch}
      onShowFileDiff={onShowFileDiff}
      onOpenFileLink={onOpenFileLink}
    />
  );
}
