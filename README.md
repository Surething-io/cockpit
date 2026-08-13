<p align="center">
  <a href="https://opencockpit.dev">
    <img src="public/icons/icon-128x128.png" width="80" alt="OpenCockpit logo" />
  </a>
</p>

<h1 align="center">OpenCockpit — The open Claude Code GUI for any agent</h1>

<p align="center">
  <strong>One seat. One AI. Everything under control.</strong><br/>
  <sub><code>/ˈkɒkpɪt/</code> — like an aircraft cockpit</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@surething/cockpit"><img src="https://img.shields.io/npm/v/@surething/cockpit?color=12a594&label=npm&style=flat-square" alt="npm version"/></a>
  <a href="https://www.npmjs.com/package/@surething/cockpit"><img src="https://img.shields.io/npm/dm/@surething/cockpit?color=12a594&label=downloads&style=flat-square" alt="npm downloads"/></a>
  <a href="https://github.com/Surething-io/cockpit/stargazers"><img src="https://img.shields.io/github/stars/Surething-io/cockpit?color=12a594&style=flat-square" alt="GitHub stars"/></a>
  <a href="https://github.com/Surething-io/cockpit/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-12a594?style=flat-square" alt="MIT license"/></a>
  <a href="https://opencockpit.dev"><img src="https://img.shields.io/badge/website-opencockpit.dev-12a594?style=flat-square" alt="website"/></a>
  <a href="https://github.com/anthropics/anthropic-sdk-typescript"><img src="https://img.shields.io/badge/built_on-Claude%20Agent%20SDK-12a594?style=flat-square" alt="Built on Claude Agent SDK"/></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh.md">中文</a> · <a href="https://opencockpit.dev">Website</a> · <a href="https://opencockpit.dev/en/blog/">Blog</a>
</p>

---

> **OpenCockpit is the open-source Claude Code GUI** — an IDE-like workbench for the whole dev loop, and a single canvas for whatever agent you bring next. Run multi-project Claude sessions out of the box; pop open a tab for **Codex, DeepSeek, GLM, Kimi, or local Ollama** whenever you need. Built-in terminal, Chrome control, PostgreSQL / MySQL / Redis bubbles, code review, and slash modes — all local. And it's web client–server: **self-host it on a shared dev box and every teammate gets a seat.**

https://github.com/user-attachments/assets/18f1a5dc-64f3-4ff6-b9fc-9cd08181fbb8

```bash
npm i -g @surething/cockpit && cockpit
```

## Why Cockpit?

Anthropic ships **Claude Code as a CLI**. That's the right call for power users — but the moment you have more than one project in flight, your terminal turns into mission control with no instruments.

Cockpit is the instrument panel. It does **not** replace Claude Code; it stands on top of the official Agent SDK and gives you the things a CLI can't:

| Pain with raw Claude Code | What Cockpit adds |
|---|---|
| Stuck on one model | **6 engines side by side** in tabs: Claude (default), Codex, DeepSeek, GLM, Kimi, local Ollama — each its own session |
| One session at a time, terminal chaos at 3+ projects | **Multi-project tabs**, parallel agent sessions, red-dot inbox, desktop notifications |
| Image attachments are awkward | Drop / paste images straight into chat |
| "What was I debugging yesterday?" | Cmd+K cross-project session browser, pinning, forking |
| Agent can't reach your browser / DB | **Smart Bubbles**: Chrome, PostgreSQL, MySQL, Redis — drivable by the agent |
| Reading an unfamiliar repo means a 90-min file-tree scavenger hunt | **Code Map** chip view — caller / callee pins, click to walk the call graph |
| Reviewing AI output is friction | **LAN-shared review pages**, line-level comments, send any comment back as AI context |
| Same "do X but don't change code" prompt every day | **Slash modes** `/qa /fx /ex /go /cg /cc /cr` + custom `SKILL.md` via the Skills sidebar |
| No automation hooks | One-time / interval / cron-based **scheduled tasks** |
| "Cloud relay" trust concerns | **Fully local**. No telemetry. API keys (DeepSeek / GLM / Kimi) stay in `~/.cockpit/<engine>/credentials.json` on your laptop. |

