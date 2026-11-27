/**
 * GET /api/snapshots/diff?cwd=<abs path>&commit=<hash>[&file=<relative path>]
 *
 * File-level diff of one snapshot commit vs its parent (empty tree for a
 * day-root commit). Large text deferred by the list can be read by file.
 */
import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { SnapshotService } from '@cockpit/effect-services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler((req) =>
  Effect.gen(function* () {
    const { searchParams } = new URL(req.url);
    const cwd = searchParams.get('cwd');
    const commit = searchParams.get('commit');
    if (!cwd) {
      return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    }
    if (!commit) {
      return yield* Effect.fail(new ValidationError({ field: 'commit', reason: 'missing' }));
    }
    const svc = yield* SnapshotService;
    const diff = yield* svc.diff(cwd, commit, searchParams.get('file') ?? undefined);
    return ok(diff);
  })
);
