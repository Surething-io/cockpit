import { appendTextPart, appendToolPart, joinAssistantText } from '../shared/assistantText';
import type { ChatMessage, ToolCallInfo } from './types';

// Single engine-agnostic stream→messages reducer (#10 line 1).
//
// Pure: maps the SSE events every engine route emits (claude/deepseek/kimi SDK, codex,
// ollama — all share this vocabulary, verified) into ChatMessage updates,
// scoped to the current turn's assistant bubble (`assistantId`). The caller owns the
// assistant placeholder lifecycle:
//   - originator (useChatStream): creates it on send, passes its id (behavior unchanged)
//   - viewer (useLiveStream): creates it on `system.init`, passes its id
// Hook-side concerns (throttling, onSessionId/onFetchTitle/token usage/retry & rate-limit
// indicators) stay OUT of here.

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
  _turnId?: string; // per-turn unique id (the dispatch runId) — identity for live-bubble dedup
  _ts?: number; // server clock at startRun — time boundary for disk-copy dedup
  message?: { model?: string; role?: string; content?: unknown };
  event?: { type?: string; delta?: { type?: string; text?: string } };
  result?: unknown;
  error?: string; // {type:'error'} events emitted by engines / the orchestrator's failure path
  // system/task_notification fields (SDKTaskNotificationMessage) — a background task reporting back.
  task_id?: string;
  status?: 'completed' | 'failed' | 'stopped';
  summary?: string;
  output_file?: string;
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
      return messages.map((m) =>
        m.id === assistantId
          ? {
              ...m,
              content: joinAssistantText(m.content || '', txt, !!m.pendingTextBreak),
              parts: appendTextPart(m.parts, txt, !!m.pendingTextBreak),
              pendingTextBreak: false,
            }
          : m
      );
    }
    return messages;
  }

  // complete assistant message: codex/ollama/synthetic carry text here (claude, deepseek and
  // kimi stream text as deltas → skipped to avoid duplication, in both SDK and Built-in Agent
  // mode); tool_use blocks for all engines
  if (ev.type === 'assistant') {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return messages;
    const blocks = content as Block[];
    let out = messages;

    const isSynthetic = ev.message?.model === '<synthetic>';
    if (engine === 'codex' || engine === 'ollama' || isSynthetic) {
      const newText = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
      if (newText)
        out = out.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: joinAssistantText(m.content || '', newText, !!m.pendingTextBreak),
                parts: appendTextPart(m.parts, newText, !!m.pendingTextBreak),
                pendingTextBreak: false,
              }
            : m
        );
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
          // A tool_use between two text segments starts a new paragraph for the
          // next one (see shared/assistantText.ts). Mirrors the history parsers.
          return {
            ...m,
            toolCalls: [...(m.toolCalls || []), tc],
            parts: appendToolPart(m.parts, tc.id),
            pendingTextBreak: true,
          };
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

  // in-stream error ({type:'error', error}) — emitted by codex/kimi/ollama/deepseek and the
  // orchestrator's failure path. Without this the viewer (useLiveStream, which routes through
  // this reducer) drops it silently and a failed turn shows as an empty bubble. (useChatStream
  // handles 'error' itself and returns before calling this, so it is unaffected.)
  if (ev.type === 'error') {
    const errText = ev.error || 'An error occurred. Please try again.';
    const banner = `⚠️ ${errText}`;
    return messages.map((m) =>
      m.id === assistantId
        ? {
            ...m,
            // joinAssistantText rather than a raw `\n\n` concat, so this stays
            // byte-identical to deriveContent(parts) — the banner is its own part.
            content: joinAssistantText(m.content || '', banner, true),
            parts: appendTextPart(m.parts, banner, true),
            isStreaming: false,
          }
        : m
    );
  }

  // turn end: finalize the assistant bubble
  if (ev.type === 'result') {
    const resultText = typeof ev.result === 'string' ? ev.result.trim() : '';
    return messages.map((m) =>
      m.id === assistantId
        ? {
            ...m,
            content: !m.content && resultText ? resultText : m.content,
            parts: !m.content && resultText ? appendTextPart(m.parts, resultText) : m.parts,
            isStreaming: false,
            toolCalls: m.toolCalls?.map((tc) => ({ ...tc, isLoading: false })),
          }
        : m
    );
  }

  return messages;
}