### How it compares

An honest snapshot as of July 2026 — each tool wins somewhere. Spotted an error? PRs welcome.

|  | **OpenCockpit** | Claude Code Desktop (official) | Opcode |
|---|---|---|---|
| Positioning | **IDE-like workbench for the whole dev loop** | agent session companion | session manager for Claude Code |
| Architecture | ✅ **web client–server** — deploy on a shared dev box; the whole team codes with AI in parallel, each on their own project / worktree | single-user desktop app | single-user desktop app |
| Open source | ✅ MIT | ❌ closed source | ✅ AGPL-3.0 |
| Engines | ✅ **Claude + Codex / DeepSeek / GLM / Kimi / Ollama** (BYOK) | Claude only | Claude only |
| Parallel multi-project sessions | ✅ | ✅ | ✅ |
| Agent-drivable browser & DB (Chrome / Postgres / MySQL / Redis) | ✅ Smart Bubbles | ❌ preview pane only | ❌ |
| LAN-shared code review pages | ✅ | ❌ | ❌ |
| Fully offline / air-gapped | ✅ via Ollama | ❌ | ❌ |
| Phone / tablet access | ✅ any LAN browser — code runs on **your** machine | ✅ via Claude Code on the web (cloud sandbox) | ❌ desktop only |
| Native desktop app | ❌ local web app (needs Node ≥ 20) | ✅ | ✅ Tauri |
| Newest Claude Code features on day one | ⏳ tracks Agent SDK releases with a lag | ✅ first party | ❌ |
| Automation triggers | one-time / interval / cron | ✅ Routines: cron + API + GitHub events | background agents |
| Session checkpoints / rewind | pinning & forking only | ✅ | ✅ checkpoint timeline |
| Per-tool-call change snapshots (real disk diff for every Edit / Write / **Bash** / MCP call, 7-day local history) | ✅ | ❌ | ❌ per-prompt checkpoints only |
| Usage / cost analytics | basic token counts | n/a (plan-based) | ✅ full dashboard |
| Cost | GUI free (MIT); AI billed by whichever engine you bring — can be $0 with local Ollama | app free; needs a paid Claude plan or API billing | GUI free (AGPL); needs a paid Claude plan or API billing |
| Actively maintained | ✅ | ✅ | ⚠️ last release Aug 2025 |

**Pick Claude Code Desktop** if you live inside the Anthropic ecosystem and want first-party polish. **Pick Opcode** if you want a native desktop feel with checkpoints and cost analytics. **Pick OpenCockpit** if you want more than a chat window — an open-source, IDE-like cockpit that covers the whole dev loop (read code, drive your browser and databases, review, automate) with any engine you bring, even from your phone.

## Features

### Engines — Claude by default, bring any agent you want

- **Claude** *(default)* — full official Agent SDK; zero setup if `claude` CLI is already configured
- **Codex** — reuses your `~/.codex` config; same chat, same shell + bubbles
- **DeepSeek** — DeepSeek key + live model picker (`deepseek-v4-pro` by default) and a **balance check**
- **GLM** *(Zhipu / BigModel)* — BigModel key + live model picker (`glm-5.2` by default) and a Coding Plan **quota check**; one key, two hosts — switch **Region** between `open.bigmodel.cn` and `api.z.ai`
- **Kimi** *(Moonshot)* — Kimi Code key + live model picker (`kimi-for-coding`, `k3`, …) and a **quota check**; no `kimi` CLI needed
- **Ollama** — auto-starts the daemon; pick any pulled model from the chat header; fully offline
- Each engine lives in its own **tab with its own session history**; switch from the new-tab dropdown
- API keys stored locally in `~/.cockpit/<engine>/credentials.json`; **no cloud relay**

