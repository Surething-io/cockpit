import { describe, it, expect } from 'vitest';
import { groupListItems } from './markdownTaskListFix';

const kinds = (items: { isTask: boolean }[]) =>
  items.map((i) => (i.isTask ? 'T' : 'B'));

describe('groupListItems', () => {
  it('keeps a pure task list as a single task group', () => {
    const groups = groupListItems([{ isTask: true }, { isTask: true }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].isTask).toBe(true);
    expect(groups[0].items).toHaveLength(2);
  });

  it('keeps a pure bullet list as a single plain group', () => {
    const groups = groupListItems([{ isTask: false }, { isTask: false }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].isTask).toBe(false);
  });

  it('splits the real bug case: leading bullets then tasks', () => {
    // - 错误分析 / - slack 业务  (plain)  +  - [ ] ...  (tasks)
    const items = [
      { isTask: false },
      { isTask: false },
      { isTask: true },
      { isTask: true },
      { isTask: true },
    ];
    const groups = groupListItems(items);
    expect(groups.map((g) => (g.isTask ? 'T' : 'B'))).toEqual(['B', 'T']);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(3);
  });

  it('splits interior plain items (e.g. a stray empty checkbox) into 3 groups', () => {
    const groups = groupListItems([
      { isTask: true },
      { isTask: false },
      { isTask: true },
    ]);
    expect(groups.map((g) => (g.isTask ? 'T' : 'B'))).toEqual(['T', 'B', 'T']);
  });

  it('preserves order and item identity across groups', () => {
    const a = { isTask: false, id: 'a' };
    const b = { isTask: true, id: 'b' };
    const c = { isTask: true, id: 'c' };
    const groups = groupListItems([a, b, c]);
    expect(groups[0].items[0]).toBe(a);
    expect(groups[1].items).toEqual([b, c]);
  });

  it('handles an empty list', () => {
    expect(groupListItems([])).toEqual([]);
  });

  it('round-trips kinds without loss', () => {
    const items = [
      { isTask: false },
      { isTask: true },
      { isTask: false },
      { isTask: false },
      { isTask: true },
    ];
    const flattened = groupListItems(items).flatMap((g) => g.items);
    expect(kinds(flattened)).toEqual(kinds(items));
  });
});
