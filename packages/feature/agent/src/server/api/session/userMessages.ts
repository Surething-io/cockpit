// Full user-message index of one session — the backing store for the chat's
// "user messages" modal.
//
// Why this is not a slice of /api/session-by-path: that route returns a paginated
// window of RENDERED messages (10 turns by default), which is exactly what the
// modal must not be limited to. Here the whole transcript is walked and only the
// human turns are returned, so the modal can list and search a session end to end
// while the chat itself stays paginated.
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import {
  AppError,
  NotFoundError,
  ValidationError,
} from '@cockpit/effect-core';
import { resolveSessionPath } from './sessionStore';
import { parseUserMessageIndex } from './transcriptParsers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface UserMessagesBody {
  cwd?: string;
  /**
   * Must be the session the client is CURRENTLY RENDERING (`loadedSessionId`),
   * not the live `sessionId` — that one is reassigned on every SDK `system.init`,
   * and an index read from a different file would hand back message ids that are
   * nowhere in the DOM. See the note in useChatHistory.ts.
   */
  sessionId?: string;
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as UserMessagesBody;
    const { cwd, sessionId } = body;
    if (!cwd || !sessionId) {
      return yield* Effect.fail(
        new ValidationError({ field: !cwd ? 'cwd' : 'sessionId', reason: 'missing' })
      );
    }

    // Same 6-engine resolution as session-by-path: the file's location is the engine.
    const resolved = yield* Effect.sync(() => resolveSessionPath(cwd, sessionId));
    if (!resolved) {
      return yield* Effect.fail(
        new NotFoundError({ resource: 'session', id: sessionId })
      );
    }
    const { sessionPath, engine } = resolved;

    const index = yield* Effect.tryPromise({
      try: () => parseUserMessageIndex(sessionPath, engine),
      catch: (cause) =>
        new AppError({ message: 'parseUserMessageIndex failed', cause }),
    });

    return ok({
      messages: index.entries,
      totalTurns: index.totalTurns,
      sessionId,
      engine,
    });
  })
);
