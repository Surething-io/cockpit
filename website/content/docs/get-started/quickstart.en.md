From `npm install` to a real, agent-driven task on your own project — in one page. The walkthrough at the end uses all three panels and is the fastest way to internalise what Cockpit actually does.

## Prerequisites

| Component | Minimum | Notes |
|---|---|---|
| **Node.js** | 20.x | Tested on 20 LTS and 22; older versions are not supported. |
| **Claude Code** | latest | Needed for the default Claude engine. `npm install -g @anthropic-ai/claude-code`, then run `claude` once so it can save its token to `~/.claude/`. |
| **Git** | any recent | Powers the Git status / history / blame views. |
| **Chrome / Chromium** | any recent | Optional — only if you use the Browser bubble or the Chrome extension. |
| **OS** | macOS / Linux / Windows | Native install on all three. WSL2 works on Windows but isn't required. |

## Install

```bash
npm install -g @surething/cockpit
```

This puts two identical binaries on your PATH:

- **`cockpit`** — the canonical name.
- **`cock`** — short alias for everyday use.

Verify:

```bash
cockpit -v
```

### Optional: Chrome extension

Only needed if you want the Browser bubble to inspect real Chrome tabs (read the DOM, capture network requests, run JavaScript). The Agent and Explorer panels work without it. See [Chrome Extension → Install](/en/docs/console/chrome-extension/#install) for the four-click setup.

### Optional: different port

Default is **3457**. Override per run with `--port 4000`.

## Run it

In any project directory:

```bash
cockpit .
```

Or point it at a specific path:

```bash
cockpit ~/code/my-project
```

The server starts on port 3457 and opens `http://localhost:3457` in your browser automatically. Use `--no-open` to suppress the auto-open.

### Install as a desktop app (PWA)

Cockpit ships a Web App Manifest, so Chrome / Edge treat `http://localhost:3457` as an installable PWA. Install it once and it runs in its own window — no address bar or tabs — feeling like a native desktop app.

1. Click the **install icon** on the right of the address bar (or menu → Install OpenCockpit) to install it once.
2. After installing, visiting `http://localhost:3457` again shows an **Open in app** button in the address bar — click it to open in the standalone app window.
3. Clicking that button while the app window is already open reuses the existing window instead of spawning a new one (`launch_handler: navigate-existing`).

A narrow screen (phone/tablet) install lands on the `/m` mobile view, while a desktop install lands on the full three-panel workspace — one install adapts to both.

## Your first chat

The UI loads on the **Agent** panel with a default Claude tab.

1. Type a message in the input at the bottom and press `Enter` to send.
2. `Shift+Enter` inserts a newline.
3. Paste an image and it attaches automatically.
4. Prefix a line with `!` to run a shell command — its output is sent back as context.

Each tab is independent. Use the `+` button to open a new one, and the sessions icon in the sidebar to open the Session Browser across all projects.

## Keyboard shortcuts to know

| Shortcut | What it does |
|---|---|
| `Cmd+1 / 2 / 3` | Switch panel: Agent / Explorer / Console |
| `Cmd+P` | Quick file open (fuzzy across the project) |
| `Cmd+F` | Find in current file |
| `Cmd+M` | Maximise current bubble |

## A realistic end-to-end workflow (using all three panels)

Where Cockpit really pays off is **parallel work** — running a feature and chasing a bug at the same time, in separate workspaces, without context-switching cost. The loop below uses all three panels and is the fastest way to internalise what Cockpit actually does.

### Setup — parallel work with worktrees

Open the project (on `main`). The **top bar** of the Cockpit window (the TabManager strip above the three panels) shows the current branch name **main**. Click it to open the **worktree dialog**, and add 5 worktrees one at a time (the dialog creates one per action, so click 5 times).

Now the same Cockpit window can hold 5 project tabs in parallel: 3 for feature work, 2 for bug-fixing — each its own checkout, its own chat session, no stepping on each other.

### Feature work — `/qa` → `/cg` → `/ex` → `/go` → review

1. **`/qa`** — describe the requirement. Claude switches to **clarification mode**: instead of jumping into code, it asks back about ambiguous points.

   ```text
   /qa add a "related products" module to the PDP, sourced from the
   top-10-viewed items in the same category
   ```

2. **Highlight comments** — select a key sentence in the AI's reply and add a comment; Cockpit numbers them in order (1, 2, 3, …). Each comment stays **local-only as a pending note**; **the next chat message you send automatically carries every pending comment (with the anchored text) along to the AI**.

   To fire a fresh request directly from a selection instead of waiting, the "Send to AI" small input that appears when you highlight text in the AI's reply lets you type a follow-up there and Enter — the highlighted text plus all pending comments go out as the next prompt.

3. **`/cg`** — impact assessment, powered by the [CodeGraph](/en/docs/explorer/search/#codegraph) index.

   ```text
   /cg which files, APIs, and tests does this change touch?
   ```

4. **`/ex`** — have the AI summarise its understanding.

   ```text
   /ex summarise your understanding of the requirement and how you plan to implement it
   ```

5. **Highlight again** — comment on the summary to align on disputed points.

6. **`/go`** — ship it. Claude breaks the change into MVP stages, writes code, self-verifies each stage, and **finishes with a decision tree** showing what path it took at each branch and why.

   ```text
   /go land the plan above
   ```

7. **Code review** — switch to Explorer's **Status** tab to walk the diff file-by-file. Unhappy with something? **Highlight-comment** (multiple rounds); comments support a "Send to AI" action that kicks off a fix-up pass — see [Comments](/en/docs/explorer/file-tree/#comments).

### End-to-end verification — Console + `/cc`

Once the code's in, run it locally:

1. Switch to **Console** (`Cmd+3`), type `zsh` for an interactive terminal, then `npm run dev`.
2. The terminal bubble's header carries a **short-ID badge** — click it to copy `cock terminal <id>` to your clipboard so the AI can read what the terminal's doing via Cockpit's CLI: `cock terminal <id> output` (recent output), `cock terminal <id> wait` (wait for the running command to settle), `cock terminal list` (list all registered terminals).
3. Still in Console, type your app's URL (e.g. `http://localhost:3456`) to open a Browser bubble. Click that bubble's short-ID badge to grab `cock browser <id>` the same way. **With the [Chrome extension](/en/docs/console/chrome-extension/#install) installed**, `cock browser <id> <action>` drives a real Chrome tab — supported actions include `snapshot` / `navigate` / `click` / `type` / `fill` / `hover` / `evaluate` / `console` / `network` / `cookies` / `storage` / `perf`. Without the extension you still get the page in an iframe but with limited reach.
4. In Agent, use **`/cc`** and paste both short IDs into the prompt to ask the AI for an end-to-end check:

   ```text
   /cc terminal: cock terminal abc123
       browser:  cock browser xyz789
       verify the chat input "send" flow — message should land in the DB
       and the UI should refresh in real time
   ```

   `/cc` has the AI drive your terminal and browser bubbles directly through the `cock` CLI, capture network traffic and DOM, then hand you the evidence.

### Bug fixing — `/fx` → `/cg` → `/ex` → `/go`

Switch to another worktree's tab to chase a bug. The loop mirrors feature work, just entering through `/fx`:

1. **`/fx`** — describe the bug. Claude enters **evidence-chain mode** — analyses only, doesn't write code.

   ```text
   /fx user reports "page 3 of the product list is slow to load" —
   find the root cause
   ```

2. **Highlight comments** — same routine as feature work (comments 1, 2, 3, auto-attached on the next send; or use the "Send to AI" input that pops up on highlight to push immediately).

3. **`/cg`** — second-pass confirmation of the hypothesis (call graph, co-edit history).

   ```text
   /cg look at PaginatedList's callers and any N+1 query risk
   ```

4. **`/ex`** — output a fix plan with trade-offs.

5. **Highlight again** — align on the fix.

6. **`/go`** — land it. Then loop back into the e2e verification above; `/cc` confirms the fix end-to-end.

### What you used

- **worktrees** — 5 parallel work streams, features and bugs side by side
- **Agent** — six built-in slash commands (`/qa /cg /ex /go /fx /cc`) plus highlight-comment for multi-round alignment
- **Explorer** — **Status** tab plus comment-driven fix-up loop
- **Console** — zsh service runner + Browser bubble + each bubble's **short-ID badge** so the AI can close the loop through the `cock` CLI

## Upgrading

```bash
npm install -g @surething/cockpit@latest
```

Or use the bundled helper:

```bash
cockpit update
```

Both do the same thing. Settings, sessions, skills, and API keys live under `~/.cockpit/` and are preserved across upgrades.

## Uninstall

```bash
npm uninstall -g @surething/cockpit
```

To remove all local state too:

```bash
rm -rf ~/.cockpit
```

> If you'll reinstall later, back up your `~/.cockpit/` folder first — it carries your sessions, pinned tabs, scheduled tasks, and other state.

## What's next

- [Engines Overview](/en/docs/agent/engines/) — add Codex, DeepSeek, Kimi, or Ollama as alternative tabs
- [Skills](/en/docs/agent/skills/) — what `/qa /fx /ex /go /cg /cc /cr` actually do
- [CLI Reference](/en/docs/reference/cli/) — drive bubbles from external scripts
