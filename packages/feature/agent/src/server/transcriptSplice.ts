import { basename } from 'node:path';

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

/** Stashed history followed by the independent turn, seam re-linked. Shared by merge and view. */
export function spliceClaudeTranscript(history: string[], turn: string[], sessionPath: string): string[] {
  const sessionId = basename(sessionPath).replace(/\.jsonl$/, '');
  const seam = tailUuid(history);
  return [...history, ...turn.map((line) => relinkAndRestamp(line, seam, sessionId))];
}

/** Codex's temporary current file starts with a duplicate session_meta stub. */
export function spliceCodexTranscript(history: string[], turn: string[]): string[] {
  let start = 0;
  try {
    const first = JSON.parse(turn[0] ?? 'null');
    if (first?.type === 'session_meta' && typeof first.payload?.id === 'string' && typeof first.payload?.cwd === 'string') start = 1;
  } catch { /* malformed lines pass through to the decoder */ }
  return [...history, ...turn.slice(start)];
}
