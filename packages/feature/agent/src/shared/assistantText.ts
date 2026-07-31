/**
 * Single source of truth for assembling the multiple text segments an assistant
 * emits within ONE turn (narration between tool calls).
 *
 * Used by BOTH sides so a turn comes out identical live and after refresh:
 *  - live reducer (client/applyStreamEvent.ts): streamed deltas + complete blocks
 *  - history parsers (server/api/session/history.ts, server/api/session-by-path.ts):
 *    replay from the on-disk jsonl on page load / reconnect
 *
 * Two representations of the same turn are built side by side from ONE boundary
 * decision (`breakBefore`: has a tool_use landed since the previous text?):
 *
 *  - `parts` — the ordered text/tool skeleton. This is what MessageBubble
 *    renders: one row per segment, so a segment with a tool call after it can be
 *    styled as mid-turn narration rather than the turn's answer.
 *  - `content` — the flat string. No longer the render path, but still what the
 *    copy button, mergeIncrementalMessages' change detection and title
 *    generation read, so it must keep its exact historical shape: a blank line
 *    before a segment that follows a tool_use, verbatim concatenation otherwise
 *    (matching how deltas accumulate, having no block boundary to break on).
 *    Without that blank line, two `**...**` narration lines glued into one run
 *    (e.g. `Migration:****2/5`).
 *
 * `deriveContent(parts)` reproduces `content` byte for byte — verified against
 * every assistant message in the local transcript corpus. Keep it that way: it
 * is what makes `content` safe to eventually drop in favour of `parts` alone.
 */

/**
 * Append `next` to `prev`, inserting exactly one blank line between them when
 * `breakBefore` is set and both sides are non-empty. Trailing newlines on
 * `prev` are collapsed first so an already-newline-terminated segment does not
 * produce three or more consecutive blank lines.
 */
export function joinAssistantText(prev: string, next: string, breakBefore: boolean): string {
  if (!next) return prev;
  if (!prev) return next;
  if (!breakBefore) return prev + next;
  return `${prev.replace(/\n+$/, '')}\n\n${next}`;
}

/**
 * Ordered skeleton of one assistant turn: text segments and tool calls in the
 * order the model emitted them.
 *
 * `content` (the joined string above) and `toolCalls` are two flattened
 * projections of this same sequence — each keeps half the information and drops
 * the interleaving. `parts` keeps it, which is what lets the renderer tell a
 * mid-turn narration segment (a text part with a tool part after it) from the
 * turn's actual answer (the final text part).
 *
 * A tool part carries only the id: ToolCallInfo stays in `toolCalls`, which
 * remains the single store for tool data (result patching, isLoading). The two
 * structures therefore update on independent paths — a text delta never changes
 * the `toolCalls` array identity (which would defeat MessageBubble's memos), and
 * a tool result never changes `parts`.
 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string };

/**
 * Append a text segment, merging into the trailing text part unless `breakBefore`
 * says a tool_use has intervened. Consecutive text with no tool between it is ONE
 * segment.
 *
 * `breakBefore` is deliberately the SAME argument the caller passes to
 * `joinAssistantText` for the same segment — never a second, independently
 * computed decision (e.g. "is the last part a tool?"). Those two can disagree:
 * the parsers flip their flag for any tool_use block but only materialise a tool
 * for blocks that carry both name and id, so a malformed block would break the
 * string and not the parts. Sharing the one flag makes `deriveContent(parts) ===
 * content` hold by construction rather than by coincidence.
 *
 * Returns a new array (never mutates) when something changed, so callers can use
 * it directly in a reducer; returns the input untouched for empty text.
 */
export function appendTextPart(
  parts: MessagePart[] | undefined,
  text: string,
  breakBefore = false
): MessagePart[] {
  const base = parts || [];
  if (!text) return base;
  const last = base[base.length - 1];
  if (!breakBefore && last?.type === 'text') {
    return [...base.slice(0, -1), { type: 'text', text: last.text + text }];
  }
  return [...base, { type: 'text', text }];
}

/**
 * Append a tool part. De-duplicates on id to mirror the live reducer's guard
 * against a re-delivered tool_use block — a duplicate must NOT open a new text
 * segment, or the turn would gain a paragraph break that the old string path
 * never produced.
 */
export function appendToolPart(parts: MessagePart[] | undefined, id: string): MessagePart[] {
  const base = parts || [];
  if (base.some((p) => p.type === 'tool' && p.id === id)) return base;
  return [...base, { type: 'tool', id }];
}

/**
 * Rebuild the flat `content` string from `parts`.
 *
 * Every part boundary is by construction a tool boundary (see appendTextPart),
 * so the conditional break degenerates into an unconditional one — which is why
 * this is just a fold of `joinAssistantText` with `breakBefore` pinned to true.
 * Folding the same function (rather than reimplementing it as a trim + join) is
 * deliberate: it stays byte-identical even in the pathological cases, e.g. a
 * segment made only of newlines, where the accumulator's trailing-newline trim
 * eats into the preceding separator. mergeIncrementalMessages compares these
 * strings, so any drift would surface as a phantom "content changed" re-render.
 */
export function deriveContent(parts: MessagePart[] | undefined): string {
  return (parts || [])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .reduce((acc, p, i) => (i === 0 ? p.text : joinAssistantText(acc, p.text, true)), '');
}
