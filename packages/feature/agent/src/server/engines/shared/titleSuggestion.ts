/**
 * "Suggest a title" for the title dialog, run on the session's OWN engine.
 *
 * Every engine answers one prompt built from a short excerpt of the conversation, and does
 * so without creating a session: Claude with `persistSession: false`, Codex on an ephemeral
 * thread, the Pi-family providers with a plain chat completion, Grok in a throwaway
 * directory whose native session is removed afterwards. See each engine's `suggestTitle`.
 *
 * Whatever the model says goes through cleanSuggestedTitle, which guarantees a title the
 * dialog can save (one line, no `@`, not empty, capped) — the suggestion only fills the
 * input; the user still presses Save.
 */
import { titleNameProblem } from '../../../shared/sessionTitle';

/** Upper bound on one suggestion, process start-up included. */
export const TITLE_SUGGESTION_TIMEOUT_MS = 60_000;
/** Longest suggestion kept, in characters; a title is a label, not a summary. */
export const SUGGESTED_TITLE_MAX = 40;

export interface TitleExcerpt {
  /** The first few things the user asked, oldest first. */
  userMessages: string[];
  /** The latest assistant reply, if any. */
  lastReply: string | null;
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);

export function buildTitlePrompt(excerpt: TitleExcerpt): string {
  const asked = excerpt.userMessages.map((m, i) => `${i + 1}. ${clip(m.trim(), 600)}`).join('\n');
  return [
    'Name the conversation below with a short title, the way a person would label it in a list.',
    'Rules: reply with ONLY the title, on one line; at most 8 words (or 16 characters for Chinese,',
    'Japanese or Korean); in the language the user writes in; no quotes, no trailing punctuation,',
    'no "@" character, no markdown.',
    '',
    'The user asked:',
    asked || '(nothing yet)',
    ...(excerpt.lastReply ? ['', 'The latest reply:', clip(excerpt.lastReply.trim(), 1200)] : []),
  ].join('\n');
}

/**
 * The model's answer reduced to a saveable title, or '' when nothing usable is left.
 * Takes the first meaningful line, drops a "Title:" lead-in, wrapping quotes and markdown,
 * removes every `@`, collapses whitespace and caps the length.
 */
export function cleanSuggestedTitle(raw: string): string {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  let title = line
    .replace(/\*\*|__|`/g, '')
    .replace(/^(?:#+\s*|[-*]\s+)/, '')
    .replace(/^(?:title|标题)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’「『《]+|["'“”‘’」』》]+$/g, '')
    .replace(/\\[nr]/g, ' ')
    .replace(/@/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[。.!！?？,，;；:：]+$/, '')
    .trim();
  const chars = [...title];
  if (chars.length > SUGGESTED_TITLE_MAX) title = chars.slice(0, SUGGESTED_TITLE_MAX).join('').trimEnd();
  return titleNameProblem(title) ? '' : title;
}

/** One chat completion against an OpenAI-compatible endpoint (DeepSeek, Kimi, GLM, Ollama). */
export async function openAiCompatibleTitle(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  signal: AbortSignal;
}): Promise<string> {
  const response = await fetch(`${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: 'user', content: opts.prompt }],
      max_tokens: 200,
      stream: false,
    }),
    signal: opts.signal,
  });
  const body = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    error?: { message?: unknown };
  } | null;
  if (!response.ok) {
    const reason = typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`;
    throw new Error(`Title suggestion failed: ${reason}`);
  }
  const content = body?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}
