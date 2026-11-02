// Effect boundary for Pi's native session storage and model selection.
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Effect } from 'effect';
import type { SessionManager, SessionEntry } from '@earendil-works/pi-coding-agent';
import { AppError } from '@cockpit/effect-core';
import { getPiSessionsDir, isPiEngine, PI_SESSIONS_DIR, type PiEngine } from '@cockpit/shared-utils';
import { piBranchMessages } from '../server/engines/piEvents';

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
const describePiSession = (path: string): Effect.Effect<PiSessionFile, AppError> => Effect.tryPromise({
  try: async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(path);
    return { id: manager.getSessionId(), path, cwd: manager.getCwd(), ...piSelection(manager.getBranch()), modifiedAt: (await stat(path)).mtimeMs };
  },
  catch: (cause) => new AppError({ message: `Cannot read Pi session ${path}`, cause }),
});

/** List native sessions; an unreadable file must not hide unrelated sessions. */
export const listPiSessions = (cwd?: string): Effect.Effect<PiSessionFile[], AppError> =>
  Effect.tryPromise({
    try: async () => {
      const readDir = (dir: string) => readdir(dir, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => { if (cause.code === 'ENOENT') return []; throw cause; });
      const dirs = cwd ? [getPiSessionsDir(cwd)] : (await readDir(PI_SESSIONS_DIR)).filter((d) => d.isDirectory()).map((d) => join(PI_SESSIONS_DIR, d.name));
      const paths: string[] = [];
      for (const dir of dirs) {
        for (const file of await readDir(dir)) if (file.isFile() && file.name.endsWith('.jsonl')) paths.push(join(dir, file.name));
      }
      return paths;
    },
    catch: (cause) => new AppError({ message: 'Cannot list Pi sessions', cause }),
  }).pipe(
    Effect.flatMap((paths) => Effect.forEach(paths, (path) => describePiSession(path).pipe(
      Effect.map((session) => !cwd || session.cwd === resolve(cwd) ? [session] : []),
      Effect.catchAll((error) => Effect.logWarning(error.message, error.cause).pipe(Effect.as([] as PiSessionFile[]))),
    ), { concurrency: 8 })),
    Effect.map((sessions) => sessions.flat()),
  );

/** Resolve a session in this project without probing any legacy stores. */
export const findPiSession = (cwd: string, id: string): Effect.Effect<PiSessionFile | undefined, AppError> =>
  Effect.tryPromise({
    try: async () => (await import('@earendil-works/pi-coding-agent')).SessionManager.findById(cwd, id, getPiSessionsDir(cwd)),
    catch: (cause) => new AppError({ message: 'Cannot resolve Pi session', cause }),
  }).pipe(Effect.flatMap((path) => path ? describePiSession(path) : Effect.succeed(undefined)));

export interface PiSessionView {
  manager: SessionManager;
  entries: SessionEntry[];
  messages: ReturnType<typeof piBranchMessages>;
  name?: string;
}

/** Read the active native branch for chat display, leaving compaction to Pi. */
export const readPiSession = (path: string): Effect.Effect<PiSessionView, AppError> => Effect.tryPromise({
  try: async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(path);
    const entries = manager.getBranch();
    return { manager, entries, messages: piBranchMessages(entries, manager.getCwd()), name: manager.getSessionName() };
  },
  catch: (cause) => new AppError({ message: 'Cannot read Pi session', cause }),
});

/** Promise bridge for the existing engine preflight contract. */
export const readPiModel = (cwd: string | undefined, id: string | undefined, engine: string): Promise<string | undefined> =>
  !cwd || !id ? Promise.resolve(undefined) : Effect.runPromise(findPiSession(cwd, id).pipe(Effect.map((s) => s?.engine === engine ? s.model : undefined)));
