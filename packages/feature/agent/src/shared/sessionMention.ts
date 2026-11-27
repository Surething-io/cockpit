/**
 * `@<session title> <task>` — addressing a session Bot by its displayed title.
 *
 * Bots own `@name` first; a line falls through to session Bots only when its first token is
 * not a registered Bot. Titles are free text (spaces, CJK), so the end of the title cannot
 * be found by tokenizing: the LONGEST session title the line starts with wins, and it must
 * be followed by whitespace or the end of the line, so `@Fix` never matches inside
 * `@Fixtures`. Matching is case-insensitive.
 *
 * Two sessions sharing the matched title are reported as ambiguous instead of picking one:
 * a task sent to the wrong session runs in the wrong project and cannot be taken back.
 *
 * The candidates are the session Bots (server/lib/sessionBots): sessions ticked "can be
 * @-mentioned", named by their CURRENT title when that title is a valid name.
 *
 * Pure and shared, so the server's dispatch and the composer's autocomplete agree.
 */
export interface MentionableSession {
  /** The session's `@` name (a valid title, whitespace collapsed), never a raw title. */
  title: string;
  cwd: string;
  sessionId: string;
}

export type SessionMention =
  | { kind: 'match'; session: MentionableSession; title: string; rest: string }
  | { kind: 'ambiguous'; title: string; candidates: MentionableSession[] };

/** A name with whitespace collapsed — exactly what the composer inserts and the server matches. */
export function mentionTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

const fold = (title: string) => mentionTitle(title).toLowerCase();

/**
 * Resolve the text after a line's leading `@` against the session Bots.
 * Returns null when no session title starts the text — the line is then ordinary prose.
 */
export function matchSessionMention(
  text: string,
  sessions: ReadonlyArray<MentionableSession>,
): SessionMention | null {
  const lower = text.toLowerCase();
  let best: string | null = null;
  for (const session of sessions) {
    const title = fold(session.title);
    if (!title || title.length <= (best?.length ?? 0)) continue;
    if (!lower.startsWith(title)) continue;
    const next = text.charAt(title.length);
    if (next && !/\s/.test(next)) continue;
    best = title;
  }
  if (best === null) return null;
  const candidates = sessions.filter((session) => fold(session.title) === best);
  const title = text.slice(0, best.length);
  if (candidates.length > 1) return { kind: 'ambiguous', title, candidates };
  return { kind: 'match', session: candidates[0], title: mentionTitle(candidates[0].title), rest: text.slice(best.length).trim() };
}
