import * as fs from 'fs';
import {
  getClaudeSessionPath,
  getClaude2SessionPath,
  getDeepseekSessionPath,
  getDeepseekBuiltinSessionPath,
  getOllamaSessionPath,
  findCodexSessionPath,
  findKimiSessionPath,
} from '@cockpit/shared-utils';

export type SessionEngine =
  | 'claude'
  | 'claude2'
  | 'codex'
  | 'kimi'
  | 'ollama'
  | 'deepseek';

export interface SessionStore {
  sessionPath: string;
  engine: SessionEngine;
  mode?: 'sdk' | 'builtin';
}

/**
 * Where a session lives IS what it ran as — the transcript files carry no engine field, so
 * the store that holds one is the only authority. Engine and execution mode are TWO
 * dimensions and only the store can separate them: deepseek's SDK and Built-in Agent modes
 * write to different roots, so `mode` is authoritative for those two and MUST be reported
 * alongside the engine (collapsing them to `engine: 'deepseek'` alone loses the half that
 * decides which loop resumes the session).
 *
 * `mode` is deliberately absent where the store cannot prove it: claude/claude2 write the
 * same directory whether they ran through the SDK or the PTY, so guessing there would
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
  const claude2Path = getClaude2SessionPath(cwd, sessionId);
  if (fs.existsSync(claude2Path)) {
    return { sessionPath: claude2Path, engine: 'claude2' };
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
  const codexPath = findCodexSessionPath(sessionId);
  if (codexPath) {
    return { sessionPath: codexPath, engine: 'codex' };
  }
  const kimiPath = findKimiSessionPath(sessionId);
  if (kimiPath) {
    return { sessionPath: kimiPath, engine: 'kimi' };
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
 * The four listed here store Claude-compatible JSONL at a path we can construct from
 * (cwd, sessionId) alone, so a synthesized transcript is indistinguishable from one the
 * engine wrote itself. codex and kimi are deliberately excluded: their transcripts are
 * owned by their own CLIs and named on terms we do not control — codex is
 * `<date-dirs>/rollout-<timestamp>-<thread_id>.jsonl`, kimi is `<cwd-hash>/<sid>/context.jsonl`
 * — so a file we invent may simply never be found or resumed by them. Readers (history,
 * session-by-path) still support all six; only the write side is narrowed.
 *
 * Keep this in sync with `canForkEngine` on the client, which greys out the buttons so the
 * limit shows up as a disabled control rather than a request that fails.
 */
export function isForkableStore(store: SessionStore): boolean {
  return store.engine !== 'codex' && store.engine !== 'kimi';
}

/**
 * Path for a NEW session placed in the same store as `store`. Returns null for stores we
 * must not write into (see isForkableStore) — callers turn that into a user-facing error
 * instead of dropping a file the owning CLI would never read.
 */
export function newSessionPathInStore(
  store: SessionStore,
  cwd: string,
  newSessionId: string
): string | null {
  switch (store.engine) {
    case 'claude':
      return getClaudeSessionPath(cwd, newSessionId);
    case 'claude2':
      return getClaude2SessionPath(cwd, newSessionId);
    case 'deepseek':
      return store.mode === 'builtin'
        ? getDeepseekBuiltinSessionPath(cwd, newSessionId)
        : getDeepseekSessionPath(cwd, newSessionId);
    case 'ollama':
      return getOllamaSessionPath(cwd, newSessionId);
    default:
      return null;
  }
}
