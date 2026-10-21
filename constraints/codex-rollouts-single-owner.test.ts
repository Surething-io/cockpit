/**
 * Constraint: CodexRolloutsSingleOwner (architecture rule, L3).
 *
 * Discovering codex rollouts (listing ~/.codex/sessions, reading a rollout's
 * session_meta, mapping a thread id to its file) belongs to the TranscriptIndex
 * catalog alone: `index.codexSessions` / `index.resolveCodex`, or the
 * `findCodexSession` / `listCodexSessionEntries` bridges for plain-async code.
 *
 * Why: a second, synchronous codex index lived in shared/utils/paths.ts. Being a
 * separate owner it grew its own invalidation rule — a directory-mtime cache that
 * marked a rollout "seen" before its first line was written, so that session could
 * not be found again until a restart — and being synchronous and outside the
 * handlers, its full-tree statSync scan on every project listing slipped past the
 * NoSyncIoInRequestHandlers ratchet.
 *
 * Rules:
 *   1. the removed sync API names do not come back anywhere — nor the old index file:
 *      seeding the catalog from it trusted metas the catalog never read (a version-1
 *      index lacks the sub-agent fields, so sub-agents were listed as sessions);
 *   2. CODEX_SESSIONS_DIR appears only in the catalog owner and in modules that
 *      merely BUILD a path under it (new-session placement, the noHistory stash).
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SCAN_ROOTS = ['src', 'packages', 'bin'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.next-prod', 'dist']);
const SOURCE = /\.(m?[jt]sx?)$/;
const TEST = /\.test\.[jt]sx?$/;

const REMOVED_API =
  /\b(findCodexSessionPath|findCodexSessionEntry|listCodexSessions|listAllCodexSessions|refreshCodexSessionIndex|listCodexSessionsByEncodedPath|readCodexIndex|writeCodexIndex|CODEX_SESSION_INDEX_FILE)\b/;

const DIR_ALLOWED = new Set([
  'packages/shared/utils/src/paths.ts', // definition
  'packages/feature/agent/src/effect/transcriptIndexLive.ts', // the catalog owner
  'packages/feature/agent/src/server/api/session/sessionStore.ts', // path for a NEW session
  'packages/feature/agent/src/server/engines/shared/noHistoryRollout.ts', // stash path root
]);

function* walk(path: string): Generator<string> {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (SOURCE.test(path) && !TEST.test(path)) yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(join(path, name));
  }
}

/** Source with // and /* *\/ comments blanked, so prose mentioning a name does not count. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function scan(): { removed: string[]; dirUsers: string[] } {
  const removed: string[] = [];
  const dirUsers: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      const rel = relative(ROOT, file).split(sep).join('/');
      const src = code(readFileSync(file, 'utf8'));
      if (REMOVED_API.test(src)) removed.push(rel);
      if (/\bCODEX_SESSIONS_DIR\b/.test(src) && !DIR_ALLOWED.has(rel)) dirUsers.push(rel);
    }
  }
  return { removed, dirUsers };
}

describe('CodexRolloutsSingleOwner', () => {
  const { removed, dirUsers } = scan();

  it('the removed synchronous codex index API does not come back', () => {
    expect(removed).toEqual([]);
  });

  it('only the catalog owner (and path builders) touch CODEX_SESSIONS_DIR', () => {
    expect(dirUsers).toEqual([]);
  });
});
