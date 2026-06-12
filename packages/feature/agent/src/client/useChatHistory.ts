'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { ChatMessage, TokenUsage } from './types';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { AppError } from '@cockpit/effect-core';

// Shared: POST /api/session-by-path — returns null on failure (matches `!response.ok`).
// Also used by SubagentTranscript to fetch subagent transcripts (via toolUseId).
export const postSessionByPath = (body: Record<string, unknown>) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch('/api/session-by-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    },
    catch: (cause) => new AppError({ message: 'session-by-path failed', cause }),
  });

// Migrated from src/components/project/useChatHistory.ts. Self-contained:
// only depends on React and on agent types (now local to this package).
// Server endpoints (/api/session-by-path, /api/session/:id/history) are
// referenced via fetch URLs at runtime — no module-level cross-package
// dependency.

// ============================================
// Constants
// ============================================

const TURNS_PER_PAGE = 10;
// Incremental fetch throttle interval (ms)
const INCREMENTAL_THROTTLE_MS = 5_000;

// ============================================
// Types
// ============================================

interface UseChatHistoryOptions {
  cwd?: string;
  initialSessionId?: string;
  onSessionId: (sid: string) => void;
  onTitleChange?: (title: string) => void;
  onTokenUsage?: (usage: TokenUsage) => void;
}

interface UseChatHistoryReturn {
  isLoadingHistory: boolean;
  isLoadingMore: boolean;
  hasMoreHistory: boolean;
  loadMoreHistory: () => Promise<void>;
  loadHistory: (sid: string) => Promise<void>;
  loadHistoryByCwdAndSessionId: (
    cwd: string,
    sid: string,
    incremental?: boolean,
    limit?: number,
    beforeTurnIndex?: number
  ) => Promise<void>;
  // The sessionId of the JSONL file whose contents are currently
  // displayed in `messages`. Differs from the live `sessionId` (which
  // drifts every time the SDK emits a `system.init`) — operations that
  // reference rendered message ids (e.g. fork) MUST use this one so the
  // server reads the same file the client is looking at.
  loadedSessionId: string | null;
}

// ============================================
// Hook
// ============================================

