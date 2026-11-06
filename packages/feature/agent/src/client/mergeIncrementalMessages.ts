import type { ChatMessage } from './types';
import { splitTurns } from '../shared/chatTurns';

export interface HistoryPageAnchor {
  firstMessageId?: string;
  startTurnIndex: number;
}

// Use the same alignment for both the merge and its pagination cursor.
function findWindowStart(messages: ChatMessage[], firstMessageId: string): number {
  if (messages[0]?.id === firstMessageId) return 0;
  return messages.findLastIndex((message) => message.id === firstMessageId);
}

/** Locate the rendered history's start relative to a server page's known cursor. */
export function getHistoryStartTurnIndex(
  messages: ChatMessage[],
  anchor: HistoryPageAnchor | undefined,
): number | undefined {
  if (!anchor) return undefined;
  if (anchor.firstMessageId === undefined) {
    return messages.length === 0 ? anchor.startTurnIndex : undefined;
  }
  const windowStart = findWindowStart(messages, anchor.firstMessageId);
  if (windowStart < 0) return undefined;
  // Older turns can survive an incremental suffix merge. Live messages after
  // the anchor do not move this cursor, even before they have reached disk.
  return Math.max(0, anchor.startTurnIndex - splitTurns(messages.slice(0, windowStart)).length);
}

// ============================================
// Incremental history merge
//
// Incremental /api/session-by-path fetches may carry a `limit`, so the response
// can be a suffix WINDOW of the session (last N turns), not the whole file.
// Merging a window into the rendered list must align it first — diffing from
// index 0 would treat the window offset as a full mismatch and silently
// truncate everything the user had loaded before the window (the pre-fix bug).
//
// Pure function so the merge is unit-testable (see mergeIncrementalMessages.test.ts).
// Returns the SAME array reference when nothing changed, so React state setters
// can skip the update.
// ============================================
export function mergeIncrementalMessages(
  prevMessages: ChatMessage[],
  newMessages: ChatMessage[]
): ChatMessage[] {
  if (newMessages.length === 0) return prevMessages;

  // Align the window against prevMessages by the window's first message id.
  // Search from the END: the window is a suffix of the session, so on duplicate
  // ids the later occurrence is the correct anchor.
  const alignIndex = prevMessages.length === 0 ? 0 : findWindowStart(prevMessages, newMessages[0].id);
  if (alignIndex < 0) {
    // No overlap between the window and what's rendered: the session grew past
    // the window since the last load, or the file was rewritten. The window is
    // the only current data we have — replace (scroll-up pagination re-fetches
    // older turns via hasMore).
    return newMessages;
  }

  const prevTail = prevMessages.slice(alignIndex);
  // Find the first differing message index within the aligned region.
  // Compare id AND content: content alone misses the reconcile that swaps a
  // temp `live-*` bubble for its canonical disk uuid (same text, new id) —
  // skipping that would leave ephemeral ids around and break later id-based dedup.
  // Task membership/count can change when steering arrives without changing the
  // existing text; refresh it too so edit scope and confirmation stay current.
  let diffIndex = 0;
  for (let i = 0; i < Math.min(prevTail.length, newMessages.length); i++) {
    if (
      prevTail[i].id !== newMessages[i].id ||
      prevTail[i].content !== newMessages[i].content ||
      prevTail[i].turnId !== newMessages[i].turnId ||
      prevTail[i].turnUserId !== newMessages[i].turnUserId ||
      prevTail[i].turnUserCount !== newMessages[i].turnUserCount
    ) {
      break;
    }
    diffIndex = i + 1;
  }
  if (diffIndex === prevTail.length && diffIndex === newMessages.length) {
    // Aligned region identical → nothing changed, keep object identity.
    return prevMessages;
  }
  if (diffIndex === prevTail.length && diffIndex < newMessages.length) {
    // Only new messages appended after what we have
    return [...prevMessages, ...newMessages.slice(diffIndex)];
  }
  // Updates/deletions inside the window: keep everything before the window plus
  // the identical prefix, replace the rest of the window.
  return [
    ...prevMessages.slice(0, alignIndex),
    ...prevTail.slice(0, diffIndex),
    ...newMessages.slice(diffIndex),
  ];
}


// ============================================
// Jump-window merge
//
// A jump window is turns [target, end] — fetched when the user picks a message
// from the user-message modal that pagination has not loaded. It always runs to
// the disk tail, so every rendered message AFTER the last one the window
// contains is a bubble that is not on disk yet (the reply currently streaming).
// Replacing `messages` wholesale would erase it mid-render.
//
// No-overlap is NOT treated as "prev must be all live". That case is
// unreachable on the real path — the jump target came from the on-disk index,
// so the window contains it, so any prev from the same session overlaps — which
// leaves only one way to observe it: prev belongs to a DIFFERENT session
// (loaded while the request was in flight). Splicing there would render two
// sessions' messages as one conversation, so this drops the tail instead.
// The caller still guards the session id; this is the second lock, not the first.
// ============================================
export function mergeJumpWindow(
  prevMessages: ChatMessage[],
  windowMessages: ChatMessage[]
): ChatMessage[] {
  if (windowMessages.length === 0) return prevMessages;

  const windowIds = new Set(windowMessages.map((m) => m.id));
  const lastOnDisk = prevMessages.map((m) => windowIds.has(m.id)).lastIndexOf(true);
  if (lastOnDisk < 0) return windowMessages;

  const liveTail = prevMessages.slice(lastOnDisk + 1);
  return liveTail.length === 0 ? windowMessages : [...windowMessages, ...liveTail];
}
