---
name: skillify
description: "Distil a proven workflow from this conversation into a reusable Skill file."
argument-hint: "[placement directory] [target to skillify]"
---

# Skillify

Abstract "the thing you just pulled off" into a reusable skill. This is an **analyze → extract → save** flow:

- **Step 1 is always analysis**: first decide whether the conversation / recent context holds knowledge worth distilling into a skill. If not, say so and stop — never force it.
- The placement directory and other args are **only needed at the final save step** — do NOT front-load a "where should it go?" question.

Applies when the user says: "abstract this into a skill", "write up what we just learned as a skill", "do this automatically next time", "skillify this", "capture this workflow".

Core goal: **turn a one-time success into a stable procedure, not copy a transient chat into a prompt.**

## Arguments (all optional; used only at save time)

- **Trailing text** (after `/skillify`) = the object / lead to skillify; if omitted, distil from recent context.
- **Placement directory `<skills-dir>`** = where the skill lands; the canonical source goes to `<skills-dir>/<slug>/SKILL.md`. **Only needed at the "save" step**; ask only if the user hasn't provided it — never ask before analysis.

## Step 1: Analyze — is there knowledge worth capturing (scan → gate)

Answer "**should this even be extracted**" first. Most candidates die here, not in the writing.

### 1a. Three-phase scan: don't miss invisible skills

Review what you just did, sweeping each phase once, asking one question per phase: **is there a "non-obvious action / judgement" here?**

| Phase | What to scan | Why it's easily missed |
|---|---|---|
| Discovery | How did you locate / trigger / diagnose the real problem? Which signal did triage use? | No visible deliverable — most often missed |
| Decision | What justified the judgement call at the sticking point? Any reusable criterion? | Treated as "intuition", not realized it can be codified |
| Solution | Is the execution skeleton / tool-combo / verification reusable? | Visible — easiest to fixate on |

The scan is about **breadth, anti-omission**: people naturally notice only "solution" (it has deliverables), while "discovery / decision" — the diagnosing and judging moves — are high-value yet invisible.

> The three phases are only for **scanning candidates**, not chapters in SKILL.md. The body should be organized by **failure mode / investigation action**, not by these three categories.

### 1b. The real gate: don't over-extract

For each candidate, all four must pass:

