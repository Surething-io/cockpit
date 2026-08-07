/**
 * "Independent task" (noHistory) for Codex rollouts.
 *
 * Codex history is reconstructed from the rollout JSONL file passed to `resume`.
 * Unlike Claude's SDK path, Codex has no public "start an empty turn with this exact
 * session id" option. The practical lever is the rollout file itself: keep the file
 * present, but replace it with a minimal stub containing only its `session_meta`.
 *
 * During the turn, Codex resumes the same thread id from an empty history. Afterwards
 * we append the new turn lines (excluding the temporary `session_meta`) back onto the
 * stashed original rollout, so Cockpit's visible history and future Codex resumes stay
 * continuous.
 */
import * as fs from 'fs';
import { dirname, join } from 'path';
import { CODEX_SESSIONS_DIR } from '@cockpit/shared-utils';

const STASH_SUFFIX = '.nohistory-backup';

export function codexNoHistoryStashPath(sessionPath: string): string {
  return `${sessionPath}${STASH_SUFFIX}`;
}

function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

function isSessionMeta(line: string): boolean {
  try {
    const entry = JSON.parse(line) as { type?: string; payload?: { id?: unknown; cwd?: unknown } };
    return entry.type === 'session_meta' && typeof entry.payload?.id === 'string' && typeof entry.payload?.cwd === 'string';
  } catch {
    return false;
  }
}

function hasOnlyCompleteJsonLines(lines: string[]): boolean {
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      return false;
    }
  }
  return true;
}

function replaceWithStash(stash: string, sessionPath: string): void {
  if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  fs.renameSync(stash, sessionPath);
}

/**
 * Replace the rollout with a no-history stub while preserving the path and thread id.
 * Returns false when the session file does not exist, which means there is no history
 * for Codex to load anyway.
 */
export function stashCodexRollout(sessionPath: string): boolean {
  if (!fs.existsSync(sessionPath)) return false;

  const stash = codexNoHistoryStashPath(sessionPath);
  if (fs.existsSync(stash)) {
    mergeStashedCodexRollout(sessionPath);
  }

  const lines = readLines(sessionPath);
  const meta = lines[0];
  if (!meta || !isSessionMeta(meta)) {
    throw new Error(`Cannot run Codex independent task: ${sessionPath} has no session_meta`);
  }

  fs.mkdirSync(dirname(stash), { recursive: true });
  fs.renameSync(sessionPath, stash);
  try {
    fs.writeFileSync(sessionPath, `${meta}\n`, 'utf-8');
  } catch (error) {
    if (fs.existsSync(stash) && !fs.existsSync(sessionPath)) {
      fs.renameSync(stash, sessionPath);
    }
    throw error;
  }
  return true;
}

/**
 * Merge a no-history Codex turn back into the original rollout.
 * The temporary rollout's first line is the copied `session_meta`; it must not be
 * duplicated into the final file.
 */
export function mergeStashedCodexRollout(sessionPath: string): 'merged' | 'restored' | 'none' {
  const stash = codexNoHistoryStashPath(sessionPath);
  if (!fs.existsSync(stash)) return 'none';

  const history = readLines(stash);
  const turn = fs.existsSync(sessionPath) ? readLines(sessionPath) : [];
  const turnLines = turn[0] && isSessionMeta(turn[0]) ? turn.slice(1) : turn;

  if (turnLines.length === 0) {
    replaceWithStash(stash, sessionPath);
    return 'restored';
  }

  if (!hasOnlyCompleteJsonLines(turnLines)) {
    replaceWithStash(stash, sessionPath);
    return 'restored';
  }

  // Codex rollout entries are append-only JSONL records keyed by call_id / item id; unlike
  // Claude transcripts, they do not carry a cross-line parentUuid chain that needs a seam
  // rewrite when an isolated turn is appended back onto the stashed history.
  fs.writeFileSync(sessionPath, [...history, ...turnLines].join('\n') + '\n', 'utf-8');
  fs.unlinkSync(stash);
  return 'merged';
}

/**
 * Boot-time repair for a process that died while a Codex independent turn was stashed.
 */
export function recoverStashedCodexRollouts(
  root: string = CODEX_SESSIONS_DIR,
): number {
  if (!fs.existsSync(root)) return 0;
  let repaired = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && full.endsWith(STASH_SUFFIX)) {
        const sessionPath = full.slice(0, -STASH_SUFFIX.length);
        try {
          if (mergeStashedCodexRollout(sessionPath) !== 'none') repaired++;
        } catch {
          /* one unreadable rollout must not abort the sweep */
        }
      }
    }
  }
  return repaired;
}
