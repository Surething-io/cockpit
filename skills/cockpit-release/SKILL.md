---
name: cockpit-release
description: Cut a new Cockpit release end-to-end — bump version, tag, publish to npm, write user-facing release notes, refresh the website, and verify everything went live.
argument-hint: [patch|minor|major]
icon: 🚀
---

You are the release captain for Cockpit (`@surething/cockpit`). Your job is to run the full release pipeline in order and stop at every irreversible step to confirm with the human first.

## Inputs

- `$ARGUMENTS` — `patch` (default), `minor`, or `major`. If empty, ask first which one.

## Project facts (assume these unless overridden)

- **Repo**: `Surething-io/cockpit` (origin/main is the release branch)
- **npm package**: `@surething/cockpit` (public, scoped, provenance-enabled)
- **Website**: `cocking.cc`, deployed via Cloudflare Pages from `website/`
- **Workflows**:
  - `Publish to npm` — triggered by `push tag v*`, runs `npm publish` and creates a GitHub Release with auto-generated (= near-empty) notes.
  - `Deploy Website` — triggered by `push` touching `website/**` OR `workflow_dispatch`. Builds at the time of run, so re-running it picks up any new GitHub Release notes.
- **Convention**: every release ships with **hand-authored** user-facing release notes in the project's voice (see `/cockpit-changelog` skill). The auto-generated "Full Changelog: …compare/…" line is **not** part of the convention — strip it.

## Pre-flight (before touching anything)

Run these checks. If any fails, **stop and report** — do not "fix" them silently.

1. `git status --porcelain` is empty (working tree clean)
2. `git rev-parse --abbrev-ref HEAD` is `main`
3. `git fetch && git rev-list HEAD..origin/main --count` is `0` (local is up to date, nothing remote ahead)
4. Show the commits since the last tag so the human can sanity-check the bump scope:
   ```bash
   PREV=$(git describe --tags --abbrev=0)
   git log "$PREV..HEAD" --oneline
   ```
5. Read the bump type from `$ARGUMENTS`. If absent or unclear, ask: *"Bump from $PREV → patch / minor / major?"*

## The release pipeline

Execute step-by-step. Print each command before running it. Wait for confirmation only at the marked points.

### Step 1 — Bump version (local, reversible)

```bash
npm version <patch|minor|major>      # creates commit "1.0.x" and annotated tag v1.0.x
```

Show the resulting `git log -1 --oneline` and the new tag. **Reversible** with `git tag -d <tag> && git reset --hard HEAD~1` — say so explicitly to the human.

🛑 **Confirm with human before pushing.**

### Step 2 — Push commit + tag (triggers npm publish, IRREVERSIBLE)

```bash
git push --follow-tags
```

Pushing the `v*` tag triggers `Publish to npm`. After this point, npm publish is on its way and a published version cannot be retracted (npm's 72h unpublish window exists but should be avoided).

### Step 3 — Watch `Publish to npm` workflow

Find the run id and watch it:

```bash
gh run list --repo Surething-io/cockpit --workflow "Publish to npm" --limit 1 --json databaseId,status
gh run watch <id> --repo Surething-io/cockpit --exit-status
```

If it fails: stop, report the failing step, do not retry blindly. Possible recovery is `npm publish` manually (see RELEASING.md "Manual Publishing"), but only after diagnosing.

### Step 4 — Verify npm published

```bash
npm view @surething/cockpit version dist-tags
npm view @surething/cockpit bin
```

Expected: `version` matches new tag, `dist-tags.latest` matches, `bin` includes both `cockpit` and `cock`.

### Step 5 — Author user-facing release notes

Invoke the `/cockpit-changelog` skill (or if running standalone, draft notes using the same conventions: see `skills/cockpit-changelog/SKILL.md`).

Save the markdown to a temp file, then:

```bash
gh release edit v1.0.x --repo Surething-io/cockpit --notes-file /tmp/release-notes.md
```

🛑 **Show the human the rendered notes (`gh release view v1.0.x --repo Surething-io/cockpit`) before moving on.** Hand-authored notes are the public face of the release; one round of human review is worth it.

### Step 6 — Trigger website redeploy (so /changelog page picks up the new notes)

The npm publish workflow does **not** trigger a website rebuild. The website's `/changelog` page reads `data/changelog.json`, generated at build time by `scripts/fetch-changelog.mjs` from GitHub Releases. New release → new notes → must rebuild.

```bash
gh workflow run "Deploy Website" --repo Surething-io/cockpit --ref main
sleep 8
id=$(gh run list --repo Surething-io/cockpit --workflow "Deploy Website" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$id" --repo Surething-io/cockpit --exit-status
```

### Step 7 — Verify everything is live

```bash
# 1. npm
npm view @surething/cockpit version

# 2. GitHub Release
gh release view v1.0.x --repo Surething-io/cockpit --json name,publishedAt,url

# 3. Website changelog has the new entry at the top, with the right body
curl -s --http1.1 "https://cocking.cc/en/changelog/" | grep -oE 'v1\.0\.[0-9]+' | head -3
curl -s --http1.1 "https://cocking.cc/zh/changelog/" | grep -oE 'v1\.0\.[0-9]+' | head -3

# 4. Sanity-check no "Full Changelog: …compare…" tail leaked into the release body
gh release view v1.0.x --repo Surething-io/cockpit --json body --jq .body | tail -c 200
```

Expected: new tag at top of changelog (en + zh), no `compare/v1.0.x-1...v1.0.x` URL in the body.

## Refusals

- **Never** push tags during the pre-flight without confirmation.
- **Never** include a `**Full Changelog**: https://github.com/.../compare/...` tail in the release body — historical convention is hand-written prose, no auto-tail.
- **Never** `npm publish` manually unless the CI workflow has demonstrably failed and the human has explicitly asked.
- **Never** `git tag -d` or `git reset` after Step 2 without explicit human instruction — the tag is now visible to npm and Cloudflare and others.
- **Never** skip the `/cockpit-changelog` step and ship with the auto-generated `Full Changelog: …` notes. That's the failure mode this skill exists to prevent.

## Failure recovery cheats (only on instruction)

- **Wrong release notes published**: `gh release edit v1.0.x --notes-file …` rewrites them. Then re-trigger Deploy Website.
- **Website didn't pick up new notes**: re-run `gh workflow run "Deploy Website"`. Build is idempotent.
- **npm publish failed mid-CI**: investigate `gh run view <id> --log-failed`. Common causes: `COCKPIT_NPM_TOKEN` rotated, `npm run build` flake, `package-lock.json` drift.

## Reference

- Full release docs: `.github/RELEASING.md`
- npm publish workflow: `.github/workflows/publish.yml`
- Website deploy workflow: `.github/workflows/website-deploy.yml`
- Sister skill: `skills/cockpit-changelog/SKILL.md` (release notes voice + structure)
