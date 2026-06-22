import type { ChatMessage, ToolCallInfo } from './types';

// Single engine-agnostic stream→messages reducer (#10 line 1).
//
// Pure: maps the SSE events every engine route emits (claude/deepseek SDK, codex,
// kimi, ollama, PTY — all share this vocabulary, verified) into ChatMessage updates,
// scoped to the current turn's assistant bubble (`assistantId`). The caller owns the
// assistant placeholder lifecycle:
//   - originator (useChatStream): creates it on send, passes its id (behavior unchanged)
//   - viewer (useLiveStream): creates it on `system.init`, passes its id
// Hook-side concerns (throttling, onSessionId/onFetchTitle/token usage/retry & rate-limit
// indicators, pty_output→xterm) stay OUT of here.

interface Block {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}
interface ToolResultBlock {
  tool_use_id?: string;
  content?: unknown;
}
export interface StreamEvent {
  type?: string;
  subtype?: string;
  _human?: boolean; // synthetic human-prompt user event (rendered by useLiveStream)
  message?: { model?: string; role?: string; content?: unknown };
  event?: { type?: string; delta?: { type?: string; text?: string } };
  result?: unknown;
}

export function applyStreamEvent(
  messages: ChatMessage[],
  ev: StreamEvent,
  opts: { engine?: string; assistantId: string }
): ChatMessage[] {
  const { engine, assistantId } = opts;

  // claude/deepseek/PTY: streamed text deltas
  if (ev.type === 'stream_event') {
    const e = ev.event;
    if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
      const txt = e.delta.text;
      return messages.map((m) => (m.id === assistantId ? { ...m, content: (m.content || '') + txt } : m));
    }
    return messages;
  }

  // complete assistant message: codex/kimi/ollama/synthetic carry text here (claude's
  // text comes via deltas → skipped to avoid duplication); tool_use blocks for all engines
  if (ev.type === 'assistant') {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return messages;
    const blocks = content as Block[];
    let out = messages;

    const isSynthetic = ev.message?.model === '<synthetic>';
    if (engine === 'codex' || engine === 'kimi' || engine === 'ollama' || isSynthetic) {
      const newText = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
      if (newText) out = out.map((m) => (m.id === assistantId ? { ...m, content: (m.content || '') + newText } : m));
    }

    for (const b of blocks) {
      if (b.name) {
        const tc: ToolCallInfo = {
          id: b.id || `tool-${assistantId}-${b.name}`,
          name: b.name,
          input: b.input || {},
          isLoading: true,
        };
        out = out.map((m) => {
          if (m.id !== assistantId) return m;
          if (m.toolCalls?.some((x) => x.id === tc.id)) return m;
          return { ...m, toolCalls: [...(m.toolCalls || []), tc] };
        });
      }
    }
    return out;
  }

  // tool_result (user turn): merge into the matching toolCall
  if (ev.type === 'user') {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return messages;
    let out = messages;
    for (const b of content as ToolResultBlock[]) {
      if (b.tool_use_id) {
        const tid = b.tool_use_id;
        const result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        out = out.map((m) =>
          m.id === assistantId
            ? { ...m, toolCalls: m.toolCalls?.map((tc) => (tc.id === tid ? { ...tc, result, isLoading: false } : tc)) }
            : m
        );
      }
    }
    return out;
  }

  // turn end: finalize the assistant bubble
  if (ev.type === 'result') {
    const resultText = typeof ev.result === 'string' ? ev.result.trim() : '';
    return messages.map((m) =>
      m.id === assistantId
        ? {
            ...m,
            content: !m.content && resultText ? resultText : m.content,
            isStreaming: false,
            toolCalls: m.toolCalls?.map((tc) => ({ ...tc, isLoading: false })),
          }
        : m
    );
  }

  return messages;
}
