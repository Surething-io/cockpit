/**
 * POST /api/decisions/review { cwd, toolIds, summary? } → ReviewResult
 *
 * The deterministic part of a task review for the range spanned by `toolIds`
 * (docs/DECISION_MODE.md §4). `summary: true` drops file contents — the chat
 * status bar only needs counts. Requires decision mode on for the project.
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { requireProject } from '../projectIdentity';
import { computeReview } from '../review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { cwd?: unknown; toolIds?: unknown; summary?: unknown };
    if (typeof body.cwd !== 'string' || !body.cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    if (!Array.isArray(body.toolIds) || !body.toolIds.every((x): x is string => typeof x === 'string')) {
      return yield* Effect.fail(new ValidationError({ field: 'toolIds', reason: 'must be a string array' }));
    }
    const project = yield* requireProject(body.cwd);
    if (!project.enabled) return yield* Effect.fail(new ValidationError({ field: 'decisionMode', reason: 'disabled for this project' }));
    return ok(yield* computeReview(body.cwd, body.toolIds, body.summary !== true));
  }),
);
