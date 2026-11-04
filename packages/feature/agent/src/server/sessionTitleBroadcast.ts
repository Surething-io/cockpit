import { Effect } from 'effect';
import { WSError } from '@cockpit/effect-core';
import type { SessionTitleChange } from '../shared/sessionTitle';

/** Read the existing global-state transport, as consoleBroadcast does, without
 * importing src/ into a feature or creating a second connection registry. */
export const broadcastSessionTitle = (change: SessionTitleChange) => Effect.suspend(() => {
  const shared = globalThis as unknown as { __cockpitGlobalStateClients?: Set<{ readyState: number; send: (data: string) => void }> };
  const message = JSON.stringify({ type: 'session-title-changed', data: change });
  return Effect.forEach([...shared.__cockpitGlobalStateClients ?? []], (client) =>
    client.readyState !== 1 ? Effect.void : Effect.try({
      try: () => client.send(message),
      catch: (cause) => new WSError({ proto: 'global-state', kind: 'send', cause }),
    }).pipe(Effect.catchAll((cause) => Effect.logWarning('Session title notification failed', cause))),
  { discard: true });
});
