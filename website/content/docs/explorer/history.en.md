The **Git history** tab plus a few related views — branches, worktrees, blame — let you walk through who did what, when, and why.

| Section | What's in it |
|---|---|
| [Commit Log](#commit-log) | Newest-first commits, click for diff |
| [Branches](#branches) | Switch / create / delete local & remote |
| [Worktrees](#worktrees) | Parallel checkouts, one per task |
| [Blame](#blame) | Line-by-line authorship |

## Commit Log

The **History** tab shows the commit log of the **currently selected branch**, newest first. The default selection is your HEAD branch, but you can pick any other branch from the top selector to read its log — your git HEAD doesn't move (pure viewer).

Each row carries:

- Short hash
- Author name
- Date (with "2h ago" style relative time)
- Commit subject (first line)

Click a commit and the right side of Explorer expands the **Commit Detail panel** — full message, file tree of what changed, and per-file diff. Click any file in that tree to scroll its diff into view.

To switch which branch the History tab is reading, use the top-of-tab branch selector; see [Branches](/en/docs/explorer/history/#branches).

### What History doesn't do

Same "viewer, not editor" reasoning as the Changes tab:

- **No cherry-pick** from the UI.
- **No revert**, no reset.
- **No rebase** controls.
- **No single-file history view** (you can't ask "what are all the commits that touched this file?" from inside Cockpit).

For any of those, drop into a terminal.

### Big repositories

Commits load lazily, **50 per page** — scroll to the bottom of the list and the next page fetches automatically (`handleCommitListScroll` triggers as long as `hasMoreCommits`).

Blame has **no built-in cache or rate-limit** — every Blame request shells out to `git blame` directly. Large files may take a few seconds on first blame. If that becomes a problem, that's the signal to drop to a terminal and use `git blame -L <range>` to scope the request.


## Branches

Cockpit has a branch selector that lets you switch what the Explorer panel is showing — useful when you want to see the file tree, status, and history of a different branch than the one you're currently on.

### Where it is

Open Explorer → **History** tab. The branch name at the top is the selector. Click it to open a searchable dropdown.

### What you see

The dropdown lists every branch in three groups (in this order):

- **Pinned branches** — branches you've pinned, if any; always at the top, persisted across sessions.
- **Local branches** — every local branch in the repo.
- **Remote branches** — branches that exist on the remote (e.g. `origin/feature-x`).

The branch your git HEAD is on right now is marked **(Current branch)** in the list. A search box at the top filters as you type — handy for repos with hundreds of feature branches.

### What clicking a branch does

Clicking a branch in the dropdown **reloads the History tab against that branch** — you see its commit log, and clicking commits shows that branch's diffs.

It does **not** check the branch out. Your working tree, current `HEAD`, and what's in Status all stay on whatever branch you were on. The branch selector is a viewer.

To actually check a branch out, drop into a terminal and run `git checkout` / `git switch`.

### What there isn't

Cockpit's branch UI is intentionally minimal. The following are not in the UI — use Git on the command line for them:

- Create a new branch
- Delete a branch (local or remote)
- See ahead / behind counts vs the remote
- Tag management
- Stash management

### When branches need their own working trees

If you regularly need to flip between branches *and* keep each branch's working tree intact (especially with builds running), check out [Worktrees](/en/docs/explorer/history/#worktrees) — Cockpit can create and manage Git worktrees from the UI, which is a much better workflow than constantly checking out different branches.


## Worktrees

A Git worktree is a separate working directory that shares the same `.git` data as your main checkout. You can have several worktrees of one repo, each on a different branch, each with its own files on disk — no need to stash and switch when you want to look at someone else's branch alongside your own. Cockpit has a dedicated modal for creating, switching, and removing worktrees.

### Open the worktrees modal

From Explorer's branch selector area (or the project menu), open **Git Worktrees**. The modal lists every worktree of the current repo with:

- Branch name (or `detached` if it's pointing at a specific commit)
- Full filesystem path
- 🔒 lock icon if it's locked
- **(Current)** tag on whichever worktree you're working in right now

### Create a worktree

Two ways:

#### Quick — let Cockpit name it for you

Click **Add Worktree**. Cockpit picks a default branch (it tries `origin/main`, then `origin/master`, then `main`, then `master`) and creates a new branch + worktree based on it. The branch name follows the pattern `<your-git-username>/<random-word>`, e.g. `alice/tepid`. The directory goes next to your main checkout.

Use this when you want a fresh experimental branch and don't care what it's called.

#### From an existing branch

Click **Select Branch**. A searchable list appears with every local and remote branch — except those that are already checked out in another worktree (Git only lets one worktree per branch). Pick one; Cockpit creates a worktree pointing at it.

### Switch to a worktree

Click any worktree in the list (other than the current one). Cockpit adds it as a **new project tab in the same Cockpit window** — top project bar gets another tab, with its own Agent / Explorer / Console. The original worktree stays in the project bar, one click away. So it's "same window, multiple project tabs in parallel", not a new window per worktree.

### Lock a worktree

Click the lock icon on any worktree that isn't the current one. Locking prevents Git from automatically pruning it (`git worktree prune` skips locked ones). Useful when:

- The worktree lives on a slow / removable volume that isn't always mounted.
- You're parking a half-finished branch and don't want to lose track of it.

Click the lock again to unlock.

### Delete a worktree

Click the delete button on a worktree. Cockpit shows a confirmation dialog with the path and branch so you don't accidentally nuke the wrong one. Confirm and it's gone.

This removes the worktree's directory and the Git registration. The branch itself stays — you can re-create a worktree from it later.

### Why use worktrees

The big wins, in practice:

- **Parallel reviews** — open a teammate's PR branch as a worktree while keeping your own branch's IDE/build state untouched.
- **Long-running builds** — start a build on `main`, switch to `feature-x` in a separate worktree, no `git stash` dance.
- **AI-driven branches** — let an agent work on a branch in its own worktree; you keep working on yours in parallel.

The downside: every worktree takes its own disk space for the working tree. The `.git` data is shared.


## Blame

Blame view tells you, for every line of a file, who wrote it, when, and as part of which commit. Use it when you're staring at unfamiliar code and need to know "who can I ask about this?" — or when you're tracking down when a regression was introduced.

### Turning it on

Open any file in the Explorer Code Viewer. Click the **Blame** button in the file's header bar.

Cockpit annotates every line with its blame info. Press `Esc` (or click Blame again) to turn it off.

### What the annotation shows

A narrow column appears next to the line numbers. For each line you see:

- The author's name
- The commit's short hash
- A formatted date (full timestamp visible on hover)

Consecutive lines from the same commit are visually grouped — you get one big "Alice, 2 weeks ago, fa3b21" block for a 20-line function, not 20 repeating rows. The block style makes the meaningful boundaries (where authorship changes) stand out.

Hover any blame row for a tooltip with the full commit subject.

### Jumping from blame to commit

Click any blame line and Cockpit opens the **Commit Detail panel** for that commit — full message, every file in the commit, and per-file diff. This is the standard "what else did Alice touch when she wrote this?" workflow.

### Common uses

- **Finding the person to ask** — blame a confusing function, scroll up to see the author, ask them.
- **Tracing a regression** — git-bisect, but visual: blame the broken line, jump to its commit, look at the diff.
- **Reviewing recent changes in context** — blame a file you haven't touched in months to see which lines came in recently.

### What there isn't

- **No author filter** ("show only Alice's lines" — not implemented).
- **No date filter** ("show only changes from this year" — not implemented).
- **No "ignore whitespace" toggle** — formatting commits show up alongside semantic ones.

For deeper blame work (especially `git log -L` style "history of these lines"), drop into a terminal.

### Performance on big files

Blame has **no built-in cache or rate-limiting** — each time you open Blame, Cockpit shells out to `git blame` directly. Large files may take a few seconds. If that becomes a problem, that's the signal to drop to a terminal and use `git blame -L 100,200 <file>` to scope to a line range.