- [ ] **Recurs**: will you hit this kind of scenario again? (One-off → a note is enough, no skill.)
- [ ] **Non-obvious**: is there an action / judgement you "wouldn't know without looking it up"? (Obvious things aren't worth codifying.)
- [ ] **Cost**: is the cost of getting it wrong / missing it high?
- [ ] **Stable**: is the procedure stable, not bound to this session's transient context / data?

Missing "non-obvious" or "recurs" → basically drop it.

**If nothing passes the gate → tell the user "not worth a skill this time", explain why, and stop.** Do not force a deliverable, and do not ask for a placement directory at this step.

### 1c. Merge or split: the boundary question

If discovery / decision / solution **all** surface candidates in one scenario, decide whether they go into **one closed-loop skill** or **split into a combination**:

- **Will any single phase be invoked alone?** Yes → split; always entered from the top → lean merge.
- **Is the value inside a phase or at the handoff?** At the handoff (upstream expected-state / contract must reach downstream for verification) → merge; each phase self-contained, handoff carries no info → splittable.
- **Would merging make one unit carry orthogonal failure modes?** Yes (e.g. static breadth vs dynamic-reasoning depth) → split.
- **Does this phase run first in other problems too?** Fan-out ≥2–3 → split into a reusable leaf.

**Third state (need both)**: when the loop must stay intact but a phase needs depth / reuse, use **orchestrator + leaf** — one closed-loop skill holds the contract and verification, delegating orthogonal phases to reusable sub-skills.

**Default to one closed-loop skill.** Split only on a real signal (a phase reused by a second scenario, or attention spread too thin for depth).

### 1d. Classify: decides how to write, not whether to extract

| Type | Example | Skill focus |
|---|---|---|
| Investigation | pull sources → build timeline → locate issue | evidence sources, steps, output template |
| Debug | reproduce → red test → fix → verify | invariants, tests, acceptance |
| Tool-combo | chain multiple log/monitor/analysis tools | query order, correlation IDs |
| Habit/convention | directory structure, naming, placement | path rules, naming rules |
| Writing template | issue / PR / retro report | structure, tone, prohibitions |

**Do NOT** write one-off details into the skill (a transient session, a full specific chat, a temporary verification code, etc.).

## Step 2: Extract — distil stable principles and draft

> If 1c decided on a split or orchestrator + leaf, run Step 2 once for **each** skill to land (each its own directory).

### 2a. Distil stable principles

Break the experience into:

- **Trigger**: when this skill should be used
- **Input**: what the user might provide, what to ask when it's missing
- **Evidence sources / tools**: which sources, files, CLIs, logs to check
- **Steps**: the stable, reusable execution order
- **Output**: what to hand the user, or what artifact to create
- **Boundaries**: what NOT to do, when to stop / ask
- **Verification**: how to confirm the skill worked

Write principles, not a play-by-play.

### 2b. Choose a slug

Slug: lowercase, alphanumeric + hyphen, short and clear, verb/task- or topic-oriented. Before drafting, `ls <skills-dir>/` to avoid collisions and match existing naming style (when the save dir is known).

### 2c. Draft SKILL.md

Use the generic-compatible frontmatter:

```yaml
---
name: <slug-or-display-name>
description: "One line: what the skill does and when to use it."
argument-hint: "<optional, describe args>"
alwaysAllow: ["Bash"]      # optional
requiredSources: []         # optional
---
```

Suggested body structure:

```markdown
# <Skill Name>

One-line goal.

## Trigger / When to use
## Preconditions
## Workflow / Steps
## Output format
## Boundaries & prohibitions
## Verification
## Examples
```

Writing style:

- Instructions must be executable, not vague.
- Don't write dead behaviors like "after reading, tell the user the rules are loaded".
- Action-type skills proceed by default; ask only when a key argument is missing.
- Keep concrete paths, APIs, command examples, but scrub one-off sensitive data.
- Match the existing style of the target skill library.

### 2d. Icon (optional)

- Prefer 3D / color / skeuomorphic style, consistent with existing visuals.
- Recommended source: Microsoft Fluent Emoji.
- Filename must be `icon.svg`/`icon.png`/`icon.jpg`/`icon.jpeg`, placed in the skill directory.
- No ad-hoc hand-drawn SVG stand-ins unless the user explicitly asks. If none fits, ask first — don't force one.

## Step 3: Save — land it in the given directory

**Only now do you need the placement directory `<skills-dir>`:**

- User gave a directory up front → use it directly.
- Not given → ask **now** where to put it; do not pick a directory on your own.

Conventions:

1. **One skill, one directory**: `<skills-dir>/<slug>/SKILL.md` (required) + optional `icon.svg` / `references/` / helper scripts.
2. **Never drop a SKILL.md directly in the `<skills-dir>` root**: even a single-file skill gets its own subdirectory.
3. **Keep helper data/scripts in the same directory** so the skill is self-contained.

```bash
mkdir -p <skills-dir>/<slug>
# write SKILL.md into that dir; include helper scripts/data if any
```

`<skills-dir>/` IS the canonical source — no need to symlink elsewhere.

## Verification

```bash
ls -la <skills-dir>/<slug>/
```

- [ ] `SKILL.md` exists, frontmatter valid, `name`/`description` non-empty
- [ ] Body non-empty with executable steps
- [ ] No hardcoded sensitive info (accounts, tokens, transient session ids)
- [ ] Slug doesn't collide with an existing one

## Output to the user

When done, briefly report: skill slug, source path (`<skills-dir>/<slug>/SKILL.md`), whether an icon was added, whether helper scripts/data are included. Don't paste the full SKILL.md unless asked.

## Key principles

- The user wants a **captured capability**, not a copied conversation.
- **Analysis first**: decide whether there's knowledge worth capturing; if not, stop — don't force it, and don't ask for a directory early.
- The canonical source always lives in `<skills-dir>/<slug>/`; even a single-file skill gets its own subdirectory.
- Distinguish fact / hypothesis / to-be-confirmed; don't hardcode a solution too early.
