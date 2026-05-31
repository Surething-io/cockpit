The **Files** tab is the Explorer panel's primary view — a virtualised tree of every file in the project, plus the per-file viewers and the inline annotation surface Cockpit uses to feed code references to the AI.

| Section | What's in it |
|---|---|
| [File Tree](#file-tree) | Navigation, right-click menus, multi-root, ignore rules |
| [Code Viewer](#code-viewer) | Syntax highlighting, Vi mode, in-file find, jump-to-definition |
| [Previews](#previews) | Images, PDF, Markdown, JSON, CSV, audio/video |
| [Comments](#comments) | Highlight code → comment → ship to the AI |

## File Tree

The Explorer panel (`Cmd+2`) is your view into the project's files and Git state. It opens with five tabs across the top, each scoped to a different way of looking at the same files.

### The five tabs

| Tab | What you see |
|---|---|
| **Tree** | The full project tree, virtualised so even huge repos scroll smoothly. Click a file to open it on the right; click a folder to expand. |
| **Search** | Project-wide content search. Type a string or regex, get matching lines from every file. |
| **Recent** | Files you've opened or edited recently, newest first. The fastest way back to "what was I just looking at?" |
| **Status** | Your Git working tree — staged, unstaged, and untracked files. Click any file to see its diff; stage / unstage / discard from the row controls. |
| **History** | The Git commit log. Click any commit to expand its details (files changed + diff). |

### Tree tab (the default)

The standard tree view, with:

- **Virtualised scrolling** — even a 10k-file repo doesn't stutter.
- **File icons** by extension so you can scan a list quickly.
- **Folder expand / collapse** with click; folders remember whether they were open across reloads.
- **Single-click to select**, single-click on a file to open in the right pane.

#### Right-click menu

Right-click any file or folder. The menu shows everything in a single flat list — no nested sub-menus.

**File operations:**

- **New file** — create in this directory.
- **Copy file / Copy folder** — put the file itself on Cockpit's clipboard, ready to paste into another directory in the tree.
- **Paste here** — shown when the clipboard has something to paste.
- **Delete file / Delete folder** — confirmation dialog before anything is removed.

**Copy path / name** (5 items, each one click-to-clipboard):

- **Copy relative path** — e.g. `src/utils/parser.ts`.
- **Copy absolute path** — e.g. `/Users/me/code/proj/src/utils/parser.ts`.
- **Copy relative directory path** — the containing directory (parent dir for files; the folder itself for folders).
- **Copy absolute directory path** — same, but absolute.
- **Copy file name / Copy folder name** — e.g. `parser.ts`.

### Status tab — Git working tree

Three groups:

| Group | What's in it |
|---|---|
| **Staged** | Changes that will go into the next commit. |
| **Unstaged** | Modified files not yet staged. |
| **Untracked** | New files Git hasn't seen yet. |

Click any file in any group to see its diff in the right pane (see [Diff View](/en/docs/explorer/changes/#diff-view) for what that looks like). Each row also has shortcut buttons for the obvious actions: stage / unstage / discard.

### History tab — commit log

A scrollable list of commits, newest first, with the author and short SHA. Click any commit to expand the **commit detail panel**: full message, file list, and per-file diffs.

This view also opens automatically when you click "View commit" from a Blame line — see [Blame](/en/docs/explorer/history/#blame).

### Quick file open

Independent of the tabs, hit **`Cmd+P`** anywhere in Cockpit to jump straight to a file by fuzzy-matched name. See [Quick File Open](/en/docs/explorer/search/#quick-file-open).


## Code Viewer

Click any file in Explorer and Cockpit opens it in the **Code Viewer** on the right. By default it's read-only — syntax-highlighted, with line numbers, no surprises. If you want to edit, you turn editing on with a click or by typing in Vi mode.

This page covers reading, editing, searching, and Vi.

### What you see

- **Line numbers** down the left, always.
- **Syntax highlighting** for every common language — JavaScript / TypeScript / Python / Go / Rust / JSON / Markdown and dozens more. Detection is by file extension.
- **Read-only by default** — you can scroll, select, copy, but typing does nothing until you switch to edit mode.

### Edit mode

Cockpit's Code Viewer is intentionally light — it's a fast viewer with editing, not a full IDE replacement. For deep editing work, stay in VS Code / Cursor / your editor of choice. For "I just need to tweak one line", Cockpit's enough.

| Action | How |
|---|---|
| **Enter edit mode** | Click in the file content area or start typing in Vi (`i`) |
| **Save** | `Cmd+S` — writes back to disk |
| **Cancel unsaved changes** | Reload the file from the Files tab |

When the file has unsaved changes, the title shows a dot indicator.

### Find inside the file

`Cmd+F` opens the search bar.

| Option | Effect |
|---|---|
| **Plain text** (default) | Literal match |
| **Regex** toggle | Treats the query as a regular expression |
| **Match case** toggle | Case-sensitive search |
| **Whole word** toggle | Only matches whole words |

Type at least 2 characters and matches highlight in place. Use the up / down buttons to navigate.

Replace isn't built in — for find-and-replace work, edit the file in your usual editor.

### Vi mode

If you live in vi keybindings, turn Vi mode on (toggle in the Code Viewer header). Then:

- `i`, `a`, `I`, `A`, `o`, `O` — insert modes (`Esc` back to normal)
- `h` `j` `k` `l` — move
- `w` `b` `e` — word motion
- `gg` / `G` — top / bottom of file
- `0` / `^` / `$` — line ends
- `dd`, `yy`, `p` — line operations
- `v` / `V` — visual mode
- `/` — search (the same one as `Cmd+F`)

The cursor position is tracked and persists as you switch tabs.

### Jumping to a specific line

A few entry points push you to a specific line:

- **Quick File Open (`Cmd+P`)** then click — opens the file at the top.
- **Click a Blame line** — jumps to that line in the viewer.
- **Click a search result** — jumps to that match.
- **Click a Git history file** — opens the diff at the changed lines.

There's no `:line:col` jump syntax in `Cmd+P`. Inside Vi mode you can type `:42` then Enter to jump to line 42 the vi way.


## Previews

Click a file in Explorer and what happens next depends on the file type. For source code, Cockpit opens it in the [Code Viewer](/en/docs/explorer/file-tree/#code-viewer). For a few file types it opens a richer **preview** instead: Markdown rendered as a document, images as images, JSON as a navigable tree.

### Markdown

Click any `.md` file to see it rendered as a document — headings, lists, tables, code blocks, links, all the usual. The TOC (table of contents) appears in a sidebar so you can navigate long docs.

| What you can do |  |
|---|---|
| **Read** | The rendered Markdown is the default view. |
| **Add comments** | Select any chunk of text and add a comment, the same way you'd comment on code. Comments are anchored to the lines you selected and show up the same way as code comments. |
| **See the source** | The raw `.md` source is one click away from the preview header. |

What you don't get: Mermaid diagram rendering, LaTeX math. If you write Markdown that depends on those, the preview will show the source text inside the code block, not a rendered diagram.

### Images

Click any image file (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, etc.) to open it in the image preview. It fits the available space.

### JSON

JSON files get a dedicated preview with two views you can switch between (defaults to **Raw**; toggle to Readable when you want to browse):

- **Raw** (default) — the plain text of the file with syntax highlighting. Useful if you want to copy it or see the formatting exactly as on disk.
- **Readable** — formatted, indented, with the tree foldable at every object and array. You can search within the values to find a specific key or string.

For very large JSON files, the Readable view stays responsive — folding collapses things you don't need.

### What's *not* previewed (yet)

Cockpit opens these as plain text in the Code Viewer rather than a dedicated preview:

- PDF
- CSV / TSV
- Office formats (`.docx`, `.xlsx`, `.pptx`)
- Audio / video files
- Binary files (you'll see "binary file" instead of trying to render gibberish)

If you need to view those, open them with your usual tool.


## Comments

**Comments** are how you bookmark interesting code in Cockpit and how you hand a curated set of code references to the AI without copy-pasting line by line. Pick lines, write a note, repeat across files, then send the whole bundle into a chat.

### How to add a comment

Anywhere code is shown — Code Viewer, Code Map, Diff View, Markdown preview — select a range of text with your mouse. A small floating toolbar appears next to the selection with:

- **Add Comment** — opens a small textarea; type your note, save.
- **Send to AI** — bundles your current selection plus every comment you've added into a formatted block ready to paste into chat.

The comment sticks to the lines you selected. Each comment records:

- The file path and line range.
- A snapshot of the text you had selected (so if the file changes later, you still have the original text).
- The note you wrote.
- When you created and updated it.

### Where comments live

Comments are saved on disk under your Cockpit data folder, scoped to the project they were made in. They survive Cockpit restarts and they don't sync anywhere — they're your private working notes for the current project.

### The comments list

There's a **Comments** modal that shows every comment in the current project at once — grouped by file, with a preview of the code each one points to. From here you can:

- Click a comment to jump to that file and line.
- Edit the note.
- Delete individual comments, or clear them all.

This is also the place to **send everything to AI at once** — useful when you've spent ten minutes annotating six files and want the AI to take it all in.

### "Send to AI" — what actually happens

When you hit Send to AI, Cockpit formats your comments as a Markdown block like this:

```
### Code References

[1] src/parser.ts:42-45
\`\`\`
for (let i = 0; i < items.length; i++) {
  // ...
}
\`\`\`
Note: This is O(n²) — needs to be rewritten as a single pass.

[2] src/lexer.ts:120-128
\`\`\`
...
\`\`\`
Note: ...
```

This text is **copied to your clipboard** — Cockpit doesn't auto-inject it into a chat. Switch to the Agent panel, paste, type your actual question after the block, send. The deliberate copy step lets you choose which chat tab receives the references and what question to ask.

### Where it works

Comments work on:

- ✅ Code Viewer (regular source files)
- ✅ Code Map / BlockViewer
- ✅ Diff View
- ✅ Markdown preview (anchored to the rendered text, not the raw source)

### Notes

- Comments are **plain text** — no Markdown formatting in the note body.
- Comments **don't move** when you edit code below them. If you insert 10 lines above a comment, its line range still points at the original numbers; the saved selected-text snapshot will look correct, but the live highlight may be off.
- A virtual file called `__chat__` is used internally for "I'd like to attach this snippet" comments made directly on chat content — you don't normally see these.

