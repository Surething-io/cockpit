import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { writeToPtySession } from '../pty/claudePtyDriver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Manual fallback: write the frontend floating window's keys into the interactive claude PTY stdin of a running session.
// Only effective while that session has a running PTY (the PTY exits when the turn ends → delivered=false).
export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { sessionId?: string; data?: string };
    if (!body.sessionId || typeof body.data !== 'string') {
      return yield* Effect.fail(
        new ValidationError({ field: !body.sessionId ? 'sessionId' : 'data', reason: 'missing' })
      );
    }
    const delivered = writeToPtySession(body.sessionId, body.data);
    return ok({ delivered });
  })
);
