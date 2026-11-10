/**
 * POST /api/decisions/verification { cwd, orderedToolIds, runs, claimedPass }
 *   → VerificationResult (docs/DECISION_MODE.md §5)
 *
 * Runs come from the client's parsed transcript (tool calls carry the engines'
 * own exit signals); the server classifies checks, places each run against the
 * snapshot timeline and decides its state. Requires decision mode on.
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { requireProject } from '@cockpit/feature-decisions/server';
import { parseRuns, verifyRange } from '../review/verification';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');


export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Record<string, unknown>;
    if (typeof body.cwd !== 'string' || !body.cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    if (!isStrArray(body.orderedToolIds)) return yield* Effect.fail(new ValidationError({ field: 'orderedToolIds', reason: 'must be a string array' }));
    const runs = parseRuns(body.runs);
    if (!runs) return yield* Effect.fail(new ValidationError({ field: 'runs', reason: 'malformed' }));
    const project = yield* requireProject(body.cwd);
    if (!project.enabled) return yield* Effect.fail(new ValidationError({ field: 'decisionMode', reason: 'disabled for this project' }));
    return ok(yield* verifyRange(body.cwd, body.orderedToolIds, runs, body.claimedPass === true));
  }),
);
