OpenCockpit is the open-source GUI for Claude Code — and a single canvas for whatever AI agent you bring next. Everything runs locally.

## What you get

- **Multi-project parallel sessions.** Run 5+ agent sessions across separate projects at once. Each one lives in its own tab; you get a desktop toast when any finishes.
- **Bring any agent.** Claude works out of the box. Codex, DeepSeek, Kimi (Moonshot), and local Ollama models are one tab away — paste an API key (or none for Ollama).
- **More than chat.** A real terminal, Chrome automation, and bubbles for PostgreSQL / MySQL / Redis / Neo4j / Jupyter — all inside one window your agent can drive.
- **Code-aware navigation.** LSP go-to-definition, a Code Map of function calls, and a `/cg` slash command that lets the AI explore the project graph via HTTP.

## The three panels

Cockpit's whole UI is three panels rendered in parallel. None of them ever unmount — switching is just a CSS translate. `Cmd+1 / 2 / 3` flips between them; on touch devices you can swipe.

| Panel | Cmd | What it does |
|---|---|---|
| **Agent** | `Cmd+1` | Multi-tab chat with Claude / Codex / DeepSeek / Kimi / Ollama |
| **Explorer** | `Cmd+2` | File browser, code viewer, Git, LSP, code graph |
| **Console** | `Cmd+3` | Terminal + Browser + DB bubbles, all command-driven |

### Panel 1 — Agent (`Cmd+1`)

The chat surface. Each tab is an independent conversation with whatever engine you picked.

- **Engines.** Claude / Codex / DeepSeek / Kimi (Moonshot) / Ollama — switch per tab. Claude works out of the box; the rest need a one-time key (or none for Ollama).
- **Sessions.** Pin a session to the sidebar, fork it to branch the conversation, search across projects via the Session Browser (sidebar icon).
- **AI mode slash commands.** Type `/` in the chat input to pick from **six** modes that rewire how the AI approaches the next reply: `/qa` (clarify before changing code), `/fx` (bug evidence chain, analysis only), `/ex` (deep structured analysis), `/go` (landing mode — MVP-staged implementation with self-verify), `/cg` (CodeGraph exploration), `/cc` (Cockpit-CLI-driven end-to-end verification). Skills installed via `SKILL.md` show up in the same menu as `/skill-name`.
- **Shell prefix.** Any input starting with `!` runs as a shell command and its output is appended to the prompt.
- **Scheduled tasks.** A sidebar panel for one-shot, interval, and cron schedules — run a prompt every morning to summarise yesterday's PRs, every hour to scan release notes, every 5 minutes to babysit a long-running task.
- **Skills.** `SKILL.md` files become callable `/skill-name` commands across all tabs.

[Read more about chat →](/en/docs/agent/sessions/)

### Panel 2 — Explorer (`Cmd+2`)

The code surface. **Five tabs** across the top:

| Tab | Purpose |
|---|---|
| **Tree** | Virtualised file tree with right-click menus (new / copy / delete / copy path). |
| **Search** | Project-wide full-text search + entry point for CodeGraph. |
| **Recent** | Files ordered by access time — your "what was I just looking at?" view. |
| **Status** | Git working tree: staged / unstaged / untracked, with one-click stage / discard. |
| **History** | Git commit log; click any commit for its file list and diff. |

Inside any file:

- **Syntax highlighting** for every common language.
- **Vi mode** in the code editor — `i`, `Esc`, `h/j/k/l`, etc.
- **Cmd+F** to find within the file (regex, case-sensitive, whole word).
- **Cmd+P** for fuzzy file open across the whole project.
- **Right-click on a line** → Blame view with author / commit / time per line.
- **Cmd+click** a symbol → jump to its definition (TypeScript / JavaScript / Python).
- **Code Map** — visualise function callers and callees as a graph.

Whatever Explorer shows you, the AI can query the same graph via `/cg` from the Agent panel — see [CodeGraph](/en/docs/explorer/search/#codegraph).

[Read more about Explorer →](/en/docs/explorer/file-tree/#file-tree)

### Panel 3 — Console (`Cmd+3`)

The "everything else" surface. Type into the input bar at the bottom and Cockpit picks the right bubble type for you:

| Type this | Get this bubble |
|---|---|
| `ls`, `make build`, `pytest`… | One-shot command bubble |
| `zsh`, `bash` | Full interactive terminal — `vim`, `top`, anything you'd run in iTerm |
| `https://example.com` | Browser bubble (drives a real Chrome tab) |
| `postgresql://...` / `postgres://...` | PostgreSQL bubble |
| `mysql://...` | MySQL bubble |
| `redis://...` | Redis bubble |
| any `.ipynb` path | Jupyter bubble |

Each bubble is draggable; `Cmd+M` maximises the focused one. Bubbles persist across sessions until you close them, and the **CLI** lets external scripts drive them (see [CLI Reference](/en/docs/reference/cli/)).

[Read more about Console →](/en/docs/console/input-bar/)

## Cross-panel features

- **Code references via comments.** In Explorer, select a range of code and add a comment (`Cmd+/` or the floating toolbar). Add as many as you need across files; when you're ready to ask the AI, the **Comments** modal in Agent renders every pinned comment as a formatted block (file path + line range + code + your note) that you can copy straight into chat. This is the supported path for "tell the AI about this specific code" — there is no drag-and-drop.
- **Jump to file from search.** `Cmd+P` opens fuzzy file search and lands you in the Explorer tree at the matched file, ready to comment / preview / blame.
- **Bubbles ↔ Agent.** Every Browser bubble (and one-shot / interactive terminal bubble) carries a **short-ID badge** in its title bar. Click it to register the bubble and copy `cock browser <id>` / `cock terminal <id>` to your clipboard — paste it into chat and the AI can drive that exact bubble through Cockpit's CLI.

## Who this is for

If you spend your day driving Claude Code through a terminal and wish you could:

- watch five concurrent agent sessions without `tmux` gymnastics
- swap to Codex or DeepSeek for one task without rebooting your shell
- click a row in the file tree and immediately see Git blame for that line
- have the AI query Postgres and visualise the result without leaving the chat

…then Cockpit is the surface you've been hand-rolling in scripts.

## What this is *not*

- **Not a hosted product.** Everything runs locally; you bring your own keys. There is no SaaS plan.
- **Not a code editor.** Cockpit views and reviews code, but a deep editing experience belongs in VS Code / Cursor / nvim. We integrate cleanly with whatever editor you already use.
- **Not a Claude wrapper.** Claude is the default, but every panel is engine-agnostic. The codebase already ships five model adapters.

## Next steps

- [Quickstart](/en/docs/get-started/quickstart/) — install, run, and a realistic end-to-end task using all three panels
- [Skills](/en/docs/agent/skills/) — the single page most users wish they'd read first
- [Engines Overview](/en/docs/agent/engines/) — add Codex / DeepSeek / Kimi / Ollama as alternative tabs
