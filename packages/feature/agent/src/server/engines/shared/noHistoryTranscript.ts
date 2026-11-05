/**
 * "Independent task" (noHistory) for the Claude Agent SDK engines.
 *
 * The Built-in Agent gets this for free — it builds the message array itself, so dropping
 * history is one line (`existing = []` in builtinAgent/index.ts). The SDK engines never see
 * a message array: history is loaded by the vendor CLI from the session's own transcript
 * when we pass `resume: <sid>`. The only lever we have is whether that file is there.
 *
 * So an independent turn runs with the transcript MOVED ASIDE and `sessionId: <sid>` in
 * place of `resume` — Claude finds no file, starts with an empty context, and writes this
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
 * READERS AND RECOVERY
 * --------------------
 * The current `<sid>.jsonl` can be absent until the CLI writes its first event.
 * Logical transcript discovery and reads include the stash throughout this window.
 * A crash can leave the only history copy there, so recoverStashedTranscripts()
 * still restores or merges it on server boot.
 */
import * as fs from 'fs';
import { join } from 'path';
import { CLAUDE_PROJECTS_DIR } from '@cockpit/shared-utils';
import { rewriteTranscriptSync } from '../../transcriptWrite';
import { invalidateTranscript } from '../../../effect/transcriptIndexLive';
import { noHistoryStashPath } from '../../transcriptLayout';
import { spliceClaudeTranscript } from '../../transcriptSplice';
export { noHistoryStashPath } from '../../transcriptLayout';

function readLines(filePath: string): string[] {
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
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
  try {
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
    fs.renameSync(stash, sessionPath);
  } finally {
    invalidateTranscript(sessionPath);
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
  invalidateTranscript(sessionPath);
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
    replaceWithStash(stash, sessionPath);
    return 'restored';
  }

  if (!hasOnlyCompleteJsonLines(turn)) {
    replaceWithStash(stash, sessionPath);
    return 'restored';
  }

  rewriteTranscriptSync(sessionPath, spliceClaudeTranscript(history, turn, sessionPath).join('\n') + '\n');
  fs.unlinkSync(stash);
  return 'merged';
}

/**
 * Boot-time sweep: fold in any stash left behind by a crash or a kill.
 *
 * Without this the affected session stays missing from every session list until someone
 * happens to start another independent turn in it — and the only copy of the conversation
 * sits under a filename nothing reads. Runs over the SDK store that can produce a
 * stash (claude). Returns the number of sessions repaired.
 */
export function recoverStashedTranscripts(
  roots: readonly string[] = [CLAUDE_PROJECTS_DIR],
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
