/**
 * GET /api/sessions/status?cwd=<abs dir>&sessionId=<id>[&full=1][&inputId=<id>]
 *
 * Status of any session, derived on read from the run registry and the transcript's own
 * terminal markers: running | done | failed | incomplete. Includes the last reply (cut to
 * 4000 chars unless full=1; see lastReplyTruncated) and an openable link.
 * Not tied to delegation; any session works. See DelegationService.
 * `inputId` (from an existing-session delegate receipt) reports that ONE message: not
 * delivered → incomplete, otherwise the reply to it, never an older turn's.
 */
import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { DelegationService } from '@cockpit/effect-services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler((req) =>
  Effect.gen(function* () {
    const { searchParams } = new URL(req.url);
    const cwd = searchParams.get('cwd');
    const sessionId = searchParams.get('sessionId');
    if (!cwd || !sessionId) {
      return yield* Effect.fail(new ValidationError({ field: !cwd ? 'cwd' : 'sessionId', reason: 'missing' }));
    }
    const delegation = yield* DelegationService;
    const inputId = searchParams.get('inputId') || undefined;
    const report = yield* delegation.status(cwd, sessionId, { full: searchParams.get('full') === '1', ...(inputId && { inputId }) });
    return ok(report);
  })
);
