/**
 * GET /api/decisions/export?cwd= — every decision of the project with its full
 * event history, as a downloadable JSON file (backup / moving machines).
 * Export works with the switch off: it only reads.
 */
import { Effect } from 'effect';
import { handler } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { requireProject } from '../projectIdentity';
import { listHistories } from '../store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get('cwd');
    if (!cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    const project = yield* requireProject(cwd);
    const decisions = yield* listHistories(project.projectId);
    const body = JSON.stringify({ format: 'cockpit-decisions/1', exportedAt: Date.now(), projectId: project.projectId, kind: project.kind, decisions }, null, 2);
    return new Response(body, {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="decisions-${project.projectId.slice(0, 24)}.json"`,
      },
    });
  }),
);
