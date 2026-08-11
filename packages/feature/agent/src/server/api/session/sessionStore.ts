import * as fs from 'fs';
import { join } from 'path';
import {
  CODEX_SESSIONS_DIR,
  getClaudeSessionPath,
  getDeepseekSessionPath,
  getDeepseekBuiltinSessionPath,
  getKimiSessionPath,
  getKimiBuiltinSessionPath,
  getGlmSessionPath,
  getGlmBuiltinSessionPath,
  getOllamaSessionPath,
  findCodexSessionPath,
} from '@cockpit/shared-utils';

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
  mode?: 'sdk' | 'builtin';
}

/**
 * Where a session lives IS what it ran as — the transcript files carry no engine field, so
 * the store that holds one is the only authority. Engine and execution mode are TWO
 * dimensions and only the store can separate them: deepseek's, kimi's and glm's SDK and
 * Built-in Agent modes write to different roots, so `mode` is authoritative for those and
 * MUST be reported alongside the engine (collapsing them to `engine: 'deepseek'` alone loses
 * the half that decides which loop resumes the session).
 *
 * `mode` is deliberately absent where the store cannot prove it: claude writes the
 * same directory whether it ran through the SDK or the PTY, so guessing there would
 * replace one wrong answer with another. Absent means "unknown, keep what the tab had".
 */
export function resolveSessionPath(
  cwd: string,
  sessionId: string
): SessionStore | null {
  const sessionPath = getClaudeSessionPath(cwd, sessionId);
  if (fs.existsSync(sessionPath)) {
    return { sessionPath, engine: 'claude' };
  }
  const deepseekPath = getDeepseekSessionPath(cwd, sessionId);
  if (fs.existsSync(deepseekPath)) {
    return { sessionPath: deepseekPath, engine: 'deepseek', mode: 'sdk' };
  }
  // Same engine, other execution mode: sessions run through the Built-in Agent live in
  // their own store, so both have to be probed before we conclude "not a deepseek session".
  const deepseekBuiltinPath = getDeepseekBuiltinSessionPath(cwd, sessionId);
  if (fs.existsSync(deepseekBuiltinPath)) {
    return {
      sessionPath: deepseekBuiltinPath,
      engine: 'deepseek',
      mode: 'builtin',
    };
  }
  // Kimi is structurally identical to deepseek: same two stores, same mode split.
  const kimiPath = getKimiSessionPath(cwd, sessionId);
  if (fs.existsSync(kimiPath)) {
    return { sessionPath: kimiPath, engine: 'kimi', mode: 'sdk' };
  }
  const kimiBuiltinPath = getKimiBuiltinSessionPath(cwd, sessionId);
  if (fs.existsSync(kimiBuiltinPath)) {
    return { sessionPath: kimiBuiltinPath, engine: 'kimi', mode: 'builtin' };
  }
  // GLM likewise: an SDK store and a Built-in Agent store, split by execution mode.
  const glmPath = getGlmSessionPath(cwd, sessionId);
  if (fs.existsSync(glmPath)) {
    return { sessionPath: glmPath, engine: 'glm', mode: 'sdk' };
  }
  const glmBuiltinPath = getGlmBuiltinSessionPath(cwd, sessionId);
  if (fs.existsSync(glmBuiltinPath)) {
    return { sessionPath: glmBuiltinPath, engine: 'glm', mode: 'builtin' };
  }
  const codexPath = findCodexSessionPath(sessionId);
  if (codexPath) {
    return { sessionPath: codexPath, engine: 'codex' };
  }
  const ollamaPath = getOllamaSessionPath(cwd, sessionId);
  if (fs.existsSync(ollamaPath)) {
    return { sessionPath: ollamaPath, engine: 'ollama' };
  }
  return null;
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
    case 'deepseek':
      return store.mode === 'builtin'
        ? getDeepseekBuiltinSessionPath(cwd, newSessionId)
        : getDeepseekSessionPath(cwd, newSessionId);
    case 'kimi':
      return store.mode === 'builtin'
        ? getKimiBuiltinSessionPath(cwd, newSessionId)
        : getKimiSessionPath(cwd, newSessionId);
    case 'glm':
      return store.mode === 'builtin'
        ? getGlmBuiltinSessionPath(cwd, newSessionId)
        : getGlmSessionPath(cwd, newSessionId);
    case 'ollama':
      return getOllamaSessionPath(cwd, newSessionId);
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
