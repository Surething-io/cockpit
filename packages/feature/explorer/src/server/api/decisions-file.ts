/**
 * GET /api/decisions/file?cwd=&path= → { enabled, decisions: [{ decision, state, lines }] }
 *
 * Decisions linked to one file, for the code viewer (docs/DECISION_MODE.md §8.1).
 * Only those that apply here or are not committed yet are returned; a symbol
 * link is placed on the symbol's CURRENT start line (parsed now), so markers
 * follow the code instead of a stored line number. `path` is cwd-relative.
 */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { derivedContext, deriveState, listDecisions, readGitInfo, requireProject } from '@cockpit/feature-decisions/server';
import { fileFunctionsLocal } from '@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams;
    const cwd = sp.get('cwd');
    const path = sp.get('path');
    if (!cwd || !path) return yield* Effect.fail(new ValidationError({ field: 'cwd|path', reason: 'missing' }));
    const project = yield* requireProject(cwd);
    if (!project.enabled) return ok({ enabled: false, decisions: [] });

    const toplevel = (yield* readGitInfo(cwd))?.toplevel ?? cwd;
    const realCwd = yield* Effect.promise(() => realpath(cwd).catch(() => cwd));
    const abs = isAbsolute(path) ? path : resolve(realCwd, path);
    const rel = relative(toplevel, abs).split(sep).join('/');
    const cwdRel = relative(realCwd, abs).split(sep).join('/');

    const linked = (yield* listDecisions(project.projectId)).filter((d) => d.status === 'active' && d.links.some((l) => l.path === rel));
    if (linked.length === 0) return ok({ enabled: true, decisions: [] });

    const ctx = yield* derivedContext(project.projectId, cwd, linked);
    const needsSymbols = linked.some((d) => d.links.some((l) => l.path === rel && l.symbol));
    const fns = needsSymbols ? yield* Effect.promise(() => fileFunctionsLocal(cwd, cwdRel).catch(() => null)) : null;
    const lineOf = new Map((fns?.functions ?? []).map((f) => [f.qualifiedName, f.startLine]));

    const out = [];
    for (const d of linked) {
      const state = yield* deriveState(d, ctx);
      if (state !== 'applicable' && state !== 'not-landed') continue;
      const lines = d.links
        .filter((l) => l.path === rel && l.symbol)
        .map((l) => lineOf.get(l.symbol!))
        .filter((n): n is number => typeof n === 'number');
      out.push({ decision: d, state, lines });
    }
    return ok({ enabled: true, decisions: out });
  }),
);
