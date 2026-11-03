import { appendFile, mkdir, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import { FSError } from '@cockpit/effect-core';
import { GROK_SESSIONS_DIR, encodePath } from '@cockpit/shared-utils';
import { object, type AcpObject } from '../server/engines/grokAcp/client';

export function grokSessionPath(cwd: string, sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid Grok session id');
  return join(GROK_SESSIONS_DIR, encodePath(cwd), `${sessionId}.jsonl`);
}

export function appendGrokTranscript(cwd: string, sessionId: string, entry: AcpObject): Effect.Effect<void, FSError> {
  return Effect.tryPromise({
    try: async () => {
      const dir = join(GROK_SESSIONS_DIR, encodePath(cwd));
      await mkdir(dir, { recursive: true });
      await appendFile(grokSessionPath(cwd, sessionId), `${JSON.stringify({
        ...entry, uuid: randomUUID(), sessionId, cwd, timestamp: new Date().toISOString(),
      })}\n`, { mode: 0o600 });
    },
    catch: (cause) => new FSError({ path: GROK_SESSIONS_DIR, op: 'write', cause }),
  });
}

interface GrokProject { encodedPath: string; cwd: string; count: number }

const describeProject = (encodedPath: string): Effect.Effect<GrokProject[], FSError> => Effect.gen(function* () {
  const dir = join(GROK_SESSIONS_DIR, encodedPath);
  const files = yield* Effect.tryPromise({
    try: async () => (await readdir(dir)).filter((file) => file.endsWith('.jsonl')),
    catch: (cause) => new FSError({ path: dir, op: 'read', cause }),
  });
  if (!files.length) return [];
  const filePath = join(dir, files[0]);
  const first = yield* Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => open(filePath, 'r'), catch: (cause) => new FSError({ path: filePath, op: 'read', cause }) }),
    (file) => Effect.tryPromise({
      try: async () => {
        const buffer = Buffer.alloc(8192);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return object(JSON.parse(buffer.toString('utf8', 0, bytesRead).split('\n')[0])).cwd;
      },
      catch: (cause) => new FSError({ path: filePath, op: 'read', cause }),
    }),
    (file) => Effect.promise(() => file.close()),
  );
  return typeof first === 'string' ? [{ encodedPath, cwd: first, count: files.length }] : [];
});

export const listGrokProjects: Effect.Effect<GrokProject[], FSError> = Effect.gen(function* () {
  const dirs = yield* Effect.tryPromise({
    try: () => readdir(GROK_SESSIONS_DIR, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return [];
      throw cause;
    }),
    catch: (cause) => new FSError({ path: GROK_SESSIONS_DIR, op: 'read', cause }),
  });
  const projects = yield* Effect.forEach(dirs.filter((dir) => dir.isDirectory()),
    (dir) => describeProject(dir.name).pipe(Effect.catchAll((error) =>
      Effect.logWarning('Cannot read Grok project header', error).pipe(Effect.as([] as GrokProject[])))),
    { concurrency: 8 },
  );
  return projects.flat();
});
