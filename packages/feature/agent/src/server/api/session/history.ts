import * as fs from 'fs';
import { Effect } from 'effect';
import { getClaudeSessionPath } from '@cockpit/shared-utils';
import { dynamicHandler, ok } from '@cockpit/effect-runtime/server';
import {
  AppError,
  NotFoundError,
  ValidationError,
} from '@cockpit/effect-core';
import { parseTranscriptFile } from './transcriptToMessages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = dynamicHandler<
  { sessionId: string },
  AppError | NotFoundError | ValidationError
>((_req, { sessionId }) =>
  Effect.gen(function* () {
    if (!sessionId) {
      return yield* Effect.fail(
        new ValidationError({ field: 'sessionId', reason: 'missing' })
      );
    }
    const cwd = process.cwd();
    const transcriptPath = getClaudeSessionPath(cwd, sessionId);
    if (!fs.existsSync(transcriptPath)) {
      return yield* Effect.fail(
        new NotFoundError({ resource: 'session', id: sessionId })
      );
    }
    const messages = yield* Effect.tryPromise({
      try: () => parseTranscriptFile(transcriptPath),
      catch: (cause) =>
        new AppError({ message: 'parseTranscriptFile failed', cause }),
    });
    return ok({ messages });
  })
);
