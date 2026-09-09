import { describe, it, expect } from 'vitest';
import { paneLayout } from './paneLayout';

describe('paneLayout — the diff column and the split are one right half', () => {
  it('is a pass-through when no diff is open', () => {
    const paneTabIds = ['a', 'b'];
    const l = paneLayout(paneTabIds, 1, 'b', false);
    // Same ARRAY, not just equal: this is read past a memo boundary every render.
    expect(l.panes).toBe(paneTabIds);
    expect(l.activePane).toBe(1);
    expect(l.split).toBe(true);
    expect(l.row).toBe(true);
  });

  it('single pane, no diff: not a row at all', () => {
    const l = paneLayout(['a'], 0, 'a', false);
    expect(l.split).toBe(false);
    expect(l.row).toBe(false);
  });

  it('a diff hides the split down to the pane you were focused on', () => {
    const l = paneLayout(['a', 'b'], 1, 'b', true);
    expect(l.panes).toEqual(['b']);   // the FOCUSED pane survives, not pane 0
    expect(l.activePane).toBe(0);
    expect(l.split).toBe(false);      // layout controls must reflect the screen
    expect(l.row).toBe(true);         // …but it is still a row: chat | diff
  });

  it('a diff beside a single pane is also a row', () => {
    const l = paneLayout(['a'], 0, 'a', true);
    expect(l.panes).toEqual(['a']);
    expect(l.row).toBe(true);
    expect(l.split).toBe(false);
  });

  it('the diff column always orders after every pane', () => {
    // The failure this guards: with one visible pane the pane takes order 0 and
    // a diff column left to DOM position could land on the LEFT.
    for (const [panes, active, activeId, diff] of [
      [['a', 'b'], 0, 'a', true],
      [['a', 'b'], 1, 'b', true],
      [['a'], 0, 'a', true],
    ] as const) {
      const l = paneLayout([...panes], active, activeId, diff);
      const paneOrders = l.panes.map((_, i) => i);
      expect(Math.min(...paneOrders.map((o) => l.diffOrder - o))).toBeGreaterThan(0);
    }
  });

  it('closing the diff gives back the exact split that was there', () => {
    // The whole reason the exclusion is derived rather than enforced: opening a
    // diff must not cost the user the layout they built.
    const paneTabIds = ['a', 'b'];
    const opened = paneLayout(paneTabIds, 1, 'b', true);
    expect(opened.split).toBe(false);

    // paneTabIds is untouched by the open — nothing mutated it.
    expect(paneTabIds).toEqual(['a', 'b']);

    const closed = paneLayout(paneTabIds, 1, 'b', false);
    expect(closed.panes).toBe(paneTabIds);
    expect(closed.activePane).toBe(1);
    expect(closed.split).toBe(true);
  });
});
