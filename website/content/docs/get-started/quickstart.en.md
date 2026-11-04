From `npm install` to a real, agent-driven task on your own project — in one page. The walkthrough at the end uses all three panels and is the fastest way to internalise what OpenCockpit actually does.

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

### Feature work — `/qa` → `/spec` → `/design` → `/go` → `/cr`

This shows the full workflow; simple changes can skip stages that add no useful information. The first three stages clarify requirements, specify behavior, and design the implementation without implementing the feature. Use `/go` explicitly to start coding.

1. **`/qa`** — clarify the requirement. The AI produces a lean PRD covering goals, scope, assumptions, and material choices that need your input.

   ```text
   /qa add a "related products" module to the PDP, sourced from the
   top-10-viewed items in the same category
   ```

2. **Highlight comments** — select a key sentence in the AI's reply and add a comment; Cockpit numbers them in order. Comments stay local until your next chat message automatically carries all pending comments and their anchored text to the AI. Or type in the **Send to AI** input that appears on selection and press Enter to send a follow-up immediately.

3. **`/spec`** — turn agreed requirements into behavior rules, contracts, boundaries, and acceptance criteria for development and testing.

   ```text
   /spec specify the related-products module, including behavior and acceptance
   criteria for fewer than 10 products, no results, and loading failures
   ```

4. **`/design`** — ground the technical approach in existing code, explain responsibilities, data flow, and material tradeoffs, then order implementation steps and verification. Use `/cg` first if you need separate impact exploration through [CodeGraph](/en/docs/explorer/search/#codegraph).

   ```text
   /design trace the product query and detail-page data flow, then propose
   a technical design, implementation order, and verification for the spec above
   ```

5. **Highlight again** — comment on the specification or technical design to resolve disagreements; carry confirmed decisions forward without reopening them.

6. **`/go`** — implement agreed work in small verified slices, record decisions the specification did not cover, and report results, blockers, and residuals.

   ```text
   /go implement the specification and technical design above
   ```

7. **`/cr`** — ask the AI to check static correctness and runtime behavior involving state, timing, and concurrency, and report findings.

   ```text
   /cr review this change
   ```

8. **Code review** — switch to Explorer's **Status** tab to walk the diff file-by-file. Highlight-comment on anything that needs adjustment and use "Send to AI" for a fix-up pass — see [Comments](/en/docs/explorer/file-tree/#comments).

### End-to-end verification — Console + `/cc`

Once the code's in, run it locally:

1. Switch to **Console** (`Cmd+3`), type `zsh` for an interactive terminal, then `npm run dev`.
2. The terminal bubble's header carries a **short-ID badge** — click it to copy `cockpit terminal <id>` to your clipboard so the AI can read what the terminal's doing via Cockpit's CLI: `cockpit terminal <id> output` (recent output), `cockpit terminal <id> wait` (wait for the running command to settle), `cockpit terminal list` (list all registered terminals).
3. Still in Console, type your app's URL (e.g. `http://localhost:3456`) to open a Browser bubble. Click that bubble's short-ID badge to grab `cockpit browser <id>` the same way. **With the [Chrome extension](/en/docs/console/chrome-extension/#install) installed**, `cockpit browser <id> <action>` drives a real Chrome tab — supported actions include `snapshot` / `navigate` / `click` / `type` / `fill` / `hover` / `evaluate` / `console` / `network` / `cookies` / `storage` / `perf`. Without the extension you still get the page in an iframe but with limited reach.
4. In Agent, use **`/cc`** and paste both short IDs into the prompt to ask the AI for an end-to-end check:

   ```text
   /cc terminal: cockpit terminal abc123
       browser:  cockpit browser xyz789
       verify the chat input "send" flow — message should land in the DB
       and the UI should refresh in real time
   ```

   `/cc` has the AI drive your terminal and browser bubbles directly through the `cockpit` CLI, capture network traffic and DOM, then hand you the evidence.

### Bug fixing — `/fx` → `/cg` → `/design` → `/go`

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

4. **`/design`** — use the root cause and code evidence to design the fix, including preserved behavior, implementation steps, and regression checks. A simple fix with an established approach can go straight to `/go`.

   ```text
   /design design a fix for the root cause above, including impact,
   implementation steps, and checks that pagination behavior is preserved
   ```

5. **Highlight again** — align on the fix.

6. **`/go`** — land it. Then loop back into the e2e verification above; `/cc` confirms the fix end-to-end.

### What you used

- **worktrees** — 5 parallel work streams, features and bugs side by side
- **Agent** — built-in slash commands (`/qa /spec /design /go /cr /fx /cg /cc`) plus highlight-comment for multi-round alignment
- **Explorer** — **Status** tab plus comment-driven fix-up loop
- **Console** — zsh service runner + Browser bubble + each bubble's **short-ID badge** so the AI can close the loop through the `cockpit` CLI

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

> If you'll reinstall later, back up your `~/.cockpit/` folder first — it carries your sessions, favourites, scheduled tasks, and other state.

## What's next

- [Engines Overview](/en/docs/agent/engines/) — add Codex, DeepSeek, GLM, Kimi, or Ollama as alternative tabs
- [Skills](/en/docs/agent/skills/) — what `/qa /spec /design /fx /ex /go /cg /cc /cr` actually do
- [CLI Reference](/en/docs/reference/cli/) — drive bubbles from external scripts
