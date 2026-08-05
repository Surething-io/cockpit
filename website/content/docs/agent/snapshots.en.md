Every time the AI runs a tool that can touch your files — an `Edit`, a `Write`, a `Bash` command, a Task subagent, an MCP tool — Cockpit takes a **snapshot of your project**. The result is a git-history-style timeline for each reply: one entry per tool call, each showing the **real on-disk diff** that call produced.

| Section | What's in it |
|---|---|
| [Opening the viewer](#opening-the-viewer) | The file-diff icon on a reply |
| [Reading the timeline](#reading-the-timeline) | One commit per tool call |
| [How snapshots work](#how-snapshots-work) | Shadow git repo, fully local |
| [Retention & disk usage](#retention--disk-usage) | 7-day history, size guards |
| [Concurrent sessions](#concurrent-sessions) | Attribution markers |

## Opening the viewer

Hover any assistant reply that ran file-touching tools and click the **file-diff icon** in its toolbar ("View all file changes"). It works for live replies and for old sessions you reopen — snapshots are keyed to the tool calls themselves.

Before this existed, the diff was reconstructed from the tool's *parameters*, which had two blind spots: **Bash changes were invisible** (a `sed -i`, a code generator, an `npm install` that patches files — none of it showed), and multiple edits to the same file could drift from what actually landed on disk. Snapshots close both gaps: what you see is what the disk said.

## Reading the timeline

The viewer mirrors the Explorer's [History tab](/en/docs/explorer/history/):

- **Left: one entry per tool call**, in execution order — short hash, time, and a subject like `[Write] nebula/codes.py`. This is the AI's edit *sequence*, not a merged blob: you can replay how the change was built step by step.
- **Right: the selected call's detail** — tool name, file tree with per-file `+/-` line counts, and a split diff view. A **compact/full** toggle collapses unchanged stretches (GitHub-style) or shows every line.
- Files the tool didn't declare but that changed in the same window get a **purple dot** — see [Concurrent sessions](#concurrent-sessions).

If no snapshot exists for a message (history older than the retention window, or snapshots just enabled), the viewer falls back to parameter reconstruction and labels it **"reconstructed"** — so you always know whether you're looking at disk truth or a best-effort rebuild.

## How snapshots work

Cockpit keeps a **shadow git repository** per project under `<data dir>/snapshots/` (`~/.cockpit/snapshots/` by default):

- Your project's own `.git` is **never touched** — the shadow repo has its own object store and only reads your working tree.
- Your project's `.gitignore` is honored, so `node_modules/`, build output, and the like never enter a snapshot. Common secret patterns (`.env*`, `*.pem`, SSH keys) are excluded even for projects without a `.gitignore`.
- Everything is **local**. Snapshots never leave your machine.
- All engines are covered — Claude, Codex, DeepSeek, GLM, Kimi, Ollama — because the snapshot hook sits on the one code path every engine's tool events flow through.
- Read-only tools (`Read`, `Grep`, web search, …) are skipped, and a tool call that changed nothing produces no entry.

## Retention & disk usage

Snapshots are deliberately short-lived — they're a review aid, not a backup:

- History is kept for **7 days** (one branch per day; expired days are deleted and their objects reclaimed immediately).
- A project untouched for **30 days** has its shadow repo removed entirely; so do repos whose project directory no longer exists.
- Size guards keep runaway projects in check: files over **2 MB** are skipped, and a change set over **50,000 files or 1 GB** suspends snapshotting for that project (with a log warning) rather than eating your disk.
- Cost is modest in practice: a 13 GB monorepo with ~100 MB of tracked sources compresses to a ~74 MB shadow repo, and each subsequent snapshot stores only the changed files (~80 ms per tool call).

Tunables, if you need them, are environment variables — see the [CLI reference](/en/docs/reference/cli/#environment-variables): `COCKPIT_SNAPSHOT_KEEP_DAYS`, `COCKPIT_SNAPSHOT_REPO_TTL_DAYS`, `COCKPIT_SNAPSHOT_MAX_FILE_KB`.

## Concurrent sessions

Several sessions can work in the same project directory at once. Snapshots share one timeline per directory, and attribution is **best effort**: files a tool explicitly declared (an `Edit`'s target) are shown normally, while files that changed in the same window but weren't declared carry a purple **concurrent-change** marker — likely another session or an external process. For `Bash` calls, which declare nothing, all changes in the window are attributed to the call.
