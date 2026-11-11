/**
 * Read side of the retired decision-mode context block. Pure; shared by
 * client and server.
 *
 * Decision mode used to put a delimited `<cockpit-decisions>` block in front
 * of some user messages. The feature is gone, but transcripts written while it
 * existed still carry the block, so everything that reads user text keeps
 * recognising it: the chat bubble folds it, and titles / previews strip it so
 * it is never shown as the user's own words.
 */

const BLOCK = /^\s*<cockpit-decisions>\n?([\s\S]*?)<\/cockpit-decisions>\s*/;
const ITEM = /^- \[(dec-[a-z0-9]+-[a-z0-9]+) r(\d+)\] (.*)$/gm;

export interface SplitMessage {
  /** The block's items, or empty when the message carries none. */
  items: Array<{ key: string; text: string }>;
  /** The user's own text. */
  body: string;
}

/** Split a user message into the old injected block and the user's own text. */
export function splitDecisionContext(text: string): SplitMessage {
  const m = BLOCK.exec(text);
  if (!m) return { items: [], body: text };
  const items: SplitMessage['items'] = [];
  for (const it of m[1].matchAll(ITEM)) items.push({ key: `${it[1]}@${it[2]}`, text: it[3] });
  return { items, body: text.slice(m[0].length) };
}

export const stripDecisionContext = (text: string): string => splitDecisionContext(text).body;
