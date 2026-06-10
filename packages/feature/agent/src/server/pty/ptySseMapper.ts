/**
 * ptySseMapper — maps the PTY driver's jsonl transcript lines into the SSE events that the
 * frontend useChatStream understands.
 *
 * Key constraints (verified against useChatStream.ts:96-217):
 *   - the claude engine renders text via `stream_event` (content_block_delta/text_delta);
 *     in the `assistant` event, claude's text blocks are **explicitly skipped** (to avoid duplicating the stream).
 *   → PTY mode only has block-level text, so the assistant text block must be **synthesized into one stream_event**
 *     for the text to render (one whole block at once, no per-character typewriter — the per-character feel comes
 *     from the floating window, see design §5/§6 dual-view).
 *   - assistant tool_use block → `assistant` event (the frontend reads name/id/input to build a toolCall)
 *   - user tool_result block → `user` event (the frontend backfills the result by tool_use_id)
 *   - leading `system/init` carries session_id; trailing `result`
 *
 * Pure function, no IO, headlessly unit-testable.
 */
import type { TranscriptLine } from './claudePtyDriver';

export type SSEEvent = Record<string, unknown>;

/** Leading event: hands the frontend the sessionId (maps to onSessionId). */
export function initEvent(sessionId: string): SSEEvent {
  return { type: 'system', subtype: 'init', session_id: sessionId };
}

/** Trailing event: triggers the frontend's setIsLoading(false) / wrap-up. */
export function resultEvent(sessionId: string, opts?: { usage?: unknown }): SSEEvent {
  return { type: 'result', subtype: 'success', session_id: sessionId, usage: opts?.usage };
}

/**
 * Map one jsonl transcript line into 0..N SSE events.
 * file-history-snapshot / summary / system (non-result) / thinking blocks → produce nothing (frontend doesn't need them).
 */
export function mapLineToEvents(line: TranscriptLine, sessionId: string): SSEEvent[] {
  const out: SSEEvent[] = [];
  const content = line.message?.content;

  if (line.type === 'assistant' && Array.isArray(content)) {
    const blocks = content as Array<{ type?: string; text?: string; name?: string; id?: string; input?: unknown }>;

    // 1) text blocks → synthesize a stream_event (the only path the claude engine renders text through)
    const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
    if (text) {
      out.push({
        type: 'stream_event',
        session_id: sessionId,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      });
    }

    // 2) tool_use blocks → assistant event (the frontend reads name/id/input)
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (toolUses.length > 0) {
      out.push({
        type: 'assistant',
        session_id: sessionId,
        message: { role: 'assistant', content: toolUses },
      });
    }
    // thinking blocks: ignored
    return out;
  }

  if (line.type === 'user' && Array.isArray(content)) {
    const blocks = content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>;
    const toolResults = blocks.filter((b) => b.type === 'tool_result' && b.tool_use_id);
    if (toolResults.length > 0) {
      out.push({
        type: 'user',
        session_id: sessionId,
        message: { role: 'user', content: toolResults },
      });
    }
    // the user's own text (the prompt we pasted in) was already optimistically inserted by the frontend, so produce nothing
    return out;
  }

  return out; // other line types produce nothing
}
