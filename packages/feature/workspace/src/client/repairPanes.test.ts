import { describe, it, expect } from 'vitest';
import { repairPanes } from './useTabState';
import type { TabInfo } from './useTabState';

const tab = (id: string): TabInfo => ({ id, cwd: '/w', title: id });
const ids = (r: { panes: string[] }) => r.panes;

describe('repairPanes — the pane invariant', () => {
  it('leaves a healthy layout untouched', () => {
    const tabs = [tab('a'), tab('b'), tab('c')];
    const r = repairPanes(['a', 'b'], tabs, '/w');
    expect(ids(r)).toEqual(['a', 'b']);
    expect(r.created).toEqual([]);
  });

  it('refills a pane whose tab is gone, preferring an unused tab', () => {
    // 'b' was closed elsewhere; pane 1 must not keep pointing at it.
    const tabs = [tab('a'), tab('c')];
    const r = repairPanes(['a', 'b'], tabs, '/w');
    expect(r.panes[0]).toBe('a');
    expect(r.panes[1]).toBe('c');
    expect(r.created).toEqual([]);
  });

  it('never lets two panes hold the same tab', () => {
    const tabs = [tab('a')];
    const r = repairPanes(['a', 'a'], tabs, '/w');
    expect(r.panes[0]).toBe('a');
    expect(r.panes[1]).not.toBe('a');
    expect(r.created).toHaveLength(1);          // nothing else to give it
    expect(r.panes[1]).toBe(r.created[0].id);
  });

  it('creates a blank chat only when there is nothing left to point at', () => {
    const r = repairPanes(['gone', 'alsoGone'], [], '/w');
    expect(r.created).toHaveLength(2);
    expect(new Set(r.panes).size).toBe(2);
    expect(r.panes).toEqual(r.created.map((t) => t.id));
  });

  it('does not steal a tab a later pane still legitimately holds', () => {
    // pane 0 is vacant, pane 1 validly holds 'b' — the fix must not take 'b'.
    const tabs = [tab('a'), tab('b')];
    const r = repairPanes(['gone', 'b'], tabs, '/w');
    expect(r.panes[1]).toBe('b');
    expect(r.panes[0]).toBe('a');
  });

  it('fills an empty slot on the restore path (unresolved session id)', () => {
    const tabs = [tab('a'), tab('b')];
    const r = repairPanes(['a', ''], tabs, '/w');
    expect(r.panes).toEqual(['a', 'b']);
  });

  it('handles a single pane', () => {
    const tabs = [tab('a')];
    expect(ids(repairPanes(['a'], tabs, '/w'))).toEqual(['a']);
    expect(ids(repairPanes(['gone'], tabs, '/w'))).toEqual(['a']);
  });
});
