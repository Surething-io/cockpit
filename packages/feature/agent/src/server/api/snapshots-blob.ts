/**
 * GET /api/snapshots/blob?cwd=<abs path>&rev=<commit>&file=<repo-relative path>
 *
 * Raw bytes of an IMAGE at a snapshot revision — the image counterpart of
 * /api/snapshots/diff, which returns null contents for binaries.
 *
 * Why not /api/git/blob: that route runs `git show` inside the project's own
 * repo, and snapshot commits live in a separate shadow GIT_DIR under
 * <cockpitDir>/snapshots/. Same guards, different repo.
 */
import path from 'path';
import { Effect } from 'effect';
import { handler } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { SnapshotService } from '@cockpit/effect-services';
import { getMimeType } from '@cockpit/feature-explorer/server/files/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler((req) =>
  Effect.gen(function* () {
    const { searchParams } = new URL(req.url);
    const cwd = searchParams.get('cwd');
    const rev = searchParams.get('rev');
    const file = searchParams.get('file');
    if (!cwd) {
      return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    }
    if (!rev) {
      return yield* Effect.fail(new ValidationError({ field: 'rev', reason: 'missing' }));
    }
    if (!file) {
      return yield* Effect.fail(new ValidationError({ field: 'file', reason: 'missing' }));
    }
    const svc = yield* SnapshotService;
    const bytes = yield* svc.blob(cwd, rev, file);

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': getMimeType(path.extname(file)),
        'Content-Length': String(bytes.byteLength),
        // A snapshot rev is always a commit hash, so the blob is immutable.
        'Cache-Control': 'private, max-age=31536000, immutable',
        // SVG is served as image/svg+xml and only ever loaded through <img>
        // (which does not run scripts); nosniff + a null CSP keep it that way
        // even if something later navigates straight to this URL.
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  })
);
