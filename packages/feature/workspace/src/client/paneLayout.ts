/**
 * What the agent panel puts on screen, given the panes the user set up and
 * whether a diff column is open.
 *
 * A diff column and a second chat pane are the same right half of the panel, so
 * they are mutually exclusive. That exclusion is DERIVED here and nowhere else.
 *
 * The alternative — collapsing `paneTabIds` to one entry when a diff opens —
 * enforces the same rule by mutation, and pays for it twice. It needs a matching
 * rule at every site that can turn either one on (open diff, toggle split, close
 * pane, restore a saved layout), which is the coordination logic a missing model
 * charges you. And it is lossy in a way nothing can undo: opening a diff would
 * silently destroy a split the user built, and closing the diff could not bring
 * it back. Derived, the split is only hidden, and it returns by itself.
 *
 * The corollary is that a diff NEVER becomes a pane. `paneTabIds` still holds
 * nothing but live tab ids, so the pane invariant in useTabState — every pane
 * holds a tab that exists, no two panes hold the same one — is untouched, and
 * `repairPanes` never has to learn that diffs exist.
 */
export interface PaneLayout {
  /**
   * Panes on screen, in on-screen order. The SAME array as `paneTabIds` when no
   * diff is open — identity matters, it is read on every render by components
   * downstream of a memo boundary.
   */
  panes: string[];
  /** Index into `panes` of the focused one. */
  activePane: number;
  /**
   * Panes are laid out as a flex row. Not the same question as `split`: one
   * chat beside a diff column is a row with a single pane in it, and that pane
   * still needs its flex `order`, or the diff column's order competes with DOM
   * position to decide which side is which.
   */
  row: boolean;
  /** Two chats are visible — what the layout controls should reflect. */
  split: boolean;
  /** flex `order` for the diff column: past every pane, so it is always last. */
  diffOrder: number;
}

/**
 * A chat has live, user-visible geometry only when all three layers agree:
 * its tab occupies a pane, the Agent panel is selected, and the parent
 * workspace is showing this project's iframe. The last condition matters for
 * cross-project jumps — an internally selected tab inside a hidden iframe is
 * not active from the reader's point of view.
 */
export function isChatSurfaceActive(
  tabId: string,
  paneTabIds: readonly string[],
  agentViewActive: boolean,
  projectVisible: boolean,
): boolean {
  return projectVisible && agentViewActive && paneTabIds.includes(tabId);
}

export function paneLayout(
  paneTabIds: string[],
  activePane: number,
  activeTabId: string,
  diffOpen: boolean,
): PaneLayout {
  const panes = diffOpen ? [activeTabId] : paneTabIds;
  return {
    panes,
    activePane: diffOpen ? 0 : activePane,
    row: panes.length > 1 || diffOpen,
    split: panes.length > 1,
    diffOrder: panes.length,
  };
}

/**
 * Which tab, if any, is currently blown up to cover the whole pane row.
 *
 * The maximised pane IS the focused pane — not by convention, but because this
 * is the only thing that answers the question, and it answers it by reading
 * `layout.activePane`. There is no second variable to disagree with.
 *
 * That is the whole point of the signature. `maximized` used to be a pane
 * INDEX held next to `activePane`, and the toggle that set it also moved focus,
 * so the two agreed at the moment they were written. They did not stay that
 * way: `setActiveTabId` moves focus on its own whenever you pick a tab that is
 * already showing in the other pane, and it has no reason to know maximising
 * exists. One click on the tab bar and the app was rendering pane 0 full width
 * while pane 1 held the focus — so the composer, the tab-bar highlight and
 * every externally routed message belonged to a column nobody could see.
 *
 * A boolean cannot drift, because it does not say WHERE. Switching tabs now
 * moves the maximise along with the focus, which is also what a user means by
 * clicking a tab while one column fills the screen.
 *
 * Gated on `split` for the same reason the diff column is: with one pane there
 * is nothing to cover, and a stale `true` must not survive into a layout where
 * it would mean something different.
 */
