Terminal in Cockpit is actually two bubbles in one: a **one-shot command** bubble for things like `ls` or `pytest`, and a full **interactive terminal** bubble for things like `bash`, `vim`, or `top`. The input bar picks the right one based on what you type (see [Command Input](/en/docs/console/input-bar/) for the full dispatch rules).

## One-shot command

Type something normal like:

```text
make build
```

A bubble opens, the command runs, output streams in. When it finishes you see the exit status. The bubble stays around — scroll back through the output, copy it, search inside it, re-run it.

What it can do:

- **Live streaming** — output appears as the command produces it, not after it finishes.
- **ANSI colours** preserved.
- **Copy output** — the 📋 icon in the bubble's title bar (ANSI codes stripped on copy). **Copy the command itself** — the 📄 icon next to it.
- **`Cmd+F` to search** within the output. Two modes you can toggle:
  - **Search** highlights matches in-place.
  - **Filter** hides everything except the matching lines.
- **`Ctrl+C` button** (shown in the running-status row at the bottom of the bubble, and in the header when maximised): sends `SIGTERM` to the entire process tree (root PID plus all descendants), then `SIGKILL` 1 second later to anything still alive.
- **Stdin while running** — the running-status row has a small input box for piping data into long-running commands: Enter sends a line, `Tab` sends a tab character, `Ctrl+<key>` sends the corresponding control character (`Ctrl+C`, `Ctrl+D`, etc. all work).
- **Re-run** with the ↻ icon in the title bar — no retyping.
- **Delete** with the ✕ icon in the title bar; clicking it on a running bubble interrupts first, then clears the bubble.

What it isn't:

- Not interactive in the full PTY sense. If you run something that expects a real terminal (`vim`, `top`, `python` with no flags), it'll probably break or hang. Use the interactive bubble below.

## Interactive terminal

Type a known interactive program: `zsh`, `bash`, `sh`, `fish`, `nu`, `python`, `python3`, `node`, `irb`, `lua`, `vim`, `nvim`, `vi`, `nano`, `emacs`, `top`, `htop`, `less`, `man`.

A real terminal bubble opens with a proper PTY behind it (`nodePty.spawn`). `vim` works. `top` works. `Ctrl+C` works. Mouse selection, copy, paste — all work.

| Feature | How |
|---|---|
| **Type & run** | Click in the bubble, type. Just like your usual terminal. |
| **Copy** | Select text — Cockpit copies on selection (no `Cmd+C` needed in most setups). |
| **Paste** | `Cmd+V` |
| **Search** | `Cmd+F` opens the search bar |
| **Maximise** | `Cmd+M` makes the bubble fill the Console panel; `Esc` to restore |
| **Stop the process** | `Ctrl+C` like a normal terminal; the bubble's **Ctrl+C** button sends SIGTERM, then SIGKILL 1 second later if anything's still alive |

Closing an interactive bubble sends the process a `SIGTERM` (with the same SIGKILL fallback). The bubble's history is preserved unless you click the explicit delete button.

## Which shell does it use?

**Cockpit uses your own default shell** (reads the `SHELL` env var; on Windows it reads `COMSPEC`) and invokes it as `<shell> --login -c <command>` — for both one-shot commands and PTY bubbles. So quoting, globbing, shell aliases, `~` expansion, `set -e` and the rest all follow your shell's semantics.

If you want a different shell ad-hoc, **the interactive bubble is yours to drive** — type `zsh`, `bash`, `fish`, whatever. Cockpit won't override your choice.

## When to use which

- Need to see the output of one specific command? **One-shot.**
- Need a session where you'll run several commands and keep state (env vars, current directory, history)? **Interactive.**
- Running a tool that draws to the whole screen (`vim`, `top`, full-screen TUI)? **Interactive — it'll only work there.**
- Running something for the AI to capture (`!command` from chat)? **One-shot, the output goes back into the chat.**

## Next

- [Command Input](/en/docs/console/input-bar/) — full list of what opens what
- [Aliases & Env Vars](/en/docs/console/aliases-env/) — make short names for common commands
- [CLI Reference → cockpit terminal](/en/docs/reference/cli/#cockpit-terminal) — drive a terminal bubble from outside
