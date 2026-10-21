/**
 * GET /api/session/<sessionId>/history?cwd=<abs path>
 *
 * The whole transcript of one session, parsed into chat messages.
 *
 * `cwd` is required, and deliberately so: a transcript path is derived from it
 * (`<store root>/encodePath(cwd)/<sessionId>.jsonl`), so a sessionId alone does
 * not locate a session. This route used to substitute `process.cwd()`, which
 * resolved only for sessions belonging to the directory the server happened to
 * be launched from — i.e. never, for a prod `cockpit` started outside a project.
 *
 * For a windowed read (pagination, fingerprint, subagent drill-in) use
 * /api/session-by-path instead; this route always parses the whole file.
 */
import { Effect } from 'effect';
import { dynamicHandler, ok } from '@cockpit/effect-runtime/server';
import {
  AppError,
  NotFoundError,
  ValidationError,
} from '@cockpit/effect-core';
import { resolveSessionPath } from './sessionStore';
import { parseTranscriptFile } from './transcriptToMessages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = dynamicHandler<
  { sessionId: string },
  AppError | NotFoundError | ValidationError
>((req, { sessionId }) =>
  Effect.gen(function* () {
    if (!sessionId) {
      return yield* Effect.fail(
        new ValidationError({ field: 'sessionId', reason: 'missing' })
      );
    }
    const cwd = new URL(req.url).searchParams.get('cwd');
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: 'cwd', reason: 'missing' })
      );
    }
    // Probe every engine store, not just Claude's — same reason fork/deleteTurn do:
    // where a session lives IS what it ran as, and this route is reachable for a
    // codex / deepseek / kimi / glm / ollama chat too. resolveSessionPath also
    // subsumes the existence check (null = no store holds it).
    const store = yield* Effect.promise(() => resolveSessionPath(cwd, sessionId));
    if (!store) {
      return yield* Effect.fail(
        new NotFoundError({ resource: 'session', id: sessionId })
      );
    }
    const messages = yield* Effect.tryPromise({
      try: () => parseTranscriptFile(store.sessionPath),
      catch: (cause) =>
        new AppError({ message: 'parseTranscriptFile failed', cause }),
    });
    return ok({ messages });
  })
);
