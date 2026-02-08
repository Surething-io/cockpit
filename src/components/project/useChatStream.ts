'use client';

import { useState, useCallback, useRef } from 'react';
import { ChatMessage, ToolCallInfo, ImageInfo, MessageImage, TokenUsage } from '@/types/chat';

// ============================================
// Types
// ============================================

interface UseChatStreamOptions {
  sessionId: string | null;
  cwd?: string;
  onSessionId: (sid: string) => void;
  onFetchTitle: (sid: string) => void;
}

interface UseChatStreamReturn {
  isLoading: boolean;
  tokenUsage: TokenUsage | null;
  handleSend: (content: string, images?: ImageInfo[]) => Promise<void>;
  handleStop: () => void;
  abortControllerRef: React.RefObject<AbortController | null>;
}

// ============================================
// Hook
// ============================================

export function useChatStream(
  messages: ChatMessage[],
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  { sessionId, cwd, onSessionId, onFetchTitle }: UseChatStreamOptions
): UseChatStreamReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 用于在 handleStreamEvent 中获取最新的 sessionId
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;

  // 流式文本缓冲区 - 用于节流 setState
  const streamBufferRef = useRef<{ messageId: string; text: string } | null>(null);
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 刷新缓冲区到 state
  const flushStreamBuffer = useCallback(() => {
    const buffer = streamBufferRef.current;
    if (buffer && buffer.text) {
      const { messageId, text } = buffer;
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? { ...msg, content: (msg.content || '') + text }
            : msg
        )
      );
      streamBufferRef.current = { messageId, text: '' };
    }
    streamFlushTimerRef.current = null;
  }, [setMessages]);

  // 停止生成
  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  // SSE 事件处理
  const handleStreamEvent = useCallback((event: Record<string, unknown>, messageId: string) => {
    const eventType = event.type as string;

    // 处理 session_id
    if (eventType === 'system' && event.subtype === 'init') {
      const newSessionId = event.session_id as string;
      onSessionId(newSessionId);
      sessionIdRef.current = newSessionId;
      return;
    }

    // 处理流式文本块（打字机效果）- 使用缓冲区节流
    if (eventType === 'stream_event') {
      const streamEvent = event.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (streamEvent?.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
        const deltaText = streamEvent.delta.text || '';

        // 累积到缓冲区
        if (!streamBufferRef.current || streamBufferRef.current.messageId !== messageId) {
          streamBufferRef.current = { messageId, text: deltaText };
        } else {
          streamBufferRef.current.text += deltaText;
        }

        // 节流：每 50ms 刷新一次
        if (!streamFlushTimerRef.current) {
          streamFlushTimerRef.current = setTimeout(flushStreamBuffer, 50);
        }
      }
      return;
    }

    // 处理文本内容（完整消息）
    if (eventType === 'assistant') {
      const message = event.message as { content?: Array<{ text?: string; name?: string; id?: string; input?: Record<string, unknown> }> } | undefined;
      if (message?.content) {
        for (const block of message.content) {
          // 处理工具调用
          if ('name' in block && block.name) {
            const toolCall: ToolCallInfo = {
              id: (block.id as string) || `tool-${Date.now()}`,
              name: block.name as string,
              input: (block.input as Record<string, unknown>) || {},
              isLoading: true,
            };
            setMessages((prev) =>
              prev.map((msg) => {
                if (msg.id !== messageId) return msg;
                // 避免重复添加
                const exists = msg.toolCalls?.some((tc) => tc.id === toolCall.id);
                if (exists) return msg;
                return {
                  ...msg,
                  toolCalls: [...(msg.toolCalls || []), toolCall],
                };
              })
            );
          }
        }
      }
    }

    // 处理工具结果
    if (eventType === 'user') {
      const message = event.message as { content?: Array<{ tool_use_id?: string; content?: string }> } | undefined;
      if (message?.content) {
        for (const block of message.content) {
          if ('tool_use_id' in block && block.tool_use_id) {
            const toolUseId = block.tool_use_id;
            const result = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);

            setMessages((prev) =>
              prev.map((msg) =>
                msg.id === messageId
                  ? {
                      ...msg,
                      toolCalls: msg.toolCalls?.map((tc) =>
                        tc.id === toolUseId
                          ? { ...tc, result, isLoading: false }
                          : tc
                      ),
                    }
                  : msg
              )
            );
          }
        }
      }
    }

    // 处理最终结果
    if (eventType === 'result') {
      // 流结束，立即刷新缓冲区
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      flushStreamBuffer();

      // 新会话第一条消息完成后，获取标题
      const currentSessionId = sessionIdRef.current;
      if (currentSessionId && cwd) {
        setMessages((prev) => {
          if (prev.length === 2) {
            onFetchTitle(currentSessionId);
          }
          return prev;
        });
      }

      // 捕获 token 使用信息
      const usage = event.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
      const totalCostUsd = event.total_cost_usd as number | undefined;

      if (usage) {
        setTokenUsage({
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
          cacheReadInputTokens: usage.cache_read_input_tokens || 0,
          totalCostUsd: totalCostUsd || 0,
        });
      }

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? {
                ...msg,
                isStreaming: false,
                toolCalls: msg.toolCalls?.map((tc) => ({
                  ...tc,
                  isLoading: false,
                })),
              }
            : msg
        )
      );
    }
  }, [setMessages, flushStreamBuffer, onSessionId, onFetchTitle, cwd]);

  // 发送消息
  const handleSend = useCallback(
    async (content: string, images?: ImageInfo[]) => {
      // 转换图片格式
      const messageImages: MessageImage[] | undefined = images?.map((img) => ({
        type: 'base64' as const,
        media_type: img.media_type,
        data: img.data,
      }));

      // 添加用户消息
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content,
        images: messageImages,
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);

      // 创建助手消息占位
      const assistantMessageId = `assistant-${Date.now()}`;
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        isStreaming: true,
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // 创建 AbortController 用于中断请求
      abortControllerRef.current = new AbortController();

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: content,
            sessionId: sessionIdRef.current,
            images: messageImages,
            cwd,
          }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error('请求失败');
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('无法读取响应流');
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') continue;

              try {
                const event = JSON.parse(data);
                handleStreamEvent(event, assistantMessageId);
              } catch {
                // 忽略解析错误
              }
            }
          }
        }
      } catch (error) {
        // 如果是用户主动中断，不显示错误信息
        if (error instanceof Error && error.name === 'AbortError') {
          // 保留已生成的内容，仅结束流式状态
        } else {
          console.error('Chat error:', error);
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? { ...msg, content: '发生错误，请重试', isStreaming: false }
                : msg
            )
          );
        }
      } finally {
        abortControllerRef.current = null;
        setIsLoading(false);
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMessageId
              ? { ...msg, isStreaming: false }
              : msg
          )
        );
      }
    },
    [cwd, setMessages, handleStreamEvent]
  );

  return {
    isLoading,
    tokenUsage,
    handleSend,
    handleStop,
    abortControllerRef,
  };
}
