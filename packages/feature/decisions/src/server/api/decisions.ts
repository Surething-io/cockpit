/**
 * /api/decisions — decision records of the project a cwd belongs to.
 *
 * GET   ?cwd=[&id=]                       → { decisions } | { decision, events } (one, with history)
 * POST  { cwd, content, source, links?, origin?, supersedes? } → { decision }
 * PATCH { cwd, id, content?, links? }     → { decision }  (edit, recorded as a revision)
 * PATCH { cwd, id, status, reason? }      → { decision }  (retire / reactivate)
 *
 * Writes require decision mode to be on for the project: with the switch off
 * the feature produces no data at all (docs/DECISION_MODE.md §2). Reads stay
 * available so turning it back on shows everything that was kept.
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { foldDecision } from '../../shared/types';
import { requireProject } from '../projectIdentity';
import {
  createDecision,
  editDecision,
  listDecisions,
  parseContent,
  parseLinks,
  parseOrigin,
  parseSource,
  readEvents,
  setDecisionStatus,
} from '../store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const missing = (field: string) => new ValidationError({ field, reason: 'missing' });

const lift = <A>(v: A | ValidationError): Effect.Effect<A, ValidationError> =>
  v instanceof ValidationError ? Effect.fail(v) : Effect.succeed(v);

const requireEnabled = (cwd: string) =>
  requireProject(cwd).pipe(
    Effect.filterOrFail(
      (p) => p.enabled,
      () => new ValidationError({ field: 'decisionMode', reason: 'disabled for this project' }),
    ),
  );

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams;
    const cwd = sp.get('cwd');
    if (!cwd) return yield* Effect.fail(missing('cwd'));
    const project = yield* requireProject(cwd);
    const id = sp.get('id');
    if (id) {
      const events = yield* readEvents(project.projectId, id);
      return ok({ decision: foldDecision(id, events), events });
    }
    return ok({ decisions: yield* listDecisions(project.projectId) });
  }),
);

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Record<string, unknown>;
    if (typeof body.cwd !== 'string' || !body.cwd) return yield* Effect.fail(missing('cwd'));
    const project = yield* requireEnabled(body.cwd);
    const content = yield* lift(parseContent(body.content, false));
    const source = yield* lift(parseSource(body.source));
    const links = yield* lift(parseLinks(body.links));
    const origin = yield* lift(parseOrigin(body.origin));
    if (body.supersedes !== undefined && typeof body.supersedes !== 'string') {
      return yield* Effect.fail(new ValidationError({ field: 'supersedes', reason: 'must be a decision id' }));
    }
    const decision = yield* createDecision(project.projectId, {
      content,
      source,
      links,
      ...(origin ? { origin } : {}),
      ...(typeof body.supersedes === 'string' ? { supersedes: body.supersedes } : {}),
    });
    return ok({ decision });
  }),
);

export const PATCH = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Record<string, unknown>;
    if (typeof body.cwd !== 'string' || !body.cwd) return yield* Effect.fail(missing('cwd'));
    if (typeof body.id !== 'string' || !body.id) return yield* Effect.fail(missing('id'));
    const project = yield* requireEnabled(body.cwd);
    if (body.status !== undefined) {
      if (body.status !== 'retired' && body.status !== 'active') {
        return yield* Effect.fail(new ValidationError({ field: 'status', reason: 'must be retired or active' }));
      }
      const reason = typeof body.reason === 'string' ? body.reason : undefined;
      return ok({ decision: yield* setDecisionStatus(project.projectId, body.id, body.status, reason) });
    }
    const content = body.content === undefined ? undefined : yield* lift(parseContent(body.content, true));
    const links = body.links === undefined ? undefined : yield* lift(parseLinks(body.links));
    if (!content && !links) return yield* Effect.fail(missing('content|links|status'));
    return ok({ decision: yield* editDecision(project.projectId, body.id, { ...(content ? { content } : {}), ...(links ? { links } : {}) }) });
  }),
);
