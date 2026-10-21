import { readFile } from 'fs/promises';
import { Effect } from 'effect';
import { withFileLock } from '@cockpit/shared-utils';
import { dynamicHandler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { FSError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import { beginTranscriptEdit } from '../../sessionRunHub';
import { resolveSessionPath } from './sessionStore';
import { rewriteTranscript } from '../../transcriptWrite';
import { deleteClaudeTurnLines } from './deleteTurnLines';
import { deleteCodexTurnLines } from './codexFork';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DeleteTurnRequestBody {
  cwd: string;
  messageUuid: string;
}

/** DELETE: permanently remove the question, answer and tool records in one turn. */
export const DELETE = dynamicHandler<
  { sessionId: string },
  FSError | NotFoundError | ValidationError
>((req, { sessionId }) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as DeleteTurnRequestBody;
    if (!body.cwd) {
      return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
    }
    if (!body.messageUuid) {
      return yield* Effect.fail(new ValidationError({ field: 'messageUuid', reason: 'missing' }));
    }
    const store = yield* Effect.promise(() => resolveSessionPath(body.cwd, sessionId));
    if (!store) {
      return yield* Effect.fail(new NotFoundError({ resource: 'session', id: sessionId }));
    }

    // Hold the session's writer lease for the whole read → filter → write: a turn starting
    // mid-edit would have its engine append lines that the write-back then overwrites (the
    // engine does not take our file lock).
    const endEdit = beginTranscriptEdit(sessionId);
    if (!endEdit) {
      return yield* Effect.fail(new ValidationError({ field: 'sessionId', reason: 'session is running' }));
    }

    const result = yield* Effect.tryPromise({
      try: () => withFileLock(store.sessionPath, async () => {
        const text = await readFile(store.sessionPath, 'utf-8');
        const originalLines = text.split('\n').filter((line) => line.length > 0);
        const deleted = store.engine === 'codex'
          ? deleteCodexTurnLines(originalLines, body.messageUuid)
          : deleteClaudeTurnLines(originalLines, body.messageUuid);
        if (!deleted.targetMissed) {
          await rewriteTranscript(
            store.sessionPath,
            deleted.newLines.length > 0 ? `${deleted.newLines.join('\n')}\n` : '',
          );
        }
        return deleted;
      }),
      catch: (cause) => new FSError({ path: store.sessionPath, op: 'write', cause }),
    }).pipe(Effect.ensuring(Effect.sync(endEdit)));

    if (result.targetMissed) {
      return yield* Effect.fail(new NotFoundError({ resource: 'message', id: body.messageUuid }));
    }

    return ok({ success: true, deletedLineCount: result.deletedLineCount });
  })
);