export function maximizedTabId(layout: PaneLayout, maximized: boolean): string | null {
  if (!maximized || !layout.split) return null;
  return layout.panes[layout.activePane] ?? null;
}

/**
 * Visibility and geometry for one chat tab's pane.
 *
 * `panes` is the whole answer: a tab is visible iff it is in the list, and
 * its side is its index. One pane is exactly the old behaviour — the tab is
 * `block`, everything else `hidden`. Tabs are never unmounted, here or below;
 * that is a hard invariant of this app (CLAUDE.md), and panes only promote a
 * second tab out of `hidden`.
 *
 * Visual order is imposed with flex `order`, not by DOM position. The panes are
 * rendered inside tabs.map, so their DOM order is TAB order — which meant a new
 * chat, appended to the end of the tab list, always landed on the right and
 * shoved the previous right-hand pane over to the left, whichever pane had
 * actually been targeted. Reordering the DOM instead is not an option: moving a
 * tab's position would remount it, and tabs are never unmounted here.
 *
 * The divider is a left border on the pane whose ORDER is not 0, not Tailwind's
 * `divide-x` on the container. `divide-x` selects with `& > * + *`, i.e. by DOM
 * position — and DOM position no longer says which side a pane is on, so the
 * rule landed on whichever pane happened to be second in the tab list and
 * vanished from between them as soon as a new chat shuffled that.
 *
 * The active pane is bracketed by a 1px rule on its top AND bottom edge. Both
 * panes are fully live, so "active" decides exactly one thing — where a new or
 * reopened session lands, and which pane owns the shared composer — and a
 * hairline is proportionate. The bottom rule matters more than it looks: the
 * composer sits below BOTH panes, so the only thing tying it to a column is
 * that column's lower edge running into it. The other pane keeps transparent
 * borders of the same width so nothing shifts when focus changes.
 *
 * `row` is NOT `panes.length > 1`. The diff column is a third occupant of the
 * same flex row that is not a pane, so a single chat can be laid out beside
 * something without being split — and a pane in a row needs its `order` even
 * when it is the only one, or the diff column's order competes with DOM
 * position, the exact failure the paragraph above is about.
 *
 * EVERY branch returns its own `position`, and the caller must not add one.
 * This function used to return `absolute` for the maximised pane while the
 * caller's template hardcoded `relative`, which does not resolve the way the
 * class list reads: Tailwind emits `.absolute` before `.relative`, both at the
 * same specificity, so `relative` won and the "maximised" pane quietly stayed a
 * flex item at half width. It also cost a second bug — the maximised branch
 * dropped the `border-y` every split pane carries, and because the pane was
 * still in the row beside its neighbour, that missing 1px showed up as the two
 * header bars sitting a pixel apart. The transparent `border-y` here is what
 * keeps content from shifting as it toggles.
 */
export function paneClass(tabId: string, panes: string[], activePane: number, row: boolean, maximized: boolean): string {
  const at = panes.indexOf(tabId);
  if (at === -1) return 'relative hidden';
  // Maximised: lifted out of the row to cover it, exactly like the diff column
  // and for the same reason — the other pane keeps its layout instead of being
  // collapsed, so restoring is free and nothing under here ever moves. z-30
  // beats the sibling pane's z-20 ✕; `position: absolute` with a z-index opens
  // a stacking context, so this pane's OWN ✕ still sits on top of its content.
  // No focus rule: it is the focused pane by construction (see the toggle) and
  // there is no second pane on screen to distinguish it from.
  if (maximized) return 'absolute inset-0 z-30 border-y border-y-transparent';
  if (!row) return 'relative h-full block';
  // Focus is only meaningful between two panes. Beside a diff column there is
  // one chat, so it carries no rule at all rather than a transparent one —
  // nothing can shift when focus cannot move.
  const focus = panes.length > 1
    ? ` border-y ${at === activePane ? 'border-y-brand' : 'border-y-transparent'}`
    : '';
  const divider = at > 0 ? ' border-l border-border' : '';
  return `relative h-full flex-1 min-w-0${focus}${divider}`;
}
