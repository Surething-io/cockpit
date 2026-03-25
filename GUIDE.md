# Cockpit Quick Start

## Installation & Launch

```bash
cd /path/to/cockpit
npm install
npm run setup       # Build + register the cock command
cock                # Start server, auto-opens browser at http://localhost:3457
```

Dev mode: `npm run dev` (port 3456, HMR hot reload)

## Chrome Extension (First-time Setup)

Browser bubbles rely on this extension for cookie injection and automation scripts:

1. Open `chrome://extensions/` in Chrome
2. Enable "Developer mode" in the top-right corner
3. Click "Load unpacked" and select the `chrome-extension/` directory

Once installed, no further action is needed. The extension auto-updates when code changes. You can check extension status in the Cockpit settings page (gear icon in the sidebar).

## Interface Overview

```
+-- Sidebar -+----------------------------------------------+
| Projects   |                                              |
| Pinned     |   Three-panel swipe (Cmd+1 / Cmd+2 / Cmd+3) |
| Scheduled  |                                              |
| Settings   |   Agent(Chat) | Explorer(Files) | Console    |
+------------+----------------------------------------------+
```

- **Sidebar**: Project management, pinned sessions, scheduled tasks
- **Three-panel layout**: All panels render simultaneously, swipe to switch (no unmounting)

## Three-Panel Core Usage

### 1. Agent (Cmd+1) — AI Chat

- Multi-tab interface, each tab is an independent Claude session
- **Enter** to send, **Shift+Enter** for newline
- Paste images to attach directly to messages
- Type `/` to trigger slash command completion (built-in + custom)
- Type `!ls -la` to execute shell commands and attach output to messages
- File changes in AI messages are viewable via "View file changes" Diff button

### 2. Explorer (Cmd+2) — File Browser

Four tabs:

| Tab | Function |
|-----|----------|
| Directory Tree | File tree + context menu (new/copy/delete/copy path) |
| Recent Files | Recently opened files list |
| Git Changes | Stage/unstage/discard changes, click to view Diff |
| Git History | Commit log, click to view commit details |

Code preview area:
- **Cmd+F** in-file search
- **Cmd+Click** go-to-definition (TypeScript / Python)
- Hover to show type information
- Select text to reveal floating toolbar: Add comment / Ask AI / Search
- **Cmd+P** quick file open

### 3. Console (Cmd+3) — Terminal & Bubbles

The input bar supports multiple input types:

| Input | Behavior |
|-------|----------|
| `ls -la` | Creates a command bubble, executes shell command |
| `zsh` | Creates an interactive PTY terminal (supports vim, npm, etc.) |
| `https://example.com` | Creates a browser bubble, loads webpage in iframe |
| `postgresql://...` | Creates a database bubble, connects to PostgreSQL |
| `redis://...` | Creates a Redis bubble |

- **Tab** for command completion
- **Up/Down arrows** to browse command history
- Bubbles support drag-to-reorder, maximize (Cmd+M), and dual/single column toggle

## CLI Automation

Browser and terminal bubbles each have a 4-character short ID (shown as a badge in the title bar). Use the CLI to control them:

```bash
# Browser automation
cock browser list                    # List all browser bubbles
cock browser abcd snapshot           # Get page element tree
cock browser abcd click --ref e5     # Click an element
cock browser abcd evaluate --js "return document.title"

# Terminal automation
cock terminal list                   # List all terminal bubbles
cock terminal abcd output            # Read terminal output
cock terminal abcd stdin "npm test"  # Send command to terminal
```

Full commands: `cock browser --help` / `cock terminal --help`

## Common Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+1/2/3 | Switch to Agent / Explorer / Console |
| Cmd+P | Quick file open |
| Cmd+F | In-file search |
| Cmd+Click | Go to definition |
| Cmd+M | Maximize/restore bubble |
| Cmd+S | Save file being edited |
| Ctrl+- | Navigate back |
| Ctrl+Shift+- | Navigate forward |
| Escape | Stop AI generation / Exit Blame / Close panel |

## More

Full feature manual: [docs/manual.en.md](docs/manual.en.md)
