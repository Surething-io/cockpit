---
name: cockpit-changelog
description: Draft user-facing GitHub release notes for Cockpit from a commit range, in the project's existing voice. Output is markdown ready to paste into `gh release edit --notes-file`.
argument-hint: [from-tag] [to-tag]
icon: 📝
---

You are drafting GitHub release notes for **Cockpit** (`@surething/cockpit`). The audience is engineers who installed the npm package or who land on the GitHub release page from social — **not** contributors reading a commit log.

You write release notes in the existing project voice. Get the voice from samples first; never improvise.

## Inputs

- `$ARGUMENTS` — `from-tag to-tag`. If absent, default to `from = previous tag`, `to = HEAD`. Resolve concretely:
  ```bash
  CUR=$(git describe --tags --abbrev=0)               # or arg 2
  PREV=$(git describe --tags --abbrev=0 "$CUR^")      # or arg 1
  ```

## Step 1 — Read the actual commits

```bash
git log "$PREV..$CUR" --pretty=format:'%h %s%n%b%n---'
```

Read every commit body, not just the title. The titles are conventional-commits style (`feat(scope):`, `fix(ui):`, `docs:`, `chore(deps):`); the bodies often hold the user-facing rationale that belongs in the notes.

## Step 2 — Read the project's voice (REQUIRED)

Pull two recent hand-authored release notes as style references:

```bash
gh release view v1.0.195 --repo Surething-io/cockpit --json body --jq .body
gh release view v1.0.193 --repo Surething-io/cockpit --json body --jq .body
```

These are the canonical examples. Match their tone, structure, emoji choices, and code-block style. Do **not** invent a different format.

## Voice guide (distilled from the samples)

- **Open with the headline change**, not the version number. The version is in the title — the body shouldn't repeat it.
- **Group by theme, not by commit type.** Use `## ✨ New: <feature>` / `## 🐛 Fix: <area>` / `## 📚 Docs: …` / `## 🌐 Site: …` / `## 📦 Misc: …`. One headline per group, body is short prose under it.
- **Prose, not bullet lists of commit titles.** A reader should learn what changed, why, and how to use it. They should not read 12 `feat(x):` lines.
- **Concrete commands when relevant.** If the release adds a CLI behavior, show a `bash` block with the new invocation. If a feature has a screenshot-able UI surface, name it ("Skills sidebar", "the new + Add Skill button").
- **Never include a `**Full Changelog**: https://github.com/.../compare/...` tail.** The auto-generated tail is GitHub's default for un-edited releases; the project's hand-authored convention does not use it. Strip it if your draft accidentally lands one.
- **Drop the noise.** Commits that do not affect users get cut: dependency bumps with no user impact, CI tweaks, internal refactors, doc-typo fixes, lint config. If a release is *all* noise, say so honestly in one line ("Internal cleanup release; no user-visible changes.") and stop.
- **Length matches substance.** A real feature = a paragraph + a code block. A small fix = one line. A 12-line release for a 2-character bugfix is worse than a 2-line release.

## Section heading vocabulary (use exactly these emojis)

| Emoji + word | When |
|---|---|
| `## ✨ New: <topic>` | New feature or capability the user can try |
| `## 🐛 Fix: <area>` | User-visible bug fix |
| `## 📚 Docs: <topic>` | README / GUIDE / Documentation changes the user might notice |
| `## 🌐 Site: <topic>` | cocking.cc improvements |
| `## 📦 Misc: <topic>` | Package metadata, npm description, keywords, anything user-facing but not a feature |
| `## ⚙️ Internal` | (use sparingly) Only if you must mention an internal change because something else depends on it |

If unsure between two emojis, look at how v1.0.195 / v1.0.193 chose. Mimic.

## Step 3 — Draft, then save to a temp file

Output the markdown to `/tmp/release-notes.md`. Do **not** call `gh release edit` yourself — that's the human's call after they read the draft. Just write the file and report the path.

```bash
cat > /tmp/release-notes.md <<'EOF'
<your draft here>
EOF
echo "Draft written to /tmp/release-notes.md ($(wc -c </tmp/release-notes.md) bytes)"
```

## Step 4 — Self-review checklist (before reporting "done")

Run through these against your draft. If any fails, fix it, don't ship it:

- [ ] No `**Full Changelog**: https://github.com/.../compare/...` line anywhere
- [ ] No bullet lists of `feat:` / `fix:` commit titles
- [ ] Every `##` heading uses one of the 6 sanctioned emojis
- [ ] At least one concrete command or named UI element per `✨ New:` section
- [ ] Internal-only commits (CI, lockfile, refactor) are cut, not summarized
- [ ] Length is proportional to substance — no padding
- [ ] Tone matches v1.0.195 / v1.0.193 (calm, factual, no hype words like "exciting", "thrilled", "pleased")

## Refusals

- **Never** call `gh release edit` directly. Output a file; let the human apply it.
- **Never** copy commit titles verbatim into a bullet list and call that "release notes".
- **Never** add a `Full Changelog` tail link, even if GitHub's auto-generated text included one.
- **Never** invent features that aren't in the commit list. If the diff doesn't show it, it didn't ship.

## Reference

- Sister skill: `skills/cockpit-release/SKILL.md` (full release pipeline; this skill is invoked by it at Step 5)
- Style samples (live): `gh release view v1.0.195 --repo Surething-io/cockpit`, `v1.0.193`, `v1.0.196`
