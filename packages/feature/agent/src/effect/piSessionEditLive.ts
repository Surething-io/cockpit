// Native Pi session editing for Cockpit's fork and delete-turn actions.
import { Effect } from 'effect';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import { AppError } from '@cockpit/effect-core';
import { rewriteTranscript } from '../server/transcriptWrite';
import { copyPiChildren, prunePiChildren } from './piSubagentSessionLive';
import { piSelection } from './piSessionLive';

/** Locate a complete human turn even when the selected bubble is an assistant. */
export function piTurn(entries: SessionEntry[], target: string): { start: number; end: number } | undefined {
  const index = entries.findIndex((e) => e.id === target);
  if (index < 0) return undefined;
  const isUser = (entry: SessionEntry) => entry.type === 'message' && entry.message.role === 'user';
  let start = index;
  while (start >= 0 && !isUser(entries[start])) start--;
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < entries.length && !isUser(entries[end])) end++;
  return { start, end };
}

/** Keep edits by their target, regardless of which later turn appended them. */
function appendReferencedEdits(entries: SessionEntry[], copy: SessionManager, ids: Map<string, string>, copiedEdits = new Set<string>()): void {
  for (const entry of entries) {
    if (entry.type !== 'context_edit' || copiedEdits.has(entry.id)) continue;
    const targetId = ids.get(entry.targetId);
    if (targetId) copy.appendContextEdit(targetId, entry.replacement);
  }
}

/** Fork using Pi's branch writer, or create a native session containing one turn. */
export const forkPiSession = (path: string, target?: string, scope: 'prefix' | 'single' = 'prefix'): Effect.Effect<{ newSessionId: string; messageCount: number } | undefined, AppError> => Effect.tryPromise({
  try: async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(path);
    const sourceId = manager.getSessionId();
    const entries = manager.getBranch();
    const turn = target ? piTurn(entries, target) : { start: 0, end: entries.length };
    if (!turn || !entries.length) return undefined;
    if (scope === 'prefix') {
      manager.createBranchedSession(entries[turn.end - 1].id);
      const retained = manager.getBranch();
      appendReferencedEdits(entries, manager,
        new Map(retained.filter((e) => e.type === 'message').map((e) => [e.id, e.id])),
        new Set(retained.filter((e) => e.type === 'context_edit').map((e) => e.id)));
      await Effect.runPromise(copyPiChildren(path, sourceId, manager.getSessionFile()!, manager.getSessionId(), entries.slice(0, turn.end)));
      return { newSessionId: manager.getSessionId(), messageCount: turn.end };
    }
    const copy = SessionManager.create(manager.getCwd(), manager.getSessionDir(), { parentSession: path });
    const selection = piSelection(entries.slice(0, turn.end));
    if (selection.model) copy.appendModelChange(selection.engine, selection.model);
    const ids = new Map<string, string>();
    for (const entry of entries.slice(turn.start, turn.end)) {
      if (entry.type === 'message' && (entry.message.role === 'user' || entry.message.role === 'assistant' || entry.message.role === 'toolResult' || entry.message.role === 'system')) ids.set(entry.id, copy.appendMessage(entry.message));
    }
    appendReferencedEdits(entries, copy, ids);
    await Effect.runPromise(copyPiChildren(path, sourceId, copy.getSessionFile()!, copy.getSessionId(), entries.slice(turn.start, turn.end)));
    return { newSessionId: copy.getSessionId(), messageCount: turn.end - turn.start };
  },
  catch: (cause) => new AppError({ message: 'Cannot fork Pi session', cause }),
});

/** Delete the active branch's turn and rebuild links; discard summaries that could retain deleted text. */
export const deletePiTurn = (path: string, target: string): Effect.Effect<{ targetMissed: boolean; deletedLineCount: number }, AppError> => Effect.tryPromise({
  try: async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = SessionManager.open(path);
    const entries = manager.getBranch();
    const turn = piTurn(entries, target);
    if (!turn) return { targetMissed: true, deletedLineCount: 0 };
    const removed = new Set(entries.slice(turn.start, turn.end).map((e) => e.id));
    const retainedMessages = new Set(entries.filter((e) => e.type === 'message' && !removed.has(e.id)).map((e) => e.id));
    const kept = entries.filter((e) => e.type === 'context_edit'
      ? retainedMessages.has(e.targetId)
      : !removed.has(e.id) && e.type !== 'compaction' && e.type !== 'branch_summary');
    let parentId: string | null = null;
    const lines = [JSON.stringify(manager.getHeader())];
    for (const entry of kept) {
      lines.push(JSON.stringify({ ...entry, parentId }));
      parentId = entry.id;
    }
    await rewriteTranscript(path, lines.join('\n') + '\n');
    await Effect.runPromise(prunePiChildren(path, manager.getSessionId(), kept));
    return { targetMissed: false, deletedLineCount: entries.length - kept.length };
  },
  catch: (cause) => new AppError({ message: 'Cannot delete Pi turn', cause }),
});
