import { Effect } from 'effect';
import { FSError, ValidationError } from '@cockpit/effect-core';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { getSessionFilePath, readJsonFile } from '@cockpit/shared-utils';
import { readCachedSessionTitles } from '@cockpit/feature-agent/server/sessionTitleCache';

/** Labels and row ids are one bootstrap response, so restoring rows needs no title round trip. */
export const GET = handler((req) => Effect.gen(function* () {
  const cwd = new URL(req.url).searchParams.get('cwd');
  if (!cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'missing' }));
  const path = getSessionFilePath(cwd);
  const state = yield* Effect.tryPromise({
    try: () => readJsonFile<{ sessions: string[] }>(path, { sessions: [] }),
    catch: (cause) => new FSError({ path, op: 'read', cause }),
  });
  const sessionTitles = yield* readCachedSessionTitles(cwd, state.sessions).pipe(
    Effect.catchAll((error) => Effect.logWarning('Cannot read cached project titles', error).pipe(Effect.as([]))),
  );
  return ok({ ...state, sessionTitles });
}));
