import { Effect } from 'effect';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  COCKPIT_PROJECTS_DIR, PINNED_SESSIONS_FILE, encodePath,
  normalizeCodexSessionId, withFileLock, writeJsonFile,
} from '@cockpit/shared-utils';
import { FSError, ValidationError } from '@cockpit/effect-core';
import { normalizeSessionTitle, type SessionTitleInfo } from '../shared/sessionTitle';

type TitleRecord = { customTitle: string | null; defaultTitle?: string; revision: number };
export interface TitleFile {
  version: 1;
  records: Record<string, TitleRecord>;
  /** Snapshot preserves legacy names, including sessions whose native file is gone. */
  legacyFavorites?: Array<{ cwd: string; sessionId: string; customTitle?: string }>;
}

export const titleStore = (engine?: string) => engine === 'codex' || engine === 'grok' || engine === 'claude'
  ? engine : 'pi';
const idOf = (id: string, store: string) => store === 'codex' ? normalizeCodexSessionId(id) : id;
const keyOf = (cwd: string, id: string, store: string) => JSON.stringify([cwd, store, idOf(id, store)]);
export const sessionTitlesPath = (encodedProject: string) => join(COCKPIT_PROJECTS_DIR, encodedProject, 'session-titles.json');

/** Missing is empty; malformed or inaccessible data must never become an empty overwrite. */
async function readOptional<T>(path: string, empty: T): Promise<T> {
  return readFile(path, 'utf8').then((text) => JSON.parse(text) as T, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return empty;
    throw error;
  });
}

export const readProjectTitles = (encodedProject: string): Effect.Effect<TitleFile, FSError> => {
  const path = sessionTitlesPath(encodedProject);
  return Effect.tryPromise({
    try: () => withFileLock(path, async () => {
      const existing = await readOptional<TitleFile | undefined>(path, undefined);
      if (existing !== undefined) {
        if (!existing || existing.version !== 1 || !existing.records || Array.isArray(existing.records)
          || typeof existing.records !== 'object'
          || Object.values(existing.records).some((record) => !record || !Number.isSafeInteger(record.revision) || record.revision < 1 || (record.customTitle !== null && typeof record.customTitle !== 'string')
            || (record.defaultTitle !== undefined && (typeof record.defaultTitle !== 'string' || !record.defaultTitle.trim() || record.defaultTitle === 'Untitled Session')))
          || (existing.legacyFavorites !== undefined && (!Array.isArray(existing.legacyFavorites) || existing.legacyFavorites.some((p) => !p || typeof p.cwd !== 'string' || typeof p.sessionId !== 'string' || (p.customTitle !== undefined && typeof p.customTitle !== 'string'))))) {
          throw new Error('Invalid session title metadata');
        }
        return existing;
      }
      const favorites = await readOptional<NonNullable<TitleFile['legacyFavorites']>>(PINNED_SESSIONS_FILE, []);
      const legacyFavorites = favorites.filter((p) => encodePath(p.cwd) === encodedProject && p.customTitle?.trim());
      const initial: TitleFile = { version: 1, records: {}, legacyFavorites };
      // Migration captures the legacy data once. Explicit clears subsequently win.
      if (legacyFavorites.length) await writeJsonFile(path, initial);
      return initial;
    }),
    catch: (cause) => new FSError({ path, op: 'read', cause }),
  });
};

export function titleFromProject(data: TitleFile, sessionId: string, defaultTitle: string, store: string, cwd?: string | null): SessionTitleInfo {
  // An encoded-directory list may have no cwd in a legacy transcript. Only use
  // an unambiguous match; encoding can map distinct project paths to one folder.
  const suffix = `,${JSON.stringify(store)},${JSON.stringify(idOf(sessionId, store))}]`;
  const candidates = cwd ? [] : Object.entries(data.records).filter(([key]) => key.endsWith(suffix));
  const record = cwd ? data.records[keyOf(cwd, sessionId, store)] : candidates.length === 1 ? candidates[0][1] : undefined;
  const legacy = data.legacyFavorites?.find((p) => (!cwd || p.cwd === cwd) && idOf(p.sessionId, store) === idOf(sessionId, store));
  const customTitle = record ? record.customTitle : legacy?.customTitle ? normalizeSessionTitle(legacy.customTitle) : null;
  defaultTitle = record?.defaultTitle ?? defaultTitle;
  return { title: customTitle ?? defaultTitle, defaultTitle, customTitle, titleRevision: record?.revision ?? 0 };
}

