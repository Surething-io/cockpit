// Effect boundary for Pi's native session storage and model selection.
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { legacyPiEntryId, legacyPiSnapshot } from './piSessionIdentity';
import { join, resolve } from 'node:path';
import { Effect } from 'effect';
import type { SessionManager, SessionEntry } from '@earendil-works/pi-coding-agent';
import { AppError } from '@cockpit/effect-core';
import { getPiSessionsDir, isPiEngine, PI_SESSIONS_DIR, type PiEngine } from '@cockpit/shared-utils';
import { piBranchMessages } from '../server/engines/piEvents';

type ReadOnlyPiManager = Pick<SessionManager, 'getSessionId' | 'getCwd' | 'getBranch' | 'getSessionName'>;

/** SDK migrations run in memory: opening a native file would migrate or repair it on disk. */
export const readPiEntries = (path: string) => Effect.tryPromise({
  try: async () => {
    const { parseSessionEntries, migrateSessionEntries } = await import('@earendil-works/pi-coding-agent');
    const entries = parseSessionEntries(await readFile(path, 'utf8')).filter((entry) => entry && typeof entry === 'object');
    const header = entries[0];
    if (header?.type !== 'session' || typeof header.id !== 'string' || typeof header.cwd !== 'string') throw new Error('Invalid Pi session header');
    const legacyIds = (header.version ?? 1) < 2;
    migrateSessionEntries(entries);
    if (legacyIds) {
      // v1 has no entry IDs. SDK migration generates random ones; make that
      // in-memory mapping stable across reads without persisting a migration.
      const nativeEntries = entries.filter((entry) => entry.type !== 'session');
      const snapshot = legacyPiSnapshot(header.id, nativeEntries);
      const ids = new Map(nativeEntries.map((entry, i) =>
        [entry.id, legacyPiEntryId(header.id, i, entry, snapshot)],
      ));
      for (const entry of entries) {
        if (entry.type === 'session') continue;
        entry.id = ids.get(entry.id)!;
        entry.parentId = entry.parentId === null ? null : ids.get(entry.parentId) ?? entry.parentId;
        if (entry.type === 'compaction') entry.firstKeptEntryId = ids.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId;
      }
    }
    return { entries, header, legacyIds };
  },
  catch: (cause) => new AppError({ message: `Cannot read Pi session ${path}`, cause }),
});

/** Construct a read-only view without persisting the normalized entries. */
export const readPiManager = (path: string): Effect.Effect<ReadOnlyPiManager, AppError> => readPiEntries(path).pipe(
  Effect.flatMap(({ entries, header }) => Effect.tryPromise({
    try: async () => {
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      return SessionManager.inMemory(header.cwd, undefined, entries);
    },
    catch: (cause) => new AppError({ message: `Cannot load Pi session ${path}`, cause }),
  })),
);

export interface PiSessionFile {
  id: string;
  path: string;
  cwd: string;
  engine: PiEngine;
  model?: string;
  modifiedAt: number;
}

/** Read the latest provider selection from the native branch. */
export function piSelection(entries: SessionEntry[]): { engine: PiEngine; model?: string } {
  for (const entry of entries.toReversed()) {
    if (entry.type === 'model_change' && isPiEngine(entry.provider)) return { engine: entry.provider, model: entry.modelId };
    if (entry.type === 'message' && entry.message.role === 'assistant' && isPiEngine(entry.message.provider)) return { engine: entry.message.provider, model: entry.message.model };
  }
  return { engine: 'ollama' };
}

/** Read one native session, including the selected provider on its active branch. */
const describePiSession = (path: string): Effect.Effect<PiSessionFile, AppError> => Effect.gen(function* () {
  const manager = yield* readPiManager(path);
  const modifiedAt = yield* Effect.tryPromise({ try: async () => (await stat(path)).mtimeMs, catch: (cause) => new AppError({ message: `Cannot stat Pi session ${path}`, cause }) });
  return { id: manager.getSessionId(), path, cwd: manager.getCwd(), ...piSelection(manager.getBranch()), modifiedAt };
});

