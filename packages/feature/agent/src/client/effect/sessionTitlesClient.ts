import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import type { SessionTitleChange, SessionTitlesResponse } from '../../shared/sessionTitle';
import { acceptSessionTitles, titleKey, titleSnapshot } from '../sessionTitleState';

export const requestSessionTitle = (cwd: string, sessionId: string, customTitle?: string | null) => Effect.tryPromise({
  try: async () => {
    const response = await fetch('/api/session-title', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, sessionId, ...(customTitle !== undefined ? { customTitle } : {}) }),
    });
    if (!response.ok) throw new Error(`Cannot ${customTitle === undefined ? 'read' : 'save'} session title (HTTP ${response.status})`);
    return await response.json() as SessionTitleChange;
  },
  catch: (cause) => new AppError({ message: 'Session title request failed', cause }),
});

/** Fetch and publish one initial title batch, preserving updates received in flight. */
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
