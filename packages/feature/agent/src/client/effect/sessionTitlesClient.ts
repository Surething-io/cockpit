import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import type { SessionTitleChange, SessionTitlesResponse } from '../../shared/sessionTitle';
import { acceptSessionTitles, titleKey, titleSnapshot } from '../sessionTitleState';

/** Read a session's title, or save a patch: a rename (`customTitle`, null restores the
 *  default) and/or the "can be @-mentioned" flag. */
export const requestSessionTitle = (
  cwd: string,
  sessionId: string,
  patch?: { customTitle?: string | null; mentionable?: boolean },
) => Effect.tryPromise({
  try: async () => {
    const response = await fetch('/api/session-title', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, sessionId, ...patch }),
    });
    if (!response.ok) throw new Error(`Cannot ${patch === undefined ? 'read' : 'save'} session title (HTTP ${response.status})`);
    return await response.json() as SessionTitleChange;
  },
  catch: (cause) => new AppError({ message: 'Session title request failed', cause }),
});

/** Refresh titles in the background, preserving updates received in flight. */
export const loadSessionTitles = (cwd: string, sessionIds: string[]) => Effect.suspend(() => {
  const baseline = titleSnapshot();
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch('/api/session-title', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ cwd, sessionIds }),
      });
      if (!response.ok) throw new Error(`Cannot read session titles (HTTP ${response.status})`);
      return await response.json() as SessionTitlesResponse;
    },
    catch: (cause) => new AppError({ message: 'Session title batch failed', cause }),
  }).pipe(
    Effect.tap(({ titles }) => Effect.sync(() => acceptSessionTitles(titles, baseline))),
    Effect.map(({ titles }) => titles.map((change) => ({
      ...titleSnapshot().get(titleKey(change.cwd, change.sessionId))!,
      sessionId: change.sessionId,
    }))),
  );
});

/** Ask the session's own engine for a title (fills the dialog; never saved here). */
export const suggestSessionTitle = (cwd: string, sessionId: string) => Effect.tryPromise({
  try: async (signal) => {
    const response = await fetch('/api/session-title/suggest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ cwd, sessionId }),
    });
    const body = await response.json().catch(() => null) as { title?: string; error?: string } | null;
    if (!response.ok || typeof body?.title !== 'string') throw new Error(body?.error ?? `HTTP ${response.status}`);
    return body.title;
  },
  catch: (cause) => new AppError({ message: cause instanceof Error ? cause.message : 'Title suggestion failed', cause }),
});
