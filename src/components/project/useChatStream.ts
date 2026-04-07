'use client';

import { useState, useCallback, useRef } from 'react';
import { ChatMessage, ToolCallInfo, ImageInfo, MessageImage, TokenUsage } from '@/types/chat';
import type { ChatEngine } from './useTabState';
import i18n from '@/lib/i18n';

// ============================================
// Types
// ============================================

interface UseChatStreamOptions {
  sessionId: string | null;
  cwd?: string;
  engine?: ChatEngine;
  ollamaModel?: string;
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
  { sessionId, cwd, engine, ollamaModel, onSessionId, onFetchTitle }: UseChatStreamOptions
): UseChatStreamReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Used to get latest sessionId in handleStreamEvent
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;

  // Streaming text buffer - used to throttle setState
  const streamBufferRef = useRef<{ messageId: string; text: string } | null>(null);
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flush buffer to state
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

  // Stop generation
  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  // SSE event handling
  const handleStreamEvent = useCallback((event: Record<string, unknown>, messageId: string) => {
    const eventType = event.type as string;

    // Handle session_id
    if (eventType === 'system' && event.subtype === 'init') {
      const newSessionId = event.session_id as string;
      onSessionId(newSessionId);
      sessionIdRef.current = newSessionId;
      return;
    }

    // Handle streaming text chunk (typewriter effect) - use buffer throttle
    if (eventType === 'stream_event') {
      const streamEvent = event.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (streamEvent?.type === 'content_block_delta' && streamEvent.delta?.type === 'text_delta') {
        const deltaText = streamEvent.delta.text || '';

        // Accumulate to buffer
        if (!streamBufferRef.current || streamBufferRef.current.messageId !== messageId) {
          streamBufferRef.current = { messageId, text: deltaText };
        } else {
          streamBufferRef.current.text += deltaText;
        }

        // Throttle: flush every 50ms
        if (!streamFlushTimerRef.current) {
          streamFlushTimerRef.current = setTimeout(flushStreamBuffer, 50);
        }
      }
      return;
    }

    // Handle text content (complete message)
    if (eventType === 'assistant') {
      const message = event.message as { content?: Array<{ type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> }> } | undefined;
      if (message?.content) {
        // Extract text blocks (Codex sends complete text via assistant messages, not stream_event)
        const textParts = message.content
          .filter(block => block.type === 'text' && block.text)
          .map(block => block.text!);
        if (textParts.length > 0) {
          const newText = textParts.join('');
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === messageId
                ? { ...msg, content: (msg.content || '') + newText }
                : msg
            )
          );
        }

        for (const block of message.content) {
          // Handle tool call
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
                // Avoid duplicate additions
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

    // Handle tool result
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

    // Handle final result
    if (eventType === 'result') {
      // Stream ended, flush buffer immediately
      if (streamFlushTimerRef.current) {
        clearTimeout(streamFlushTimerRef.current);
        streamFlushTimerRef.current = null;
      }
      flushStreamBuffer();

      // After first message in new session completes, fetch title
      const currentSessionId = sessionIdRef.current;
      if (currentSessionId && cwd) {
        setMessages((prev) => {
          if (prev.length === 2) {
            onFetchTitle(currentSessionId);
          }
          return prev;
        });
      }

      // Capture token usage info
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

  // Send message
  const handleSend = useCallback(
    async (content: string, images?: ImageInfo[]) => {
      // Convert image format
      const messageImages: MessageImage[] | undefined = images?.map((img) => ({
        type: 'base64' as const,
        media_type: img.media_type,
        data: img.data,
      }));

      // Add user message
      const userMessage: ChatMessage = {
        id: `user-${Date.now()}`,
        role: 'user',
        content,
        images: messageImages,
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsLoading(true);

      // Create assistant message placeholder
      const assistantMessageId = `assistant-${Date.now()}`;
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        toolCalls: [],
        isStreaming: true,
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // Create AbortController for interrupting request
      abortControllerRef.current = new AbortController();

      try {
        // Ollama requires a model to be selected
        if (engine === 'ollama' && !ollamaModel) {
          throw new Error('Please select an Ollama model first (click the model picker above)');
        }

        const apiUrl = engine === 'codex' ? '/api/chat/codex' : engine === 'kimi' ? '/api/chat/kimi' : engine === 'ollama' ? '/api/chat/ollama' : '/api/chat';
        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: content,
            sessionId: sessionIdRef.current,
            images: messageImages,
            cwd,
            language: i18n.language,
            ...(engine === 'ollama' && ollamaModel && { model: ollamaModel }),
          }),
          signal: abortControllerRef.current.signal,
        });

        if (!response.ok) {
          throw new Error(i18n.t('chat.requestFailed'));
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error(i18n.t('chat.cannotReadStream'));
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
                // Ignore parse errors
              }
            }
          }
        }
      } catch (error) {
        // If user actively interrupted, do not show error message
        if (error instanceof Error && error.name === 'AbortError') {
          // Keep already-generated content, only end streaming state
        } else {
          console.error('Chat error:', error);
          const errorMsg = error instanceof Error ? error.message : i18n.t('chat.errorRetry');
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMessageId
                ? { ...msg, content: errorMsg, isStreaming: false }
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
    [cwd, engine, ollamaModel, setMessages, handleStreamEvent]
  );

  return {
    isLoading,
    tokenUsage,
    handleSend,
    handleStop,
    abortControllerRef,
  };
}
