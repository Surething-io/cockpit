// Regression net for the incremental-history merge. Run with `npm test`
// (vitest) or `npx vitest run <this file>`.
//
// Covers the scheduled-task jump bugs:
//   1. windowed (limit=N) incremental responses must not truncate the
//      already-loaded history that precedes the window;
//   2. externally appended messages (scheduled-task runs) must show up;
//   3. unchanged data must keep object identity (React skip).
import { describe, it, expect } from 'vitest';
import { getHistoryStartTurnIndex, mergeIncrementalMessages, mergeJumpWindow } from './mergeIncrementalMessages';
import type { ChatMessage } from './types';

const msg = (id: string, content = `content-${id}`): ChatMessage =>
  ({ id, role: 'assistant', content } as ChatMessage);

describe('history pagination after window merges', () => {
  const task = (n: number, userCount = 1): ChatMessage[] => [
    ...Array.from({ length: userCount }, (_, input) => ({
      id: `user-${n}-${input}`, role: 'user' as const, content: `Q${n}-${input}`, turnId: `task-${n}`,
    })),
    { ...msg(`answer-${n}`), turnId: `task-${n}` },
  ];

  it.each([0, 1, 2])('keeps the server cursor for a first page containing %s inputs per task', (userCount) => {
    const page = [task(10, userCount), task(11, userCount)].flat();
    expect(getHistoryStartTurnIndex(page, { firstMessageId: page[0].id, startTurnIndex: 10 })).toBe(10);
  });

  it('keeps the earlier visible boundary when an incremental suffix retains a prefix', () => {
    const prev = [task(5, 0), task(6, 2), task(7), task(8), task(9), task(10)].flat();
    const suffix = [task(10), task(11, 2)].flat();
    const merged = mergeIncrementalMessages(prev, suffix);
    expect(getHistoryStartTurnIndex(merged, { firstMessageId: suffix[0].id, startTurnIndex: 10 })).toBe(5);
  });

  it('adopts the suffix boundary when a non-overlapping window replaces the messages', () => {
    const suffix = task(20, 2);
    const merged = mergeIncrementalMessages(task(5), suffix);
    expect(getHistoryStartTurnIndex(merged, { firstMessageId: suffix[0].id, startTurnIndex: 20 })).toBe(20);
  });

  it('keeps zero as the boundary after all older history was loaded', () => {
    const all = Array.from({ length: 20 }, (_, n) => task(n, n === 3 ? 0 : 2)).flat();
    const suffix = [task(19, 2), task(20)].flat();
    const merged = mergeIncrementalMessages(all, suffix);
    expect(getHistoryStartTurnIndex(merged, { firstMessageId: suffix[0].id, startTurnIndex: 19 })).toBe(0);
  });

  it('does not count live messages after the page anchor as earlier history', () => {
    const disk = task(10);
    const messages = [...disk, { ...msg('live-user'), role: 'user' as const }, msg('live-answer')];
    expect(getHistoryStartTurnIndex(messages, { firstMessageId: disk[0].id, startTurnIndex: 10 })).toBe(10);
  });

  it('uses the same duplicate-ID alignment as the incremental merge', () => {
    const messages = [task(5), task(6), task(7)].flat();
    messages[2].id = 'duplicate';
    messages[4].id = 'duplicate';
    const suffix = [{ ...messages[4] }, messages[5]];
    const merged = mergeIncrementalMessages(messages, suffix);
    expect(getHistoryStartTurnIndex(merged, { firstMessageId: 'duplicate', startTurnIndex: 7 })).toBe(5);
  });

  it('handles empty history and unavailable anchors without inventing a cursor', () => {
    expect(getHistoryStartTurnIndex([], { startTurnIndex: 0 })).toBe(0);
    expect(getHistoryStartTurnIndex(task(1), undefined)).toBeUndefined();
    expect(getHistoryStartTurnIndex(task(1), { firstMessageId: 'missing', startTurnIndex: 1 })).toBeUndefined();
  });
});

