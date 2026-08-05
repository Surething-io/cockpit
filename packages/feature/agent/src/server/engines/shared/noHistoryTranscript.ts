/**
 * "Independent task" (noHistory) for the Claude Agent SDK engines.
 *
 * The Built-in Agent gets this for free — it builds the message array itself, so dropping
 * history is one line (`existing = []` in builtinAgent/index.ts). The SDK engines never see
 * a message array: history is loaded by the vendor CLI from the session's own transcript
 * when we pass `resume: <sid>`. The only lever we have is whether that file is there.
 *
 * So an independent turn runs with the transcript MOVED ASIDE and `sessionId: <sid>` in
 * place of `resume` — the CLI finds no file, starts with an empty context, and writes this
 * turn to the same path it would have resumed. Afterwards the stashed history and the fresh
 * turn are concatenated back into one file.
 *
 * WHY NOT A THROWAWAY SESSION ID
 * ------------------------------
 * Running the turn under a temporary sid and merging the jsonl back looks equivalent and is
 * not: the vendor keys other artifacts off the session id, notably subagent transcripts at
 * `<projectDir>/<sid>/subagents/agent-<id>.jsonl` (see session-by-path.ts). A temporary sid
 * sends every subagent of that turn into a directory the merged transcript no longer points
 * at, so each Task drill-in in the UI would open nothing. Keeping the real sid means the
 * subagent dir, snapshots, run registry, global state and title all stay correct, and the
 * jsonl is the only thing that moves.
 *
 * WHAT THIS COSTS
 * ---------------
 * For the duration of the turn the session has no `<sid>.jsonl`, so it drops out of the
 * session lists (they all filter on `.endsWith('.jsonl')`). The open tab is unaffected — it
 * renders from the live WS stream and does not re-read the transcript mid-turn. A crash in
 * that window would leave the only copy of the conversation in the stash, which is why
 * recoverStashedTranscripts() runs on server boot.
 */
import * as fs from 'fs';
import { join, basename } from 'path';
import { CLAUDE_PROJECTS_DIR, CLAUDE2_PROJECTS_DIR } from '@cockpit/shared-utils';

/**
 * Stash location: inside the session's OWN directory — the same one the vendor uses for
 * `<sid>/subagents/`. Deliberately not a sibling `<sid>.jsonl.bak`: session lists scan the
 * project dir non-recursively, so both are invisible to them, but a leftover file here is
 * attributable to its session at a glance instead of loose in the project directory.
 */
export function noHistoryStashPath(sessionPath: string): string {
  return join(sessionPath.replace(/\.jsonl$/, ''), 'nohistory-backup.jsonl');
}

function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

/** Last uuid in the stashed history — the entry the resumed turn must chain onto. */
function tailUuid(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (typeof entry.uuid === 'string') return entry.uuid;
    } catch {
      /* corrupt line — keep looking backwards */
    }
  }
  return null;
}

/**
 * Re-link the seam. The independent turn was written as a session unto itself, so its
 * opening entry carries `parentUuid: null`. Concatenated verbatim that leaves a root in the
 * middle of the file, and the next ordinary (resumed) turn walks the parent chain back from
 * the tail, stops at that root, and silently sees only the post-seam messages. Pointing the
 * root at the stashed history's last uuid makes it one continuous chain again.
 */
function relinkAndRestamp(line: string, parentUuid: string | null, sessionId: string): string {
  try {
    const entry = JSON.parse(line);
    if (parentUuid && 'parentUuid' in entry && entry.parentUuid === null) {
      entry.parentUuid = parentUuid;
    }
    // Defensive: the CLI already stamps our sid because we pass `sessionId`, but a mismatch
    // here would make the merged file disagree with its own filename.
    if (typeof entry.sessionId === 'string') entry.sessionId = sessionId;
    return JSON.stringify(entry);
  } catch {
    return line; // corrupt line — pass through rather than drop conversation data
  }
}

/**
 * Move the transcript aside so the CLI starts this turn with no context.
 * Returns false when there is nothing to stash (a brand-new session), in which case the
 * turn is already history-free and the caller needs no merge afterwards.
 */
export function stashTranscript(sessionPath: string): boolean {
  if (!fs.existsSync(sessionPath)) return false;
  const stash = noHistoryStashPath(sessionPath);
  if (fs.existsSync(stash)) {
    // A previous independent turn died before merging. Fold it in first, so this turn
    // stashes the COMPLETE history rather than burying the older stash under a new one.
    mergeStashedTranscript(sessionPath);
  }
  fs.mkdirSync(join(stash, '..'), { recursive: true });
  fs.renameSync(sessionPath, stash);
  return true;
}

/**
 * Put the conversation back together: stashed history first, then the turn that just ran.
 * Idempotent and safe to call when nothing is stashed, which is what makes it usable both
 * as the normal post-turn step and as the boot-time recovery step.
 */
export function mergeStashedTranscript(sessionPath: string): 'merged' | 'restored' | 'none' {
  const stash = noHistoryStashPath(sessionPath);
  if (!fs.existsSync(stash)) return 'none';

  const history = readLines(stash);
  const turn = fs.existsSync(sessionPath) ? readLines(sessionPath) : [];

  if (turn.length === 0) {
    // The turn produced nothing (aborted before the first write, or the process died).
    // Restore verbatim — rename rather than rewrite, so the bytes are untouched.
    fs.renameSync(stash, sessionPath);
    return 'restored';
  }

  const sessionId = basename(sessionPath).replace(/\.jsonl$/, '');
  const seam = tailUuid(history);
  const merged = [...history, ...turn.map((line) => relinkAndRestamp(line, seam, sessionId))];
  fs.writeFileSync(sessionPath, merged.join('\n') + '\n', 'utf-8');
  fs.unlinkSync(stash);
  return 'merged';
}

/**
 * Boot-time sweep: fold in any stash left behind by a crash or a kill.
 *
 * Without this the affected session stays missing from every session list until someone
 * happens to start another independent turn in it — and the only copy of the conversation
 * sits under a filename nothing reads. Runs over the two SDK stores that can produce a
 * stash (claude, claude2). Returns the number of sessions repaired.
 */
export function recoverStashedTranscripts(
  roots: readonly string[] = [CLAUDE_PROJECTS_DIR, CLAUDE2_PROJECTS_DIR],
): number {
  let repaired = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let projectDirs: string[];
    try {
      projectDirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const project of projectDirs) {
      const projectPath = join(root, project);
      let sessionDirs: string[];
      try {
        sessionDirs = fs
          .readdirSync(projectPath, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue;
      }
      for (const sid of sessionDirs) {
        const sessionPath = join(projectPath, `${sid}.jsonl`);
        try {
          if (mergeStashedTranscript(sessionPath) !== 'none') repaired++;
        } catch {
          /* one unreadable session must not abort the sweep */
        }
      }
    }
  }
  return repaired;
}
