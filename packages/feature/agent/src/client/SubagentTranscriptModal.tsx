'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { MessageBubble } from './MessageBubble';
import { postSessionByPath } from './useChatHistory';
import type { ChatMessage, ToolCallInfo } from './types';

// Modal transcript of a subagent spawned by an Agent/Task tool call.
// Reads `<sessionId>/subagents/agent-<id>.jsonl` via /api/session-by-path
// (toolUseId param) and renders it with the same MessageBubble as the main
// session. Polls while open and the parent tool call has no result yet;
// closing the modal unmounts it, which stops the polling.

const POLL_INTERVAL_MS = 5_000;

interface SubagentMeta {
  agentType?: string;
  description?: string;
}

interface SubagentTranscriptModalProps {
  cwd: string;
  sessionId: string;
  toolCall: ToolCallInfo;
  onClose: () => void;
}

export function SubagentTranscriptModal({ cwd, sessionId, toolCall, onClose }: SubagentTranscriptModalProps) {
  const { t } = useTranslation();
  // null = not loaded yet (loading or transcript not found)
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [meta, setMeta] = useState<SubagentMeta | null>(null);
  const [loadAttempted, setLoadAttempted] = useState(false);
  const fingerprintRef = useRef<string | undefined>(undefined);

  // Parent Agent tool call still has no result → subagent is (likely) running
  const isRunning = !toolCall.result;

  const fetchTranscript = useCallback(async () => {
    const exit = await BrowserRuntime.runPromiseExit(
      postSessionByPath({
        cwd,
        sessionId,
        toolUseId: toolCall.id,
        ifFingerprint: fingerprintRef.current,
      })
    );
    setLoadAttempted(true);
    if (exit._tag !== 'Success' || !exit.value) return;
    const data = exit.value as {
      notModified?: boolean;
      fingerprint?: string;
      messages?: ChatMessage[];
      subagent?: SubagentMeta;
    };
    if (data.fingerprint) fingerprintRef.current = data.fingerprint;
    if (data.notModified) return;
    if (data.messages) setMessages(data.messages);
    if (data.subagent) setMeta(data.subagent);
  }, [cwd, sessionId, toolCall.id]);

  // Fetch on mount; keep polling while the subagent is running. When
  // isRunning flips to false the effect re-runs → one final fetch picks up
  // the transcript tail, then no interval.
  useEffect(() => {
    fetchTranscript();
    if (!isRunning) return;
    const timer = setInterval(fetchTranscript, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isRunning, fetchTranscript]);

  // Auto-scroll to bottom on new content, paused while the user scrolls up
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  };
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const description =
    typeof toolCall.input?.description === 'string' ? toolCall.input.description : '';
  const subtitle = [meta?.agentType, description].filter(Boolean).join(' · ');

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        onClick={onClose}
      >
        <div
          className="bg-card rounded-lg shadow-xl w-full max-w-[90%] h-[90vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0">
            <span className="text-base">🤖</span>
            <span className="font-medium text-sm text-foreground flex-shrink-0">
              {t('chat.subagent')}
            </span>
            {subtitle && (
              <span className="text-xs text-muted-foreground truncate flex-1 min-w-0" title={subtitle}>
                {subtitle}
              </span>
            )}
            <span className="ml-auto flex items-center gap-2 flex-shrink-0">
              {isRunning && (
                <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
              )}
              <button
                onClick={onClose}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title={t('common.close')}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          </div>

          {/* Transcript */}
          <div ref={bodyRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-3">
            {messages === null ? (
              <div className="text-xs text-muted-foreground text-center py-4">
                {loadAttempted ? t('chat.subagentEmpty') : t('common.loading')}
              </div>
            ) : (
              messages.map((m) => <MessageBubble key={m.id} message={m} cwd={cwd} />)
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}
