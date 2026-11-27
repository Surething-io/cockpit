/**
 * GET /api/snapshots/range-diff?cwd=<abs path>&head=<hash>[&base=<hash>][&file=<relative path>]
 *
 * Net file-level diff across a range of snapshot commits — what a whole turn
 * changed, as opposed to /api/snapshots/diff's single tool call.
 *
 * `base` is omitted when the oldest commit in the range is parentless (the
 * range starts from the empty tree). It is the PARENT of the oldest commit
 * the caller wants included, never that commit itself — see rangeDiffImpl.
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
    const head = searchParams.get('head');
    const base = searchParams.get('base');
    if (!cwd) {
      return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    }
    if (!head) {
      return yield* Effect.fail(new ValidationError({ field: 'head', reason: 'missing' }));
    }
    const svc = yield* SnapshotService;
    const diff = yield* svc.rangeDiff(cwd, base || null, head, searchParams.get('file') ?? undefined);
    return ok(diff);
  })
);