describe('mergeIncrementalMessages', () => {
  it('refreshes task membership and the input count when steering arrives', () => {
    const prev = [{ ...msg('a'), turnId: 'task-1', turnUserCount: 1 }];
    const window = [{ ...msg('a'), turnId: 'task-1', turnUserCount: 2 }, msg('steer')];
    expect(mergeIncrementalMessages(prev, window)).toEqual(window);
    expect(mergeIncrementalMessages(prev, [{ ...msg('a'), turnId: 'task-2', turnUserCount: 1 }])[0].turnId).toBe('task-2');
  });

  it('keeps object identity when the aligned window is unchanged', () => {
    const prev = [msg('a'), msg('b'), msg('c'), msg('d')];
    const window = [msg('c'), msg('d')]; // last-N window, identical
    expect(mergeIncrementalMessages(prev, window)).toBe(prev);
  });

  it('appends new messages from a window WITHOUT truncating pre-window history (main regression)', () => {
    // prev holds 4 messages; the incremental fetch returns only the last-3 window,
    // which now contains 2 new messages appended by a scheduled-task run.
    const prev = [msg('a'), msg('b'), msg('c'), msg('d')];
    const window = [msg('d'), msg('e'), msg('f')];
    const out = mergeIncrementalMessages(prev, window);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    // pre-window prefix keeps identity (memoized bubbles don't re-render)
    expect(out[0]).toBe(prev[0]);
    expect(out[3]).toBe(prev[3]);
  });

  it('handles full (non-windowed) incremental responses like before: plain append', () => {
    const prev = [msg('a'), msg('b')];
    const full = [msg('a'), msg('b'), msg('c')];
    const out = mergeIncrementalMessages(prev, full);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(out[0]).toBe(prev[0]);
  });

  it('replaces the tail when a temp live-* bubble is reconciled to its canonical id', () => {
    const prev = [msg('a'), msg('live-1', 'hello')];
    const window = [msg('a'), msg('uuid-1', 'hello')]; // same text, canonical id
    const out = mergeIncrementalMessages(prev, window);
    expect(out.map((m) => m.id)).toEqual(['a', 'uuid-1']);
  });

  it('updates changed content inside the window while keeping the identical prefix', () => {
    const prev = [msg('a'), msg('b'), msg('c', 'old')];
    const window = [msg('b'), msg('c', 'new'), msg('d')];
    const out = mergeIncrementalMessages(prev, window);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(out[2].content).toBe('new');
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
  });

  it('falls back to the window when there is no overlap (session grew past the window)', () => {
    const prev = [msg('a'), msg('b')];
    const window = [msg('x'), msg('y'), msg('z')];
    // Nothing to align on — the window is the only current data (hasMore
    // pagination recovers older turns on scroll-up).
    expect(mergeIncrementalMessages(prev, window)).toEqual(window);
  });

  it('drops prev messages past the window end (deleted / rewritten on disk)', () => {
    const prev = [msg('a'), msg('b'), msg('stale')];
    const window = [msg('a'), msg('b')];
    const out = mergeIncrementalMessages(prev, window);
    expect(out.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('returns prev untouched for an empty response', () => {
    const prev = [msg('a')];
    expect(mergeIncrementalMessages(prev, [])).toBe(prev);
  });

  it('handles empty prev (first incremental before any load)', () => {
    const window = [msg('a'), msg('b')];
    expect(mergeIncrementalMessages([], window)).toEqual(window);
  });

  it('anchors on the LAST occurrence when ids repeat', () => {
    const prev = [msg('a'), msg('dup'), msg('b'), msg('dup')];
    const window = [msg('dup'), msg('e')];
    const out = mergeIncrementalMessages(prev, window);
    expect(out.map((m) => m.id)).toEqual(['a', 'dup', 'b', 'dup', 'e']);
  });
});

// The user-message modal's jump: the window is turns [target, end], pulled in
// because the target had no bubble on screen. What it must not do is drop the
// reply that is streaming, or splice in a session the user has since left.
describe('mergeJumpWindow', () => {
  it('keeps the not-yet-persisted tail that is streaming', () => {
    const prev = [msg('c'), msg('d'), msg('live-asst-1', 'streaming…')];
    const window = [msg('a'), msg('b'), msg('c'), msg('d')];
    expect(mergeJumpWindow(prev, window).map((m) => m.id)).toEqual([
      'a', 'b', 'c', 'd', 'live-asst-1',
    ]);
  });

  it('recognises the tail by absence from the window, not by an id prefix', () => {
    // useChatStream mints `auto-*` and `user-<ts>` bubbles too — anything that
    // hardcoded the `live-` prefix would silently drop these.
    const prev = [msg('c'), msg('auto-asst-2'), msg('user-1757000000000')];
    const window = [msg('a'), msg('b'), msg('c')];
    expect(mergeJumpWindow(prev, window).map((m) => m.id)).toEqual([
      'a', 'b', 'c', 'auto-asst-2', 'user-1757000000000',
    ]);
  });

  it('returns the window when everything rendered is already in it', () => {
    const prev = [msg('c'), msg('d')];
    const window = [msg('a'), msg('b'), msg('c'), msg('d')];
    expect(mergeJumpWindow(prev, window)).toBe(window);
  });

  it('drops a non-overlapping prev instead of splicing two sessions together', () => {
    // Reachable only if the session changed while the jump request was in
    // flight. Concatenating would render both files as one conversation.
    const prev = [msg('other-1'), msg('other-2')];
    const window = [msg('a'), msg('b')];
    expect(mergeJumpWindow(prev, window)).toBe(window);
  });

  it('leaves the rendered list alone when the window came back empty', () => {
    const prev = [msg('c'), msg('d')];
    expect(mergeJumpWindow(prev, [])).toBe(prev);
  });
});
