Two small Console features that make daily use a lot smoother: **aliases** (give short names to long commands) and **environment variables** (set values for the current tab that commands can read at runtime).

## Aliases

An alias replaces the **first word** of a one-shot command with something else. For example:

| Alias | Expands to |
|---|---|
| `ll` | `ls -la` |
| `gs` | `git status` |
| `gp` | `git push` |
| `gc` | `git commit` |

Then typing `ll src/` runs `ls -la src/`. Typing `gs` runs `git status`. **Only the first word is replaced** — everything after stays as you typed it. Cockpit ships with this small starter set out of the box.

**Scope: global.** Aliases apply across every project and every tab. Changes take effect on your next command — no restart needed.

**Alias manager: the small icon in the Cockpit top bar** (not the one in the Console input bar — that's the env-var manager). Inside the modal:

- Each existing alias is one row: left is `$ <name>` (read-only), right is the command (editable in place — change the expansion right there). Hover the row and 🗑 delete appears at the end.
- A `+` row at the bottom for adding a new alias: name on the left, command on the right, Enter to save.
- There's no "temporarily disable" toggle — only add / edit / delete.

**Aliases also apply to**: re-run (▶ button) and saved commands in the [Quick Commands](/en/docs/console/input-bar/#quick-commands-button-left-of-the-input) popover — they all go through the same dispatch order.

**Aliases do not apply to**: interactive shells (`zsh`, `bash`, and other PTY commands). Those go straight to the PTY and use your shell's own aliases.

## Environment variables

Environment variables live on the current tab's Console panel — every command you run from this tab gets these `KEY=VALUE` pairs prepended to its environment.

**Scope: per tab.** Each tab keeps its own set of env vars in its own file; switch to another tab and you'll see a completely different set.

**Env manager: the `{x}` (Variables) icon in the Console input bar toolbar.** Once open:

- The subtitle at the top shows the current scope ("Tab scope").
- Each variable is one row: KEY (read-only) on the left, VALUE (editable) on the right, 🗑 to delete.
- A row at the bottom for adding a new variable: KEY, VALUE, Enter or the `+` button to add.
- Click Save to persist — the next command picks it up; no restart.

### Typical uses

- **Per-tab API keys** — `STRIPE_API_KEY=sk_test_...` in your test-environment tab; `STRIPE_API_KEY=sk_live_...` in your production-tools tab. Each tab runs against its own key — no risk of crossing the wires.
- **Per-tab database URLs** — `DATABASE_URL=postgresql://localhost/dev_db` in your dev tab, `…/staging_db` in another.
- **A tool path you want everywhere** — e.g. `PATH=/opt/homebrew/bin:$PATH`. **You'll need to set it in each tab that needs it** — each tab has its own env file.

### Variable expansion

Cockpit writes VALUE into the child process environment as a **literal string** — no `$VAR` expansion, no `~` expansion, no quote parsing. If you want `PATH=/opt/homebrew/bin:$PATH`:

- Type the **literal** `/opt/homebrew/bin:$PATH` as the VALUE.
- At runtime: Cockpit stuffs that literal string into the `PATH` env var, and **the shell** expands `$PATH` when it runs the command.

## Where it lives

Everything runs locally. Aliases are global and travel with your machine; env vars are stored per tab inside Cockpit's data folder. To move to a new machine, copy your Cockpit data folder over and your aliases plus every tab's env vars come along.

## Common issues

- **Alias not expanding** — aliases only apply to the *first word* of a one-shot command. Inside an interactive shell (`zsh`, `bash`), commands go through your shell's own aliases, not Cockpit's.
- **Env var "not set" in a fresh terminal** — interactive shells are child processes that inherit the env Cockpit injects, but anything you `export` inside them doesn't flow back to Cockpit.
- **`$VAR` inside a VALUE didn't expand** — by design. Cockpit doesn't do shell expansion; it hands the literal string to the shell, which expands it when the command actually runs.
- **Vars disappeared after I switched tabs** — each tab has its own env file. To have the same variable in multiple tabs, set it in each tab.

## Next

- [Command Input](/en/docs/console/input-bar/) — how Console picks bubbles and where aliases sit in the dispatch order
