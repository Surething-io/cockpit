import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import { rewriteTranscript } from '../server/transcriptWrite';
import { readPiEntries } from './piSessionLive';

/** Caller owns the session writer lease before any read, migration or SDK open. */
export const openPiSessionForWrite = (path: string) => Effect.gen(function* () {
  const { entries, legacyIds } = yield* readPiEntries(path);
  return yield* Effect.tryPromise({
    try: async () => {
      if (legacyIds) await rewriteTranscript(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      return SessionManager.open(path);
    },
    catch: (cause) => new AppError({ message: `Cannot open Pi session for writing ${path}`, cause }),
  });
});
