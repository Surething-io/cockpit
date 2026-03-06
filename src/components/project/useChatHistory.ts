'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { ChatMessage, TokenUsage } from '@/types/chat';

// ============================================
// Constants
// ============================================

const TURNS_PER_PAGE = 10;
// incremental 拉取节流间隔（毫秒）
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

  // 使用 ref 确保回调使用最新引用
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const onTokenUsageRef = useRef(onTokenUsage);
  onTokenUsageRef.current = onTokenUsage;

  // 文件指纹：用于 incremental 检查文件是否有变更
  const fingerprintRef = useRef<string | undefined>(undefined);
  // 上次 incremental 拉取时间：用于节流
  const lastIncrementalFetchRef = useRef(0);

  // 根据 cwd + sessionId 加载历史消息
  const loadHistoryByCwdAndSessionId = useCallback(async (
    cwdPath: string,
    sid: string,
    incremental = false,
    limit?: number,
    beforeTurnIndex?: number
  ) => {
    // 方向 2: incremental 时间节流 — 距上次拉取不超过 N 秒则跳过
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
      // 方向 3: incremental 时携带指纹，服务端判断文件未变更则直接返回
      const requestBody: Record<string, unknown> = { cwd: cwdPath, sessionId: sid, limit, beforeTurnIndex };
      if (incremental && fingerprintRef.current) {
        requestBody.ifFingerprint = fingerprintRef.current;
      }

      const response = await fetch('/api/session-by-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      if (response.ok) {
        const data = await response.json();

        // 方向 3: 文件未变更，跳过所有处理
        if (data.notModified) {
          return;
        }

        // 保存文件指纹
        if (data.fingerprint) {
          fingerprintRef.current = data.fingerprint;
        }

        // 更新分页状态
        if (data.totalTurns !== undefined) {
          setTotalTurns(data.totalTurns);
        }
        if (data.hasMore !== undefined) {
          setHasMoreHistory(data.hasMore);
        }

        if (data.messages && data.messages.length > 0) {
          if (incremental) {
            // 增量更新模式：只更新变化的消息
            setMessages((prevMessages) => {
              const newMessages = data.messages as ChatMessage[];
              // 如果消息数量相同且最后一条消息相同，不更新
              if (
                prevMessages.length === newMessages.length &&
                prevMessages.length > 0 &&
                prevMessages[prevMessages.length - 1].content === newMessages[newMessages.length - 1].content
              ) {
                return prevMessages;
              }
              // 找到第一个不同的消息索引
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
              // 保留相同的前缀，替换后面的部分
              if (diffIndex === prevMessages.length && diffIndex < newMessages.length) {
                // 只有新增消息，追加即可
                return [...prevMessages, ...newMessages.slice(diffIndex)];
              }
              // 有更新或删除，需要替换
              return newMessages;
            });
          } else {
            setMessages(data.messages);
          }
        }
        if (data.sessionId) {
          onSessionId(data.sessionId);
        }
        // 通知父组件标题变化
        if (data.title) {
          onTitleChangeRef.current?.(data.title);
        }
        // 设置 token 使用信息（从历史记录的最后一条 assistant 消息获取）
        if (data.usage) {
          onTokenUsageRef.current?.({
            inputTokens: data.usage.input_tokens || 0,
            outputTokens: data.usage.output_tokens || 0,
            cacheCreationInputTokens: data.usage.cache_creation_input_tokens || 0,
            cacheReadInputTokens: data.usage.cache_read_input_tokens || 0,
            totalCostUsd: 0, // 历史记录中没有费用信息
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

  // 加载更多历史消息（向上滚动时调用）
  const loadMoreHistory = useCallback(async () => {
    if (!cwd || !sessionId || isLoadingMore || !hasMoreHistory) return;

    setIsLoadingMore(true);
    try {
      const beforeIndex = currentTurnIndex !== undefined
        ? currentTurnIndex
        : totalTurns - Math.ceil(messages.filter(m => m.role === 'user').length);

      const response = await fetch('/api/session-by-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          sessionId,
          limit: TURNS_PER_PAGE,
          beforeTurnIndex: beforeIndex > 0 ? beforeIndex : undefined
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.messages && data.messages.length > 0) {
          // 将新消息添加到现有消息前面
          setMessages(prev => [...data.messages, ...prev]);
          // 更新当前 turn 索引
          const loadedTurns = data.messages.filter((m: ChatMessage) => m.role === 'user').length;
          setCurrentTurnIndex(beforeIndex - loadedTurns);
        }
        if (data.hasMore !== undefined) {
          setHasMoreHistory(data.hasMore);
        }
        // 保存指纹
        if (data.fingerprint) {
          fingerprintRef.current = data.fingerprint;
        }
      }
    } catch (error) {
      console.error('Failed to load more history:', error);
    } finally {
      setIsLoadingMore(false);
    }
  }, [cwd, sessionId, isLoadingMore, hasMoreHistory, currentTurnIndex, totalTurns, messages, setMessages]);

  // 加载历史消息（按 sessionId）
  const loadHistory = useCallback(async (sid: string) => {
    setIsLoadingHistory(true);
    try {
      const response = await fetch(`/api/session/${sid}/history`);
      if (response.ok) {
        const data = await response.json();
        if (data.messages && data.messages.length > 0) {
          setMessages(data.messages);
        }
      }
    } catch (error) {
      console.error('Failed to load history:', error);
    } finally {
      setIsLoadingHistory(false);
    }
  }, [setMessages]);

  // 页面加载时加载历史消息（只运行一次）
  useEffect(() => {
    if (cwd && initialSessionId) {
      loadHistoryByCwdAndSessionId(cwd, initialSessionId, false, TURNS_PER_PAGE);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 只在组件挂载时运行一次

  return {
    isLoadingHistory,
    isLoadingMore,
    hasMoreHistory,
    loadMoreHistory,
    loadHistory,
    loadHistoryByCwdAndSessionId,
  };
}
