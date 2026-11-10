/**
 * /api/decisions/project — decision-mode project state for a cwd.
 *
 * GET  ?cwd=                     → DecisionProjectResolution (resolved | ambiguous)
 * POST { cwd, enabled: boolean } → flip the per-project switch
 * POST { cwd, bind: id | 'new' } → settle an ambiguous checkout
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { bindProject, resolveProject, setEnabled } from '../projectIdentity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get('cwd');
    if (!cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    return ok(yield* resolveProject(cwd));
  }),
);

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { cwd?: unknown; enabled?: unknown; bind?: unknown };
    if (typeof body.cwd !== 'string' || !body.cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    if (typeof body.bind === 'string' && body.bind) {
      const state = yield* bindProject(body.cwd, body.bind);
      return ok({ status: 'resolved', ...state });
    }
    if (typeof body.enabled !== 'boolean') return yield* Effect.fail(new ValidationError({ field: 'enabled|bind', reason: 'missing' }));
    const state = yield* setEnabled(body.cwd, body.enabled);
    return ok({ status: 'resolved', ...state });
  }),
);