/** Strict path inventory: only a confirmed missing directory is empty. */
const piSessionPaths = (cwd?: string): Effect.Effect<string[], AppError> => Effect.tryPromise({
  try: async () => {
    const readDir = (dir: string) => readdir(dir, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => { if (cause.code === 'ENOENT') return []; throw cause; });
    const dirs = cwd ? [getPiSessionsDir(cwd)] : (await readDir(PI_SESSIONS_DIR)).filter((entry) => entry.isDirectory()).map((entry) => join(PI_SESSIONS_DIR, entry.name));
    const paths: string[] = [];
    for (const dir of dirs) for (const file of await readDir(dir)) if (file.isFile() && file.name.endsWith('.jsonl')) paths.push(join(dir, file.name));
    return paths;
  },
  catch: (cause) => new AppError({ message: 'Cannot list Pi sessions', cause }),
});
const missingPiFile = (error: AppError) => (error.cause as NodeJS.ErrnoException)?.code === 'ENOENT';

/** A failed file read is an incomplete inventory, not an absent session. */
export const listPiSessions = (cwd?: string): Effect.Effect<PiSessionFile[], AppError> => piSessionPaths(cwd).pipe(
  Effect.flatMap((paths) => Effect.forEach(paths, (path) => describePiSession(path).pipe(
    Effect.map((session) => !cwd || session.cwd === resolve(cwd) ? [session] : []),
    Effect.catchAll((error) => missingPiFile(error) ? Effect.succeed([] as PiSessionFile[]) : Effect.fail(error)),
  ), { concurrency: 8 })),
  Effect.map((sessions) => sessions.flat()),
);

/** Read only the header for lookup; SDK findById suppresses permission and IO failures. */
const readPiHeader = (path: string) => Effect.tryPromise({
  try: async () => {
    const { parseSessionEntries } = await import('@earendil-works/pi-coding-agent');
    const handle = await open(path, 'r');
    try {
      let pending = Buffer.alloc(0);
      const chunk = Buffer.alloc(4096);
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
        for (;;) {
          const end = pending.indexOf(10);
          if (end < 0 && bytesRead > 0) break;
          const text = (end < 0 ? pending : pending.subarray(0, end)).toString('utf8');
          pending = end < 0 ? Buffer.alloc(0) : pending.subarray(end + 1);
          const entry = parseSessionEntries(text).find((value) => value && typeof value === 'object');
          if (entry) {
            if (entry.type !== 'session' || typeof entry.id !== 'string' || typeof entry.cwd !== 'string') throw new Error('Invalid Pi session header');
            return entry;
          }
          if (end < 0) throw new Error('Missing Pi session header');
        }
      }
    } finally { await handle.close(); }
  },
  catch: (cause) => new AppError({ message: `Cannot discover Pi session ${path}`, cause }),
});

/** Native header lookup remains strict without loading every session's message branch. */
export const findPiSession = (cwd: string, id: string): Effect.Effect<PiSessionFile | undefined, AppError> => Effect.gen(function* () {
  for (const path of yield* piSessionPaths(cwd)) {
    const header = yield* readPiHeader(path).pipe(Effect.catchAll((error) => missingPiFile(error) ? Effect.succeed(undefined) : Effect.fail(error)));
    if (header?.id !== id || resolve(header.cwd) !== resolve(cwd)) continue;
    return yield* describePiSession(path).pipe(Effect.catchAll((error) => missingPiFile(error) ? Effect.succeed(undefined) : Effect.fail(error)));
  }
  return undefined;
});

export interface PiSessionView {
  manager: ReadOnlyPiManager;
  entries: SessionEntry[];
  messages: ReturnType<typeof piBranchMessages>;
  name?: string;
}

/** Read the active native branch for chat display, leaving compaction to Pi. */
export const readPiSession = (path: string): Effect.Effect<PiSessionView, AppError> => readPiManager(path).pipe(Effect.map((manager) => {
  const entries = manager.getBranch();
  return { manager, entries, messages: piBranchMessages(entries, manager.getCwd()), name: manager.getSessionName() };
}));

/** Promise bridge for the existing engine preflight contract. */
export const readPiModel = (cwd: string | undefined, id: string | undefined, engine: string): Promise<string | undefined> =>
  !cwd || !id ? Promise.resolve(undefined) : Effect.runPromise(findPiSession(cwd, id).pipe(Effect.map((s) => s?.engine === engine ? s.model : undefined)));
