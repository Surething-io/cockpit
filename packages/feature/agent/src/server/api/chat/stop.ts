import { Effect } from 'effect';
import { requestStop } from '../../sessionRunHub';
import { handler, parseJsonRaw } from '@cockpit/effect-runtime/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// #10 ws-converge: explicit stop. The run is detached from the POST that started it, so
// a client disconnect (refresh) no longer aborts it — only this endpoint does. The client
// sends whatever key it has (sessionId once known, else the provisional runId); we try
// both so a stop lands whether or not the run has rekeyed runId → sessionId yet.
export const POST = handler((request) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(request)) as { sessionId?: string; runId?: string };
    const stopped =
      (!!body.sessionId && requestStop(body.sessionId)) ||
      (!!body.runId && requestStop(body.runId));
    return Response.json({ ok: stopped });
  })
);
