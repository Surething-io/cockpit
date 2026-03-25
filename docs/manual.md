# Cockpit Feature Manual

## Table of Contents

- [1. Workspace & Project Management](#1-workspace--project-management)
- [2. Agent — AI Chat](#2-agent--ai-chat)
- [3. Explorer — File Browser](#3-explorer--file-browser)
- [4. Console — Terminal & Bubbles](#4-console--terminal--bubbles)
- [5. Browser Automation (CLI)](#5-browser-automation-cli)
- [6. Terminal Automation (CLI)](#6-terminal-automation-cli)
- [7. Code Review System](#7-code-review-system)
- [8. Scheduled Tasks](#8-scheduled-tasks)
- [9. Notes System](#9-notes-system)
- [10. Git Tools](#10-git-tools)
- [11. LSP Code Intelligence](#11-lsp-code-intelligence)
- [12. Chrome Extension](#12-chrome-extension)
- [13. Keyboard Shortcuts Reference](#13-keyboard-shortcuts-reference)

---

## 1. Workspace & Project Management

### 1.1 Sidebar

The left sidebar serves as the global navigation hub:

- **Project List**: Displays all opened projects; click to switch, drag to reorder
  - Red dot indicates unread AI replies
  - Loading animation indicates AI is responding
  - Right-click to remove a project
- **Pinned Sessions**: Quick access to frequently used sessions; supports renaming and drag-to-reorder
- **Scheduled Tasks Panel**: View and manage all scheduled tasks (see [Section 8](#8-scheduled-tasks))
- **Notes Button**: Opens global notes
- **Settings Button**: Theme toggle, Chrome extension status, version info

### 1.2 Top Bar

Each project's top toolbar:

| Element | Description |
|---------|-------------|
| Project Path | Current working directory; click to copy |
| Git Branch | Current branch name; click to open Worktree manager |
| View Switcher | Switch between Agent / Explorer / Console |
| Review Dropdown | Manage code reviews (create/switch/delete) |
| Session Manager | Open list of all Claude sessions for the project |
| VS Code / Cursor | One-click open project in editor |
| Alias Manager | Manage global command aliases |
| Token Stats | View Claude API usage and costs |

### 1.3 Multi-Project Workflow

- Sidebar + button opens folder picker to add projects
- Each project runs in an independent iframe; switching preserves state
- When a background project's AI session completes, a Toast notification appears in the bottom-left
- WebSocket pushes real-time project state changes

### 1.4 Session Management

- **Multi-tab**: Each project can have multiple Claude conversations open simultaneously
- **Pinned Sessions**: Pin frequently used sessions to the sidebar
- **Fork Session**: Hover over a user message → Fork icon to branch a new session from that message
- **Session Browser**: Sidebar button opens a global session list, browsable across projects

---

## 2. Agent — AI Chat

Shortcut **Cmd+1** to switch to this panel.

### 2.1 Sending Messages

- **Enter** to send, **Shift+Enter** for newline
- **Paste images**: Supports PNG/JPEG/WebP/GIF, max 5MB, shows thumbnail preview before sending
- **Escape**: Press Escape while AI is generating to stop

### 2.2 Slash Commands

Type `/` to trigger the completion menu; use Up/Down arrows to select, Enter/Tab to confirm:

- **Built-in commands**: e.g., `/compact`
- **Global commands**: Defined in `~/.cockpit/commands.json`
- **Project commands**: Defined in the project root's `.cockpit/commands.json`

### 2.3 Shell Command Integration

- Type `!command` to execute a shell command; output is automatically attached to the AI message
- Type `cock ...` to execute Cockpit CLI commands; output is attached to the message

### 2.4 AI Message Display

- Full Markdown rendering: syntax highlighting, tables, lists, GitHub Alerts, math formulas, HTML
- **Mermaid diagrams**: Interactive rendering
- **Tool calls**: Displayed collapsed; expandable to view input/output details
- **File changes**: After Edit/Write tool calls, a "View file changes" button opens a Diff view
- **Markdown file preview**: Read/Edit of `.md` files shows a preview button
- **Todo list**: If AI uses TodoWrite, displays current task progress

### 2.5 Input Bar Tool Buttons

From left to right:

| Button | Function |
|--------|----------|
| Git Stage All (+) | Executes `git add -A` |
| Git Changes | Switches to Explorer's Git Changes tab |
| Comment List | Opens all code comments; supports batch copy/send to AI |
| User Message List | Lists all user messages; click to quickly navigate |
| Notes | Opens project notes |
| Scheduled Task | Creates a scheduled AI task |

### 2.6 Text Selection in Messages

Selecting text in an AI reply reveals a floating toolbar:

- **Add Comment**: Saves the selected AI reply text as a comment
- **Ask AI**: Uses the selected text as a quote to ask AI a follow-up question

---

## 3. Explorer — File Browser

Shortcut **Cmd+2** to switch to this panel.

### 3.1 Four Tabs

#### Directory Tree

- Lazy-loaded file tree; click to expand/collapse directories
- File icons overlay Git status indicators (M modified, A added, D deleted, R renamed, ? untracked)
- WebSocket file watcher; external changes auto-refresh
- Context menu:
  - New file
  - Copy/paste files
  - Delete file/directory
  - Copy relative/absolute path
  - Copy file/directory name
- **Cmd+C** to copy selected file, **Cmd+V** to paste

#### Recent Files

- Lists recently opened files in reverse chronological order
- Remembers the last scroll position for each file

#### Git Changes

- Displays staged and unstaged changes in separate sections
- Per-file actions: stage, unstage, discard changes, view Diff
- Batch operations: checkbox multi-select for bulk stage/unstage/discard
- Click a file to view Diff; supports Diff minimap navigation

#### Git History

- Branch selection dropdown (with search)
- Paginated commit log
- Click a commit to view changed files and per-file Diff

### 3.2 Code Preview Area

Right-side code viewer features:

- **Virtual scrolling**: Smooth scrolling for large files (tens of thousands of lines)
- **Syntax highlighting**: Shiki engine, supports all major languages
- **Line numbers**

#### In-File Search (Cmd+F)

- Case-sensitive / whole-word matching toggles
- Enter for next match, Shift+Enter for previous
- Highlights all matches

#### Git Blame

- Click the Blame button to activate
- Left side of each line shows author, timestamp, commit hash
- Click commit hash → Commit detail panel slides up from the bottom
- Escape to exit Blame view

#### Inline Editing

- Toggle edit mode to make line contents editable
- Cmd+S to save
- Detects external file changes and shows conflict prompt
- Dirty marker indicates unsaved changes

#### Vi Mode

Press Escape in view mode to enter Vi normal mode:

- Movement: `h j k l`, `w b e` (word-level), `gg` / `G` (first/last line), `Ctrl+D/U` (half-page scroll)
- Editing: `dd` delete line, `yy` yank line, `p` paste, `x` delete character, `o/O` new line
- Enter insert mode: `i a I A`
- Save: `:w`
- Search: `/keyword`, `n/N` next/previous

#### JSON Readable Mode

`.json` files can switch to a formatted view; supports Cmd+F search.

#### Image Preview

Image files render directly in the preview area.

#### Markdown Preview

`.md` files display as an interactive preview, rendered with TipTap editor.

### 3.3 Quick File Open (Cmd+P)

- Fuzzy-match search across all project files
- Recently opened files appear first
- Up/Down arrows to select, Enter to open

### 3.4 Floating Selection Toolbar

Appears when selecting text in the code preview area:

- **Add Comment**: Creates a comment on the selected line range
- **Send to AI**: Sends the selected code as a quoted reference to AI chat
- **Search**: Searches for the selected text across the entire project

### 3.5 Diff View

Diff viewer for Git Changes and Commit details:

- Virtual-scrolled rendering
- Diff minimap (right-side thumbnail navigation)
- Line-level comments: Select Diff lines to add comments or send to AI
- Markdown/JSON files can switch to preview mode

---

## 4. Console — Terminal & Bubbles

Shortcut **Cmd+3** to switch to this panel.

### 4.1 Input Bar

- **Tab** for command completion (uses shell's completion engine)
- **Up/Down arrows** to browse command history
- **`/` slash commands** for quick execution of preset commands
- URL-format input is automatically recognized as browser/database/Redis bubbles

#### Tool Buttons

| Button | Function |
|--------|----------|
| Quick Commands (lightning) | Opens preset command list |
| Notes (pencil) | Project notes |
| Dual/Single Column Toggle | Bubble layout mode |
| Environment Variables | View/edit environment variables |
| Launch zsh (>_) | Creates an interactive terminal bubble |

### 4.2 Command Bubbles

Each command execution creates a bubble card:

- **Title bar**: Command text, ShortID badge, timestamp
- **Output area**: ANSI color rendering
- **Status**: Running (animation), success (green), failed (red exit code)
- **Actions**: Copy output, copy command, re-run, delete
- **Search/Filter output**: Search mode (highlight matches) or filter mode (show only matching lines)
- **Drag to reorder**: Drag the title bar to rearrange bubble order
- **Maximize**: Cmd+M to expand the selected bubble to full height

#### PTY Interactive Terminal

Typing `zsh` or commands requiring interaction (e.g., `vim`, `npm`) creates a full pseudo-terminal:

- Rendered with xterm.js
- Supports Ctrl+C/D/Z/L and other control keys
- Auto-resizes terminal dimensions

### 4.3 Browser Bubbles

Enter a URL (e.g., `https://example.com`) to create:

- **iframe rendering**: Loads the target webpage; Chrome extension injects cookies
- **Navigation bar**: Back, forward, refresh, URL input field
- **ShortID badge**: 4-character identifier; click to copy CLI command
- **Automation bridge**: Once connected, controllable via `cock browser` CLI
- **Link interception**: `target="_blank"` links within the page automatically create new bubbles instead of new tabs
- **Sleep strategy**:
  - When not visible and CLI is not connected, auto-sleeps after 5 minutes (unloads iframe to free resources)
  - No sleep when CLI is connected
  - No sleep when visible
  - Click to wake from sleep

### 4.4 Database Bubble (PostgreSQL)

Enter `postgresql://user:pass@host:port/db` to create:

- **Left panel**: Schema selector, table/view list (with row count estimates), type filter (T tables / V views), refresh button
- **Table structure**: Click a table name to view column info (name, type, nullable, default, primary key, foreign key, indexes)
- **Data browsing**:
  - Paginated table display
  - Column filtering: supports =, !=, >, <, LIKE, IN, IS NULL, and more operators
  - Column sorting: click headers to toggle ASC/DESC
  - Shows total row count
- **SQL Editor**: Enter arbitrary SQL queries; multi-statement support
- **CSV Export**: Export query results as CSV files

### 4.5 Redis Bubble

Enter `redis://...` to create:

- **Data browsing**: Key list, type indicators, search/filter, view values (string/hash/list/set/zset), TTL, size
- **Server info**: Redis INFO output
- **CLI terminal**: Interactive Redis command line with history and formatted output
- **Key operations**: Delete key (with confirmation)

### 4.6 Bubble Layout

- **Dual-column grid** (default): Bubbles displayed in 2 columns side by side
- **Single-column list**: Bubbles stacked vertically
- Toggle via the layout button in the input bar; setting is persisted per project

---

## 5. Browser Automation (CLI)

Control browser bubbles opened in Console via the `cock browser` command.

### 5.1 Basic Usage

```bash
cock browser list                        # List all connected browsers
cock browser <id>                        # View status and help
cock browser <id> --help                 # Full command list
```

`<id>` is the 4-character short identifier shown in the bubble's title bar.

### 5.2 Navigation

```bash
cock browser <id> navigate --url <url>   # Navigate to URL
cock browser <id> reload                 # Reload page
cock browser <id> reload --noCache       # Reload ignoring cache
cock browser <id> back                   # Go back
cock browser <id> forward                # Go forward
cock browser <id> url                    # Get current URL
cock browser <id> title                  # Get page title
```

### 5.3 Page Inspection

```bash
cock browser <id> snapshot               # Get page element tree (a11y tree, each element has a ref ID)
cock browser <id> screenshot             # Take screenshot, save to /tmp, returns path
```

### 5.4 Interaction

```bash
cock browser <id> click --ref e5         # Click element
cock browser <id> type --ref e3 --text "hello"   # Type text
cock browser <id> fill --ref e3 --value "hello"  # Fill form field
cock browser <id> hover --ref e5         # Hover
cock browser <id> focus --ref e5         # Focus
cock browser <id> scroll --direction down        # Scroll
cock browser <id> key Enter              # Press key
cock browser <id> wait --text "Dashboard"        # Wait for text to appear
```

Ref IDs are obtained via the `snapshot` command.

### 5.5 JavaScript Execution

```bash
cock browser <id> evaluate --js "return document.title"
cock browser <id> evaluate --js "return document.querySelector('.btn').textContent" --all-frames
```

`--all-frames` executes across all iframes. The execution context inherits the page's authentication state.

### 5.6 Debugging Tools

```bash
cock browser <id> console --level error          # View console errors
cock browser <id> network --status 4xx,5xx       # View failed network requests
cock browser <id> network_record start           # Start recording network requests
cock browser <id> network_record stop            # Stop recording and output results
cock browser <id> perf --metric timing           # Page load performance
cock browser <id> cookies                        # View cookies
cock browser <id> storage --type local           # View localStorage
cock browser <id> theme --mode dark              # Toggle dark mode
```

### 5.7 Assertions

```bash
cock browser <id> assert --ref e5 --visible true
# Outputs PASS or FAIL; exit code is 1 on failure
```

### 5.8 Data Flow

```
CLI command → HTTP API → WebSocket → BrowserBubble → postMessage → iframe content script → execute → result returns via same path
```

---

## 6. Terminal Automation (CLI)

Control terminal bubbles in Console via the `cock terminal` command.

```bash
cock terminal list                       # List all terminals
cock terminal <id>                       # View status and help
cock terminal <id> output                # Read terminal buffer output
cock terminal <id> stdin "npm test"      # Send command to terminal
cock terminal <id> follow                # Stream output in real-time (Ctrl+C to exit)
```

---

## 7. Code Review System

### 7.1 Creating a Review

Top bar "Review Dropdown" → Create new review. Reviews are associated with the current project's Git changes.

### 7.2 Managing Reviews

- Toggle review active/inactive status
- Drag to reorder reviews
- Delete review (requires confirmation)
- Red dot for unread comments

### 7.3 Comments

- Select text in Diff view or code preview → Add comment
- Comments are grouped by file
- Reply support
- Comments can be sent to AI as code context

### 7.4 LAN Sharing

Review pages are exposed to the local network via Share Server (port = main port + 1000):

- Production: `http://<LAN-IP>:4457/review/<id>`
- Only `/review/*` paths are accessible; all other routes return 403

---

## 8. Scheduled Tasks

### 8.1 Creating a Task

The clock button in the ChatInput toolbar opens the creation panel. Three modes:

| Mode | Configuration | Example |
|------|---------------|---------|
| One-time | Delay in minutes | Execute after 30 minutes |
| Interval | Interval in minutes + optional active time window | Every 60 minutes, 09:00-18:00 |
| Cron | Cron expression | `0 9 * * 1-5` (weekdays at 9 AM) |

Tasks automatically send a message to the current session at the specified time, and Claude responds automatically.

### 8.2 Managing Tasks

Sidebar "Scheduled Tasks Panel":

- View all task statuses (running/paused/completed)
- Unread red dot (after task execution completes)
- Actions: Run now, edit, pause/resume, delete
- Drag to reorder
- Click a task to jump to its associated project and session

### 8.3 Active Time Window

Interval-type tasks support setting an active time range (e.g., `09:00-18:00`); triggers outside this range are skipped. Cross-midnight ranges are supported (e.g., `22:00-06:00`).

---

## 9. Notes System

### 9.1 Access

- Notes button in ChatInput toolbar → Project notes
- Notes button in Console input bar → Project notes
- Notes button in sidebar → Global notes

### 9.2 Editor

Rich text editor built on TipTap:

- **Toolbar**: Bold, italic, code, headings (H1-H3), lists (ordered/unordered/task), blockquote, table, undo/redo, link
- **Slash commands** (type `/`): Insert heading, list, task list, blockquote, code block, table, divider, link
- **Auto-save**: Automatically saves 5 seconds after modification

---

## 10. Git Tools

### 10.1 Git Worktree Management

Click the Git branch button in the top bar to open:

- View all worktrees with their branches and HEAD commits
- Create new worktree (auto-suggests path and branch name)
- Switch to worktree (opens in a new project iframe)
- Delete worktree

### 10.2 Branch Switching

Top bar branch name dropdown:

- Search to filter branches
- Shows local and remote branches
- Click to switch branch

### 10.3 Git Stage All

The + button in ChatInput: executes `git add -A` to stage all changes.

---

## 11. LSP Code Intelligence

Supports TypeScript (tsserver) and Python (pyright).

### 11.1 Go to Definition

**Cmd+Click** on an identifier in code to jump to its definition:

- Within the same file: scrolls to the definition
- Cross-file: automatically opens the target file

### 11.2 Type Hover

Hover over an identifier for 300ms to display type information and documentation.

### 11.3 Find References

Triggered from the floating toolbar or context menu. A bottom panel lists all reference locations; click to jump.

### 11.4 Navigation History

After jumping to a definition:

- **Ctrl+-** to go back to the previous location
- **Ctrl+Shift+-** to go forward to the next location

---

## 12. Chrome Extension

### 12.1 Installation

1. Open `chrome://extensions/` in Chrome
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `chrome-extension/` directory

### 12.2 Features

The extension provides the following capabilities for browser bubbles:

- **Cookie injection**: Copies cookies from the main browser into iframe requests, maintaining login state within iframes
- **CSP/X-Frame-Options removal**: Allows any webpage to load within an iframe
- **Link interception**: Redirects `target="_blank"` and `window.open()` to new bubbles
- **URL tracking**: Monitors SPA route changes and updates the bubble's URL display
- **iframe disguise**: Makes pages within iframes believe they are the top-level window
- **Automation layer**: Provides element tree construction, clicking, typing, screenshot, and other automation capabilities

### 12.3 Status Check

The settings panel (sidebar gear icon) displays:

- Whether the extension is installed
- Extension version number
- Extension directory path (copyable)
- Reload extension button

---

## 13. Keyboard Shortcuts Reference

### Global

| Shortcut | Action |
|----------|--------|
| Cmd+1 | Switch to Agent |
| Cmd+2 | Switch to Explorer |
| Cmd+3 | Switch to Console |

### Agent

| Shortcut | Action |
|----------|--------|
| Enter | Send message |
| Shift+Enter | New line |
| Escape | Stop AI generation |

### Explorer

| Shortcut | Action |
|----------|--------|
| Cmd+P | Quick file open |
| Cmd+F | In-file search |
| Cmd+Click | Go to definition |
| Ctrl+- | Navigate back |
| Ctrl+Shift+- | Navigate forward |
| Cmd+C | Copy file |
| Cmd+V | Paste file |
| Cmd+S | Save file being edited |
| Cmd+Enter | Save file being edited |
| Escape | Exit Blame → Exit search → Close Explorer (sequential presses within 3s) |

### Console

| Shortcut | Action |
|----------|--------|
| Tab | Command completion |
| Up/Down Arrows | Command history |
| Cmd+M | Maximize/restore selected bubble |
| Ctrl+C/D/Z | PTY terminal control keys |

### Vi Mode (Explorer Code Viewer)

| Key | Action |
|-----|--------|
| h j k l | Left/Down/Up/Right movement |
| w b e | Word-level movement |
| gg / G | Jump to first/last line |
| Ctrl+D / Ctrl+U | Half-page scroll down/up |
| dd | Delete line |
| yy | Yank (copy) line |
| p | Paste |
| x | Delete character |
| o / O | New line below/above |
| i / a / I / A | Enter insert mode |
| :w | Save |
| /keyword | Search |
| n / N | Next/previous match |
| u | Undo |
