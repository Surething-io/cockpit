import { describe, it, expect } from 'vitest';
import { paneLayout, paneClass, maximizedTabId } from './paneLayout';

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

describe('paneClass — one position, and it has to be the right one', () => {
  const POSITIONS = ['static', 'fixed', 'absolute', 'relative', 'sticky'];
  const positionsIn = (cls: string) =>
    cls.split(/\s+/).filter((c) => POSITIONS.includes(c));

  const CASES: Array<[string, string]> = [
    ['hidden pane', paneClass('x', ['a', 'b'], 0, true, false)],
    ['single pane, no row', paneClass('a', ['a'], 0, false, false)],
    ['left pane of a split', paneClass('a', ['a', 'b'], 0, true, false)],
    ['right pane of a split', paneClass('b', ['a', 'b'], 0, true, false)],
    ['pane beside a diff column', paneClass('a', ['a'], 0, true, false)],
    ['maximised pane', paneClass('a', ['a', 'b'], 0, true, true)],
  ];

  it.each(CASES)('%s declares exactly one position', (_name, cls) => {
    // The caller must add none of its own. It used to add `relative`, which beat
    // the maximised branch's `absolute` (Tailwind emits .absolute first, same
    // specificity) and left the "maximised" pane at half width.
    expect(positionsIn(cls)).toHaveLength(1);
  });

  it('maximised is absolute and covers its container', () => {
    const cls = paneClass('a', ['a', 'b'], 0, true, true);
    expect(positionsIn(cls)).toEqual(['absolute']);
    expect(cls).toContain('inset-0');
    expect(cls).not.toContain('flex-1');
  });

  it('maximised keeps the same 1px border box as an unmaximised pane', () => {
    // Both panes in a split carry `border-y`. Dropping it while maximised put
    // the two header bars a pixel apart; keeping a transparent one also stops
    // the content shifting as the pane toggles.
    const split = paneClass('a', ['a', 'b'], 0, true, false);
    const max = paneClass('a', ['a', 'b'], 0, true, true);
    expect(split).toContain('border-y');
    expect(max).toContain('border-y');
  });

  it('only the maximised pane leaves the flex row', () => {
    expect(paneClass('a', ['a', 'b'], 0, true, false)).toContain('flex-1');
    expect(paneClass('b', ['a', 'b'], 0, true, false)).toContain('flex-1');
  });
});

describe('maximizedTabId — the maximised pane is the focused pane', () => {
  const split = (activePane: number) => paneLayout(['a', 'b'], activePane, ['a', 'b'][activePane], false);

  it('is nothing at all when not maximised', () => {
    expect(maximizedTabId(split(0), false)).toBeNull();
  });

  it('is the focused pane when maximised', () => {
    expect(maximizedTabId(split(0), true)).toBe('a');
    expect(maximizedTabId(split(1), true)).toBe('b');
  });

  it('FOLLOWS the focus — the bug this shape exists to prevent', () => {
    // Repro: maximise the left pane, then click the RIGHT pane's tab in the tab
    // bar. setActiveTabId sees that tab already showing in the other pane, so it
    // moves focus and leaves the layout alone (useTabState setActiveTabId).
    //
    // While "which pane is maximised" was its own index, it stayed on pane 0
    // while focus went to pane 1: the app rendered 'a' full width, but the
    // composer, the tab-bar highlight and every externally routed message all
    // belonged to 'b' — a column nobody could see.
    const beforeClick = maximizedTabId(split(0), true);
    const afterClick = maximizedTabId(split(1), true);
    expect(beforeClick).toBe('a');
    expect(afterClick).toBe('b');
    expect(afterClick).not.toBe(beforeClick);
  });

  it('never survives into a layout with nothing to cover', () => {
    // One pane, or a pane beside a diff column: both are `split: false`, and a
    // stale `true` must not mean something there.
    expect(maximizedTabId(paneLayout(['a'], 0, 'a', false), true)).toBeNull();
    expect(maximizedTabId(paneLayout(['a', 'b'], 0, 'a', true), true)).toBeNull();
  });

  it('agrees with paneClass: exactly one pane is absolute, and it is the focused one', () => {
    const layout = split(1);
    const max = maximizedTabId(layout, true);
    const classes = layout.panes.map((id) =>
      paneClass(id, layout.panes, layout.activePane, layout.row, max === id),
    );
    expect(classes.filter((c) => c.includes('absolute'))).toHaveLength(1);
    expect(classes[1]).toContain('absolute');   // pane 1 is the focused one
    expect(classes[0]).not.toContain('absolute');
  });
});
