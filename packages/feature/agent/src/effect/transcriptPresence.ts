import { stat } from 'node:fs/promises';
import { Effect, Either } from 'effect';
import { FSError } from '@cockpit/effect-core';
import { transcriptStashPath } from '../server/transcriptLayout';
import { transcriptGeneration } from '../server/transcriptRevision';

export type FileIdentity = { ino: number; size: number; mtimeMs: number };
export interface TranscriptLayout {
  current: FileIdentity | null;
  history: FileIdentity | null;
  generation: number;
}
export const identifyTranscriptFile = (path: string): Effect.Effect<FileIdentity | null, FSError> => Effect.tryPromise({
  try: () => stat(path).then((s) => ({ ino: s.ino, size: s.size, mtimeMs: s.mtimeMs }), (cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  }),
  catch: (cause) => new FSError({ path, op: 'stat', cause }),
});
export const sameTranscriptFile = (a: FileIdentity | null, b: FileIdentity | null, allowAppend = false): boolean =>
  a === null || b === null ? a === b : a.ino === b.ino && (
    a.size === b.size && a.mtimeMs === b.mtimeMs || allowAppend && b.size > a.size
  );

/** A bounded topology read shared by path resolution, catalogs and full transcript readers. */
export const withTranscriptLayout = <A, E, R>(path: string, engine: string,
  read: (layout: TranscriptLayout) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | FSError, R> => Effect.gen(function* () {
  const stash = transcriptStashPath(path, engine);
  const probe = (): Effect.Effect<TranscriptLayout, FSError> => Effect.gen(function* () {
    const generation = transcriptGeneration(path);
    const current = yield* identifyTranscriptFile(path);
    const history = stash ? yield* identifyTranscriptFile(stash) : null;
    return { current, history, generation };
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = yield* probe();
    if (before.generation !== transcriptGeneration(path)) continue;
    const result = yield* Effect.either(read(before));
    const after = yield* probe();
    if (before.generation !== transcriptGeneration(path) || after.generation !== before.generation
      || !sameTranscriptFile(before.history, after.history) || !sameTranscriptFile(before.current, after.current, true)) continue;
    if (Either.isLeft(result)) return yield* Effect.fail(result.left);
    return result.right;
  }
  return yield* Effect.fail(new FSError({ path, op: 'read', cause: new Error('Transcript layout changed repeatedly') }));
});

export const transcriptExists = (path: string, engine: string): Effect.Effect<boolean, FSError> =>
  withTranscriptLayout(path, engine, (layout) => Effect.succeed(Boolean(layout.current || layout.history)));