### Agent — AI chat that scales

- Default engine powered by the **official Claude Agent SDK** — zero extra setup
- **Multi-project concurrent sessions** with desktop notifications and red-dot badges
- Session **pinning, forking**, cross-project session browser (Cmd+K)
- **Per-tool-call snapshots** — every file-touching tool call is snapshotted (shadow git, fully local); review each reply's changes as a git-history-style timeline, including what `Bash` did
- `!command` prefix to run shell from chat — output piped back as context
- Image attachments, code references, token usage tracking

### Explorer — Code & files

- **4-tab file browser**: Directory · Recent · Git Changes · Git History
- Syntax highlighting (Shiki) with **Vi mode** editing
- Git **blame**, diff view, branch switching, **worktree** management
- **LSP integration** — go to definition, find references, hover info
- **Code Map** — every function as a chip with caller / callee pins; click to walk the call graph. Multi-language: TS/JS, Python, Go, Rust. No LSP, no project setup, works offline.
- **CodeGraph** — a **code graph** for the agent: same tree-sitter index exposed as 10 HTTP endpoints — 6 base (`search` / `callers` / `callees` / `impact` / `file` / `coedit`) + 4 analytics (`context` / `related` / `risk` / `affected`, powered by PageRank · PPR · TF-IDF · Louvain, zero training) — so the agent queries coordinates instead of grepping text; trigger with `/cg` from chat. Coordinates only, never source — precise, cheap, and catches the conventional coupling no regex can.
- Fuzzy file search (Cmd+F), JSON viewer, Markdown preview

### Console — Terminal & smart Bubbles

- Full **xterm.js** terminal with shell integration
- 🌐 **Browser Bubble** — control Chrome via accessibility tree (click, type, navigate, screenshot, network)
- 🐘 **PostgreSQL Bubble** — browse schema, run queries, export
- 🐬 **MySQL Bubble** — browse databases & tables, run queries
- 🔴 **Redis Bubble** — browse keys, inspect values, execute commands
- Drag-to-reorder, grid / maximized layout, per-tab env vars & shell aliases

### Code Review — LAN-shared, no SaaS

- LAN-shareable review pages — **teammates need zero install**
- Line-level comments with reply threads
- **Send any comment back to AI** as context for an automated fix
- Red-dot badges keep unread feedback visible across projects

### Slash modes — change the agent's posture

