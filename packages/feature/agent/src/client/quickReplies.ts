/**
 * Quick-reply phrase customization — storage shape and the text format the
 * editor dialog speaks.
 *
 * Persisted in ~/.cockpit/settings.json under `quickReplies`, keyed by
 * language:
 *
 *   "quickReplies": { "zh": [["就这个","不要这样"],["为什么"]] }
 *
 * Keyed by language on purpose: a phrase is sent to the model verbatim, so one
 * shared list would mean a user who writes Chinese phrases keeps sending
 * Chinese after switching the UI to English. A language with no entry falls
 * back to the built-in i18n defaults and keeps following the language switch —
 * which is also what "restore defaults" returns you to, by deleting that
 * language's entry rather than writing the defaults out as literals.
 */

/** The two languages the app ships (see @cockpit/shared-i18n). */
export type QuickReplyLang = 'en' | 'zh';

export interface QuickRepliesSetting {
  en?: string[][];
  zh?: string[][];
}

/** Guards a paste of a whole document from becoming an unusable panel. */
const MAX_PHRASE_LENGTH = 200;
const MAX_ROWS = 12;
const MAX_PHRASES_PER_ROW = 8;

/** i18next resolves to a base language, but a stray region tag ("zh-CN") must
 *  not silently create a third bucket that nothing ever reads back. */
export const toQuickReplyLang = (language: string | undefined): QuickReplyLang =>
  language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';

/**
 * Coerce arbitrary on-disk data into rows. Never throws — settings.json is
 * hand-editable, and a malformed entry should degrade to "no customization"
 * rather than break the toolbar for every selection.
 *
 * Returns null (not []) when there is nothing usable, because the caller
 * distinguishes "no customization → show defaults" from "customized to empty".
 */
export const normalizeRows = (raw: unknown): string[][] | null => {
  if (!Array.isArray(raw)) return null;
  const rows: string[][] = [];
  for (const rawRow of raw.slice(0, MAX_ROWS)) {
    if (!Array.isArray(rawRow)) continue;
    const row: string[] = [];
    for (const entry of rawRow.slice(0, MAX_PHRASES_PER_ROW)) {
      // Non-strings are dropped rather than String()-ed: a stray `null` would
      // render as a clickable button that sends the text "null".
      if (typeof entry !== 'string') continue;
      const phrase = entry.trim().slice(0, MAX_PHRASE_LENGTH);
      if (phrase) row.push(phrase);
    }
    if (row.length) rows.push(row);
  }
  return rows.length ? rows : null;
};

export const readQuickReplies = (
  settings: unknown,
  lang: QuickReplyLang
): string[][] | null => {
  if (!settings || typeof settings !== 'object') return null;
  const bucket = (settings as { quickReplies?: unknown }).quickReplies;
  if (!bucket || typeof bucket !== 'object') return null;
  return normalizeRows((bucket as Record<string, unknown>)[lang]);
};

/**
 * Both the full-width "，" and the ASCII "," split a row.
 *
 * Accepting the full-width form is the whole point: a Chinese IME emits it by
 * default, and only honoring "," would silently glue a whole row into one
 * button. The cost is that a phrase cannot itself contain a comma — acceptable
 * for one-tap phrases like "就这个" / "Give an example", and the alternative
 * (quoting or escaping) is a syntax users would have to be taught.
 */
const ROW_SEPARATOR = /[,，]/;

/** Editor text → rows. Blank lines and empty items vanish rather than becoming
 *  zero-width buttons. */
export const parseQuickReplies = (text: string): string[][] =>
  text
    .split('\n')
    .map((line) =>
      line
        .split(ROW_SEPARATOR)
        .map((phrase) => phrase.trim().slice(0, MAX_PHRASE_LENGTH))
        .filter(Boolean)
        .slice(0, MAX_PHRASES_PER_ROW)
    )
    .filter((row) => row.length > 0)
    .slice(0, MAX_ROWS);

/** Rows → editor text. Serializes with the separator that language's users
 *  type, so re-saving an untouched buffer is a no-op. */
export const formatQuickReplies = (rows: readonly (readonly string[])[], lang: QuickReplyLang): string =>
  rows.map((row) => row.join(lang === 'zh' ? '，' : ', ')).join('\n');
