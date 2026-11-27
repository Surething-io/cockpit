/**
 * Session Bots — sessions the user ticked "can be @-mentioned" in the title dialog.
 *
 * They are listed with the Bots (the `@` menu, the Bots panel) and addressed as
 * `@<title> <task>`, which hands the task to that existing session (see the session-run
 * skill). Nothing about favorites is involved: the registry below is the only membership.
 *
 * The registry stores identity only ({ cwd, sessionId }). The NAME is the session's current
 * title, read fresh on every listing and dispatch, so a rename takes effect at once and the
 * previous spelling simply stops matching. A title that is not a valid name (multi-line,
 * contains `@`; see titleNameProblem) leaves the entry listed but not addressable.
 */
import { Effect } from 'effect';
import { FSError } from '@cockpit/effect-core';
import { SESSION_BOTS_FILE, readJsonFileForUpdate, withFileLock, writeJsonFile } from '@cockpit/shared-utils';
import { titleNameProblem, type TitleNameProblem } from '../../shared/sessionTitle';
import { mentionTitle, type MentionableSession } from '../../shared/sessionMention';
import { getSessionTitleInfo } from '../state/globalState';
import { resolveSessionPath } from '../api/session/sessionStore';

interface SessionBotRecord {
  cwd: string;
  sessionId: string;
  addedAt: string;
}

export interface SessionBotInfo {
  cwd: string;
  sessionId: string;
  addedAt: string;
  /** The session's current title. */
  title: string;
  /** The `@` name, or null when the title cannot be one (see `problem`). */
  name: string | null;
  problem: TitleNameProblem | null;
  /** The engine the session runs on; null when its transcript is gone. */
  engine: string | null;
}

const fsError = (op: 'read' | 'write') => (cause: unknown) => new FSError({ path: SESSION_BOTS_FILE, op, cause });
const same = (a: { cwd: string; sessionId: string }, cwd: string, sessionId: string) => a.cwd === cwd && a.sessionId === sessionId;

/**
 * The registry, read strictly: a missing file is empty, but a file that does not parse or
 * is not a list of records is an ERROR — never an empty list. Folding it to [] would show no
 * Bots and, worse, let the next tick write that [] back over every other membership.
 */
async function loadRegistry(): Promise<SessionBotRecord[]> {
  const data = await readJsonFileForUpdate<unknown>(SESSION_BOTS_FILE, []);
  if (!Array.isArray(data) || data.some((r) => !r || typeof r.cwd !== 'string' || typeof r.sessionId !== 'string')) {
    throw new Error(`${SESSION_BOTS_FILE} is not a list of { cwd, sessionId } records, refusing to use or overwrite it`);
  }
  return data as SessionBotRecord[];
}

const readRegistry = Effect.tryPromise({ try: loadRegistry, catch: fsError('read') });

export const isSessionBot = (cwd: string, sessionId: string): Effect.Effect<boolean, FSError> =>
  readRegistry.pipe(Effect.map((records) => records.some((r) => same(r, cwd, sessionId))));

/** Add or remove one session. Idempotent; returns whether it is a session Bot afterwards. */
export const setSessionBot = (cwd: string, sessionId: string, on: boolean): Effect.Effect<boolean, FSError> =>
  Effect.tryPromise({
    try: () => withFileLock(SESSION_BOTS_FILE, async () => {
      const records = await loadRegistry();
      const rest = records.filter((r) => !same(r, cwd, sessionId));
      const existing = records.find((r) => same(r, cwd, sessionId));
      const next = on ? [...rest, existing ?? { cwd, sessionId, addedAt: new Date().toISOString() }] : rest;
      await writeJsonFile(SESSION_BOTS_FILE, next);
      return on;
    }),
    catch: fsError('write'),
  });

export const listSessionBots: Effect.Effect<SessionBotInfo[], FSError> = Effect.gen(function* () {
  const records = yield* readRegistry;
  return yield* Effect.forEach(records, (record) => Effect.tryPromise({
    try: async (): Promise<SessionBotInfo> => {
      const [info, store] = await Promise.all([
        getSessionTitleInfo(record.cwd, record.sessionId),
        resolveSessionPath(record.cwd, record.sessionId),
      ]);
      const problem = titleNameProblem(info.title);
      return {
        ...record,
        title: info.title,
        name: problem ? null : mentionTitle(info.title),
        problem,
        engine: store?.engine ?? null,
      };
    },
    catch: fsError('read'),
  }), { concurrency: 8 });
}).pipe(Effect.withSpan('agent.sessionBots.list'));

/** Only a line that starts with `@` can address anything; skip the IO otherwise. */
export const mayMentionSession = (prompt: string): boolean => /^\s*@\S/m.test(prompt);

/** The addressable session Bots, for resolveCommandPrompt. */
export const loadMentionableSessions: Effect.Effect<MentionableSession[], FSError> = listSessionBots.pipe(
  Effect.map((bots) => bots.flatMap((b) => b.name && b.engine ? [{ cwd: b.cwd, sessionId: b.sessionId, title: b.name }] : [])),
);
