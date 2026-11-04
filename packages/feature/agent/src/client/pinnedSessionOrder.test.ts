import { describe, expect, it } from 'vitest';
import { insertPinnedSession, pinnedDropSide, type DropSide } from './pinnedSessionOrder';

describe('favorite insertion positions', () => {
  const items = ['a', 'b', 'c', 'd'].map((sessionId) => ({ sessionId }));
  it.each<[string, string, DropSide, string[]]>([
    ['a', 'c', 'before', ['b', 'a', 'c', 'd']],
    ['a', 'c', 'after', ['b', 'c', 'a', 'd']],
    ['d', 'b', 'before', ['a', 'd', 'b', 'c']],
    ['d', 'b', 'after', ['a', 'b', 'd', 'c']],
    ['d', 'a', 'before', ['d', 'a', 'b', 'c']],
    ['a', 'd', 'after', ['b', 'c', 'd', 'a']],
    ['b', 'c', 'before', ['a', 'b', 'c', 'd']],
  ])('inserts %s %s %s', (source, target, side, expected) => {
    expect(insertPinnedSession(items, source, target, side).map((item) => item.sessionId)).toEqual(expected);
    expect(items.map((item) => item.sessionId)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('uses the same midpoint boundary for the insertion marker and the final drop', () => {
    const bounds = { top: 100, height: 40 };
    expect(pinnedDropSide(119, bounds)).toBe('before');
    expect(pinnedDropSide(120, bounds)).toBe('after');
    expect(pinnedDropSide(139, bounds)).toBe('after');
  });
  it('does not move another item if a source or target disappears during the drag', () => {
    expect(insertPinnedSession(items, 'missing', 'b', 'after')).toEqual(items);
    expect(insertPinnedSession(items, 'a', 'missing', 'before')).toEqual(items);
    expect(insertPinnedSession(items, 'a', 'a', 'after')).toEqual(items);
  });
});
