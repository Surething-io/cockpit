/**
 * The decision-context block decision mode puts in front of a user message
 * (docs/DECISION_MODE.md §7.2). Pure; shared by client and server.
 *
 * It is plain text in the user turn — every engine can read it — delimited
 * so that everything reading user text can fold or strip it: the chat bubble
 * folds it, titles / previews / review turn labels strip it, and extraction
 * strips it so a quote from it can never be attributed to the user. Each item
 * carries `[id rREV]`, which is how "once per session, unless edited" is told
 * from the transcript itself.
 */

export const DECISION_CONTEXT_OPEN = '<cockpit-decisions>';
export const DECISION_CONTEXT_CLOSE = '</cockpit-decisions>';

export interface DecisionContextItem {
  id: string;
  /** Decision `updatedAt` — re-injected only after an edit. */
  rev: number;
  choice: string;
  premises: string[];
}

const PREAMBLE =
  "Earlier decisions in this project and the conditions they rest on. Background only: if the user's request below conflicts with one, " +
  'point out the conflict and the affected premise and let the user decide — do not silently follow either side.';

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function buildDecisionContext(items: readonly DecisionContextItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map((d) => {
    const premises = d.premises.length ? ` Holds while: ${d.premises.map(oneLine).join('; ')}.` : '';
    return `- [${d.id} r${d.rev}] ${oneLine(d.choice)}${premises}`;
  });
  return `${DECISION_CONTEXT_OPEN}\n${PREAMBLE}\n${lines.join('\n')}\n${DECISION_CONTEXT_CLOSE}\n\n`;
}

const BLOCK = /^\s*<cockpit-decisions>\n?([\s\S]*?)<\/cockpit-decisions>\s*/;
const ITEM = /^- \[(dec-[a-z0-9]+-[a-z0-9]+) r(\d+)\] (.*)$/gm;

export interface SplitMessage {
  /** The block's items, or empty when the message carries none. */
  items: Array<{ key: string; text: string }>;
  /** The user's own text. */
  body: string;
}

/** Split a user message into the injected block and the user's own text. */
export function splitDecisionContext(text: string): SplitMessage {
  const m = BLOCK.exec(text);
  if (!m) return { items: [], body: text };
  const items: SplitMessage['items'] = [];
  for (const it of m[1].matchAll(ITEM)) items.push({ key: `${it[1]}@${it[2]}`, text: it[3] });
  return { items, body: text.slice(m[0].length) };
}

export const stripDecisionContext = (text: string): string => splitDecisionContext(text).body;

/** `id@rev` of every decision already injected in these user messages. */
export function injectedKeys(userTexts: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const t of userTexts) for (const it of splitDecisionContext(t).items) out.add(it.key);
  return out;
}
