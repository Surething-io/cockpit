/**
 * Output style for Codex: keep the rollout in step with the session's current selection.
 *
 * Why the rollout and not a parameter: `developerInstructions` only takes effect on
 * `thread/start`. Codex writes it into the rollout as the first content item of the thread's
 * first developer message, and `thread/resume` rebuilds the model context from the rollout —
 * a different value (or none) passed on resume is ignored, measured. The process being
 * per-turn does not help; the state lives in the file, not the process. `turn/start` has no
 * instructions field either.
 *
 * So before every resume we reconcile that file:
 *   same text as selected → no write (the common case)
 *   different text        → replace it in place
 *   nothing selected      → remove it
 *   not present           → insert it as the first item of the first developer message
 *
 * The injected text is wrapped in a marker so it can be found again without guessing which
 * developer item is ours. Runs only while the session is idle (the orchestrator admits one
 * run per session and this happens before the Codex child is spawned), so nothing else is
 * writing the file.
 *
 * Every developer item carrying the marker is rewritten, wherever it sits (a compaction
 * record may have copied it); insertion only targets the first developer message.
 */
import * as fs from 'fs';
import { rewriteTranscriptSync } from '../../transcriptWrite';

const OPEN = '<cockpit_output_style>';
const CLOSE = '</cockpit_output_style>';

/** The exact text handed to Codex as `developerInstructions`. */
export function wrapCodexOutputStyle(style: string): string {
  return `${OPEN}\n${style}\n${CLOSE}`;
}

interface ContentItem {
  type?: string;
  text?: unknown;
}

const isOurs = (item: ContentItem): boolean =>
  typeof item?.text === 'string' && item.text.startsWith(OPEN);

/** Rewrite every marked item in a content array; returns [next, changed, found]. */
function rewriteContent(
  content: ContentItem[],
  desired: string | undefined,
): [ContentItem[], boolean, boolean] {
  let found = false;
  let changed = false;
  const next: ContentItem[] = [];
  for (const item of content) {
    if (!isOurs(item)) {
      next.push(item);
      continue;
    }
    found = true;
    if (desired === undefined) {
      changed = true;
      continue;
    }
    if (item.text !== desired) changed = true;
    next.push({ ...item, text: desired });
  }
  return [next, changed, found];
}

/** A developer message's content array, wherever it sits in a parsed rollout value. */
function eachDeveloperContent(value: unknown, visit: (msg: { content: ContentItem[] }) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) eachDeveloperContent(v, visit);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.type === 'message' && obj.role === 'developer' && Array.isArray(obj.content)) {
    visit(obj as { content: ContentItem[] });
    return;
  }
  for (const v of Object.values(obj)) eachDeveloperContent(v, visit);
}

const isFirstDeveloperMessage = (entry: { type?: string; payload?: Record<string, unknown> }): boolean =>
  entry.type === 'response_item' &&
  entry.payload?.type === 'message' &&
  entry.payload?.role === 'developer' &&
  Array.isArray(entry.payload?.content);

export type CodexOutputStyleSync = 'unchanged' | 'updated' | 'removed' | 'inserted' | 'no-anchor';

/**
 * Make the rollout at `sessionPath` carry exactly `style` (undefined = none).
 * Writes only when something differs, atomically (temp file + rename).
 */
export function syncCodexOutputStyle(sessionPath: string, style: string | undefined): CodexOutputStyleSync {
  const desired = style ? wrapCodexOutputStyle(style) : undefined;
  const raw = fs.readFileSync(sessionPath, 'utf-8');
  const lines = raw.split('\n');

  let found = false;
  let changed = false;
  let firstDeveloperLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marked = line.includes(OPEN);
    // Parse only what can matter: lines holding our marker, plus (for insertion) lines up to
    // the first developer message. Everything else in a multi-MB rollout is left as a string.
    if (!marked && (firstDeveloperLine >= 0 || !line.includes('"developer"'))) continue;
    let entry: { type?: string; payload?: Record<string, unknown> };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (firstDeveloperLine < 0 && isFirstDeveloperMessage(entry)) firstDeveloperLine = i;
    if (!marked) continue;
    let lineChanged = false;
    eachDeveloperContent(entry, (msg) => {
      const [next, c, f] = rewriteContent(msg.content, desired);
      if (f) found = true;
      if (c) {
        msg.content = next;
        lineChanged = true;
      }
    });
    if (lineChanged) {
      lines[i] = JSON.stringify(entry);
      changed = true;
    }
  }

  let result: CodexOutputStyleSync;
  if (found) {
    result = !changed ? 'unchanged' : desired === undefined ? 'removed' : 'updated';
  } else if (desired === undefined) {
    return 'unchanged';
  } else if (firstDeveloperLine < 0) {
    // No initial developer message to attach to (an unfamiliar rollout shape). Leave the file
    // alone rather than invent a record Codex may not accept.
    return 'no-anchor';
  } else {
    const entry = JSON.parse(lines[firstDeveloperLine]) as { payload: { content: ContentItem[] } };
    entry.payload.content = [{ type: 'input_text', text: desired }, ...entry.payload.content];
    lines[firstDeveloperLine] = JSON.stringify(entry);
    result = 'inserted';
  }

  if (result === 'unchanged') return result;
  rewriteTranscriptSync(sessionPath, lines.join('\n'));
  return result;
}
