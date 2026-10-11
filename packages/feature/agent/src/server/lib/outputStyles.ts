/**
 * Output styles — named blocks of text appended to an engine's system prompt.
 *
 * Stored globally in ~/.cockpit/output-styles.json as `{ styles: [{id,name,content}] }`.
 * A session opts in by id (the chat toolbar picker, persisted per session in the
 * project state's `outputStyles` map); no selection means nothing is injected.
 *
 * The client sends only the id and the text is resolved here at dispatch time,
 * so an edit to a style reaches the very next turn of every session using it,
 * and a scheduled task (which has no client) resolves it exactly the same way.
 *
 * Every engine receives the same framed section (formatOutputStyleSection), never
 * the raw text: a bare line tacked onto the end of a long system prompt reads as a
 * weak preference and loses to any nearer format instruction (a skill template).
 */
import { getGlobalOutputStylesConfigPath, readJsonFile } from '@cockpit/shared-utils';

export interface OutputStyle {
  id: string;
  name: string;
  content: string;
}

/** A style is a paragraph or a page of rules, not a one-liner — well above the
 *  quick-instruction cap, but still a guard against pasting a whole document
 *  into every turn's system prompt. */
export const MAX_OUTPUT_STYLE_LENGTH = 8000;

/** Names sit in a toolbar trigger and a one-row menu entry. */
export const MAX_OUTPUT_STYLE_NAME_LENGTH = 60;

/** Random, never derived from the text: renaming a style must keep its id, since
 *  sessions reference the style by id. */
const newId = (): string => Math.random().toString(36).slice(2, 10);

/**
 * Coerce arbitrary on-disk / request data into a valid style list. Never throws.
 *
 * - An entry without a name or without content is dropped: a nameless style has no
 *   menu row, and an empty one would be a selection that injects nothing.
 * - Duplicate names are kept only once (first wins) — two menu rows with the same
 *   label cannot be told apart.
 * - Missing or colliding ids are reissued, keeping existing ones stable.
 */
export function normalizeOutputStyles(raw: unknown): OutputStyle[] {
  if (!Array.isArray(raw)) return [];
  const usedIds = new Set<string>();
  const seenNames = new Set<string>();
  const out: OutputStyle[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Partial<OutputStyle>;
    const name = typeof e.name === 'string' ? e.name.trim().slice(0, MAX_OUTPUT_STYLE_NAME_LENGTH) : '';
    const content = typeof e.content === 'string' ? e.content.trim().slice(0, MAX_OUTPUT_STYLE_LENGTH) : '';
    if (!name || !content || seenNames.has(name)) continue;
    seenNames.add(name);
    let id = typeof e.id === 'string' ? e.id : '';
    while (!id || usedIds.has(id)) id = newId();
    usedIds.add(id);
    out.push({ id, name, content });
  }
  return out;
}

export async function readOutputStyles(): Promise<OutputStyle[]> {
  const data = await readJsonFile<{ styles?: unknown }>(getGlobalOutputStylesConfigPath(), {});
  return normalizeOutputStyles(data.styles);
}

/**
 * The text to append for `id`, or undefined when nothing should be injected: no
 * selection, a style that has since been deleted, or an unreadable file. Never
 * throws — a broken styles file must not stop a turn from running.
 */
export async function resolveOutputStyleText(id: unknown): Promise<string | undefined> {
  if (typeof id !== 'string' || !id) return undefined;
  try {
    return (await readOutputStyles()).find((s) => s.id === id)?.content;
  } catch (err) {
    console.warn(`[output-styles] failed to read styles, running without one: ${String(err)}`);
    return undefined;
  }
}

/**
 * The section every engine appends to its system prompt. The style's name is left out
 * on purpose: it is a UI label, can drift from the content, and would only give the
 * model a second, possibly contradicting, statement of the same rules.
 */
export function formatOutputStyleSection(content: string): string {
  return `# Output style
The user selected this output style for the session. Apply it to every reply, not just the first — including turns that run a skill or slash command. When a skill or project instruction fixes a reply's structure (sections, templates), keep that structure and apply the style inside it.

<output_style>
${content}
</output_style>`;
}
