---
name: cc
description: "Drive the running Cockpit server through the `cockpit` CLI — open and control browser bubbles, observe terminals, query the codegraph."
---

Enter Cockpit CLI operation mode.

The Cockpit CLI is a thin local client over the running Cockpit server: each invocation forwards to the server and reuses its CodeIndex / caches / git views.

CLI entry point selection (**default = prod**):

- Default: **`cockpit`** (prod, port 3457) — use this when no explicit dev signal is given.
- Switch to `cockpit-dev` (dev, port 3456) ONLY when the user explicitly signals dev mode, via one of:
  1. They write `cockpit-dev ...` directly in the task text.
  2. The first word after `/cc` is `dev` (e.g. `/cc dev terminal bmfb check the errors`).
- `cock` is the prod-only short alias of `cockpit`; behaviour is identical. There is no short alias for dev.

Examples below use `cockpit`; only swap in `cockpit-dev` when one of the two dev signals above is present.

## Subcommands

| Subcommand | Purpose |
|---|---|
| (none) / `<path>` | Start server, open project |
| `browser open <url>` | Create a browser bubble (auto-registered) and print its id |
| `browser <id> <action>` | Drive browser bubbles |
| `terminal <id> [<action>]` | Read-only observation of a terminal ring buffer |
| `codegraph <subcmd>` | Project code graph (search/callers/callees/impact/file/coedit/context/related/risk/affected) |
| `update` | Upgrade to latest npm version |

## Typical usage pattern

Terminal / browser bubbles in the UI carry a 4-char short id (e.g. `bmfb` / `mpcw`). After `/cc` users typically follow with `cockpit <subcmd> <id> <what to do>`, e.g.:

```
/cc cockpit terminal bmfb look at the recent error logs           ← default prod (cockpit)
/cc cockpit browser mpcw take a screenshot of the current page    ← default prod (cockpit)
/cc cockpit codegraph risk searchIndex assess the impact          ← default prod (cockpit)
/cc dev terminal aqou check the errors                            ← dev signal #2 → use cockpit-dev
/cc cockpit-dev codegraph file packages/...                       ← dev signal #1 → use cockpit-dev
```

When you receive such input:
1. Treat `<id>` as the concrete bubble identifier and pass it to the subcommand
2. Run `cockpit <subcmd> <id>` (or `<subcmd> --help`) first to see supported actions
3. Pick the right action to fulfil the user's task

## When you don't know which id to use — list bubbles first

If the user refers to a bubble semantically ("the alloydb proxy terminal" / "the admin page") rather than by id, list every bubble in the current project — each one carries any user-set title:

```bash
cockpit connection list --cwd $PWD
```

Output rows are TAB-separated: `<type>  <shortId>  <title>  <projectCwd>  <command-or-url>`. Match the user's reference against the title, take the `<shortId>`, then proceed with the typical usage pattern. Unnamed bubbles show `(none)` for title — fall back to the `<command>` column (terminal's command string / browser's URL) to disambiguate.

## When no bubble exists — open one yourself

Do not ask the user to open a browser bubble by hand. `open` creates one in the
project that owns `--cwd` (default: your shell's cwd), registers its bridge
automatically, and prints the short id to drive it with:

```bash
cockpit browser open http://localhost:3000     # → "abcd  →  registered and ready"
cockpit browser abcd snapshot                  # drive it as usual
cockpit browser abcd close                     # remove the bubble when done
```

Close what you open — a registered bubble never sleeps, so leaving them behind
costs the user a live iframe + WebSocket each.

`open` exits **2** when it created the bubble but no Cockpit UI picked it up
(nothing is driving it yet). That means no browser window has this project open
— check `--cwd` points at the right project, and ask the user to open it. It is
NOT a reason to retry.

Two things `open` cannot do: it only works for projects that are open in a
Cockpit window, and **previewing a local `.html` runs it with full shell
access** — treat `cockpit browser open ./some.html` as executing that file.

## Getting detailed usage

Every subcommand's `--help` is the canonical reference — **it includes usage, flags, output format, exit codes, and examples.** Read it first:

```bash
cockpit --help
cockpit <subcommand> --help
cockpit codegraph <subsubcmd> --help
```
