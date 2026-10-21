import { readdir } from 'fs/promises';
import { join } from 'path';
import { Effect } from 'effect';
import { CLAUDE_PROJECTS_DIR } from '@cockpit/shared-utils';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { FSError, NotFoundError } from '@cockpit/effect-core';
import { TranscriptIndex } from '@cockpit/effect-services';
import { mergeStats } from '../transcriptViews';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Every top-level JSONL under ~/.claude/projects/<dir>/. Subagent sidechains in
 * subdirectories are skipped — they would double-count their parent's tokens.
 */
const listClaudeTranscripts: Effect.Effect<string[], FSError> = Effect.gen(function* () {
  const projectDirs = yield* Effect.tryPromise({
    try: () => readdir(CLAUDE_PROJECTS_DIR),
    catch: (cause) => new FSError({ path: CLAUDE_PROJECTS_DIR, op: 'read', cause }),
  });
  const perDir = yield* Effect.forEach(
    projectDirs,
    (dir) =>
      Effect.tryPromise({
        try: () => readdir(join(CLAUDE_PROJECTS_DIR, dir)),
        catch: (cause) => new FSError({ path: dir, op: 'read', cause }),
      }).pipe(
        Effect.map((files) => files.filter((f) => f.endsWith('.jsonl')).map((f) => join(CLAUDE_PROJECTS_DIR, dir, f))),
        Effect.orElseSucceed(() => [] as string[])
      ),
    { concurrency: 8 }
  );
  return perDir.flat();
});

/**
 * Token usage across every claude session. Per-file aggregates come from the
 * transcript index (each byte parsed once, ever), so this is a stat per file plus
 * an in-memory merge — no cache, no staleness window.
 */
export const GET = handler(() =>
  Effect.gen(function* () {
    const files = yield* listClaudeTranscripts.pipe(
      Effect.catchAll(() => Effect.fail(new NotFoundError({ resource: 'projectsDir', id: CLAUDE_PROJECTS_DIR })))
    );
    const index = yield* TranscriptIndex;
    const snaps = yield* index.snapshots(files.map((path) => ({ path, format: 'claude' as const })));
    return ok(mergeStats(snaps.flatMap((s) => (s ? [s.stats] : []))));
  })
);
