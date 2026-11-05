// Native Pi session editing for Cockpit's fork and delete-turn actions.
import { Effect } from 'effect';
import { randomUUID } from 'node:crypto';
import { piTurn, deletePiBranchTurn } from './piSessionTree';
export { piTurn } from './piSessionTree';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import { AppError, ValidationError } from '@cockpit/effect-core';
import { rewriteTranscript } from '../server/transcriptWrite';
import { copyPiChildren, prunePiChildren } from './piSubagentSessionLive';
import { piSelection } from './piSessionLive';
import { openPiSessionForWrite } from './piSessionWriteLive';
import { resolvePiEntryId } from './piSessionIdentity';

/** Reject stale legacy locators explicitly; never infer a target from an ordinal alone. */
const editTarget = (manager: SessionManager, target: string): string | undefined => {
  const resolved = resolvePiEntryId(manager.getSessionId(), manager.getEntries(), target);
  if (!resolved && (target.startsWith('pi-v1-') || /^[a-f0-9]{16}$/.test(target))) {
    throw new ValidationError({ field: 'messageUuid', reason: 'Session changed; refresh before editing' });
  }
  return resolved;
};

/** Keep edits by their target, regardless of which later turn appended them. */
function appendReferencedEdits(entries: SessionEntry[], copy: SessionManager, ids: Map<string, string>, copiedEdits = new Set<string>()): void {
  for (const entry of entries) {
    if (entry.type !== 'context_edit' || copiedEdits.has(entry.id)) continue;
    const targetId = ids.get(entry.targetId);
    if (targetId) copy.appendContextEdit(targetId, entry.replacement);
  }
}

/** Fork using Pi's writer; finish native IO before cancellation releases the caller's lease. */
export const forkPiSession = (path: string, target?: string, scope: 'prefix' | 'single' = 'prefix'): Effect.Effect<{ newSessionId: string; messageCount: number } | undefined, AppError | ValidationError> => Effect.tryPromise({
  try: async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const manager = await Effect.runPromise(openPiSessionForWrite(path));
    const sourceId = manager.getSessionId();
    const entries = manager.getBranch();
    const resolved = target ? editTarget(manager, target) : undefined;
    const turn = target ? resolved ? piTurn(entries, resolved) : undefined : { start: 0, end: entries.length };
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
  catch: (cause) => cause instanceof ValidationError ? cause : new AppError({ message: 'Cannot fork Pi session', cause }),
}).pipe(Effect.uninterruptible);

/** Delete only the active path's turn, preserving the rest of the native tree. */
export const deletePiTurn = (path: string, target: string): Effect.Effect<{ targetMissed: boolean; deletedLineCount: number }, AppError | ValidationError> => Effect.tryPromise({
  try: async () => {
    const manager = await Effect.runPromise(openPiSessionForWrite(path));
    const entries = manager.getBranch();
    const resolved = editTarget(manager, target);
    const turn = resolved ? piTurn(entries, resolved) : undefined;
    if (!turn) return { targetMissed: true, deletedLineCount: 0 };
    const result = deletePiBranchTurn(manager.getEntries(), entries, resolved!, { newId: randomUUID, timestamp: new Date().toISOString() })!;
    const lines = [JSON.stringify(manager.getHeader()), ...result.entries.map((entry) => JSON.stringify(entry))];
    await rewriteTranscript(path, lines.join('\n') + '\n');
    await Effect.runPromise(prunePiChildren(path, manager.getSessionId(), result.entries));
    return { targetMissed: false, deletedLineCount: result.deletedLineCount };
  },
  catch: (cause) => cause instanceof ValidationError ? cause : new AppError({ message: 'Cannot delete Pi turn', cause }),
}).pipe(Effect.uninterruptible);
