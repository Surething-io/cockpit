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
  output_tokens?: number;
  // system/task_started | task_progress | task_notification: the spawning call, which is what
  // lets a task's state be attributed to the row that launched it. Optional on the wire —
  // absent ⇒ nothing to attribute (see applyTaskEvent).
  tool_use_id?: string;
  /** Housekeeping tasks the CLI does not surface as user work — excluded from activity UI. */
  ambient?: boolean;
  /** system/background_tasks_changed: every live task after the change (REPLACE semantics). */
  tasks?: Array<{ task_id: string; description: string; ambient?: boolean }>;
  /** task_progress: what the task is doing right now, plus its running counters. */
  last_tool_name?: string;
  usage?: { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  /** SDK wrapper field, non-null ⇒ this frame was produced INSIDE a subagent started by that
   *  tool_use (SDKAssistantMessage / SDKUserMessage / SDKPartialAssistantMessage all carry it).
   *  See isSubagentFrame. */
  parent_tool_use_id?: string | null;
}

/**
 * True for a frame that belongs to a SUBAGENT's transcript, not to this turn's bubble.
 *
 * The SDK forwards a subagent's tool_use/tool_result blocks on the parent stream by default
 * ("enough for a heartbeat counter" — `forwardSubagentText` adds its text on top), tagged with
 * the spawning tool_use id. They must not reach the reducer, for two reasons:
 *
 *  1. They are NOT in the parent transcript on disk (a subagent writes its own
 *     `<sessionId>/subagents/agent-<id>.jsonl`), so counting them live gives a bubble that
 *     loses hundreds of tool calls on the next refresh — breaking the live/reload parity
 *     shared/assistantText.ts exists to guarantee.
 *  2. Worse, each one flips `pendingTextBreak`, so a subagent that ticks while the PARENT is
 *     streaming text chops that text into a new MessagePart at every tick — arbitrary mid-word
 *     line breaks, and markdown parsed per fragment (a `**bold**` split across two parts renders
 *     as literal asterisks). Background (`run_in_background`) agents make this the normal case:
 *     they keep firing tools for the whole time the parent narrates what it just launched.
 *
 * Nothing is lost: the spawning Agent/Task tool call itself has a null `parent_tool_use_id`, so
 * it still renders, and clicking it opens the real nested transcript (SubagentTranscriptModal,
 * which reads the subagent's own jsonl).
 */
export function isSubagentFrame(ev: { parent_tool_use_id?: string | null }): boolean {
  return ev.parent_tool_use_id != null;
}

/** The `system` subtypes that report on a spawned task's life, all joined by `tool_use_id`. */
const TASK_EVENT_SUBTYPES: readonly string[] = ['task_started', 'task_progress', 'task_notification'];

export function isTaskEvent(ev: StreamEvent): boolean {
  return ev.type === 'system' && TASK_EVENT_SUBTYPES.includes(ev.subtype ?? '');
}

/**
 * Fold a `system/task_*` event into the tool call that spawned it.
 *
 * Scanning ALL messages rather than just `assistantId` is deliberate and is the whole point:
 * a backgrounded agent reports back long after its launch turn ended, by which time the live
 * bubble has moved on (the SDK auto-runs a follow-up turn, which gets its own bubble). Keying
 * on `tool_use_id` — globally unique within a session for every engine that emits these events
 * — puts the update on the launching row wherever it now lives.
 *
 * A task whose `tool_use_id` matches nothing is ignored, which is what silently drops the
 * NESTED tasks a subagent spawns (their spawning call lives in the subagent's own transcript,
 * never in this message list).
 */
function applyTaskEvent(messages: ChatMessage[], ev: StreamEvent): ChatMessage[] {
  const toolId = ev.tool_use_id;
  if (!toolId || ev.ambient) return messages;

  const patch = (prev: ToolCallInfo['task']): ToolCallInfo['task'] => {
    const next: NonNullable<ToolCallInfo['task']> = { status: 'running', ...prev };
    if (ev.subtype === 'task_notification') next.status = ev.status ?? 'completed';
    if (ev.task_id) next.id = ev.task_id;
    if (ev.last_tool_name) next.lastToolName = ev.last_tool_name;
    if (ev.summary) next.summary = ev.summary;
    if (typeof ev.usage?.tool_uses === 'number') next.toolUses = ev.usage.tool_uses;
    if (typeof ev.usage?.duration_ms === 'number') next.durationMs = ev.usage.duration_ms;
    return next;
  };

  let hit = false;
  const out = messages.map((m) => {
    if (!m.toolCalls?.some((tc) => tc.id === toolId)) return m;
    hit = true;
    return {
      ...m,
      toolCalls: m.toolCalls.map((tc) => (tc.id === toolId ? { ...tc, task: patch(tc.task) } : tc)),
    };
  });
  // Preserve array identity when nothing matched, so an unrelated task's heartbeat does not
  // re-render every bubble (MessageBubble memoises on message identity).
  return hit ? out : messages;
}

/**
 * The run is over → nothing it spawned is still working.
 *
 * sdkLoop holds the CLI process resident until every pending task reports back, so a run that
 * ends with a task still marked `running` did not finish it — it was stopped, crashed, or its
 * notification was lost. Either way the owning process is gone, which is exactly `unknown`.
 *
 * Without this sweep a stopped run leaves a spinner turning and the drill-in modal polling a
 * transcript that will never grow again, until the page is reloaded. Together with the disk
 * parsers refusing to reconstruct `running` (see TaskStatus), it makes `running` mean what it
 * says: a live claim by a process that is still alive.
 */
export function settleRunningTasks(messages: ChatMessage[]): ChatMessage[] {
  let hit = false;
  const out = messages.map((m) => {
    if (!m.toolCalls?.some((tc) => tc.task?.status === 'running')) return m;
    hit = true;
    return {
      ...m,
      toolCalls: m.toolCalls.map((tc) =>
        tc.task?.status === 'running' ? { ...tc, task: { ...tc.task, status: 'unknown' as const } } : tc
      ),
    };
  });
  return hit ? out : messages;
}

export function applyStreamEvent(
  messages: ChatMessage[],
  ev: StreamEvent,
  opts: { engine?: string; assistantId: string }
): ChatMessage[] {
  const { engine, assistantId } = opts;

  // A subagent's frames belong to its own transcript, never to this bubble (see isSubagentFrame).
  // Guarded here as well as at the hook entry points so the reducer is safe for any caller.
  if (isSubagentFrame(ev)) return messages;

  // A spawned task reporting on itself → settle the row that launched it, not this bubble.
  if (isTaskEvent(ev)) return applyTaskEvent(messages, ev);

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
