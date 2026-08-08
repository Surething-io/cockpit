/**
 * GET /api/snapshots?cwd=<abs path>&toolIds=<id,id,...>[&sessionKey=<id>]
 *
 * Snapshot commits (shadow-git, one per tool call) whose Cockpit-Tool-Id is
 * in `toolIds`, oldest first. The chat UI passes the tool_use ids of one
 * message to resolve that message's real on-disk changes.
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
    const toolIds = (searchParams.get('toolIds') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const sessionKey = searchParams.get('sessionKey') || undefined;
    if (!cwd) {
      return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    }
    const svc = yield* SnapshotService;
    const commits = yield* svc.listByToolIds(cwd, toolIds, sessionKey);
    return ok({ commits });
  })
);
