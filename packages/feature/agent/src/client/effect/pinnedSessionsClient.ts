import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import { IframeBus, Topics } from '@cockpit/effect-services';
import type { PinnedSession } from '../../shared/pinnedSession';

export const loadPinnedSessions = Effect.tryPromise({
  try: async () => {
    const response = await fetch('/api/pinned-sessions');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as { sessions?: PinnedSession[] };
  },
  catch: (cause) => new AppError({ message: 'Cannot load favorites', cause }),
});

/** Readers must not reload the old order while the write is still in flight. */
export const savePinnedSessions = (sessions: PinnedSession[]) => Effect.tryPromise({
  try: async () => {
    const response = await fetch('/api/pinned-sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessions }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  },
  catch: (cause) => new AppError({ message: 'Cannot save favorites', cause }),
}).pipe(Effect.tap(() => Effect.flatMap(IframeBus, (bus) => bus.publish(Topics.PinnedSessionsChanged, {}))));
