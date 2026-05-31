The **Changes** tab shows your Git working tree — what's staged, what isn't — alongside Cockpit's side-by-side diff viewer. This is where you review every change (yours and the AI's) before committing.

| Section | What's in it |
|---|---|
| [Status pane — working tree](#status-pane--working-tree) | Two groups (Staged / Unstaged); stage / unstage / discard |
| [Diff View](#diff-view) | Always side-by-side; line numbers; Compact folding; inline comments; minimap |

## Status pane — working tree

Open Explorer (`Cmd+2`) → **Changes** tab. Files are split into **two groups**:

| Group | What's in it |
|---|---|
| **Staged** | Changes in the Git index, ready to commit. |
| **Unstaged** | **Both** files modified since the last commit but not yet staged, **and** untracked files Git hasn't seen yet. Untracked entries carry a `?` icon. |

### Per-group batch buttons (they differ)

Each group's header buttons only show the actions that make sense there:

| Group | Header buttons |
|---|---|
| **Staged** | **Unstage All** — push every staged file back to the working area. |
| **Unstaged** | **Stage All** + **Discard All** — stage everything in one click, or throw away every unsaved change. |

### Per-row actions

Hover any file row and a single button appears at the end of the row:

- Staged row → **Unstage** (move it back to the working area).
- Unstaged row → **Stage** (add it to the index).

Per-file discard doesn't have a row-level button today — use the group-level **Discard All**, or drop into a terminal and run `git restore <file>` / `rm <file>`.

### Selecting a file shows its diff

Click any file in either group and the right pane switches to the **Diff View**.

The comparison baselines depend on which group:

| Selected | Old (left) | New (right) |
|---|---|---|
| **Staged file** | HEAD (last commit) | Staged version |
| **Unstaged file** | Staged version (if any; otherwise HEAD) | Working tree (file on disk) |

So if you stage part of a change and then keep editing, the Unstaged diff shows only the **new** edits — not everything since HEAD.

### No commit field

**Cockpit doesn't commit for you.** There's no commit-message field, no commit button. Stage files in the Status pane, then run `git commit` in any terminal — your shell, a Cockpit terminal bubble, your IDE, whatever you prefer.

This is deliberate: long commit messages don't belong in a single-line field, and Cockpit doesn't want to fight with the commit conventions and hooks you already have.


## Diff View

Cockpit renders every file change — staged / unstaged in the **Changes** tab, commits in the **History** tab, line-anchored ranges in Tech Plan Review — through the same **Diff View**.

### Always side-by-side

The Diff View always renders **side-by-side**: old on the left, new on the right, each with its own horizontal scrollbar but a synchronised vertical scroll. **No "inline" mode to toggle**.

Both sides show the original and new line numbers, with green (added) and red (removed) row highlights.

### Compact mode (default only in the Status pane)

In the **Changes** tab the diff defaults to **Compact** — Cockpit renders the changed lines plus **3 lines of context** and collapses every long stretch of unchanged code into a clickable `+N lines` marker. Click any marker and 20 lines reveal on either side; click again to keep expanding.

The Compact view carries a **Compact / Full** toggle at the top — flip to Full to see the whole file in one go.

**Other entry points** (the **History** tab's commit-detail panel, standalone diff modals, etc.) **default to Full**, not Compact. This is so commit reviews land on the full file by default.

### Minimap

A **minimap** runs down the right edge of the Diff View — the whole file squashed into a vertical bar with **green stripes for additions**, **red for deletions**, **grey for unchanged**. Click anywhere in the minimap to jump there. Handy for spotting the meaningful changes in a long diff.

### Conflicts

When Git has left conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) in a file, the Diff View just renders them as plain text — there's no special conflict-resolution UI. Open the file in your usual editor and pick a side; Cockpit doesn't have a built-in merge tool. Save, then re-stage in the **Changes** tab.
