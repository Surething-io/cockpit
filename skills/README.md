# Cockpit Skills

This folder is the home of project-internal **Cockpit Skills** — markdown
playbooks that turn into slash commands once registered with Cockpit's
Skills sidebar.

These skills live alongside the source they describe. If `release/` ever
goes stale because the release pipeline changed, a PR updates this folder
the same way it updates `bin/`.

## What's here

All skill names are prefixed with `cockpit-` so they don't collide with
generic skills (`/release`, `/changelog`) you may register from other
projects in the same Cockpit.

| Skill | Slash | Purpose |
|---|---|---|
| [`cockpit-release/`](./cockpit-release/SKILL.md) | `/cockpit-release [patch\|minor\|major]` | Run the full release pipeline end-to-end: bump → tag → publish → release notes → website redeploy → verify. |
| [`cockpit-changelog/`](./cockpit-changelog/SKILL.md) | `/cockpit-changelog [from-tag] [to-tag]` | Draft user-facing GitHub release notes in the project's voice. Invoked by `/cockpit-release` at the right step, also runnable standalone. |

## How to use them inside Cockpit

These skills are **not** auto-loaded — Cockpit doesn't scan filesystems for
SKILL.md by default. You register the absolute path once:

1. Open Cockpit's Skills sidebar (the ⭐ icon in the workspace sidebar).
2. Click **+ Add Skill**.
3. Paste the absolute path to the SKILL.md, e.g. on this machine:

   ```
   /Users/ka/Work/continic/Run/cockpit/skills/cockpit-release/SKILL.md
   /Users/ka/Work/continic/Run/cockpit/skills/cockpit-changelog/SKILL.md
   ```

4. Repeat for each skill.

After that, `/cockpit-release patch` and `/cockpit-changelog v1.0.195 v1.0.196`
show up in the slash autocomplete in any Cockpit chat.

Cockpit watches the source files — edit any SKILL.md in your editor, save,
and the next slash invocation picks up the change. No re-import.

## Why store them in-repo (and not in `~/.claude/skills/`)

Two reasons:

1. **They reference repo facts.** `/cockpit-release` knows `cocking.cc`,
   the `Surething-io/cockpit` GitHub repo, `@surething/cockpit` on npm,
   and the exact workflow names. That context is repo-specific, not
   user-specific. If a contributor clones the repo and registers these
   paths, the skill works without any per-user customization.
2. **They're versioned with the code that the playbook describes.** When
   the release workflow changes, the skill changes in the same PR.
   `git blame skills/cockpit-release/SKILL.md` answers "why does the
   release playbook do X?" the same way `git blame bin/cock.mjs` answers
   "why does the CLI handle Y?".

The skills are **not** shipped as part of the npm package
(`skills/` is excluded from `package.json#files`). They're project
documentation, not runtime code.

## Adding a new skill

1. Create a new folder `skills/cockpit-<name>/` (keep the `cockpit-`
   prefix to avoid colliding with skills from other projects).
2. Add `SKILL.md` with YAML frontmatter:

   ```yaml
   ---
   name: cockpit-<name>
   description: <one line, ends in a period>
   argument-hint: [optional-args]
   icon: 📝
   ---
   ```

3. Body is the system prompt the agent will see when `/<name>` is invoked.
   Be explicit about what to do *and* what to refuse. Look at the existing
   skills for shape.
4. Open a PR. After merge, contributors run **+ Add Skill** in their
   Cockpit and paste the absolute path on their machine.

## Further reading

- [Skills feature blog post](https://cocking.cc/en/blog/chat-to-skill/) —
  the rationale for "skills register pointers, never own your folder".
- Anthropic's spec for the SKILL.md format:
  [docs.anthropic.com](https://docs.anthropic.com/) (search for "skills").
