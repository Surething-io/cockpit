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
