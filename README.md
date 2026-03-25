<p align="center">
  <img src="public/icons/icon-128x128.png" width="80" />
</p>

# The Cockpit That Drives AI

**One seat. One AI. Everything under control.**

A unified development cockpit built on **Claude Code (Agent SDK)** — chat, code, terminal, browser, database all in one interface. If you can run Claude Code, Cockpit works out of the box — zero config, zero cloud dependency.

**20× AI power, 20× your productivity.** Run multiple AI sessions in parallel across projects, stay in flow with notifications and red-dot badges, collaborate through shared code reviews — all from within the cockpit.

## Features

### Agent — AI Chat
- Powered by Claude Code (Agent SDK) — zero API key setup if Claude Code is already configured
- Multi-project concurrent sessions — run multiple AI tasks in parallel, get notified when done
- Session pinning, forking, and cross-project session browser
- `!command` prefix to execute shell commands from chat
- Image attachments, inline code references, token usage tracking

### Explorer — Code & Files
- Directory tree / Recent / Git Changes / Git History — 4-tab file browser
- Syntax highlighting (Shiki) with Vi mode editing
- Git blame, diff view, branch switching, worktree management
- LSP integration — go to definition, find references, hover info
- Fuzzy file search (Cmd+F), JSON viewer, Markdown preview, Mermaid diagrams

### Console — Terminal & Bubbles
- Full terminal emulator (xterm.js) with shell integration
- **Browser Bubble** — control Chrome via accessibility tree: click, type, navigate, screenshot, network inspection
- **Database Bubble** — connect PostgreSQL, explore schema, run queries, export data
- **MySQL Bubble** — connect MySQL, browse databases/tables, run queries, export data
- **Redis Bubble** — browse keys, inspect values, execute commands
- Drag-to-reorder bubbles, grid / maximized layout
- Environment variables & shell aliases per tab

### Code Review — Team Collaboration
- LAN-shareable review pages — team members review without installing anything
- Line-level commenting with reply threads
- Send comments as AI context for automated fixes
- Red-dot badges for unread comments

### Scheduled Tasks
- One-time, interval, or cron-based task scheduling
- Pause/resume, reorder, result tracking

### Stay in Flow
- Three-panel swipe UI — Agent / Explorer / Console always rendered, instant switch
- Red-dot badges & toast notifications — never miss a completed AI task
- Multi-project workspace — each project isolated, switch without losing state
- Dark / Light theme, English / Chinese i18n
- Chrome extension (Manifest V3) for browser automation bridge
- CLI tools: `cock browser` / `cock terminal` for headless automation

## Install

```bash
npm install -g @surething/cockpit
cock                # Start server → http://localhost:3457
cock -h             # Show help
cock -v             # Show version
```

### From Source

```bash
git clone https://github.com/Surething-io/cockpit.git
cd cockpit
npm install
npm run setup       # Build + npm link (registers `cock` command)
```

## CLI

```bash
cock browser <id> snapshot    # Capture accessibility tree
cock browser <id> click <uid> # Click element
cock terminal <id> exec "ls"  # Execute command
cock terminal <id> output     # Get terminal output
```

## Development

```bash
npm run dev         # Dev server → http://localhost:3456
npm run build       # Production build
npm run setup       # Build + npm link
npm run lint        # ESLint
```

## Tech Stack

Next.js 16 · React 19 · TypeScript · TailwindCSS · xterm.js · Shiki · i18next
