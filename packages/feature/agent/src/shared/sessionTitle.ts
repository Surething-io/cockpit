/** Cockpit-owned title metadata; native engine titles remain independent. */
export interface SessionTitleInfo {
  title: string;
  defaultTitle: string;
  customTitle: string | null;
  titleRevision: number;
  /** A session Bot: ticked "can be @-mentioned", so it is listed with the Bots and
   *  addressable as `@<current title>` (server/lib/sessionBots). Set by the title API. */
  mentionable?: boolean;
}

export interface SessionTitleChange extends SessionTitleInfo {
  cwd: string;
  sessionId: string;
}

export interface SessionTitlesResponse {
  titles: SessionTitleChange[];
}

/**
 * A custom title is one line: no real line break, and no literal `\n` either (what a pasted
 * escaped string leaves behind). It is also the name an `@` line addresses the session by,
 * and `@` lines are line-led — a title spanning lines could never be typed as one.
 */
export function hasTitleLineBreak(title: string): boolean {
  return /[\r\n]|\\[nr]/.test(title);
}

/**
 * Why a title cannot be a session's name, or null when it can. The same rules gate saving
 * a custom title and addressing a session as `@<title>`, so a saved title is always usable:
 *   empty     — nothing to address
 *   multiline — `@` lines are line-led (see hasTitleLineBreak)
 *   at        — the name follows an `@`; one inside it (`@@ x`) could never be typed to match
 */
export type TitleNameProblem = 'empty' | 'multiline' | 'at';
export function titleNameProblem(title: string): TitleNameProblem | null {
  if (hasTitleLineBreak(title)) return 'multiline';
  if (!normalizeSessionTitle(title)) return 'empty';
  if (title.includes('@')) return 'at';
  return null;
}

export function normalizeSessionTitle(title: string): string {
  return title.replace(/[\r\n]+/g, ' ').trim();
}
