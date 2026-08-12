import * as fs from 'fs';
import { join } from 'path';
import {
  CODEX_SESSIONS_DIR,
  getClaudeSessionPath,
  getDeepseekBuiltinSessionPath,
  getKimiBuiltinSessionPath,
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
}

/**
 * Where a session lives IS what it ran as — the transcript files carry no engine field, so
 * the store that holds one is the only authority. One store per engine, so the answer is a
 * single dimension.
 *
 * There used to be a second one: deepseek/kimi/glm each wrote a separate store per
 * execution mode (Claude Agent SDK vs Built-in Agent) and a `mode` had to be reported
 * alongside the engine. Those engines now only ever run the built-in loop, and the old SDK
 * stores under ~/.cockpit/<engine>/projects are deliberately NOT probed — their transcripts
 * are in the SDK's own shape and no loop remains that can resume them, so surfacing them
 * would offer sessions that die on the first turn.
 */
export function resolveSessionPath(
  cwd: string,
  sessionId: string
): SessionStore | null {
  const sessionPath = getClaudeSessionPath(cwd, sessionId);
  if (fs.existsSync(sessionPath)) {
    return { sessionPath, engine: 'claude' };
  }
  const deepseekPath = getDeepseekBuiltinSessionPath(cwd, sessionId);
  if (fs.existsSync(deepseekPath)) {
    return { sessionPath: deepseekPath, engine: 'deepseek' };
  }
  const kimiPath = getKimiBuiltinSessionPath(cwd, sessionId);
  if (fs.existsSync(kimiPath)) {
    return { sessionPath: kimiPath, engine: 'kimi' };
  }
  const glmPath = getGlmBuiltinSessionPath(cwd, sessionId);
  if (fs.existsSync(glmPath)) {
    return { sessionPath: glmPath, engine: 'glm' };
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
      return getDeepseekBuiltinSessionPath(cwd, newSessionId);
    case 'kimi':
      return getKimiBuiltinSessionPath(cwd, newSessionId);
    case 'glm':
      return getGlmBuiltinSessionPath(cwd, newSessionId);
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
