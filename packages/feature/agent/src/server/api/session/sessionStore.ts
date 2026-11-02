import { Effect } from 'effect';
import { findPiSession } from '../../../effect/piSessionLive';
import { access } from 'fs/promises';
import { join } from 'path';
import {
  CODEX_SESSIONS_DIR,
  getClaudeSessionPath,
} from '@cockpit/shared-utils';
import { findCodexSession } from '../../../effect/transcriptIndexLive';

export type SessionEngine =
  | 'claude'
  | 'codex'
  | 'kimi'
  | 'ollama'
  | 'deepseek'
  | 'glm';

export interface SessionStore {
  sessionPath: string;
  engine: SessionEngine;
}

/** Resolve native Claude, Codex or Pi storage; Pi provider selection comes from its branch. */
export async function resolveSessionPath(
  cwd: string,
  sessionId: string
): Promise<SessionStore | null> {
  const exists = (p: string) => access(p).then(() => true, () => false);
  // Probe order is the precedence order when a session id exists in more than one store.
  const probes: Array<[SessionEngine, () => Promise<string | null>]> = [
    ['claude', async () => getClaudeSessionPath(cwd, sessionId)],
    ['codex', async () => (await findCodexSession(sessionId))?.path ?? null],
  ];
  for (const [engine, locate] of probes) {
    const sessionPath = await locate();
    if (sessionPath && (engine === 'codex' || (await exists(sessionPath)))) return { sessionPath, engine };
  }
  const pi = await Effect.runPromise(findPiSession(cwd, sessionId));
  return pi ? { sessionPath: pi.path, engine: pi.engine } : null;
}

/**
 * Engines whose store we may CREATE a session in, not merely read from.
 *
 * Stores we may CREATE a session in, not merely read from. Codex is included: an
 * isolated CODEX_HOME probe against codex-cli 0.141.0 confirmed that `resume <id>` accepts
 * a rollout copied to the normal dated path with `session_meta.payload.id` rewritten.
 */
export function isForkableStore(store: SessionStore): boolean {
  return !!store.engine;
}

/**
 * Path for a NEW session placed in the same store as `store`.
 */
export function newSessionPathInStore(
  store: SessionStore,
  cwd: string,
  newSessionId: string
): string | null {
  switch (store.engine) {
    case 'claude':
      return getClaudeSessionPath(cwd, newSessionId);
    case 'codex': {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const yyyy = String(now.getFullYear());
      const mm = pad(now.getMonth() + 1);
      const dd = pad(now.getDate());
      const stamp = `${yyyy}-${mm}-${dd}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
      return join(CODEX_SESSIONS_DIR, yyyy, mm, dd, `rollout-${stamp}-${newSessionId}.jsonl`);
    }
    default:
      return null;
  }
}
