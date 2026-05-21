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
  - `Publish to npm` — triggered by `push tag v*`, runs `npm publish` and creates a GitHub Release with an **empty body** (intentionally — see `.github/workflows/publish.yml`). Step 6 of this skill is the one that fills the body.
  - `Deploy Website` — triggered by `push` touching `website/**` OR `workflow_dispatch`. Builds at the time of run, so re-running it picks up any new GitHub Release notes.
- **Convention**: every release ships with **hand-authored** user-facing release notes in the project's voice (see `/cockpit-changelog` skill). Auto-generated `--generate-notes` content (in particular the `**Full Changelog**: …compare/…` tail) is **not** part of the convention — that's why the workflow no longer uses `--generate-notes`.

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

### Step 2 — Smoke test the local tarball BEFORE push 🆕

This step exists because three out of three `1.0.198 → 199 → 200 → 201` releases shipped DOA: install path, browser bundle, server bundle. CI green ≠ users can run it. Do NOT skip — you will spend 30 minutes shipping hot-fixes if you do.

#### 2a. Install smoke — does `npm install` succeed at all?

```bash
# Build the artifact CI will publish. TURBOPACK= overrides any shell-leaked
# TURBOPACK env (e.g. from a running dev cockpit), which would conflict with
# `next build --webpack` in package.json.
TURBOPACK= npm run build && npm run build:server

# `npm pack` does NOT trigger `prepublishOnly`, so the webpack cache that
# `prepublishOnly` cleans is still present and would bloat the tarball from
# 7 MB to ~90 MB. Clean it manually.
rm -rf .next-prod/cache

# Pack into a tarball locally
npm pack    # produces surething-cockpit-1.0.x.tgz

# Install into a clean, isolated directory — POSTINSTALL must succeed
TARBALL=$(ls -t surething-cockpit-*.tgz | head -1)
SMOKE_DIR=$(mktemp -d)
(cd "$SMOKE_DIR" && npm install -g --prefix . "$OLDPWD/$TARBALL") || {
  echo "❌ Install failed — DO NOT push"
  exit 1
}
"$SMOKE_DIR/bin/cock" --version    # must report the new version
# Keep $SMOKE_DIR around for step 2b; clean up at the end.
```

