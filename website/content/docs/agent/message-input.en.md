The text box at the bottom of every Agent tab is the message input. It looks like a single line but it does a few interesting things — a toolbar of buttons on the side, image paste, a shell-command prefix, slash menus.

## Sending and editing

| Key | What it does |
|---|---|
| `Enter` | Send the message |
| `Shift+Enter` | Insert a new line; doesn't send |
| `Esc` (cursor over chat area) | Interrupt the reply that's currently being generated |

The input grows as you type up to ~8–10 lines (about 200px), then scrolls inside the box.

> **CJK input methods**: while a candidate window (pinyin / kana selection) is open, neither `Enter` nor `Shift+Enter` will send — those are reserved for the IME to commit a candidate. Close the candidate window first, then press Enter.

## Toolbar buttons next to the input

A row of small icons sits to the left of the textarea, left to right:

- **`git add` all changes** — stage everything in the working tree in one click.
- **View git changes** — open the changes panel to see what's modified right now.
- **View comments** — opens the [Comments](/en/docs/explorer/file-tree/#comments) list in Explorer.
- **Message history** — scroll back through user messages in this tab.
- **Project notes** — open this project's note (see [Notes](/en/docs/agent/notes/)).
- **Scheduled tasks** — open the [Scheduled Tasks](/en/docs/agent/scheduled-tasks/) panel for this tab.

These are all shortcuts for "let me line up some context before the AI starts typing."

## Attaching images

To attach an image, just **paste it** (`Cmd+V`). Cockpit accepts:

- PNG, JPEG, WEBP, GIF
- Up to **5 MB** per image
- Multiple images per message — paste several in a row

Each attachment shows as a small thumbnail above the input. Click the `×` on a thumbnail to remove it.

> Drag-and-drop is not supported — only paste.

Engines that accept images: **Claude**, **Codex**, **DeepSeek**. **Kimi** and **Ollama** tabs **silently drop** image attachments (no error, no warning).

## Running shell commands from chat — the `!` prefix

If the **first line** of your message starts with `!`, Cockpit treats the rest of that line as a shell command, runs it, and feeds the output back into the conversation. Any following lines are sent along as your own note on top of the command output.

```text
!ls -la src/
also check what helpers are in utils/
```

The AI gets the directory listing plus your note. Fastest way to give the AI ground truth from your system without leaving the chat — `git log -5`, `npm outdated`, `cat .env.example`, `gh pr view 42`, anything.

> `!` only triggers when it's the **very first character of the very first line**. `Use !important here` in the middle of a sentence won't run a shell command. Multi-line scripts are **not supported** — only the first line runs. For multi-command scripts, pack them with `sh -c "..."`.

## Slash menu — `/`

Type `/` at the start of the input and a menu pops up, split into two sections:

- **Commands** (built-in) — `/qa`, `/fx`, `/ex`, `/go`, `/cg` (see [AI Mode Commands](/en/docs/agent/skills/)).
- **Skills** (your installed ones) — `/your-skill-name` (see [Skills](/en/docs/agent/skills/#custom-skills)).

Type to filter. `Tab` or `Enter` inserts the selected command into the input — then type your actual message after it and press `Enter` to send.

`!` and `/` don't conflict — `!` only fires when first-line-first-character, slash commands only fire when you typed `/` first.

If you want to reference specific code with the AI, the supported path is via [Comments](/en/docs/explorer/file-tree/#comments) — select code in Explorer, add a comment, paste the formatted comment block into chat.

## Next

- [Sessions](/en/docs/agent/sessions/) — managing multiple chat tabs
- [Skills](/en/docs/agent/skills/)
