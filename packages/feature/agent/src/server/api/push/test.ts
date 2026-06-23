/**
 * POST /api/push/test — send a test notification to all stored subscriptions.
 * Handy for verifying the end-to-end push path without waiting for an agent run.
 */
import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { FSError } from '@cockpit/effect-core';
import { sendPushNotification } from '../../push/push';

export const POST = handler(() =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: () =>
        sendPushNotification({
          title: 'Cockpit',
          body: 'Test notification',
          data: { test: true },
        }),
      catch: (cause) => new FSError({ path: 'push-subscriptions.json', op: 'read', cause }),
    });
    return ok(result);
  }),
);
