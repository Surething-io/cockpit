import { Effect } from 'effect';
import { handler, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { dispatchChat } from '../engines/orchestrator';
import { claudeSpec } from '../engines/claude';
import type { DispatchParams } from '../engines/types';

// Thin Next.js mount point. All dispatch lives in the orchestrator + claude runner so it can be
// called in-process by the scheduled-task manager too — and so this route exports only POST.
export const POST = handler((request) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(request)) as DispatchParams;
    const outcome = yield* Effect.promise(() => dispatchChat(claudeSpec, body, request));
    if (!outcome.ok) {
      return new Response(JSON.stringify({ error: outcome.error }), {
        status: outcome.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return Response.json({ runKey: outcome.runKey, sessionId: outcome.sessionId, injected: !!outcome.injected });
  })
);
