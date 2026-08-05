/**
 * What counts as a real user turn in a Claude-style transcript.
 *
 * Not every `type: 'user'` entry is something a human typed. The harness injects its own
 * user-role entries — background-task notifications, skill bodies, image annotations,
 * compaction notices — and they are distinguished only by side-band fields (`origin.kind`,
 * `isMeta`, `isCompactSummary`), never by the message content, which is ordinary text.
 *
 * This lived in three places at once (transcriptToMessages, session-by-path twice) and a
 * fourth consumer — fork.ts — reimplemented it as "type is user and has a text block". That
 * fourth copy is what shipped the bug: in a session using background tasks, every
 * `<task-notification>` read as a new human turn, cutting a 700-line conversation into 58
 * "turns" instead of 21. Excerpting one then yielded a system-event fragment, and forking
 * truncated an answer at its first background-task notification.
 *
 * The invariant worth keeping: what the UI refuses to render as a user bubble must not be a
 * turn boundary either. One definition, so a new injection kind upstream cannot be picked up
 * by the renderer and missed by the splitter.
 */

/** The transcript fields this classification reads. Structural, so any of the module-local
 *  TranscriptMessage interfaces satisfy it without importing a shared type. */
export interface InjectionFields {
  type?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  sourceToolUseID?: string;
  message?: {
    content?: string | Array<{ type?: string }> | unknown;
  };
}

/**
 * The harness-injection kind of a user message, or null if it's a real user turn.
 *   - 'skill': a skill body loaded by a tool call (folded into that call, not shown alone)
 *   - 'task-notification' / 'meta': rendered as a muted system-event bar
 */
export function injectionKind(
  msg: InjectionFields,
): 'skill' | 'task-notification' | 'meta' | null {
  if (msg.isMeta && msg.sourceToolUseID) return 'skill';
  if (msg.origin?.kind === 'task-notification') return 'task-notification';
  if (msg.origin?.kind && msg.origin.kind !== 'human') return 'meta';
  if (msg.isMeta) return 'meta';
  if (msg.isCompactSummary) return 'meta'; // context-compaction continuation notice (no isMeta on some versions)
  return null;
}

/**
 * Does this entry open a new human turn? Used to split a transcript into turns (fork /
 * excerpt) and to pick the text that names a session.
 *
 * Three conditions, each load-bearing:
 *  - `type: 'user'` — assistant/system rows never open a turn.
 *  - not harness-injected — see injectionKind.
 *  - carries actual text — a user entry whose blocks are only `tool_result` is the tail of
 *    the PREVIOUS turn (the engine reporting a tool's output), not the start of a new one.
 */
export function isHumanTurnStart(entry: InjectionFields): boolean {
  if (entry.type !== 'user') return false;
  if (injectionKind(entry) !== null) return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return content.length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => block?.type === 'text');
}
