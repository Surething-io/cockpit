/**
 * POST /api/decisions/relevant { cwd, text, files?, exclude? }
 *   → { decisions: [{ id, rev, choice, premises, reasons }] }  (at most 3)
 *
 * Decisions worth putting in front of the message being typed
 * (docs/DECISION_MODE.md §7.2). `files` are the files changed in the current
 * review range (absolute or cwd-relative); `exclude` is `id@rev` already
 * injected in this session. Requires decision mode on.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { readGitInfo, requireProject } from '../projectIdentity';
import { relevantDecisions } from '../relevance';
import { listDecisions } from '../store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Record<string, unknown>;
    if (typeof body.cwd !== 'string' || !body.cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    const cwd = body.cwd;
    const text = typeof body.text === 'string' ? body.text.slice(0, 20_000) : '';
    const project = yield* requireProject(cwd);
    if (!project.enabled) return yield* Effect.fail(new ValidationError({ field: 'decisionMode', reason: 'disabled for this project' }));
    if (!text.trim()) return ok({ decisions: [] });

    const toplevel = (yield* readGitInfo(cwd))?.toplevel ?? cwd;
    const realCwd = yield* Effect.promise(() => realpath(cwd).catch(() => cwd));
    const files = new Set(
      strs(body.files, 500).map((f) => relative(toplevel, isAbsolute(f) ? f : resolve(realCwd, f)).split(sep).join('/')),
    );
    const ranked = yield* relevantDecisions(project.projectId, cwd, yield* listDecisions(project.projectId), text, files, new Set(strs(body.exclude, 1000)));
    return ok({
      decisions: ranked.map(({ decision: d, reasons }) => ({ id: d.id, rev: d.updatedAt, choice: d.choice, premises: d.premises, reasons })),
    });
  }),
);
