/**
 * GET /api/push/public-key — VAPID public key for the client to subscribe with.
 */
import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { FSError } from '@cockpit/effect-core';
import { getPublicKey } from '../../push/push';

export const GET = handler(() =>
  Effect.gen(function* () {
    const publicKey = yield* Effect.tryPromise({
      try: () => getPublicKey(),
      catch: (cause) => new FSError({ path: 'settings.json', op: 'read', cause }),
    });
    return ok({ publicKey });
  }),
);
