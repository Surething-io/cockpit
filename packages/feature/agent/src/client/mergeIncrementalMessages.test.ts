// Regression net for the incremental-history merge. Run with `npm test`
// (vitest) or `npx vitest run <this file>`.
//
// Covers the scheduled-task jump bugs:
//   1. windowed (limit=N) incremental responses must not truncate the
//      already-loaded history that precedes the window;
//   2. externally appended messages (scheduled-task runs) must show up;
//   3. unchanged data must keep object identity (React skip).
import { describe, it, expect } from 'vitest';
import { mergeIncrementalMessages, mergeJumpWindow } from './mergeIncrementalMessages';
import type { ChatMessage } from './types';

const msg = (id: string, content = `content-${id}`): ChatMessage =>
  ({ id, role: 'assistant', content } as ChatMessage);

describe('mergeIncrementalMessages', () => {
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
