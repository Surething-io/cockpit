# Builtin Slash Commands

Every subdirectory here is one builtin slash command: `skills/<cmd>/SKILL.md`
is the command's prompt, in the exact SKILL.md format a user-defined skill
uses (YAML frontmatter + body). English only.

**This directory is runtime code, not documentation.** It is listed in
`package.json#files`, so anything added here ships inside the npm package,
and the server reads these files at dispatch time. Project-internal
playbooks (`/cockpit-release`, `/cockpit-changelog`) live in
[`docs/skills/`](../docs/skills/README.md) and are never published.

## How they are loaded

`packages/feature/agent/src/server/lib/slashCommands.ts` resolves this
directory as `$COCKPIT_ROOT/skills` (same mechanism as `apps/`; `server.mjs`
sets `COCKPIT_ROOT` to the package root), then:

1. `readdir` — every subdirectory containing a `SKILL.md` is a registered
   command. There is no separate allow-list to keep in sync: the folder set
   *is* the registry, for both dispatch and the `/api/commands` autocomplete
   dropdown (whose description text comes from each file's frontmatter).
2. On dispatch the file is read, `{{BASE_URL}}` is substituted with
   `http://localhost:<port>`, and the result is written to
   `~/.cockpit/skills/<cmd>/SKILL.md` — the copy the agent is pointed at, so
   builtins travel the same "read this skill file" path as user skills.
3. A user-registered skill with the same `name` shadows the builtin.

Edits take effect on the next dispatch — no rebuild, no restart.

## Adding a builtin command

1. `mkdir skills/<cmd>` and write `SKILL.md` with frontmatter:

   ```yaml
   ---
   name: <cmd>            # MUST equal the directory name
   description: <one line — this is verbatim what the autocomplete dropdown
                 shows; it is NOT translated, and must not be given an
                 i18n commands.<cmd> key, which would silently override it>
   argument-hint: "[optional]"
   ---
   ```

2. Body is English prose. Use `{{BASE_URL}}` for any URL the agent must curl
   on the server host.
3. That's it — no TypeScript to touch. Both the dropdown and the dispatcher
   pick it up from the directory.

The `name` must match the directory name: the directory name is what `/<cmd>`
matches and where the file is written under `~/.cockpit/skills/`, while
`name` is what the agent reads in the file. A mismatch is caught by
`skills.test.ts`.
