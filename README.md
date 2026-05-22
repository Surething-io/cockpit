<p align="center">
  <a href="https://cocking.cc">
    <img src="public/icons/icon-128x128.png" width="80" alt="Cockpit logo" />
  </a>
</p>

<h1 align="center">Cockpit — A Claude Code GUI for parallel AI coding</h1>

<p align="center">
  <strong>One seat. Any AI. Everything under control.</strong><br/>
  <sub><code>/ˈkɒkpɪt/</code> — like an aircraft cockpit</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@surething/cockpit"><img src="https://img.shields.io/npm/v/@surething/cockpit?color=12a594&label=npm&style=flat-square" alt="npm version"/></a>
  <a href="https://www.npmjs.com/package/@surething/cockpit"><img src="https://img.shields.io/npm/dm/@surething/cockpit?color=12a594&label=downloads&style=flat-square" alt="npm downloads"/></a>
  <a href="https://github.com/Surething-io/cockpit/stargazers"><img src="https://img.shields.io/github/stars/Surething-io/cockpit?color=12a594&style=flat-square" alt="GitHub stars"/></a>
  <a href="https://github.com/Surething-io/cockpit/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-12a594?style=flat-square" alt="MIT license"/></a>
  <a href="https://cocking.cc"><img src="https://img.shields.io/badge/website-cocking.cc-12a594?style=flat-square" alt="website"/></a>
  <a href="https://github.com/anthropics/anthropic-sdk-typescript"><img src="https://img.shields.io/badge/built_on-Claude%20Agent%20SDK-12a594?style=flat-square" alt="Built on Claude Agent SDK"/></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh.md">中文</a> · <a href="https://cocking.cc">Website</a> · <a href="https://cocking.cc/en/blog/">Blog</a>
</p>

---

> **Cockpit is the open-source Claude Code GUI** — and a single canvas for whatever agent you bring next. Run multi-project Claude sessions out of the box; pop open a tab for **OpenAI Codex, DeepSeek, Kimi, or local Ollama** whenever you need. Built-in terminal, Chrome control, PostgreSQL / MySQL / Redis bubbles, code review, and slash modes — all local.

https://github.com/user-attachments/assets/18f1a5dc-64f3-4ff6-b9fc-9cd08181fbb8

```bash
npm i -g @surething/cockpit && cockpit
```

## Why Cockpit?

Anthropic ships **Claude Code as a CLI**. That's the right call for power users — but the moment you have more than one project in flight, your terminal turns into mission control with no instruments.

Cockpit is the instrument panel. It does **not** replace Claude Code; it stands on top of the official Agent SDK and gives you the things a CLI can't:

| Pain with raw Claude Code | What Cockpit adds |
|---|---|
| Stuck on one model | **5 engines side by side** in tabs: Claude (default), OpenAI Codex, DeepSeek, Kimi, local Ollama — each its own session |
| One session at a time, terminal chaos at 3+ projects | **Multi-project tabs**, parallel agent sessions, red-dot inbox, desktop notifications |
| Image attachments are awkward | Drop / paste images straight into chat |
| "What was I debugging yesterday?" | Cmd+K cross-project session browser, pinning, forking |
| Agent can't reach your browser / DB | **Smart Bubbles**: Chrome, PostgreSQL, MySQL, Redis — drivable by the agent |
| Reading an unfamiliar repo means a 90-min file-tree scavenger hunt | **Code Map** chip view — caller / callee pins, click to walk the call graph |
| Reviewing AI output is friction | **LAN-shared review pages**, line-level comments, send any comment back as AI context |
| Same "do X but don't change code" prompt every day | **Slash modes** `/qa /fx /review /commit` + custom `~/.claude/commands/*.md` |
| No automation hooks | One-time / interval / cron-based **scheduled tasks** |
| "Cloud relay" trust concerns | **Fully local**. No telemetry. Keys (Codex / DeepSeek / Kimi) stay in `~/.cockpit/settings.json` on your laptop. |

## Features

### Engines — Claude by default, bring any agent you want

- **Claude** *(default)* — full official Agent SDK; zero setup if `claude` CLI is already configured
- **OpenAI Codex** — reuses your `~/.codex` config; same chat, same shell + bubbles
- **DeepSeek** — Anthropic-compatible endpoint via the Claude SDK; paste a key, pick `v4-pro` or `v4-flash`
- **Kimi** *(Moonshot)* — tool calls render in chat just like Claude's
- **Ollama** — auto-starts the daemon; pick any pulled model from the chat header; fully offline
- Each engine lives in its own **tab with its own session history**; switch from the new-tab dropdown
- Keys stored locally in `~/.cockpit/settings.json`; **no cloud relay**

### Agent — AI chat that scales

- Default engine powered by the **official Claude Agent SDK** — zero extra setup
- **Multi-project concurrent sessions** with desktop notifications and red-dot badges
- Session **pinning, forking**, cross-project session browser (Cmd+K)
- `!command` prefix to run shell from chat — output piped back as context
- Image attachments, code references, token usage tracking

### Explorer — Code & files

