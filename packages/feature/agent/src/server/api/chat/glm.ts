import { Effect } from 'effect';
import { handler, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { dispatchChat } from '../../engines/orchestrator';
import { glmSpec } from '../../engines/glm';
import type { DispatchParams } from '../../engines/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Thin Next.js mount point — dispatch lives in engines/glm.
export const POST = handler((request) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(request)) as DispatchParams;
    const outcome = yield* Effect.promise(() => dispatchChat(glmSpec, body, request));
    if (!outcome.ok) {
      return new Response(JSON.stringify({ error: outcome.error }), {
        status: outcome.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return Response.json({ runKey: outcome.runKey, sessionId: outcome.sessionId });
  })
);
