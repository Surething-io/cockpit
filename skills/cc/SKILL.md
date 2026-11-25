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

Examples below use `cockpit`; only swap in `cockpit-dev` when one of the two dev signals above is present.

## Subcommands

| Subcommand | Purpose |
|---|---|
| (none) / `<path>` | Start server, open project |
| `browser open <url\|path>` | Web page → a Chrome tab; local HTML/file → a console bubble. Prints its id |
| `browser tabs` | Every open Chrome tab with its id |
| `browser <id> <action>` | Drive a tab or bubble |
| `terminal <id> [<action>]` | Read-only observation of a terminal ring buffer |
| `codegraph <subcmd>` | Project code graph (search/symbols/callers/callees/impact/file/coedit/related/affected) |
| `update` | Upgrade to latest npm version |

## Typical usage pattern

Terminal / browser bubbles in the UI carry a 4-char short id (e.g. `bmfb` / `mpcw`). After `/cc` users typically follow with `cockpit <subcmd> <id> <what to do>`, e.g.:

```
/cc cockpit terminal bmfb look at the recent error logs           ← default prod (cockpit)
/cc cockpit browser mpcw take a screenshot of the current page    ← default prod (cockpit)
/cc cockpit codegraph impact searchIndex assess the impact          ← default prod (cockpit)
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

## Opening pages yourself

Do not ask the user to open a page by hand. `open` decides by what you give it:

- **A web page (http/https, localhost included) → a real Chrome tab** in the
  user's browser, in a "Cockpit" tab group, in the background unless `--show`.
  It has the user's logins, and a tab Cockpit opened is already allowed.
- **A local HTML app or file (md/json/csv/image/pdf…) → a console bubble** in
  the project that owns `--cwd` (default: your shell's cwd).

```bash
cockpit browser open http://localhost:3000     # → "wxyz  →  tab opened in Google Chrome"
cockpit browser wxyz snapshot                  # drive it
cockpit browser wxyz close                     # close the tab you opened

cockpit browser open ./report.html             # → "abcd  →  registered and ready" (bubble)
```

Tabs the user already has open are addressable too: `cockpit browser tabs`
lists every tab with its id (the user sees the same id in the OpenCockpit
Bridge toolbar popup). The first command on a tab the user has not allowed
brings it to the front and waits for them to approve it (per tab); if it times
out with "Waiting for the user to allow control", ask them to approve and
re-run — do not loop. When you are done with a tab the user allowed, run
`cockpit browser <id> release` to hand it back. `close` only closes tabs
Cockpit opened, never the user's own. While you act on a tab Chrome may show
"started debugging this browser"; that is expected.

Tabs can do what a person at the keyboard can, so do not hand these to the
user:

- **Dialogs** — an `alert` / `confirm` / `prompt` pauses the page. The command
  that opened it says so, and every other command fails at once with the
  dialog's text until you answer: `dialog accept [--text …]` / `dialog dismiss`.
- **Uploads** — `upload <ref> <file>…` on the file input (snapshot marks it
  `file`) or on the button that opens the file chooser; no OS dialog appears.
- **Inside iframes** — the snapshot includes them, cross-origin ones too; their
  refs look like `f7:e3#v1` and work with every command.
- **Drag** — `drag <ref> <to-ref|css>`, or `--dx/--dy` for sliders.
- **Whole page / one element** — `screenshot --full`, `screenshot <ref>`.
- **Test conditions** — `viewport iphone|android|ipad|<W>x<H>` (clicks become
  taps; add `--reload` when the site picks mobile markup from the User-Agent),
  `theme dark`, `emulate --network offline|slow-3g --cpu 4 --block "<pattern>"
  --media print`. These stay on, with Chrome's debugging bar, until
  `viewport reset` / `theme reset` / `emulate reset` — reset them when done.
  Chrome does not let extensions fake a timezone or locale.

In a background tab Chrome cannot deliver real input into a cross-origin
iframe or turn the wheel; those fall back to DOM events and the output says
so. Run `cockpit browser <id> show` first when real input matters there.

Any bubble id the user shows you works directly, even if that bubble is asleep
or its badge is grey: the command wakes and registers it (its project must be
open in a Cockpit window). Close bubbles you open — a registered bubble never
sleeps. For a bubble, `open` exits **2** when no Cockpit UI picked it up: no
browser window has this project open — check `--cwd`, and ask the user to open
it. It is NOT a reason to retry.

Two things to know about bubbles: they only work for projects that are open in
a Cockpit window, and **previewing a local `.html` runs it with full shell
access** — treat `cockpit browser open ./some.html` as executing that file.

## Getting detailed usage

Every subcommand's `--help` is the canonical reference — **it includes usage, flags, output format, exit codes, and examples.** Read it first:

```bash
cockpit --help
cockpit <subcommand> --help
cockpit codegraph <subsubcmd> --help
```
