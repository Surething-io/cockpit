The OpenCockpit CLI is a thin layer over the running Cockpit server's HTTP API. A single binary is installed by `npm install -g @surething/cockpit`: **`cockpit`**. The server itself runs continuously; sub-commands speak HTTP to `localhost:3457` to inspect or drive what's open in your panels.

| Command | Purpose |
|---|---|
| [`cockpit`](#cockpit) | Start the server (the main entry point) |
| [`cockpit browser`](#cockpit-browser) | Drive your Chrome tabs and Console browser bubbles — click, type, evaluate JS, capture network, emulate devices |
| [`cockpit terminal`](#cockpit-terminal) | Read a Terminal bubble's output (read-only; no stdin) |
| [`cockpit codegraph`](#cockpit-codegraph) | Query the project-wide code index from a shell |
| [`cockpit connection`](#cockpit-connection) | List all bubbles (terminal + browser) with their titles |
| [`cockpit update`](#cockpit-update) | Upgrade to the latest version |

## cockpit

The `cockpit` binary is the main entry point, installed by `npm install -g @surething/cockpit`.

### Usage

```text
cockpit [path] [options]
```

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
| `--token <value>` | Require a shared token for **remote** access (loopback stays exempt). Sets `COCKPIT_TOKEN`; off entirely when omitted. See [Shared-token access gate](#shared-token-access-gate). |
| `[path]` | Working directory to open. Defaults to `process.cwd()`. |

### Default port

Cockpit listens on port **3457** (dev mode: **3456**). Override per-run with `--port`, or set it permanently with the `COCKPIT_PORT` environment variable:

```bash
COCKPIT_PORT=4000 cockpit
```

The `--port` flag wins when both are set. (`<data-dir>/server.json` is written by the running server to record the live pid/port for the `cockpit` sub-commands and the single-instance guard — it is **not** read back to choose the port, so editing it by hand has no effect.)

### Sub-commands

`cockpit` itself starts the server. Two sub-commands are used to drive Cockpit from external scripts (CI, ChatOps, automation):

| Sub-command | Purpose |
|---|---|
| `cockpit browser <id> <action>` | Drive a Chrome tab or a Console browser bubble (navigate, click, evaluate JS, capture network, …) |
| `cockpit terminal <id> <action>` | Read from a running Terminal bubble (`list` / `output` / `wait`; read-only) |

Both target an already-running Cockpit server at `localhost:3457`. They're the same APIs the in-app UI uses; exposing them as CLI commands lets you script the bubbles from anywhere.

See:

- [`cockpit browser`](#cockpit-browser) — full action list (snapshot, click, type, upload, dialog, viewport, network, …)
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
| `COCKPIT_HOME` | Data directory. Defaults to `~/.cockpit`. Point it elsewhere to isolate an instance's data — sessions, scheduled tasks, terminal history, settings, skills — e.g. run a dev instance beside prod without sharing data. Accepts `~`, relative, or absolute paths. |
| `COCKPIT_PORT` | Server port (same as `--port`); also read by the `cockpit` sub-commands and `/cg` snippets. |
| `PORT` | Fallback when `COCKPIT_PORT` is unset. |
| `COCKPIT_HOST` | Bind host. Default `127.0.0.1` (local only); set `0.0.0.0` to expose on the LAN / in a cloud sandbox. |
| `COCKPIT_TOKEN` | Shared access token (same as `--token`). When set, remote HTTP/WS requests must present it (cookie / `Authorization: Bearer` / `?token=`); loopback requests stay exempt. Unset = no auth (fully open). See [below](#shared-token-access-gate). |
| `COCKPIT_NO_OPEN` | Don't auto-open the browser on start (same as `--no-open`). |
| `COCKPIT_LOG_LEVEL` | Server log level. |
| `COCKPIT_FORCE` | Bypass the single-instance guard (see below). |
| `COCKPIT_SNAPSHOT_KEEP_DAYS` | How many days of [tool-call snapshots](/en/docs/agent/snapshots/) to keep. Default `7`. |
| `COCKPIT_SNAPSHOT_REPO_TTL_DAYS` | Days of inactivity before a project's whole snapshot repo is removed. Default `30`. |
| `COCKPIT_SNAPSHOT_MAX_FILE_KB` | Per-file size cap for snapshot tracking, in KB. Default `2048` (2 MB). |
| `COCKPIT_ALLOWED_HOSTS` | Comma-separated extra host names (no scheme, no port) that requests arriving over loopback may use in their `Host` header — e.g. the public hostname of a token-less tunnel. See *Host and Origin check* below. |
| `COCKPIT_DELEGATE_MAX` | Max delegated sessions ([`/dl`](/en/docs/agent/skills/)) running at once. Default `4`; must be ≥ 1. Requests past the cap are rejected. |

#### Data directory & running a second instance

Everything Cockpit persists lives under the data directory — `~/.cockpit` by default, or wherever `COCKPIT_HOME` points. Only **one instance per data directory** may run at a time: on startup Cockpit probes `/api/health`, and if another live instance already owns the same data dir it refuses to start and points you at `COCKPIT_HOME`.

To run a second instance (e.g. dev alongside prod), give it its own data dir:

```bash
COCKPIT_HOME=~/.cockpit-dev cockpit
```

Set `COCKPIT_FORCE=1` to skip the guard (or delete `<data-dir>/server.json` if it's a stale lock left by a crash).

#### Shared-token access gate

By default Cockpit is **fully open** — anyone who can reach the port can use it. That's fine for a purely local install, but when you expose Cockpit on a LAN or in a cloud sandbox (`COCKPIT_HOST=0.0.0.0`), turn on the shared-token gate:

```bash
cockpit --token my-secret-value        # or: COCKPIT_TOKEN=my-secret-value cockpit
```

With a token set:

- **Local (loopback) requests stay exempt** — the CLI, `/cg` snippets, self-probes, and a browser running on the host itself keep working with no token. Only genuine loopback with no forwarding header is trusted.
- **Remote requests must present the token**, via any of:
  - a `cockpit_token` **cookie**;
  - an `Authorization: Bearer <value>` **header** (handy for API / WebSocket clients); or
  - a `?token=<value>` **query param** — on first visit the server sets the cookie and redirects to a clean URL, so the secret doesn't linger in the address bar or history.
- Tokens are compared in constant time; a wrong or missing token is denied.
- Leave `--token` / `COCKPIT_TOKEN` **unset** to keep the old fully-open behaviour (backward compatible).

Pair it with `COCKPIT_HOST=0.0.0.0` when sharing over the network:

```bash
COCKPIT_HOST=0.0.0.0 cockpit --token my-secret-value
```

#### Host and Origin check

Independent of the token, every HTTP request and WebSocket upgrade first passes a Host / Origin check. It blocks two ways a web page open in your browser could reach a local Cockpit — DNS rebinding and cross-site request forgery. A rejected request gets `403 Forbidden`.

- **Requests arriving over loopback must address Cockpit by an allowed host name:** `localhost` (or `*.localhost`), a `127.x.x.x` / `::1` address, this machine's hostname (and `<hostname>.local`), the `COCKPIT_HOST` value when it is a specific address, or a name in `COCKPIT_ALLOWED_HOSTS`. Requests from other machines (LAN, with `COCKPIT_HOST=0.0.0.0`) are not host-checked.
- **State-changing requests (anything but `GET` / `HEAD` / `OPTIONS`) and WebSocket upgrades that carry an `Origin` header must be same-origin with `Host`.** Browsers always send `Origin` on these; `curl`, the CLI and skills don't, so they're unaffected.

**Tunnels (ngrok, cloudflared, …) — behaviour change.** A tunnel agent on the same machine connects over loopback while `Host` carries the tunnel's public hostname, so its requests are now rejected unless you either:

- list that hostname in `COCKPIT_ALLOWED_HOSTS`, or
- run with a token — in token mode, requests carrying a forwarding header (`X-Forwarded-For`, `X-Real-IP` or `Forwarded`) are left to the token gate, which then requires the token.

```bash
COCKPIT_ALLOWED_HOSTS=my-box.ngrok.app cockpit     # no token: anyone with the URL gets in
cockpit --token my-secret-value                    # token mode: the tunnel must forward X-Forwarded-For
```

Keep the tunnel's original `Host` header. If it is rewritten to `localhost`, the browser's `Origin` no longer matches and POSTs and WebSockets get 403.

## cockpit browser

`cockpit browser` drives web pages in **your Chrome** and the **browser bubbles** in Cockpit's Console — from the AI in a chat, a shell script, or CI. It needs the [OpenCockpit Bridge extension](/en/docs/console/chrome-extension/#install).

- **Web pages are Chrome tabs.** `cockpit browser open <url>` opens one in the **Cockpit** tab group (in the background unless `--show`), with your logins. Any of your existing tabs can be driven too, by its id; the first command on a tab you haven't allowed asks you in the extension's popup.
- **Bubbles are for local content.** `cockpit browser open <file>` opens a local HTML app or file preview as a Console bubble.

Every target has a short id like `qmmm`. Get a tab's id from `cockpit browser tabs`, from the toast when Cockpit opens it, or from the extension's popup (**Copy**); a bubble's id is the badge in its title bar.

The CLI is designed for **AI-driven E2E**: every command has an actionable error template, silent failures are caught and warned, and the act/wait/assert cycle composes into atomic steps. Prefer selector-based interaction (`--text`, `--selector`) over snapshot refs — refs go stale on every re-render.

### Targets

| Command | What it does |
|---|---|
| `cockpit browser open <url> [--show]` | Open a web page as a Chrome tab in the **Cockpit** group. Allowed for the AI straight away |
| `cockpit browser open <path> [--cwd PATH]` | Open a local HTML app or file as a Console bubble in the project that owns `--cwd`. Exits `2` if no Cockpit window has that project open |
| `cockpit browser tabs` | Every Chrome tab with its id, whether it is opened by Cockpit / allowed / will ask, and `[debugging]` while the extension's debugger is on it |
| `cockpit browser list` | What Cockpit is working with: bubbles, plus tabs it opened or you allowed |
| `cockpit browser <id> show` | Bring a tab to the front |
| `cockpit browser <id> release` | Hand a tab you allowed back — the next command asks again |
| `cockpit browser <id> close` | Close a bubble, or a tab Cockpit opened (never your own tabs) |

### Quick examples

```bash
# Open a page and find your way around
cockpit browser open http://localhost:3000        # → "qmmm  →  tab opened in Google Chrome"
cockpit browser qmmm status
cockpit browser qmmm snapshot --filter 'button'

# Interact (selector-first; refs go stale on re-render)
cockpit browser qmmm click --text "Sign in"
cockpit browser qmmm fill --selector 'input[name="email"]' --value "user@example.com"
cockpit browser qmmm submit --form-selector 'form#login'

# Things that usually block automation
cockpit browser qmmm click --text "Delete"         # → "the page opened a confirm dialog"
cockpit browser qmmm dialog accept
cockpit browser qmmm upload e7#v2 ./fixtures/avatar.png
cockpit browser qmmm drag e3#v2 '#done-column'

# Probe the backend (inherits page auth)
cockpit browser qmmm fetch /api/users/me

# act → wait → assert (atomic E2E)
cockpit browser qmmm click --text "Save"
cockpit browser qmmm wait --network-idle --quiet-ms 500
cockpit browser qmmm assert --selector '[role="status"]' --text "Saved"

# Test conditions (stay on until reset)
cockpit browser qmmm viewport iphone --reload
cockpit browser qmmm emulate --network slow-3g --cpu 4
cockpit browser qmmm screenshot --full
cockpit browser qmmm viewport reset && cockpit browser qmmm emulate reset
```

### Tabs vs bubbles

Everything below works on both, unless marked **tabs**. On tabs, `click` / `type` / `key` / `hover` / `scroll` / `drag` use **real input** through Chrome's input pipeline (pages see trusted events); pass `--dom` to use synthetic DOM events instead. While the AI works on a tab, Chrome shows *"OpenCockpit Bridge started debugging this browser"* — see [the debugging bar](/en/docs/console/chrome-extension/#using-it).

**Frames.** On tabs, `snapshot` includes iframes — cross-origin ones too — nested under their `<iframe>` line, and open shadow DOM. Refs inside a frame look like `f7:e3#v1` and work with every command; `--frame 7` points `--selector` / `--text` / `evaluate` at that frame. In a **background** tab Chrome can't deliver real input into a cross-origin frame or scroll with the wheel; those fall back to DOM events and the output says so (`show` the tab first for real input).

### Full action list

#### Inspection

| Action | What it does |
|---|---|
| `snapshot [--filter <regex>] [--include-hidden-text] [--max-depth N] [--frame N]` | Accessibility tree. Banner explains the format. `--filter` greps server-side; `--include-hidden-text` surfaces text collapsed inside `<summary>` / container nodes |
| `screenshot` | PNG of the visible page, saved to `/tmp`; the path is printed |
| `screenshot --full` / `screenshot <ref>` | **Tabs:** the whole page, or one element |
| `url` | Current URL |
| `title` | Page title |
| `status` | One-line summary: URL, title, last console error, last failed request, top visible buttons. Run after a long gap to re-orient |
| `bounds <ref>` | Position and size of an element |
| `attrs <ref>` | All HTML attributes of an element |
| `computed <ref>` | Computed CSS for an element |
| `events <ref>` | Event listeners on an element. **Tabs:** every registered listener, plus the event types handled on its ancestors (where React / Vue delegate) |
| `cookies` | The page's JS-visible cookies (`document.cookie`) |
| `storage --type local\|session` | localStorage or sessionStorage contents |

#### Interaction

Selector-based forms are preferred — refs are valid only until the next snapshot or re-render. `--selector` and `--text` match **visible** elements only (a hidden twin, e.g. a collapsed mobile menu, is skipped); `--nth` counts visible matches.

| Action | What it does |
|---|---|
| `click [<ref>] [--text <substr>] [--selector <css>] [--nth N] [--exact]` | Click by ref, by visible text/aria-label, or by CSS selector |
| `click <ref> --at X,Y` | Click a point inside the element, from its top-left corner, in px or `%` (`--at 50%,50%`) — canvas, maps, charts. `hover` takes it too |
| `click <ref> --hold <ms>` | Long press (mouse, or a finger on an emulated phone) |
| `fill [<ref>] [--selector <css>] --value <v>` | Set the value via native setter + dispatch `input` event (works on React-controlled inputs) |
| `type <ref> <text> [--insert]` | Type into an input. On tabs every character is a real key press; `--insert` commits the whole text at once, the way an IME does |
| `submit [--form-selector <css>]` | Call `form.requestSubmit()`. Works where pressing `Enter` is ignored by `onKeyDown` |
| `hover <ref>` | Hover over an element (on tabs, CSS `:hover` applies) |
| `focus <ref>` | Focus an element |
| `scroll <up\|down\|left\|right> [<ref>] [--amount PX]` | Scroll the page or the element under `<ref>`. On tabs a real wheel turn, a swipe on an emulated phone |
| `key <key>` | Press a key (`Enter`, `Ctrl+A`, `Shift+Tab`, …). On React inputs, prefer `submit` |
| `drag <ref> <to-ref\|css>` / `drag <ref> --dx N --dy N` | **Tabs:** drag and drop. Native HTML5 drag-and-drop and pointer-driven lists / sliders both work |
| `upload <ref> <file> [file…]` | **Tabs:** put local files into an `<input type=file>` (snapshot marks it `file`; it may be hidden — `--selector` works too) or into the button that opens the file chooser. No OS dialog appears. Needs **Allow access to file URLs** on the extension |

#### Dialogs

**Tabs.** An `alert` / `confirm` / `prompt` / "leave this page?" dialog pauses the page. The command that opened it reports it; every other command fails at once with the dialog's text until it is answered.

| Action | What it does |
|---|---|
| `dialog` | Show the open dialog, if any |
| `dialog accept [--text <T>]` | Press OK (`--text` answers a prompt) |
| `dialog dismiss` | Press Cancel |

#### Test conditions

**Tabs.** These stay on — and keep Chrome's debugging bar up — until reset, `release`, or **Stop** in the extension's popup.

| Action | What it does |
|---|---|
| `viewport <iphone\|android\|ipad\|WxH> [--landscape] [--reload] [--mobile] [--dpr N] [--ua UA]` | Emulate a device: size, pixel ratio, touch and User-Agent. Clicks become taps. Add `--reload` when the site picks mobile markup from the User-Agent. No argument shows the current one; `viewport reset` undoes it |
| `theme dark\|light\|reset` | Emulate `prefers-color-scheme` |
| `emulate [--network offline\|slow-3g\|fast-3g\|slow-4g] [--cpu N] [--block "<pattern>,…"] [--media print] [--reduced-motion on]` | Network conditions, CPU slowdown, blocked URLs, print media, reduced motion. Each flag takes `off`; `emulate reset` clears all; no flags shows what is on. Chrome does not let extensions emulate a timezone or locale |

#### Wait — synchronisation between act and assert

| Action | What it does |
|---|---|
| `wait --network-idle [--quiet-ms 500] [--max-request-age-ms 30000]` | Wait until 0 in-flight HTTP requests for `quiet-ms` consecutive ms. Long-running streams (SSE / long-poll) older than `max-request-age-ms` are excluded |
| `wait --selector <css> [--state visible\|hidden\|attached\|detached]` | Wait for the matching element to reach the given state. Default state is `visible` |
| `wait --dom-stable [--quiet-ms 300]` | Wait until a `MutationObserver` reports no DOM changes for `quiet-ms` (useful between an act and a snapshot) |
| `wait --extension-ready [--quiet-ms 500]` | CLI-side poll of `health`. Never blocks on the page. Replaces manual `until evaluate "1+1"` loops when the page is busy |
| `wait --text <substr>` / `--url <pat>` / `--ref <ref>` / `--time <ms>` | Classic conditions: text appears, URL matches, ref is still attached, sleep |

#### Assert — non-zero exit on failure

| Action | What it does |
|---|---|
| `assert --selector <css> [--text <substr>] [--visible <bool>] [--attr "k=v"]` | Element-level assertion via selector. Refs are also accepted (`--ref`) but go stale; selector is preferred |
| `assert --network --method <M> --url <pat> --status <S> [--since <ms>]` | Assert that a matching request occurred in the network buffer. `--status` accepts ints (`200`) or ranges (`2xx`) |
| `assert --fetch <url> [--fetch-method M] [--body B] [--fetch-status N]` `[--jsonpath <P> --equals V \| --contains V \| --not-contains V]` | Make a fetch (inherits page auth) and assert the response status or a JSONPath value. JSONPath subset: `$`, `.key`, `[N]`, `[*]` |
| `assert --url <pat>` / `--title <substr>` / `--console-no-errors` | Page-level assertions |

#### Navigation

| Action | What it does |
|---|---|
| `navigate --url <url>` | Go to a URL |
| `reload [--noCache]` | Reload (optionally bypassing cache) |
| `back` | Go back one history entry |
| `forward` | Go forward one history entry |

#### Backend probing

| Action | What it does |
|---|---|
| `fetch <url> [--method <M>] [--body <B>] [--headers <JSON>]` `[--json <jsonpath>]` | GET (or any method) against the page's auth session. `--json` extracts a value via the same JSONPath subset as `assert --fetch`. Returns `{ status, contentType, data }` or `{ status, jsonpath, value }` |

`fetch` is the preferred way to read or mutate the backend from the AI — clearer than wrapping `await fetch(...).then(r => r.json())` inside `evaluate`.

#### JavaScript

| Action | What it does |
|---|---|
| `evaluate <js> [--frame N] [--all-frames]` | Run a JS expression in the page; result printed as JSON. `--frame` picks one iframe, `--all-frames` runs in every frame. Pages whose CSP blocks `eval` are handled automatically |

Use `evaluate` as an escape hatch when none of the higher-level actions fit. For plain HTTP calls, prefer `fetch`; for clicks, prefer `click --text` / `--selector`; for assertions, prefer `assert --selector`.

#### Lifecycle / fixtures

| Action | What it does |
|---|---|
| `reset [--cookies] [--storage] [--cache] [--reload]` | Atomic test-isolation helper. Combine flags as needed. `--cookies` expires JS-visible cookies; `--storage` clears `localStorage` and `sessionStorage`; `--cache` drops Cache Storage entries; `--reload` reloads the page after clearing |
| `set --type cookie --name <K> --value <V>` `[--domain <D>] [--path <P>] [--secure] [--same-site Lax\|Strict\|None] [--expires <date>]` | Write a JS-visible cookie. Returns `verified: false` if the browser silently rejected the value (cross-domain / `SameSite` mismatch / `Secure` over HTTP) |
| `set --type local-storage --name <K> --value <V>` | Write to `localStorage` |
| `set --type session-storage --name <K> --value <V>` | Write to `sessionStorage` |

#### Diagnostics

| Action | What it does |
|---|---|
| `health` | **Server-side** snapshot of the bridge: connection status, pending command count, time since last successful command. Never round-trips to the page, so it works even when the page itself is blocked on a long-running `evaluate` |
| `health --deep` | Also probes the page itself (`readyState`, `snapshotEpoch`, page-side timestamp). May block if the page is busy |
| `perf [--metric timing\|memory\|resources\|runtime]` | Performance metrics including Core Web Vitals. `runtime` (**tabs**): layout / style / script time, DOM nodes, JS heap |
| `coverage start\|stop\|status` | **Tabs:** how much of each stylesheet was actually used between `start` and `stop` (and of each script, where the browser allows it — Chrome doesn't for extensions). Reload after `start` to include page load |

#### Network & console capture

On tabs, capture starts with the first `network` / `console` / `network_record` call — it only sees activity from then on, so reload to catch the page load. It stops 2 minutes after the last read (a `network_record` keeps it running until the recording ends).

| Action | What it does |
|---|---|
| `network [--status <code>] [--method <method>] [--type <type>] [--clear]` | List captured network requests with filters. `--status` accepts comma-separated `4xx,5xx` |
| `network_record start [--url <pat>] [--method <m>] [--status <code>]` | Start recording request/response bodies |
| `network_record stop` | Stop recording |
| `network_record status` | Whether recording is on |
| `network_detail <reqId>` | Full request/response detail for one request |
| `console [--level error\|warn\|info\|debug] [--clear]` | Console messages |

### Snapshot output

`snapshot` returns a plain-text accessibility tree. The first 4–5 lines are a banner explaining the format, including the current **snapshot version** (`v=N`):

```text
# a11y tree v=3 — refs valid until next snapshot
# Text inside <details>/<summary> and unnamed container <div>/<section> is collapsed.
# Grep on role / aria-label, NOT on user-visible emoji / text.
# Tips: --include-hidden-text surfaces collapsed innerText; --filter <regex> reduces output.
# Frames: refs inside an iframe look like f7:e3#v1 — pass them as-is.
body [e0#v3]
  ...
  iframe [src=checkout.example.com] [e14#v3]
    frame f7 https://checkout.example.com/…
      button "Pay" [f7:e3#v1]
```

Each addressable element gets a ref like `e5#v3`. The `#v3` suffix is the snapshot epoch — refs from an earlier snapshot are rejected with a clear "stale" error that points you to `click --text` / `click --selector` as the re-render-safe alternative. **Most AI workflows should skip refs entirely and use `--text` / `--selector` directly.**

### Post-verify for `click` / `key` / `submit`

These actions are most prone to **silent failure** — CDP reports "succeeded" even when the framework didn't actually react to the event (React-controlled inputs ignoring synthetic `keydown`, portal-rendered buttons with no real handler, etc.). The CLI silently probes the page state before and after each action; if nothing observable changed in the verify window, it writes a warning to stderr along with actionable templates (without affecting the action's main `stdout`).

| Flag | What it does |
|---|---|
| `--verify-ms <ms>` | Override the verify window. Default is `1000` ms. Lower = faster but more false positives on slow-rendering React; higher = more tolerant |
| `--skip-verify` (or `--no-verify`) | Disable post-verify for the current command (e.g. legitimate clicks with no observable side-effect) |

### Output format

Most actions return **JSON** on stdout — easy to pipe into `jq`, `gron`, or to read from the AI. `url`, `title`, and `network_detail` return plain text. `screenshot` returns a file path. `snapshot` returns the banner + plain-text accessibility tree. `health`, `status`, `wait`, `assert`, `dialog`, `upload`, `drag`, `viewport`, `emulate` and `coverage` print a short human-friendly summary. `fetch` prints `[status] (contentType)` followed by the body, or `[status] $.jsonpath =` followed by the extracted value.

Warnings (silent-failure detection, DOM-event fallback in a background tab, etc.) go to **stderr**. The main result stays on stdout, so a `>` redirect captures the real data while letting the AI still see the warning.

### Exit codes

`0` on success, non-zero on failure (stale ref, network error, assertion failure, no matching element, a dialog blocking the page, etc.). `open <path>` exits `2` when no Cockpit window picked the bubble up. See the [main CLI page](#cockpit) for the full exit code list.

### When NOT to use this CLI

- **Testing LLM-agent driven flows end-to-end.** The agent's stochastic tool choice and `stop_reason` make UI assertions flaky. Prefer a thin runtime script that calls the same middleware or service directly with controlled inputs.
- **Pages that stream or re-render for >10 s.** `evaluate` calls queue behind page work and may time out (~15 s default). Run `wait --extension-ready` between acts and asserts; if it stays hung, pivot to a service-level test.
- **Timezone / locale-dependent behaviour.** Chrome doesn't let extensions emulate those; use a headless browser (e.g. Playwright) for such tests.

Popups and `target="_blank"` links open as ordinary Chrome tabs: find them with `cockpit browser tabs`. A tab opened by the page (not by Cockpit) asks for permission on its first command.

## cockpit terminal

`cockpit terminal <id> <action>` (or `cockpit terminal`) **reads** from a Terminal bubble in your running Cockpit — pulls the buffered output or waits for a running command to settle.

> Note: the terminal CLI is intentionally **read-only**. There is **no `stdin`** and **no `follow`** (live streaming). The code comment says: "read-only by design; the write side belongs to the Bash tool / web UI." For interactive control, drive the bubble inside Cockpit's UI, or use a Browser bubble + `cockpit browser` for automation.

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
cockpit terminal list

# Snapshot what's on screen now
cockpit terminal xy789 output

# Wait for npm run build to finish
cockpit terminal xy789 wait

# Then look at the result
cockpit terminal xy789 output | tail -50
```

### When to use this

Main patterns:

- **AI reads what your shell is doing through the bubble.** Run `npm run dev` in a Terminal bubble. Hand `cockpit terminal <id>` to the AI in chat — it can `output` for recent logs and `wait` for a build to settle.
- **CI / scripts observe a long-running command from outside.** A launcher script kicks off `npm run dev` in a Cockpit terminal; another script periodically runs `cockpit terminal <id> output` to scrape logs and assert.

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
| `search <query> [--limit N=50] [--path DIR] [--exclude-tests]` | Ranked name search. Per-category cap: 500. |
| `symbols [--path DIR] [--kind KINDS] [--exclude-tests] [--exclude GLOB]` | Export all matching function/method symbols. Repeat exclusions; use `--kind all` for every kind. |
| `callers <qname> [--file PATH]` | Direct callers of a symbol. |
| `callees <qname> [--file PATH]` | What a symbol calls. |
| `impact <qname> [--depth N=2]` | Transitive callers, BFS. Traversal is bounded. |
| `file <path>` | Symbol tree (functions/classes) inside a file. |
| `coedit <path> [--commits N=100]` | Files co-edited in git history alongside this one. |

**Derived queries** — base-index relationships and on-demand Git history:

| Subcommand | What it does |
|---|---|
| `related <qname> [--top N=10]` | Direct callers + callees + frequent co-edit partners. |
| `affected <files…\|--stdin> [--depth N=10] [--filter G] [--as-cmd RUNNER]` | Test files transitively affected. CI-friendly. |

### Common flags

```bash
--json             # Raw JSON response (full schema; see per-cmd --help)
--help, -h         # Subcommand-specific help (output format + exit codes + examples)
```

`search` examines every eligible indexed candidate, retaining only the best 50
per category by default (maximum 500). Ranking is exact name, normalized exact,
normalized prefix, then normalized substring. Ties use file path, qualified name,
and line. `--path` includes descendants; `--exclude-tests` filters files, symbols,
and optional literals. Tests are included by default. HTTP parameters are `path`
and `excludeTests=true`.

`symbols` defaults to `function,method`; `--kind all` exports every real symbol kind. Unknown UI display blocks are excluded
unless `--include-synthetic` is passed.
The directory includes descendants, and exclusions can be repeated. JSON carries
`revision`, `incomplete`, `total`, and flat `symbols[]` coordinates. There is no
result-count cap; `incomplete` reports source-index coverage limits. Sources over
2 MiB (2,097,152 bytes) are excluded; JSON `excludedFiles[]` reports their
`filePath`, `reason`, `sizeBytes`, and `limitBytes` across the whole revision.

`--summary` returns counts by kind and immediate child directory of `--path`,
without symbol coordinates. It uses the same filters and counts only files with
matching symbols. Start broad exploration with a summary; save full exports to
disk and inspect a bounded selection. HTTP equivalents are `format=summary`
and `includeSynthetic=true`.

Ambiguous `callers`, `callees`, `impact`, and `related` requests return HTTP 200
with `target: null`, empty relations, and candidate paths in `ambiguousIn`.
Pass `filePath` (CLI `--file`) to select a target. The CLI exits 2 on ambiguity,
including JSON mode, and still emits the JSON response.

```bash
cockpit codegraph symbols --path packages/feature --kind all --exclude-tests --summary
cockpit codegraph symbols --json > symbols.json
cockpit codegraph symbols --path src --exclude-tests --exclude '**/generated/**' --json
```

### Output format (plain text)

TAB-separated, one row per result. Pipeable into `cut`, `awk`, `fzf`, etc.

```text
search    sym\t<file>:<line>\t<kind>\t<qname>            or  file\t<file>
symbols   <file>:<startLine>-<endLine>\t<kind>\t<qname>
callers   <file>:<line>\t<qname>\t[<callLines>]
callees   <file>:<line>\t<qname>\t[<callLines>]
impact    d=<depth>\t<file>:<line>\t<qname>
file      <kind>\t<startLine>-<endLine>\t<qname>
coedit    <cooccur>/<total>\t<file>                  # after a '# history' comment
related   <score>\t<file>:<line>\t<qname>\t<<relations>>
affected  <file>                                     # one test path per line
```

Pass `--json` to get the full structured payload instead.

### Diagnostics on stderr

Designed so warnings don't break shell pipelines:

```text
# ambiguousIn: <files…>     Same qname in multiple files — pass --file
# degraded: <reason>        coedit-unavailable / truncated
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Output produced |
| `1` | Empty result (no callers, no tests, no hits) — short-circuits shell pipelines |
| `2` | Argument or 4xx server error |
| `3` | Cockpit server not reachable. Start it with `cockpit <project-path>`. |

### Prerequisites

The CLI hits `http://localhost:3457` by default (the **same port** as the main Cockpit server — not a separate codegraph port). The host is always loopback (the CLI and server are always co-located); only the port is overridable:

```bash
COCKPIT_PORT=… cockpit codegraph …
```

### Examples

```bash
cockpit codegraph search getCodeIndex
```

```bash
cockpit codegraph related getCodeIndex --top 5
```

```bash
cockpit codegraph impact searchIndex --depth 2
```

```bash
# Newline-separated test paths for whatever changed:
git diff --name-only | cockpit codegraph affected --stdin
```

```bash
# Drive jest directly with the affected tests:
git diff --name-only | cockpit codegraph affected --stdin --as-cmd jest
```

```bash
# Same idea for vitest:
git diff --name-only | cockpit codegraph affected --stdin --as-cmd "vitest run"
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
| `3` | Cockpit server unreachable. Start it with `cockpit <project-path>`. |

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
- Sessions and favourited sessions
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
