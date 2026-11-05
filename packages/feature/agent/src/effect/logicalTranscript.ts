import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { FSError } from '@cockpit/effect-core';
import type { TranscriptSnapshot } from '@cockpit/effect-services';
import type { TranscriptSource } from '../server/transcriptSource';
import { transcriptFormat, transcriptStashPath } from '../server/transcriptLayout';
import { spliceClaudeTranscript, spliceCodexTranscript } from '../server/transcriptSplice';
import { transcriptSnapshot } from './transcriptIndexLive';
import { transcriptGeneration } from '../server/transcriptRevision';
import { identifyTranscriptFile as identify, sameTranscriptFile as same, withTranscriptLayout, type FileIdentity } from './transcriptPresence';

export type LogicalTranscriptProjection = Pick<TranscriptSnapshot, 'format' | 'engine' | 'aiTitle' | 'summary' | 'cwd' | 'userTurns' | 'corpus'>;
/** No file bytes are read until the caller requests a projection or parser source. */
export interface LogicalTranscriptReader {
  readonly fingerprint: string;
  readonly mtimeMs: number;
  readonly projection: Effect.Effect<LogicalTranscriptProjection, FSError>;
  readonly source: Effect.Effect<TranscriptSource, FSError>;
}

/** Include Claude sessions whose current file is temporarily absent during an independent task. */
export const listLogicalTranscriptFiles = (dir: string, engine: string): Effect.Effect<string[], FSError> => Effect.gen(function* () {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = yield* identify(dir);
    if (!before) return [];
    const entries = yield* Effect.tryPromise({
      try: () => readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }),
      catch: (cause) => new FSError({ path: dir, op: 'read', cause }),
    });
    const names = new Set(entries.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')).map((entry) => entry.name));
    let changed = false;
    if (engine === 'claude') {
      yield* Effect.forEach(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('agent-')), (entry) => Effect.gen(function* () {
        const name = `${entry.name}.jsonl`;
        const path = join(dir, name);
        const generation = transcriptGeneration(path);
        const stash = transcriptStashPath(path, engine)!;
        const history = yield* identify(stash);
        // Recovery can move the stash back after readdir. Probe the current
        // path too; absence of the stash alone does not mean session deletion.
        const current = yield* identify(path);
        if (history || current) names.add(name);
        if (generation !== transcriptGeneration(path)) changed = true;
      }), { concurrency: 4 });
    }
    if (!changed && same(before, yield* identify(dir))) return [...names];
  }
  return yield* Effect.fail(new FSError({ path: dir, op: 'read', cause: new Error('Session discovery changed repeatedly') }));
});

/** One read transaction over the logical conversation. Retries topology changes, never ordinary appends. */
export const readLogicalTranscript = <A, E, R>(
  path: string, engine: string, read: (reader: LogicalTranscriptReader) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | FSError, R> => withTranscriptLayout(path, engine, (before) => Effect.gen(function* () {
    const format = transcriptFormat(engine);
    const stash = transcriptStashPath(path, engine);
    const unavailable = () => new FSError({ path, op: 'read', cause: new Error('Logical transcript changed during read') });
    if (!before.current && !before.history) return yield* Effect.fail(new FSError({ path, op: 'read', cause: new Error('Transcript not found') }));
    const snapshot = (file: string, expected: FileIdentity | null) => expected
      ? transcriptSnapshot(file, format).pipe(Effect.flatMap((value) => value ? Effect.succeed(value) : Effect.fail(unavailable())))
      : Effect.succeed(null);
    const projection = Effect.gen(function* () {
      const current = yield* snapshot(path, before.current);
      const history = stash ? yield* snapshot(stash, before.history) : null;
      const base = current ?? history;
      if (!base) return yield* Effect.fail(unavailable());
      return {
        format, engine: base.engine ?? engine,
        aiTitle: current?.aiTitle || history?.aiTitle || '',
        summary: current?.summary || history?.summary || '',
        cwd: history?.cwd ?? current?.cwd ?? null,
        userTurns: [...(history?.userTurns ?? []), ...(current?.userTurns ?? [])],
        corpus: [...(history?.corpus ?? []), ...(current?.corpus ?? [])],
      } satisfies LogicalTranscriptProjection;
    });
    const source = before.history && stash ? Effect.tryPromise({
      try: async () => {
        const turn = before.current ? await readFile(path, 'utf8') : '';
        const history = await readFile(stash, 'utf8');
        const lines = (text: string) => text.split('\n').filter((line) => line.trim());
        return { text: (engine === 'codex' ? spliceCodexTranscript(lines(history), lines(turn)) : spliceClaudeTranscript(lines(history), lines(turn), path)).join('\n') + '\n' };
      },
      catch: (cause) => new FSError({ path, op: 'read', cause }),
    }) : Effect.succeed(path);
    const reader: LogicalTranscriptReader = {
      fingerprint: `logical-v2:${engine}:${JSON.stringify([before.history, before.current])}`,
      mtimeMs: Math.max(before.history?.mtimeMs ?? 0, before.current?.mtimeMs ?? 0),
      projection, source,
    };
    return yield* read(reader);
})).pipe(Effect.withSpan('logicalTranscript.read', { attributes: { engine } }));