export function useChatHistory(
  messages: ChatMessage[],
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  sessionId: string | null,
  { cwd, initialSessionId, onSessionId, onTitleChange, onTokenUsage }: UseChatHistoryOptions
): UseChatHistoryReturn {
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [currentTurnIndex, setCurrentTurnIndex] = useState<number | undefined>(undefined);
  const [totalTurns, setTotalTurns] = useState(0);
  // sessionId of the file whose contents currently populate `messages`.
  // Updated whenever a load successfully returns messages.
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);

  // Use ref to ensure callbacks use the latest reference
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onTokenUsageRef = useRef(onTokenUsage);
  onTokenUsageRef.current = onTokenUsage;

  // File fingerprint: used for incremental check if file has changed
  const fingerprintRef = useRef<string | undefined>(undefined);
  // Last incremental fetch time: used for throttling
  const lastIncrementalFetchRef = useRef(0);

  // Load history messages by cwd + sessionId
  const loadHistoryByCwdAndSessionId = useCallback(async (
    cwdPath: string,
    sid: string,
    incremental = false,
    limit?: number,
    beforeTurnIndex?: number
  ) => {
    // Direction 2: incremental time throttle — skip if less than N seconds since last fetch
    if (incremental) {
      const now = Date.now();
      if (now - lastIncrementalFetchRef.current < INCREMENTAL_THROTTLE_MS) {
        return;
      }
      lastIncrementalFetchRef.current = now;
    }

    if (!incremental) {
      setIsLoadingHistory(true);
    }
    try {
      // Direction 3: incremental carries fingerprint, server returns early if file unchanged
      const requestBody: Record<string, unknown> = { cwd: cwdPath, sessionId: sid, limit, beforeTurnIndex };
      if (incremental && fingerprintRef.current) {
        requestBody.ifFingerprint = fingerprintRef.current;
      }

      const exit = await BrowserRuntime.runPromiseExit(postSessionByPath(requestBody));
      if (exit._tag === 'Success' && exit.value) {
        const data = exit.value as {
          notModified?: boolean;
          fingerprint?: string;
          totalTurns?: number;
          hasMore?: boolean;
          messages?: ChatMessage[];
          sessionId?: string;
          title?: string;
          usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
        };

        // Direction 3: file unchanged, skip all processing
        if (data.notModified) {
          return;
        }

        // Save file fingerprint
        if (data.fingerprint) {
          fingerprintRef.current = data.fingerprint;
        }

        // Update pagination state
        if (data.totalTurns !== undefined) {
          setTotalTurns(data.totalTurns);
        }
        if (data.hasMore !== undefined) {
          setHasMoreHistory(data.hasMore);
        }

        if (data.messages && data.messages.length > 0) {
          if (incremental) {
            // Incremental update mode: only update changed messages
            setMessages((prevMessages) => {
              const newMessages = data.messages as ChatMessage[];
              // If message count is the same and last message is unchanged, skip update
              if (
                prevMessages.length === newMessages.length &&
                prevMessages.length > 0 &&
                prevMessages[prevMessages.length - 1].content === newMessages[newMessages.length - 1].content
              ) {
                return prevMessages;
              }
              // Find the first differing message index
              let diffIndex = 0;
              for (let i = 0; i < Math.min(prevMessages.length, newMessages.length); i++) {
                if (
                  prevMessages[i].id !== newMessages[i].id ||
                  prevMessages[i].content !== newMessages[i].content
                ) {
                  break;
                }
                diffIndex = i + 1;
              }
              // Keep identical prefix, replace the rest
              if (diffIndex === prevMessages.length && diffIndex < newMessages.length) {
                // Only new messages added, append them
                return [...prevMessages, ...newMessages.slice(diffIndex)];
              }
              // Has updates or deletions, need to replace
              return newMessages;
            });
          } else {
            setMessages(data.messages);
          }
          // Track which file the rendered messages came from. Use the sid
          // we actually requested (data.sessionId echoes the request and
          // may be missing in some shapes).
          setLoadedSessionId(sid);
        }
        if (data.sessionId) {
          onSessionId(data.sessionId);
        }
        // Notify parent component of title change
        if (data.title) {
          onTitleChangeRef.current?.(data.title);
        }
        // Set token usage info (from last assistant message in history)
        if (data.usage) {
          onTokenUsageRef.current?.({
            inputTokens: data.usage.input_tokens || 0,
            outputTokens: data.usage.output_tokens || 0,
            cacheCreationInputTokens: data.usage.cache_creation_input_tokens || 0,
            cacheReadInputTokens: data.usage.cache_read_input_tokens || 0,
            totalCostUsd: 0, // No cost info in history records
          });
        }
      }
    } catch (error) {
      console.error('Failed to load history by cwd and sessionId:', error);
    } finally {
      if (!incremental) {
        setIsLoadingHistory(false);
      }
    }
  }, [setMessages, onSessionId]);

  // Load more history messages (called when scrolling up)
  const loadMoreHistory = useCallback(async () => {
    if (!cwd || !sessionId || isLoadingMore || !hasMoreHistory) return;

    setIsLoadingMore(true);
    try {
      const beforeIndex = currentTurnIndex !== undefined
        ? currentTurnIndex
        : totalTurns - Math.ceil(messages.filter(m => m.role === 'user').length);

      const exit = await BrowserRuntime.runPromiseExit(
        postSessionByPath({
          cwd,
          sessionId,
          limit: TURNS_PER_PAGE,
          beforeTurnIndex: beforeIndex > 0 ? beforeIndex : undefined,
        })
      );

      if (exit._tag === 'Success' && exit.value) {
        const data = exit.value as {
          messages?: ChatMessage[];
          hasMore?: boolean;
          fingerprint?: string;
        };
        if (data.messages && data.messages.length > 0) {
          // Prepend new messages to existing messages
          setMessages(prev => [...data.messages!, ...prev]);
          // Update current turn index
          const loadedTurns = data.messages.filter((m: ChatMessage) => m.role === 'user').length;
          setCurrentTurnIndex(beforeIndex - loadedTurns);
          // Older turns were pulled from the same file the rest of the
          // view already represents — keep loadedSessionId in sync.
          setLoadedSessionId(sessionId);
        }
        if (data.hasMore !== undefined) {
          setHasMoreHistory(data.hasMore);
        }
        // Save fingerprint
        if (data.fingerprint) {
          fingerprintRef.current = data.fingerprint;
        }
      } else if (exit._tag === 'Failure') {
        console.error('Failed to load more history:', exit.cause);
      }
    } finally {
      setIsLoadingMore(false);
    }
  }, [cwd, sessionId, isLoadingMore, hasMoreHistory, currentTurnIndex, totalTurns, messages, setMessages]);

  // Load history messages (by sessionId)
  const loadHistory = useCallback(async (sid: string) => {
    setIsLoadingHistory(true);
    const historyEff = Effect.tryPromise({
      try: async () => {
        const response = await fetch(`/api/session/${sid}/history`);
        if (!response.ok) return null;
        return (await response.json()) as { messages?: ChatMessage[] };
      },
      catch: (cause) => new AppError({ message: 'load session history failed', cause }),
    });
    const exit = await BrowserRuntime.runPromiseExit(historyEff);
    if (exit._tag === 'Success' && exit.value?.messages && exit.value.messages.length > 0) {
      setMessages(exit.value.messages);
      setLoadedSessionId(sid);
    } else if (exit._tag === 'Failure') {
      console.error('Failed to load history:', exit.cause);
    }
    setIsLoadingHistory(false);
  }, [setMessages]);

  // Load history messages on page load (runs once only)
  useEffect(() => {
    if (cwd && initialSessionId) {
      loadHistoryByCwdAndSessionId(cwd, initialSessionId, false, TURNS_PER_PAGE);
    }

  }, []); // Run only on component mount

  return {
    isLoadingHistory,
    isLoadingMore,
    hasMoreHistory,
    loadMoreHistory,
    loadHistory,
    loadHistoryByCwdAndSessionId,
    loadedSessionId,
  };
}
