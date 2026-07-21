The Console panel has one **command input** at the bottom. Every time you hit Enter, Cockpit runs a fixed dispatch order to decide what kind of bubble opens: alias expansion → plugin match → PTY command list → one-shot command. This page is the cheat sheet for what triggers what.

## Dispatch order

```
1. Alias expansion ── if firstWord matches an alias, replace with the
                      expanded command line
2. Plugin match ──── if any plugin's match(input) returns true, open
                      that bubble
3. PTY list ──────── if firstWord is in the hard-coded set below, open
                      an interactive terminal
4. Fallback ──────── one-shot command bubble (runs once, shows output)
```

The order means aliases always win first: if `db = postgresql://user@localhost/mydb`, typing `db` expands to the connection string and *then* gets caught by the PostgreSQL plugin.

## Plugin triggers (by protocol prefix)

| Prefix | What opens |
|---|---|
| `http://…` / `https://…` | **Browser bubble** — drives a real Chrome tab |
| `postgresql://…` / `postgres://…` | **PostgreSQL bubble** |
| `mysql://…` | **MySQL bubble** |
| `redis://…` / `rediss://…` (TLS) | **Redis bubble** |
| `neo4j://…` / `neo4j+s://…` / `bolt://…` / `bolt+s://…` | **Neo4j bubble** |
| Any path ending in `.ipynb` | **Jupyter bubble** |

> **Case handling**: browser and database plugins all `toLowerCase()` before matching, so `POSTGRESQL://` works the same as `postgresql://`. **Jupyter is case-sensitive** — the `.ipynb` suffix has to be lowercase, so `foo.IPYNB` won't be detected as a notebook.

## PTY command list (opens interactive terminal)

If `firstWord` is in the set below, you get an interactive PTY (full terminal — cursor control, full-screen apps, all of it):

```
zsh  bash  sh  fish  nu
python  python3  node  irb  lua
vim  nvim  vi  nano  emacs
top  htop  less  man
```

Only the first word is checked, so `vim foo.txt` or `python -i script.py` still count as PTY.

The list is **hard-coded** — your favourite REPL not on it won't be auto-detected. Workaround: set an alias that points it at one of the listed commands.

## Fallback: one-shot command bubble

Anything else gets treated as a one-shot command (`ls`, `make build`, `pytest …`) — runs once, prints its output, exits.

## HTML apps (leading window icon in the row)

The **first** icon in the row left of the input opens the **HTML panel** — a card grid of the HTML apps you've bookmarked; click one to run it in a Console bubble. For the panel itself (bookmarking, preview, the `~/.cockpit/html.json` registry) see [HTML apps](/en/docs/agent/html-apps/).

## Quick commands (⚡ button in the row left of the input)

The ⚡ icon in the row of buttons left of the text input opens the **Quick Commands** popover — save long command lines once, fire them with a single click. The popover has two sections:

| Scope | Where it's stored |
|---|---|
| **Global** | Shared across every project on this machine |
| **Project** | Visible only in the current `cwd`'s project |

### Adding

Each section has a `+` button to add a row. Fill in two fields:

- **Name** — short label like `dev`, `db-stg`, `watch-test`.
- **Command** — the actual command line to run (can be a protocol URI, a PTY command, a one-shot command — anything).

Press Enter to save.

### Running

Click the ▶ icon at the start of any row. **Running goes through the same dispatch order as pressing Enter in the input box** — a saved `postgresql://...` opens a PostgreSQL bubble, `vim foo` opens a PTY, `make build` runs as one-shot, etc.

### Deleting

The ✕ icon at the end of each row. Deletes immediately, no confirmation.

### Relation to the input bar's `/` menu

They share **the same underlying data**. Clicking the ⚡ button ≈ typing `/` in the input box and filtering through the same list. The two views differ only in interaction style:

- **⚡ button**: a popover with both sections side by side and add / delete UI.
- **`/` menu**: in-place filtering — pick and run, no editing.

Use ⚡ to set things up, use `/` for everyday running.

## Multiple bubbles, side by side

Every Enter creates a new bubble — they stack in the panel and you can drag any of them around to reorder. Two PostgreSQL connections to different databases, two browser bubbles on different sites, a terminal and a Jupyter notebook all at once: no problem.

`Cmd+M` maximises the focused bubble; press it again or hit `Esc` to restore.

## Input shortcuts

- **`↑` / `↓`** — walk through input history. Cockpit records an entry both when a shell command **finishes** and when a **plugin bubble is created** — not only on completion.
- **`Tab`** — completion. Cockpit POSTs to `/api/terminal/autocomplete` with cwd, the current input, and the cursor position. A single suggestion fills in; multiple suggestions show above the input bar and you cycle through them by pressing `Tab` again.
- **`Enter`** — run (using the dispatch order above).
- **Leading `/`** — opens the **quick commands** menu (separate from the Agent panel's Skills menu — they're two different things). Type to filter, use `↑/↓` to choose, `Enter` or `Tab` to apply. Quick commands are user-defined short aliases for longer command lines; see [Aliases & Env Vars](/en/docs/console/aliases-env/).

## When auto-detect gets it wrong

The rules above are deliberately conservative — anything that doesn't match the PTY list and isn't picked up by a plugin gets treated as a one-shot command. If you ever wanted to run a *file* called `redis://` (unlikely), you'd have to rename it; there's no escape for the parser. In practice this isn't a problem; the protocol prefixes are unambiguous.
