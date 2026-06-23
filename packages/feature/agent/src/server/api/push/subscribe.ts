/**
 * POST /api/push/subscribe — store a PushSubscription (deduped by endpoint).
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { FSError, ValidationError } from '@cockpit/effect-core';
import { addSubscription } from '../../push/push';
import type webpush from 'web-push';

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { subscription?: webpush.PushSubscription };
    const sub = body.subscription;
    if (!sub || !sub.endpoint) {
      return yield* Effect.fail(new ValidationError({ field: 'subscription', reason: 'missing' }));
    }
    yield* Effect.tryPromise({
      try: () => addSubscription(sub),
      catch: (cause) => new FSError({ path: 'push-subscriptions.json', op: 'write', cause }),
    });
    return ok({ ok: true });
  }),
);
