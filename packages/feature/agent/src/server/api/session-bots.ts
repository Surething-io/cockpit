/**
 * /api/session-bots — sessions ticked "can be @-mentioned" (server/lib/sessionBots).
 *   GET                              → SessionBotInfo[]  (name, title, project, engine)
 *   DELETE  { cwd, sessionId }       → { removed: true } (the session itself is untouched)
 * Adding happens from the title dialog (POST /api/session-title { mentionable: true }).
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { listSessionBots, setSessionBot } from '../lib/sessionBots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(() => listSessionBots.pipe(Effect.map(ok)));

export const DELETE = handler((req) => Effect.gen(function* () {
  const body = (yield* parseJsonRaw(req)) as { cwd?: unknown; sessionId?: unknown };
  if (typeof body.cwd !== 'string' || !body.cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'cwd is required' }));
  if (typeof body.sessionId !== 'string' || !body.sessionId) return yield* Effect.fail(new ValidationError({ field: 'sessionId', reason: 'sessionId is required' }));
  yield* setSessionBot(body.cwd, body.sessionId, false);
  return ok({ removed: true });
}));
