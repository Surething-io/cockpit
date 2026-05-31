Cockpit's **Notes** are scratchpads for the things that don't belong in a commit or a chat message — memos, todos, links you'll re-open, scratch calculations, anything you want around between sessions. There are two scopes:

| Scope | When to use |
|---|---|
| **Global note** | Cross-project memos, todos, bookmarks. Stays with you regardless of which project tab you're on. |
| **Project note** | Pinned to a specific project — decisions, paths, scratch calculations that only make sense inside that codebase. |

Both scopes share the same editor and the same auto-save — they just live in different places.

## Open a note

- **Global note** — the "Notes" button at the **bottom of the left sidebar** (below Scheduled Tasks, above Skills). Cockpit has **exactly one** global note, shared across every project.
- **Project note** — hover over a project row in the left sidebar and click the note icon (also reachable from the "Project notes" icon next to the Agent input). **One note per project**, scoped to the project directory — `~/code/backend` and `~/code/frontend` keep separate notes.

Each scope has exactly one note — there's no "create note" or "switch note" workflow to think about.

## What it's good for

The kinds of things that pile into Notes:

- **Memos** — "remember to ask AI about X tomorrow", "where the staging credential lives", scratch decisions you'll need to recall.
- **Todos** — bullet list with `/task` checkboxes; tick them off as you go. Lives outside any issue tracker — just for your own working state.
- **Web links** — paste URLs you'll want to re-open: docs you're reading, a PR to review, an issue you'll fix later.
- **Code snippets** — a one-liner shell command you re-type every week, a regex you can never remember.
- **Chat-reply extracts** — copy useful AI replies out of the chat so they're still there after you scroll, clear, or close the session.

The global note carries things that follow you everywhere; the project note carries things only meaningful inside one codebase.

## The editor

Tiptap-based rich-text editor with Markdown sensibility:

- Headings (H1 / H2 / H3) — type `# title` or use the slash menu.
- Bullet lists, numbered lists, task lists (checkboxes).
- Blockquotes, code blocks, tables, horizontal rules.
- Links.
- Built-in undo / redo (the StarterKit ships with History).

### Slash menu

Type `/` and a menu appears with formatting commands — **11 built-in actions** total:

| `/` | Inserts |
|---|---|
| `/h1`, `/h2`, `/h3` | Heading levels |
| `/bullet` | Bulleted list |
| `/ordered` | Numbered list |
| `/task` | Task list (checkboxes) |
| `/quote` | Blockquote |
| `/code` | Code block |
| `/table` | 3×3 table |
| `/hr` | Horizontal rule |
| `/link` | Link insertion |

These are **only** in the Notes editor — they don't appear in the chat input. The chat input has [its own different slash menu](/en/docs/agent/skills/) for Skills.

## Auto-save

Both notes auto-save about 5 seconds after you stop typing. **There's no "save" button**; while you're editing, a small "saving..." indicator shows in the top-right. If you close the modal mid-edit, the pending change is flushed first.

## Limits

- **No image embedding** — text and code only.
- **No file attachments.**
- **No cross-tab live sync** — if you have the same note open in two windows, the later save overwrites the earlier one.
- **Notes aren't shared** with collaborators — they're local to your machine. For shared docs use [Tech Plan Review](/en/docs/explorer/reviews/#create-share) instead.
- **No cross-note search** — the editor doesn't ship a built-in search; use the browser's `Cmd+F` to find things inside a note.

## Next

- [Tech Plan Review](/en/docs/explorer/reviews/#create-share) — for notes you want to share with teammates
