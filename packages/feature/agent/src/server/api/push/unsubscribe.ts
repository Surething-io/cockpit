/**
 * POST /api/push/unsubscribe — remove a subscription by endpoint.
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { FSError, ValidationError } from '@cockpit/effect-core';
import { removeSubscription } from '../../push/push';

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { endpoint?: string };
    if (!body.endpoint) {
      return yield* Effect.fail(new ValidationError({ field: 'endpoint', reason: 'missing' }));
    }
    yield* Effect.tryPromise({
      try: () => removeSubscription(body.endpoint!),
      catch: (cause) => new FSError({ path: 'push-subscriptions.json', op: 'write', cause }),
    });
    return ok({ ok: true });
  }),
);
