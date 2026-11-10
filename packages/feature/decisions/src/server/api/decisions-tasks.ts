/**
 * /api/decisions/tasks — accepted reviews.
 *
 * GET  ?cwd=&sessionId=   → { tasks: AcceptedTaskSummary[] } (newest first)
 * GET  ?cwd=&id=          → { task: AcceptedTask }  (read-only re-view)
 * POST { cwd, sessionId, goal, turns, decisions? } → { task, decisions }  (accept: recompute + freeze, then write kept decisions)
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { requireProject } from '../projectIdentity';
import { acceptTask, listSessionTasks, parseKeptDecisions, parseTurns, readTask } from '../tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const missing = (field: string) => new ValidationError({ field, reason: 'missing' });

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams;
    const cwd = sp.get('cwd');
    if (!cwd) return yield* Effect.fail(missing('cwd'));
    const project = yield* requireProject(cwd);
    const id = sp.get('id');
    if (id) return ok({ task: yield* readTask(project.projectId, id) });
    const sessionId = sp.get('sessionId');
    if (!sessionId) return yield* Effect.fail(missing('sessionId|id'));
    return ok({ tasks: yield* listSessionTasks(project.projectId, sessionId) });
  }),
);

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Record<string, unknown>;
    if (typeof body.cwd !== 'string' || !body.cwd) return yield* Effect.fail(missing('cwd'));
    if (typeof body.sessionId !== 'string' || !body.sessionId) return yield* Effect.fail(missing('sessionId'));
    const turns = parseTurns(body.turns);
    if (turns instanceof ValidationError) return yield* Effect.fail(turns);
    const project = yield* requireProject(body.cwd);
    if (!project.enabled) return yield* Effect.fail(new ValidationError({ field: 'decisionMode', reason: 'disabled for this project' }));
    const decisions = parseKeptDecisions(body.decisions);
    if (decisions instanceof ValidationError) return yield* Effect.fail(decisions);
    const goal = typeof body.goal === 'string' ? body.goal.trim().slice(0, 500) : '';
    return ok(yield* acceptTask(project.projectId, { cwd: body.cwd, sessionId: body.sessionId, goal, turns, decisions }));
  }),
);