/** Bootstrap reads only metadata; ambiguous store identities wait for the live refresh. */
export function cachedSessionTitle(data: TitleFile, cwd: string, sessionId: string): SessionTitleInfo | undefined {
  const stores = ['claude', 'codex', 'grok', 'pi'].filter((store) => data.records[keyOf(cwd, sessionId, store)]);
  if (stores.length !== 1) return undefined;
  const info = titleFromProject(data, sessionId, 'Untitled Session', stores[0], cwd);
  return info.customTitle !== null || info.defaultTitle !== 'Untitled Session' ? info : undefined;
}

/** Compute outside the metadata lock so cached reads never wait for transcript IO. */
export const refreshSessionTitle = <E, R>(
  cwd: string, sessionId: string, store: string, load: Effect.Effect<string, E, R>,
) => Effect.gen(function* () {
  const encoded = encodePath(cwd);
  const before = yield* readProjectTitles(encoded);
  const key = keyOf(cwd, sessionId, store);
  const revision = before.records[key]?.revision ?? 0;
  const fallback = yield* load;
  const path = sessionTitlesPath(encoded);
  return yield* Effect.tryPromise({
    try: () => withFileLock(path, async () => {
      const data = await readOptional<TitleFile>(path, { version: 1, records: {} });
      const current = data.records[key];
      const info = titleFromProject(data, sessionId, fallback, store, cwd);
      // A later refresh or rename owns the newer revision. Never roll it back.
      if ((current?.revision ?? 0) !== revision || !fallback.trim() || fallback === 'Untitled Session'
        || current?.defaultTitle === fallback) return { info, changed: false };
      const record: TitleRecord = { ...current, customTitle: info.customTitle, defaultTitle: fallback, revision: revision + 1 };
      const next: TitleFile = { ...data, records: { ...data.records, [key]: record } };
      await writeJsonFile(path, next);
      return { info: titleFromProject(next, sessionId, fallback, store, cwd), changed: true };
    }),
    catch: (cause) => new FSError({ path, op: 'write', cause }),
  });
});

export const readSessionTitle = (cwd: string, sessionId: string, defaultTitle: string, store: string) =>
  readProjectTitles(encodePath(cwd)).pipe(Effect.map((data) => titleFromProject(data, sessionId, defaultTitle, store, cwd)));

export const writeSessionTitle = (
  cwd: string, sessionId: string, store: string, value: unknown,
): Effect.Effect<TitleRecord, FSError | ValidationError> => Effect.gen(function* () {
  if (value !== null && typeof value !== 'string') {
    return yield* Effect.fail(new ValidationError({ field: 'customTitle', reason: 'must be a string or null' }));
  }
  const customTitle = value === null ? null : normalizeSessionTitle(value as string);
  if (customTitle === '') return yield* Effect.fail(new ValidationError({ field: 'customTitle', reason: 'must not be empty' }));
  const encoded = encodePath(cwd);
  yield* readProjectTitles(encoded);
  const path = sessionTitlesPath(encoded);
  return yield* Effect.tryPromise({
    try: () => withFileLock(path, async () => {
      const data = await readOptional<TitleFile>(path, { version: 1, records: {} });
      const key = keyOf(cwd, sessionId, store);
      const record = { ...data.records[key], customTitle, revision: (data.records[key]?.revision ?? 0) + 1 };
      await writeJsonFile(path, { ...data, records: { ...data.records, [key]: record } });
      return record;
    }),
    catch: (cause) => new FSError({ path, op: 'write', cause }),
  });
});
