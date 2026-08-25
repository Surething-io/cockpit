/**
 * GET /api/snapshots?cwd=<abs path>&toolIds=<id,id,...>[&sessionKey=<id>][&runId=<id>]
 *
 * Snapshot commits (shadow-git, one per tool call) whose Cockpit-Tool-Id is
 * in `toolIds`, oldest first. The chat UI passes the tool_use ids of one
 * message to resolve that message's real on-disk changes.
 *
 * `runId` narrows the match to a single dispatch. It matters for engines whose
 * tool ids are only unique WITHIN a turn — codex numbers live items
 * `item_0, item_1, …` and restarts the counter each turn — where tool id plus
 * session id still matches every earlier turn of the same session.
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
    const runId = searchParams.get('runId') || undefined;
    if (!cwd) {
      return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    }
    const svc = yield* SnapshotService;
    const commits = yield* svc.listByToolIds(cwd, toolIds, sessionKey, runId);
    return ok({ commits });
  })
);
