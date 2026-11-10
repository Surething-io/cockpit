/**
 * POST /api/decisions/impact { cwd, orderedToolIds, runs, claimedPass, decisionsOnly? }
 *   → ImpactResult (docs/DECISION_MODE.md §6, §7.2)
 *
 * Existing decisions the range touches, interface changes with untouched
 * callers, affected tests × verification, body-only changes and blind spots.
 * `decisionsOnly` is the status-bar form: direct decision touches only.
 * Requires decision mode on.
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { requireProject } from '@cockpit/feature-decisions/server';
import { analyzeImpact } from '../review/impact';
import { parseRuns } from '../review/verification';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Record<string, unknown>;
    if (typeof body.cwd !== 'string' || !body.cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    if (!Array.isArray(body.orderedToolIds) || !body.orderedToolIds.every((x) => typeof x === 'string')) {
      return yield* Effect.fail(new ValidationError({ field: 'orderedToolIds', reason: 'must be a string array' }));
    }
    const runs = parseRuns(body.runs ?? []);
    if (!runs) return yield* Effect.fail(new ValidationError({ field: 'runs', reason: 'malformed' }));
    const project = yield* requireProject(body.cwd);
    if (!project.enabled) return yield* Effect.fail(new ValidationError({ field: 'decisionMode', reason: 'disabled for this project' }));
    return ok(yield* analyzeImpact(body.cwd, body.orderedToolIds as string[], runs, body.claimedPass === true, body.decisionsOnly === true));
  }),
);
