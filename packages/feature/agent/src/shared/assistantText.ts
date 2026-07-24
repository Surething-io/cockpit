/**
 * Single source of truth for joining the multiple text segments an assistant
 * emits within ONE turn (narration between tool calls).
 *
 * Used by BOTH sides so a turn renders byte-identically live and after refresh:
 *  - live reducer (client/applyStreamEvent.ts): streamed deltas + complete blocks
 *  - history parsers (server/api/session/history.ts, server/api/session-by-path.ts):
 *    replay from the on-disk jsonl on page load / reconnect
 *
 * The boundary rule is shared: insert a paragraph break (blank line) before a
 * text segment ONLY when a tool_use has occurred since the previous text was
 * appended (`breakBefore`). Markdown needs a blank line to start a new
 * paragraph; without one, two `**...**` narration lines glue into one run
 * (e.g. `Migration:****2/5`). Text segments NOT separated by a tool_use are
 * concatenated verbatim — matching how the live reducer accumulates deltas,
 * which have no block-boundary signal to break on.
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
