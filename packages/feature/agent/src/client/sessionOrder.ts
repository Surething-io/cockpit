/**
 * sessionOrder — the display order every "recent sessions" list uses.
 *
 * The feed arrives sorted by `lastActive` alone (the server sorts and then
 * slices the top 20 in getGlobalSessionsSnapshot), which buries the two rows
 * that are actually asking for attention: the run that is still going and the
 * run that finished while you were elsewhere. So the lists group by status
 * first — done-but-unread, then running, then everything else — and keep
 * newest-first inside each group.
 *
 * This is presentation only. It reorders what was received; it cannot surface a
 * running session that fell outside the server's top-20 slice. In practice a
 * running session has a fresh `lastActive` and is inside it.
 *
 * Kept dependency-free (no React, no sibling imports) so /m can use it without
 * pulling the desktop row components into the mobile bundle.
 */

interface OrderableSession {
  status?: string;
  lastActive: number;
}

/** unread → loading → the rest. */
const statusRank = (status?: string): number =>
  status === 'unread' ? 0 : status === 'loading' ? 1 : 2;

/** Returns a new array; the input (a WS payload / fetch result) is never mutated. */
export function sortSessionsForDisplay<T extends OrderableSession>(sessions: readonly T[]): T[] {
  return [...sessions].sort(
    (a, b) => statusRank(a.status) - statusRank(b.status) || b.lastActive - a.lastActive,
  );
}