- **4-tab file browser**: Directory · Recent · Git Changes · Git History
- Syntax highlighting (Shiki) with **Vi mode** editing
- Git **blame**, diff view, branch switching, **worktree** management
- **LSP integration** — go to definition, find references, hover info
- **Code Map** — every function as a chip with caller / callee pins; click to walk the call graph. Multi-language: TS/JS, Python, Go, Rust. No LSP, no project setup, works offline.
- **CodeGraph** — a **code graph** for the agent: same tree-sitter index exposed as 6 HTTP endpoints (`search` / `callers` / `callees` / `impact` / `file` / `coedit`) so the agent queries coordinates instead of grepping text; trigger with `/cg` from chat. Coordinates only, never source — precise, cheap, and catches the conventional coupling no regex can.
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
- `/review` — read the diff, write notes, no rewrites
- `/commit` — stage + draft a message in your repo's style + commit
- `/cg` — **CodeGraph** project exploration: 6 HTTP endpoints for symbol / callers / impact / co-edit queries (precise where grep is fuzzy)
- **Custom**: drop any `*.md` into `~/.claude/commands/` or `./.claude/commands/` → instant slash command

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
- **Reviewing AI-generated PRs:** Switch the changed files into Code Map — changed functions are highlighted with their callers / callees still drawn around them, so blast-radius is one click away.
- **Full-stack chore mode:** `/fx` in one tab on a backend bug, `/review` in another on the frontend diff, `/commit` to wrap up — three slash modes, three different agent postures.
- **Cheap second opinion:** Same prompt in two tabs — Claude in one, **DeepSeek v4-pro** in the other — compare answers before you trust either.
- **AI-driven QA:** Browser Bubble + scheduled task = "every night at 2 AM, run this UI smoke flow and post a summary".
- **Privacy-sensitive code:** runs on your laptop. Pair with an **Ollama** tab for fully air-gapped sessions. No telemetry, no relay.

## Try online

No install, no AI chat (read-only sandbox, 5 min):

[![Try Online](https://img.shields.io/badge/Try%20Online-cocking.cc%2Ftry-12a594?style=for-the-badge)](https://cocking.cc/try)

## Prerequisites

- **Node.js ≥ 20** — [nodejs.org](https://nodejs.org/)
- **Claude Code** — [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code) (default engine)
- **Git** — for git features (blame, diff, worktree, etc.)
- **Chrome** *(optional)* — for Browser Bubble; install the bundled extension from `~/.cockpit/chrome-extension`

### Optional, per non-Claude engine

- **OpenAI Codex** — log in once with `codex login` to populate `~/.codex`
- **DeepSeek** — get an API key at [api-docs.deepseek.com](https://api-docs.deepseek.com/); paste it into the engine picker
- **Kimi (Moonshot)** — get an API key at [platform.moonshot.cn](https://platform.moonshot.cn/); paste it into the engine picker
- **Ollama** — install [ollama.com](https://ollama.com/) and `ollama pull <model>`; Cockpit auto-starts the daemon

> All API keys are stored locally in `~/.cockpit/settings.json`. No cloud relay.

## Install

```bash
npm install -g @surething/cockpit
cockpit                # start cockpit → http://localhost:3457
cockpit .              # open current dir as a project
cockpit ~/my-project   # open specified dir
cockpit -h             # help
```

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
cockpit terminal <id> exec "ls"    # execute command
cockpit terminal <id> output       # get terminal output
```

## Comparison

| | Raw Claude Code CLI | IDE plugin (Cursor, Continue) | Aider TUI | **Cockpit** |
|---|---|---|---|---|
| Multi-engine in app | Claude only | varies | yes, config-driven | **5 in-app: Claude, Codex, DeepSeek, Kimi, Ollama** |
| Multi-project parallel | tmux required | multi-window | one at a time | **first-class** |
| Cross-project search | grep | per-window | local | **Cmd+K** |
| Browser / DB control | ❌ | usually ❌ | ❌ | **✅ Bubbles** |
| Code review surface | git tools | PR provider | git | **LAN-shared** |
| Slash modes | manual | per-plugin | yes | **`/qa /fx /review /commit /cg` + custom** |
| Project-graph API for agent | ❌ | LSP (per-IDE) | ❌ | **✅ CodeGraph — 6 endpoints, AI-first, coordinates only** |
| Local-only / no cloud relay | ✅ | varies | ✅ | **✅** |
| Open source | ✅ | mostly ❌ | ✅ | **✅ MIT** |

Read the long version: [Claude Code GUI: CLI vs Cockpit vs IDE plugins](https://cocking.cc/en/blog/claude-code-gui-comparison/)

## Read more

- 📖 [What is a Code Graph (and why your AI needs one)](https://cocking.cc/en/blog/code-graph-for-ai-agents/)
- 📖 [Read code as a map, not a tree](https://cocking.cc/en/blog/read-code-as-a-map/)
- 📖 [How to run 5 Claude Code sessions in parallel](https://cocking.cc/en/blog/parallel-claude-code-sessions/)
- 📖 [Slash modes in Claude Code: /qa /fx /review /commit](https://cocking.cc/en/blog/slash-modes-claude-code/)
- 📖 [Full blog](https://cocking.cc/en/blog/)
- 📋 [Changelog](https://cocking.cc/en/changelog/)

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

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and [GUIDE.md](GUIDE.md).

## License

[MIT](LICENSE) © Surething

---

<sub>If Cockpit saved you 10 minutes today, a ⭐️ on GitHub is the cheapest thank-you we know.</sub>
