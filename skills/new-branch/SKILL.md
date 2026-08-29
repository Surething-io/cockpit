---
name: new-branch
description: "Cut a clean new branch off the latest origin/main and verify it matches the remote."
argument-hint: "[branch name; ask if omitted]"
---

# New Branch (create a branch off the latest mainline)

Branch off the latest `origin/main` so the starting point is clean and in sync with the remote.

## Trigger

The user asks to "create a new branch / new branch / cut a branch" and wants it based on the latest mainline.

## Scope (important)

This skill is **only responsible for quickly creating a clean new branch**, up to "verify right after cutting".

- **Do**: fetch → branch from `origin/main` → verify sync → output confirmation.
- **Do NOT**: explore / read code, spawn Explore / Plan agents, produce an implementation plan, or start writing code.

Any requirement description the user includes at trigger time (e.g. "improve the add-to-slack onboarding flow") is **only used to derive the branch name / record intent**, not a dev task to start here. Follow-up requirement refinement and implementation are discussed by the user in a new conversation and are out of scope for this skill.

## Pre-checks

1. Confirm the branch name (always in English, following the `<type>/<short-desc>` convention, e.g. `feat/credit-guard`, `fix/stream-recovery`):
   - User already gave a ready branch name → use it directly.
   - User gave a requirement sentence (e.g. "improve the add-to-slack onboarding flow") → **derive** an English branch name from it (e.g. `feat/slack-onboarding-flow`) and create it directly, no need to ask.
   - No derivable information at all → only then ask.
2. Confirm the working tree is clean (`git status`). If there are uncommitted changes, stop and ask the user how to handle them; do not force-switch.

## Steps

```bash
# 1. Fetch the latest remote mainline
git fetch origin main

# 2. Create and switch to the new branch off the latest origin/main
git checkout -b <branch-name> origin/main

# 3. Verify: should be 0 ahead, 0 behind
git rev-list --left-right --count origin/main...HEAD
```

`git checkout -b <name> origin/main` in one step guarantees the new branch's start = the latest remote mainline; no need to update local main first.

## Verification

- `git rev-list --left-right --count origin/main...HEAD` outputs `0	0` (0 ahead, 0 behind).
- `git status` shows you are on the new branch with a clean working tree.

Output confirmation: branch name, current HEAD commit, and sync status against origin/main.

## When to stop and ask

- No ready branch name and no derivable requirement description → ask.
- Uncommitted changes in the working tree → ask how to handle (stash / commit / discard); never discard on your own.
- A branch with the same name already exists → ask whether to overwrite or rename.

## Key principles

- **Start from the latest**: always base on `origin/main`, never on a possibly stale local main.
- **Never lose changes**: confirm before any operation that could lose the user's work.
- **Verify right after cutting**: use rev-list to confirm actual sync; never assume.
