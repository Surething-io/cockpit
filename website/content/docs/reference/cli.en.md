The Cockpit CLI is a thin layer over the running Cockpit server's HTTP API. Two binaries are installed by `npm install -g @surething/cockpit`: **`cockpit`** (canonical name) and **`cock`** (short alias) — identical. The server itself runs continuously; sub-commands speak HTTP to `localhost:3457` to inspect or drive what's open in your panels.

| Command | Purpose |
|---|---|
| [`cockpit`](#cockpit-and-cock) | Start the server (the main entry point) |
| [`cockpit browser`](#cockpit-browser) | Drive a Browser bubble — navigate, click, evaluate JS, capture network |
| [`cockpit terminal`](#cockpit-terminal) | Read a Terminal bubble's output (read-only; no stdin) |
| [`cockpit codegraph`](#cockpit-codegraph) | Query the project-wide code index from a shell |
| [`cockpit connection`](#cockpit-connection) | List all bubbles (terminal + browser) with their titles |
| [`cockpit update`](#cockpit-update) | Upgrade to the latest version |

## cockpit and cock

The `cockpit` binary is the main entry point. Its short alias is `cock` — both are installed when you `npm install -g @surething/cockpit`.

### Usage

```text
cockpit [path] [options]
cock    [path] [options]
```

The two commands are identical; pick whichever you prefer to type.

### Common forms

Start in the current directory:

```bash
cockpit
```

Start in a specific project:

```bash
cockpit ~/code/my-project
```

Start without auto-opening the browser:

```bash
cockpit . --no-open
```

Start on a different port:

```bash
cockpit . --port 4000
```

Show the version:

```bash
cockpit -v
```

### Options

| Flag | Description |
|---|---|
| `-v`, `--version` | Print the version and exit. |
| `-h`, `--help` | Show inline help. |
| `--port <n>` | Listen on a non-default port. Default `3457`. |
| `--no-open` | Don't auto-open the browser after the server starts. |
| `[path]` | Working directory to open. Defaults to `process.cwd()`. |

### Default port

Cockpit listens on port **3457**. You can override per-run with `--port`, or make it permanent by writing to `~/.cockpit/server.json`:

```json
{ "port": 4000 }
```

The per-run flag wins when both are set.

### Sub-commands

`cockpit` itself starts the server. Two sub-commands are used to drive Cockpit from external scripts (CI, ChatOps, automation):

| Sub-command | Purpose |
|---|---|
| `cockpit browser <id> <action>` | Drive a running Browser bubble (navigate, click, evaluate JS, capture network, …) |
| `cockpit terminal <id> <action>` | Read from a running Terminal bubble (`list` / `output` / `wait`; read-only) |

Both target an already-running Cockpit server at `localhost:3457`. They're the same APIs the in-app UI uses; exposing them as CLI commands lets you script the bubbles from anywhere.

See:

- [`cockpit browser`](#cockpit-browser) — full action list (25+ actions: snapshot, click, type, network, perf, …)
- [`cockpit terminal`](#cockpit-terminal) — list / output / wait (read-only)

### Upgrading

```bash
cockpit update
```

Equivalent to `npm install -g @surething/cockpit@latest`. See [`cockpit update`](#cockpit-update) for what gets preserved across upgrades.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Normal exit (server stopped cleanly) |
| `1` | Server failed to start (port in use, permission denied, missing Node, …) |
| `130` | Killed by `Ctrl+C` (`SIGINT`) |

### Environment variables

| Variable | Effect |
|---|---|
| `COCKPIT_PORT` | Same as `--port`, used by some downstream tools (`/cg` curl snippets, etc.). |
| `PORT` | Fallback if `COCKPIT_PORT` is unset. |

## cockpit browser

`cockpit browser <id> <action>` (or `cock browser` for the short form) drives a Browser bubble in your running Cockpit instance from outside — from the AI in a chat, from a shell script, from CI, from anywhere.

The `<id>` is the short ID badge from the Browser bubble's title bar. Click the badge to register the bubble and copy a starter command to your clipboard.

### Quick examples

```bash
# What's currently on the page?
cock browser xa7k2 url
cock browser xa7k2 title

# Inspect the DOM and find a button
cock browser xa7k2 snapshot
cock browser xa7k2 click e5            # 'e5' is a ref from the snapshot

# Type into an input
cock browser xa7k2 type e3 "hello"
cock browser xa7k2 fill e7 "search query"

# Navigate
cock browser xa7k2 navigate --url https://example.com
cock browser xa7k2 back
cock browser xa7k2 reload --noCache

# Capture screen and network
cock browser xa7k2 screenshot
cock browser xa7k2 network --status 4xx,5xx
cock browser xa7k2 perf

# Run arbitrary JS
cock browser xa7k2 evaluate "document.title"
cock browser xa7k2 evaluate --all-frames "await fetch('/api/x').then(r=>r.json())"
```

### Full action list

#### Inspection

| Action | What it does |
|---|---|
| `list` | List every Browser bubble currently registered |
| `snapshot` | Element tree of the page; each element has a `ref` like `e5` for use in other actions |
| `screenshot` | PNG of the page, saved to `/tmp` and the path printed |
| `url` | Current URL |
| `title` | Page title |
| `bounds <ref>` | Position and size of an element |
| `attrs <ref>` | All HTML attributes of an element |
| `computed <ref>` | Computed CSS for an element |
| `events <ref>` | Event listeners attached to an element |
| `cookies` | All cookies for the page |
| `storage --type local\|session` | localStorage or sessionStorage contents |
| `theme --mode dark\|light` | Force the bubble's theme |

#### Interaction

| Action | What it does |
|---|---|
| `click <ref>` | Click an element |
| `type <ref> <text>` | Type into an input |
| `fill <ref> <value>` | Set the value of an input or `<select>` |
| `hover <ref>` | Hover over an element |
| `focus <ref>` | Focus an element |
| `scroll --direction up\|down\|left\|right` | Scroll the page |
| `key <key>` | Press a key (`Enter`, `Ctrl+A`, `Shift+Tab`, …) |
| `wait --text <text>` / `--time <ms>` / `--ref <ref>` / `--url <url>` | Wait for a condition |

#### Navigation

| Action | What it does |
|---|---|
| `navigate --url <url>` | Go to a URL |
| `reload [--noCache]` | Reload (optionally bypassing cache) |
| `back` | Go back one history entry |
| `forward` | Go forward one history entry |

#### JavaScript

| Action | What it does |
|---|---|
| `evaluate <js>` | Run a JS expression in the page; result printed as JSON. `--all-frames` runs in every iframe. |

#### Network

| Action | What it does |
|---|---|
| `network [--status <code>] [--method <method>] [--type <type>] [--clear]` | List captured network requests with filters |
| `network_record start [--url <pat>] [--method <m>] [--status <code>]` | Start recording request/response bodies |
| `network_record stop` | Stop recording |
| `network_record status` | Whether recording is on |
| `network_detail <reqId>` | Full request/response detail for one request |
| `console [--level error\|warn\|info\|debug] [--clear]` | Console messages |
| `perf [--metric timing\|memory\|resources]` | Performance metrics including Core Web Vitals |

#### Assertion (for scripts)

| Action | What it does |
|---|---|
| `assert --ref <ref> --visible true\|false` (and similar) | Check a condition. Exits non-zero if the assertion fails — useful in CI. |

### Output format

Most actions return **JSON** on stdout — easy to pipe into `jq`, `gron`, or to read from the AI. `url`, `title`, and `network_detail` return plain text. `screenshot` returns a file path.

### Exit codes

`0` on success, non-zero on failure (bad ref, network error, assertion failure). See the [main CLI page](#cockpit-and-cock) for the full exit code list.

## cockpit terminal

`cockpit terminal <id> <action>` (or `cock terminal`) **reads** from a Terminal bubble in your running Cockpit — pulls the buffered output or waits for a running command to settle.

> Note: the terminal CLI is intentionally **read-only**. There is **no `stdin`** and **no `follow`** (live streaming). The code comment says: "read-only by design; the write side belongs to the Bash tool / web UI." For interactive control, drive the bubble inside Cockpit's UI, or use a Browser bubble + `cock browser` for automation.

The `<id>` is the short ID badge from the Terminal bubble's title bar. Click the badge to register the bubble and copy a starter command to your clipboard.

### Full action list

| Action | What it does |
|---|---|
| `list` | List every Terminal bubble currently registered. Shows status (running / idle) and the command in each. |
| `output` | Print the entire buffered output of the terminal — the full history from when the bubble started. |
| `wait` | Block until the currently-running command settles. Useful in scripts that need to "wait for `npm run build` to finish before continuing". |

### Quick examples

```bash
# Find your bubbles
cock terminal list

# Snapshot what's on screen now
cock terminal xy789 output

# Wait for npm run build to finish
cock terminal xy789 wait

# Then look at the result
cock terminal xy789 output | tail -50
```

### When to use this

Main patterns:

- **AI reads what your shell is doing through the bubble.** Run `npm run dev` in a Terminal bubble. Hand `cock terminal <id>` to the AI in chat — it can `output` for recent logs and `wait` for a build to settle.
- **CI / scripts observe a long-running command from outside.** A launcher script kicks off `npm run dev` in a Cockpit terminal; another script periodically runs `cock terminal <id> output` to scrape logs and assert.

### Limits

The Terminal CLI is intentionally lighter than the Browser CLI:

- **No write to stdin.** You can't push commands into the terminal process from the CLI.
- No screen-scraping with structured selectors (`output` gives you the raw buffer, you parse it yourself).
- No window-resize, signals, or `Ctrl+C`-style interrupt actions.

For full interactive control (`Ctrl+C`, typing commands, etc.), interact with the bubble in Cockpit's UI directly.

## cockpit codegraph

`cockpit codegraph` queries the project-wide code index that powers the in-product [CodeGraph](/en/docs/explorer/search/#codegraph) feature (`/cg` mode), but from your shell so it composes with scripts, CI, and Unix pipelines.

The Cockpit server must be running — the CLI talks to it over HTTP on the local port.

### Two families of subcommands

**Lookups** — coordinates only (file paths + line numbers), mirroring the in-product API:

| Subcommand | What it does |
|---|---|
| `search <query>` | Find symbols by name. Returns file + qname hits. |
| `callers <qname> [--file PATH]` | Direct callers of a symbol. |
| `callees <qname> [--file PATH]` | What a symbol calls. |
| `impact <qname> [--depth N=2]` | Transitive callers, BFS. Use `risk` for ranked output. |
| `file <path>` | Symbol tree (functions/classes) inside a file. |
| `coedit <path> [--commits N=100]` | Files co-edited in git history alongside this one. |

**Analytics** — blended scoring across PPR / TF-IDF / Louvain communities / co-edit:

| Subcommand | What it does |
|---|---|
| `context --query Q [--cursor C] [--open F1,F2,…] [--top N=15]` | Top-K semantically relevant coordinates for a free-form question. |
| `related <qname> [--top N=10]` | Broader neighbours: callers + callees + PPR + co-edit + community. |
| `risk <qname> [--depth N=2] [--top N=20]` | Risk-scored impact + suggested tests. |
| `affected <files…\|--stdin> [--depth N=10] [--filter G] [--as-cmd RUNNER]` | Test files transitively affected. CI-friendly. |

### Common flags

```bash
--json             # Raw JSON response (full schema; see per-cmd --help)
--help, -h         # Subcommand-specific help (output format + exit codes + examples)
```

### Output format (plain text)

TAB-separated, one row per result. Pipeable into `cut`, `awk`, `fzf`, etc.

```text
search    sym\t<file>:<line>\t<kind>\t<qname>            or  file\t<file>
callers   <file>:<line>\t<qname>\t[<callLines>]
callees   <file>:<line>\t<qname>\t[<callLines>]
impact    d=<depth>\t<file>:<line>\t<qname>
file      <kind>\t<startLine>-<endLine>\t<qname>
coedit    <cooccur>/<total>\t<file>                  # after a '# history' comment
context   <score>\t<file>:<line>\t<qname>\t[<signals>]
related   <score>\t<file>:<line>\t<qname>\t<<relations>>
risk      <score>\td=<depth>\t<file>:<line>\t<qname>\t[<tags>]
affected  <file>                                     # one test path per line
```

Pass `--json` to get the full structured payload instead.

### Diagnostics on stderr

Designed so warnings don't break shell pipelines:

```text
# ambiguousIn: <files…>     Same qname in multiple files — pass --file
# cursor: <note>            Cursor format auto-corrected ('.' → '::', etc.)
# degraded: <reason>        analytics-warming / coedit-unavailable / truncated
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Output produced |
| `1` | Empty result (no callers, no tests, no hits) — short-circuits shell pipelines |
| `2` | Argument or 4xx server error |
| `3` | Cockpit server not reachable. Start it with `cock <project-path>`. |

### Prerequisites

The CLI hits `http://localhost:3457` by default (the **same port** as the main Cockpit server — not a separate codegraph port). Override via:

```bash
COCKPIT_HOST=… COCKPIT_PORT=… cock codegraph …
```

### Examples

```bash
cock codegraph search getCodeIndex
```

```bash
cock codegraph related getCodeIndex --top 5
```

```bash
cock codegraph risk searchIndex --depth 2
```

```bash
# Newline-separated test paths for whatever changed:
git diff --name-only | cock codegraph affected --stdin
```

```bash
# Drive jest directly with the affected tests:
git diff --name-only | cock codegraph affected --stdin --as-cmd jest
```

```bash
# Same idea for vitest:
git diff --name-only | cock codegraph affected --stdin --as-cmd "vitest run"
```

### See also

- [CodeGraph (in-product)](/en/docs/explorer/search/#codegraph) — the same index, but queried by the AI via `/cg` slash mode.
- [LSP](/en/docs/explorer/search/#lsp) — alternative for editor-grade go-to-definition / find-references.

## cockpit connection

`cockpit connection list` enumerates every bubble — terminal *and* browser — that the running Cockpit server knows about, with each bubble's user-set title (set via the ✎ button next to the bubble's short id).

The point is to give an LLM (or a human at a shell) a way to map cryptic 4-character bubble ids to human-meaningful purposes before driving them via `cockpit terminal <id> …` or `cockpit browser <id> …`. This page maps to the `/cc` slash mode used by the agentic flow.

### Usage

```bash
cockpit connection list [--cwd PATH] [--all] [--json]
```

Only one subcommand exists today — `list`.

### Flags

| Flag | Meaning |
|---|---|
| `--cwd PATH` | Only list bubbles whose project cwd matches `PATH` (canonicalised). Use `$PWD` to scope to the current shell. |
| `--all` | Include dead entries (exited terminals, disconnected browsers). Off by default. |
| `--json` | Emit raw JSON instead of TAB-separated lines. |

### Output (plain, TAB-separated)

```text
<type>  <shortId>  <title-or-(none)>  <projectCwd-or-?>  <command-or-empty>
```

One row per bubble. `<type>` is `term` or `browser`.

### Output (`--json`)

Array of:

```json
{
  "type": "term" | "browser",
  "shortId": "abcd",
  "title": "optional user-set label",
  "projectCwd": "/abs/path",
  "tabId": "…",
  "command": "npm run dev",
  "alive": true
}
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Bubbles found |
| `1` | No bubbles (after filters) |
| `2` | Usage / argument error |
| `3` | Cockpit server unreachable. Start it with `cock <project-path>`. |

### Examples

```bash
# All live bubbles across all projects:
cockpit connection list
```

```bash
# Only this project's bubbles:
cockpit connection list --cwd $PWD
```

```bash
# Everything (including dead), as JSON for programmatic use:
cockpit connection list --all --json | jq
```

### See also

- [`cockpit terminal`](#cockpit-terminal) — drive a terminal bubble by id.
- [`cockpit browser`](#cockpit-browser) — drive a browser bubble by id.

## cockpit update

`cockpit update` upgrades Cockpit to the latest published version.

```bash
cockpit update
```

Equivalent to running:

```bash
npm install -g @surething/cockpit@latest
```

You can run either; they do the same thing.

### What gets preserved

Everything in your Cockpit data folder (`~/.cockpit/`) is untouched by an upgrade:

- API keys and engine settings
- Sessions and pinned tabs
- Scheduled tasks
- Skills registry
- Notes
- Reviews
- The Chrome extension cache

Just the global npm package gets replaced.

### After upgrading

Restart any running `cockpit` process to pick up the new version. If you have Cockpit open in a browser tab, refresh the page after restart.

To verify:

```bash
cockpit -v
```

### If `cockpit update` fails

The most common cause is that `npm install -g` needs elevated permissions on your system (a globally-installed npm package is owned by root on some setups). If you see an `EACCES` error, run with `sudo`:

```bash
sudo npm install -g @surething/cockpit@latest
```

Or, better, fix your npm permissions once so you don't need sudo. The npm docs have a guide for this — search "resolving EACCES permissions errors npm".

### Pinning to a version

To install a specific version instead of the latest:

```bash
npm install -g @surething/cockpit@1.0.42
```

The version list is at [npmjs.com/package/@surething/cockpit](https://www.npmjs.com/package/@surething/cockpit).

### Downgrade

The same command — just give it the older version you want:

```bash
npm install -g @surething/cockpit@1.0.41
```

Your data folder is forward and backward compatible across minor versions; downgrading is safe.