If `npm install` errors with `ERR_MODULE_NOT_FOUND` / postinstall failures / missing files / 404 on workspace `@cockpit/*` packages, the published `package.json` `dependencies` list is broken (e.g. listing private workspace packages npm can't fetch). **Reset and fix**:

```bash
git tag -d v1.0.x
git reset --hard HEAD~1
# fix the bug, recommit, npm version again
```

#### 2b. Prod-runtime smoke — does the prod build actually run?

CI compiles fine but runtime errors only show when the app boots in prod mode. The webpack browser/server split has bitten us multiple times (see v1.0.200 / 201 commit messages — `createRequire is not a function` was a runtime, not build, error).

Use **port 3458** for smoke — it avoids conflicts with both:
- the local dev cockpit (port 3456) you usually have running
- any prod cockpit (port 3457) you may also have installed via `npm link`

The cock binary picks up `PORT=3458` from env and binds there. `env -i` strips inherited env (notably any `COCKPIT_PORT` leaked from a running dev cockpit) so the smoke can't accidentally probe the wrong instance.

```bash
# Boot the JUST-PACKED tarball, not the globally-linked cock.
# Re-install into a temp dir if you don't already have one from step 2a.
SMOKE_PORT=3458
env -i PATH="$PATH" HOME="$HOME" PORT=$SMOKE_PORT COCKPIT_ENV=prod COCKPIT_NO_OPEN=1 \
  "$SMOKE_DIR/bin/cock" > /tmp/cock-smoke.log 2>&1 &
COCK_PID=$!
sleep 12      # cold-start of next-server + WS + share server takes ~8-12s

FAIL=0

# Probe a few endpoints — any non-2xx is a hard fail.
# /api/version must also report the new version string (not empty) — the
# handler used to read process.cwd()/package.json which silently returned
# empty when the prod-install was running from outside the repo.
VERSION_BODY=$(curl -fsS "http://localhost:$SMOKE_PORT/api/version") || FAIL=1
echo "$VERSION_BODY" | grep -q "1\.0\." || { echo "version body unexpected: $VERSION_BODY"; FAIL=1; }
curl -fsS "http://localhost:$SMOKE_PORT/api/commands?cwd=$PWD"                                                >/dev/null || FAIL=1
curl -fsS "http://localhost:$SMOKE_PORT/api/projectGraph/file-functions?cwd=$PWD&path=packages/feature/explorer/src/server/codeMap/types.ts" >/dev/null || FAIL=1

kill $COCK_PID 2>/dev/null
wait $COCK_PID 2>/dev/null

if [ "$FAIL" = "1" ]; then
  echo "❌ Prod runtime smoke failed — DO NOT push"
  echo "--- log ---"; tail -25 /tmp/cock-smoke.log
  exit 1
fi
```

The three probes exercise three different code paths:
- `/api/version` — minimal handler, confirms boot + Next.js routing works
- `/api/commands` — exercises `@cockpit/feature-agent` (slash-command discovery)
- `/api/projectGraph/file-functions` — exercises `@cockpit/feature-explorer` (code-map, tree-sitter, the heaviest workspace package)

If any returns a non-2xx, the published tarball is broken — typically because a workspace package's source isn't being inlined into `dist/` or `.next-prod/` and the runtime hits an unresolved `@cockpit/*` import.

If your release introduces a new feature, **manually exercise it** in the running prod cockpit too. The probes above only cover the existing known paths.

#### 2c. Cleanup — kill the smoke process and remove the tarball/install dir

The single `kill $COCK_PID` above only signals the wrapper process; the underlying `node` server (the actual port listener) often survives and keeps listening on `$SMOKE_PORT`. A leftover smoke instance on 3458 will silently absorb the **next** release's probes and make `/api/version` look broken (the stale instance is on old code where `/api/version` returns `{"version":""}` because it reads `process.cwd()/package.json` from outside the repo) — costing 10+ minutes of confused debugging. Kill the whole process tree:

```bash
# Kill the node child + the wrapper, then verify the port is free.
pkill -P $COCK_PID 2>/dev/null
kill    $COCK_PID 2>/dev/null
sleep 2
lsof -i :$SMOKE_PORT -sTCP:LISTEN -P -n >/dev/null && {
  echo "❌ $SMOKE_PORT still bound — leftover smoke process. Investigate before next release."
  lsof -i :$SMOKE_PORT -sTCP:LISTEN -P -n
  exit 1
}

# Drop the install dir and the local tarball — they're 39 MB / 8 MB respectively,
# and the tarball name collides with the next bump if left behind.
rm -rf "$SMOKE_DIR" surething-cockpit-*.tgz
```

If `$SMOKE_PORT` is unexpectedly already bound when you START step 2b, that's almost always a leftover from a previous release that wasn't cleaned up. Check `ps -o pid,lstart,command -p <pid>` to confirm it's a smoke leftover (started today, command is `cockpit`, `/api/version` returns `{"version":""}`) before killing — don't blow away an unrelated cockpit the human is actively using.

🛑 **Confirm with human before pushing.**

### Step 3 — Push commit + tag (triggers npm publish, IRREVERSIBLE)

```bash
git push --follow-tags
```

Pushing the `v*` tag triggers `Publish to npm`. After this point, npm publish is on its way and a published version cannot be retracted (npm's 72h unpublish window exists but should be avoided).

### Step 4 — Watch `Publish to npm` workflow

Find the run id and watch it:

```bash
gh run list --repo Surething-io/cockpit --workflow "Publish to npm" --limit 1 --json databaseId,status
gh run watch <id> --repo Surething-io/cockpit --exit-status
```

If it fails:
- **Transient infra**: `@vscode/ripgrep` 403 (GitHub releases rate limit), `npm ci` ECONNRESET, GH API 504 — `gh run rerun <id>` is fine.
- **Real failure** in npm publish or build: stop, report, do not retry blindly. Possible recovery is `npm publish` manually (see `.github/RELEASING.md` "Manual Publishing"), but only after diagnosing.

### Step 5 — Verify npm published

```bash
npm view @surething/cockpit version dist-tags
npm view @surething/cockpit bin
```

Expected: `version` matches new tag, `dist-tags.latest` matches, `bin` includes both `cockpit` and `cock`.

### Step 6 — Replace the auto-generated release body with hand-authored notes

The publish workflow creates the GitHub Release with **empty body** (the workflow used to use `--generate-notes`, which leaked `**Full Changelog**: ...compare/...` tails — see commit history). The body MUST be filled in by you.

Invoke the `/cockpit-changelog` skill (or if running standalone, draft notes using the same conventions: see `skills/cockpit-changelog/SKILL.md`).

Save the markdown to a temp file, then:

```bash
gh release edit v1.0.x --repo Surething-io/cockpit --notes-file /tmp/release-notes.md
```

**Hard verify the body is what you intended** (and that no rogue `compare/` link leaked back in):

```bash
gh release view v1.0.x --repo Surething-io/cockpit --json body --jq .body | tail -c 200
gh release view v1.0.x --repo Surething-io/cockpit --json body --jq .body | grep -q '/compare/' && {
  echo "❌ Full Changelog tail leaked — re-run gh release edit"
  exit 1
}
```

🛑 **Show the human the rendered notes (`gh release view v1.0.x --repo Surething-io/cockpit`) before moving on.** Hand-authored notes are the public face of the release; one round of human review is worth it.

### Step 7 — Trigger website redeploy (so /changelog page picks up the new notes)

The npm publish workflow does **not** trigger a website rebuild. The website's `/changelog` page reads `data/changelog.json`, generated at build time by `scripts/fetch-changelog.mjs` from GitHub Releases. New release → new notes → must rebuild.

```bash
gh workflow run "Deploy Website" --repo Surething-io/cockpit --ref main
sleep 8
id=$(gh run list --repo Surething-io/cockpit --workflow "Deploy Website" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$id" --repo Surething-io/cockpit --exit-status
```

### Step 8 — Verify everything is live

```bash
# 1. npm
npm view @surething/cockpit version

# 2. GitHub Release
gh release view v1.0.x --repo Surething-io/cockpit --json name,publishedAt,url

# 3. Website changelog has the new entry at the top
curl -s --http1.1 "https://cocking.cc/en/changelog/" | grep -oE 'v1\.0\.[0-9]+' | head -3
curl -s --http1.1 "https://cocking.cc/zh/changelog/" | grep -oE 'v1\.0\.[0-9]+' | head -3

# 4. Sanity: no "Full Changelog: …compare…" tail in the release body
gh release view v1.0.x --repo Surething-io/cockpit --json body --jq .body | tail -c 200
```

Expected: new tag at top of changelog (en + zh), no `compare/v1.0.x-1...v1.0.x` URL in the body.

## Refusals

- **Never** push tags during the pre-flight without confirmation.
- **Never** skip Step 2 (smoke tests). Three out of three releases between v1.0.198 and v1.0.201 shipped DOA because earlier versions of this skill let CI green stand in for "users can install + run it"; the resulting hot-fix chain ate an evening. Smoke before push, every time.
- **Never** include a `**Full Changelog**: https://github.com/.../compare/...` tail in the release body — historical convention is hand-written prose, no auto-tail.
- **Never** `npm publish` manually unless the CI workflow has demonstrably failed and the human has explicitly asked.
- **Never** `git tag -d` or `git reset` after Step 3 (push) without explicit human instruction — the tag is now visible to npm and Cloudflare and others.
- **Never** skip Step 6 (hand-authored notes). The publish workflow creates the release with an empty body specifically so this step is unavoidable; if you find yourself looking at an empty release page on cocking.cc/changelog, you forgot.

## Failure recovery cheats (only on instruction)

- **Step 2 install/runtime smoke failed**: `git tag -d v1.0.x && git reset --hard HEAD~1`, fix the bug, `npm version` again. Catching this here saves shipping a hot-fix release.
- **Wrong release notes published**: `gh release edit v1.0.x --notes-file …` rewrites them. Then re-trigger Deploy Website.
- **Website didn't pick up new notes**: re-run `gh workflow run "Deploy Website"`. Build is idempotent.
- **npm publish failed mid-CI**:
  - Transient (`@vscode/ripgrep` 403, `npm ci` ECONNRESET, GH API 504): `gh run rerun <id>` is fine.
  - Real: `gh run view <id> --log-failed`. Common causes: `COCKPIT_NPM_TOKEN` rotated, `npm run build` flake, `package-lock.json` drift.
- **GH Release `Create GitHub Release` step inside the publish workflow 504'd**: workflow finishes "failed" but npm IS published. Step 6's `gh release create v1.0.x --notes-file ...` (instead of `gh release edit`) covers this — the release didn't exist yet so create-with-notes is the right call.

## Reference

- Full release docs: `.github/RELEASING.md`
- npm publish workflow: `.github/workflows/publish.yml`
- Website deploy workflow: `.github/workflows/website-deploy.yml`
- Sister skill: `skills/cockpit-changelog/SKILL.md` (release notes voice + structure)