- `/qa` — **Clarify-only**: restate, ask back, never code
- `/fx` — **Diagnose-only**: bug evidence chain, never edit
- `/ex` — **Explore**: 6-step structured discussion skeleton (study → diverge → converge → re-diverge → iterate-verify → summarize)
- `/go` — **Land**: take a converged plan, slice into MVP stages, write + self-verify per stage, recap at end
- `/cg` — **CodeGraph** project exploration: 10 HTTP endpoints for symbol / callers / impact / co-edit / risk / affected queries (precise where grep is fuzzy)
- `/cc` — **Cockpit CLI**: drive the cockpit CLI surface — codegraph subcommands, terminal observation, browser automation
- `/cr` — **Code review**: full PR review — static triangulation (intent / input domain / surroundings) + dynamic modelling (state diagram + timeline → 6 risk classes), findings ranked by impact × probability
- **Custom**: drop any `SKILL.md` and add it via the Skills sidebar — it auto-appears in the slash autocomplete menu (see [Skills](#skills--extensibility))

### Scheduled tasks — Cron for AI

- One-time, interval, or **cron** scheduling
- Pause / resume, reorder, track results across projects

### Skills — extensibility

- Drop in any `SKILL.md` to teach the agent a new trick
- Invoke with `/skill-name` from chat
- All managed from a single Skills sidebar

## Use cases

- **Solo dev, multi-repo:** "I have a refactor running in API, tests writing in Web, and a bug investigation in Pipeline — all at once, all visible."
- **Day one in an unfamiliar repo:** Open it in Code Map, click through caller/callee pins, walk the auth flow in five clicks instead of a 90-minute file-tree scavenger hunt.
- **Two-person team:** Senior reviews via LAN-shared review page, no GitHub PR round-trip needed for in-progress work.
- **Team on a shared dev box:** self-host one Cockpit where the code lives — every teammate opens a browser, takes a seat, and runs their own AI sessions in their own project / worktree.
- **Reviewing AI-generated PRs:** Switch the changed files into Code Map — changed functions are highlighted with their callers / callees still drawn around them, so blast-radius is one click away.
- **Full-stack chore mode:** `/fx` in one tab on a backend bug, `/ex` in another to plan the frontend refactor, `/go` to land it — three slash modes, three different agent postures.
- **Cheap second opinion:** Same prompt in two tabs — Claude in one, **DeepSeek v4-pro** in the other — compare answers before you trust either.
- **AI-driven QA:** Browser Bubble + scheduled task = "every night at 2 AM, run this UI smoke flow and post a summary".
- **Privacy-sensitive code:** runs on your laptop. Pair with an **Ollama** tab for fully air-gapped sessions. No telemetry, no relay.

## Try online

No install, no AI chat (read-only sandbox, 5 min):

[![Try Online](https://img.shields.io/badge/Try%20Online-opencockpit.dev%2Ftry-12a594?style=for-the-badge)](https://opencockpit.dev/try)

## Prerequisites

- **macOS, Linux, or Windows** — Windows support is experimental ([details](#windows))
- **Node.js ≥ 20** — [nodejs.org](https://nodejs.org/)
- **Claude Code** — [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code) (default engine)
- **Git** — for git features (blame, diff, worktree, etc.)
- **Chrome** *(optional)* — for Browser Bubble; install the bundled extension from `~/.cockpit/chrome-extension`

### Optional, per non-Claude engine

- **Codex** — log in once with `codex login` to populate `~/.codex`
- **DeepSeek** — get an API key at [api-docs.deepseek.com](https://api-docs.deepseek.com/); paste it into the engine picker
- **GLM (Zhipu / BigModel)** — get an API key (`<id>.<secret>`) at [bigmodel.cn/apikey/platform](https://bigmodel.cn/apikey/platform); paste it into the **API Key** field of the model picker in the chat header. The same key works on both hosts, so **Region** (`open.bigmodel.cn` / `api.z.ai`) is just routing — it defaults from your UI language and can be overridden in the picker.
- **Kimi (Moonshot)** — get a **Kimi Code** API key (`sk-kimi-…`) at [kimi.com/code/console](https://www.kimi.com/code/console); paste it into the **API Key** field of the model picker in the chat header. *(A `platform.moonshot.cn` Open Platform key is a different product and will not work.)* The `kimi` CLI is no longer used.
- **Ollama** — install [ollama.com](https://ollama.com/) and `ollama pull <model>`; Cockpit auto-starts the daemon

> API keys are stored locally, each in its own file at `~/.cockpit/<engine>/credentials.json` (e.g. `~/.cockpit/kimi/credentials.json`, `~/.cockpit/glm/credentials.json`) — never in `settings.json`. No cloud relay.

## Install

```bash
npm install -g @surething/cockpit
cockpit                # start cockpit → http://localhost:3457
cockpit .              # open current dir as a project
cockpit ~/my-project   # open specified dir
cockpit -h             # help
```

### Running in the background

`cockpit` runs in the foreground, so closing the terminal stops it. To keep it
running:

```bash
cockpit start          # start in the background
cockpit status         # running? which version, port, pid, uptime
cockpit restart        # restart in place
cockpit stop
```

`start` accepts the same flags as `cockpit` (`--port`, `--token`). Output goes
to `~/.cockpit/logs/server.log`.

`restart` asks the running server to replace itself, so the port and token it
was started with are preserved — you do not need to repeat them.

> There is no launchd/systemd integration: after a reboot, run `cockpit start`
> again (or add it to your login items).

### Updating

```bash
cockpit update
```

…or click the version pill in the sidebar when an update is available.

If Cockpit is **running**, it updates in place: the server hands off to a
helper that installs while nothing is holding the install directory, then
relaunches with the same port and token. A failed install rolls back to the
previous version and still restarts, so an interrupted update never leaves you
without a working Cockpit.

If it is **not running**, `cockpit update` simply installs.

Once the new server is up, any browser tab left open from the old version shows
a "reload" prompt — its cached assets belong to the previous build.

### Windows

Windows support is **experimental** — it is exercised by CI but has far less
real-world mileage than macOS and Linux. Cockpit runs natively; the Console
panel uses Git Bash when it is installed and falls back to PowerShell, the same
order Claude Code applies on Windows.

- Install [Git for Windows](https://git-scm.com/download/win) for a bash
  terminal. Without it the Console panel runs PowerShell, and the
  `cockpit.bash` channel used by HTML apps is unavailable.
- The file browser, diff, review and chat panels behave as they do elsewhere.

Prefer a Linux toolchain? Run *all* of Cockpit inside **WSL2**, where it is an
ordinary Linux install:

```powershell
wsl --install          # once, from an admin PowerShell, then reboot
```

```bash
wsl                                  # enter your Linux shell
npm install -g @surething/cockpit    # install Node ≥ 20 inside WSL first
cockpit
```

Either way, open `http://localhost:3457` in your Windows browser — WSL2
forwards localhost automatically.

> **Pick one side and stay there.** Running Cockpit on Windows while your
> project lives inside WSL (or the reverse) gives the agent one set of paths
> and its terminal another: the same directory is `C:\Users\me\proj` on one
> side and `/mnt/c/Users/me/proj` on the other, so paths passed between them
> do not resolve. Keep Cockpit and your code in the same world.

> Both `cockpit` (full name) and `cock` (short alias) ship with the package — use whichever you prefer. Docs and examples use `cockpit`; existing muscle memory keeps working.

### From source

```bash
git clone https://github.com/Surething-io/cockpit.git
cd cockpit
npm install
npm run setup       # build + npm link (registers `cockpit` and `cock`)
```

## CLI

```bash
cockpit browser <id> snapshot      # capture accessibility tree
cockpit browser <id> click <uid>   # click element
cockpit terminal list              # list terminal bubbles
cockpit terminal <id> output       # read terminal output (filter, cursor)
cockpit connection list --cwd .    # list ALL bubbles (term + browser) with user-set titles
```

## Read more

- 📖 [What is a Code Graph (and why your AI needs one)](https://opencockpit.dev/en/blog/code-graph-for-ai-agents/)
- 📖 [Read code as a map, not a tree](https://opencockpit.dev/en/blog/read-code-as-a-map/)
- 📖 [How to run 5 Claude Code sessions in parallel](https://opencockpit.dev/en/blog/parallel-claude-code-sessions/)
- 📖 [Full blog](https://opencockpit.dev/en/blog/)
- 📋 [Changelog](https://opencockpit.dev/en/changelog/)

## Development

```bash
npm run dev         # dev server → http://localhost:3456
npm run build       # production build
npm run setup       # build + npm link
npm run lint        # ESLint
```

## Tech stack

Next.js 16 · React 19 · TypeScript · TailwindCSS · xterm.js · node-pty · Shiki · tree-sitter (WASM) · i18next · Claude Agent SDK · Vercel AI SDK

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [OpenCockpit docs](https://opencockpit.dev/en/docs/).

## License

[MIT](LICENSE) © Surething

---

<sub>If Cockpit saved you 10 minutes today, a ⭐️ on GitHub is the cheapest thank-you we know.</sub>
