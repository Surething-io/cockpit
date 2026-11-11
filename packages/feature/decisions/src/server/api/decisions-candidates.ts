/**
 * /api/decisions/candidates — the candidate inbox.
 *
 * GET  ?cwd=                                   → { candidates } (newest first)
 * POST { cwd, key, action: 'keep', content? }  → { decision }   (keep, optionally edited)
 * POST { cwd, key, action: 'dismiss' }         → { ok: true }
 *
 * Candidates come from every extraction of the project; keeping one does not
 * require accepting a review. Requires decision mode on.
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { requireProject } from '../projectIdentity';
import { dismissCandidate, keepCandidate, listCandidates } from '../candidates';
import { parseContent } from '../store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const enabledProject = (cwd: string) =>
  requireProject(cwd).pipe(
    Effect.filterOrFail(
      (p) => p.enabled,
      () => new ValidationError({ field: 'decisionMode', reason: 'disabled for this project' }),
    ),
  );

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get('cwd');
    if (!cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    const project = yield* enabledProject(cwd);
    return ok({ candidates: yield* listCandidates(project.projectId) });
  }),
);

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Record<string, unknown>;
    if (typeof body.cwd !== 'string' || !body.cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    if (typeof body.key !== 'string' || !/^[qc]-[0-9a-f]{20}$/.test(body.key)) return yield* Effect.fail(new ValidationError({ field: 'key', reason: 'malformed' }));
    const project = yield* enabledProject(body.cwd);
    if (body.action === 'dismiss') {
      yield* dismissCandidate(project.projectId, body.key);
      return ok({ ok: true });
    }
    if (body.action !== 'keep') return yield* Effect.fail(new ValidationError({ field: 'action', reason: 'keep | dismiss' }));
    let content;
    if (body.content !== undefined) {
      const parsed = parseContent(body.content, false);
      if (parsed instanceof ValidationError) return yield* Effect.fail(parsed);
      content = parsed;
    }
    return ok({ decision: yield* keepCandidate(project.projectId, body.cwd, body.key, content) });
  }),
);
