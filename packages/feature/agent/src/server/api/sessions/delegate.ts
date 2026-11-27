/**
 * POST /api/sessions/delegate
 * Body: { cwd, engine?, model?, title?, prompt? | briefPath?, sessionId? }
 * Header (optional): x-cockpit-run-id: $COCKPIT_RUN_ID — identifies the calling session,
 *   which is also where an omitted `engine` comes from (the child inherits the caller's)
 *
 * Starts a new session in `cwd` on `engine` and returns a receipt immediately; it does not
 * wait for the task. With `sessionId`, the task goes into that existing session instead
 * (an `@<favorite>` line, see the session-run skill), on its own engine and model. Nothing is stored server-side: the receipt is the record.
 * Backs the /dl skill. See DelegationService.
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { DelegationService } from '@cockpit/effect-services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handler((req) =>
  Effect.gen(function* () {
    const raw = yield* parseJsonRaw(req);
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const delegation = yield* DelegationService;
    // The header reaches BOTH calls: `validate` uses it to settle a missing
    // `engine` (inherit the caller's), `delegate` to record the parent link.
    const parentRunId = req.headers.get('x-cockpit-run-id');
    const request = yield* delegation.validate(body, parentRunId);
    const receipt = yield* delegation.delegate(request, parentRunId);
    return ok(receipt);
  })
);
