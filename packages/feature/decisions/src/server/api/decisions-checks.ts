/**
 * POST /api/decisions/checks { cwd, command, isCheck } → { include, exclude }
 *
 * The user's correction of check detection for one command, per project
 * (docs/DECISION_MODE.md §5). Requires decision mode on.
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { requireProject } from '../projectIdentity';
import { setCheckOverride } from '../checks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Record<string, unknown>;
    if (typeof body.cwd !== 'string' || !body.cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    if (typeof body.command !== 'string' || !body.command.trim()) return yield* Effect.fail(new ValidationError({ field: 'command', reason: 'missing' }));
    if (typeof body.isCheck !== 'boolean') return yield* Effect.fail(new ValidationError({ field: 'isCheck', reason: 'must be boolean' }));
    const project = yield* requireProject(body.cwd);
    if (!project.enabled) return yield* Effect.fail(new ValidationError({ field: 'decisionMode', reason: 'disabled for this project' }));
    return ok(yield* setCheckOverride(project.projectId, body.command.slice(0, 4000), body.isCheck));
  }),
);
