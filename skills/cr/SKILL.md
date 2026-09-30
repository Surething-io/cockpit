---
name: cr
description: "Full code review: triangulate every change statically, model state/timing slices dynamically. Use when reviewing a PR / branch / commit / working-tree diff; pass `hard` for per-slice subagent fan-out."
---

# cr — Full Code Review

> Form: **text diagrams for the skeleton, pseudocode for the deterministic logic
> (orchestration, gating, report format), short prose checklists for judgement.**

Most review is static — read the snapshot, judge right/wrong; easy, never skip it. The hard
part is **deriving dynamic behaviour from static code** (timing / state / concurrency). cr
does both tracks.

## Principles (reason from these when no rule fits)

- **P1 Independent judgement** — reviewers are clean subagents; they never see each other's
  work; the main session never judges, filters, or steers between them.
- **P2 Lossless relay** — the main session owns only the frame; everything inside a finding
  is the reviewer's own words.
- **P3 Real behaviour over proxies** — judge what code and dependencies actually do (source,
  comparison, caller), not what a name, comment, mock, green test or intuition suggests.
- **P4 Solution diagram first, then the breaks** — the reader understands a problem only
  against the whole solution; draw once, say only what the drawing can't; rate by the harm
  the broken promise existed to prevent.

---

## 0. Skeleton

```text
                          ┌──────────────────────────────┐
                          │ main session                 │
                          │ run_cr(target, user_args)    │   dispatches + assembles,
                          └──────────────┬───────────────┘   never reviews (P1)
                                         ▼
                          ┌──────────────────────────────┐
                          │ choose_tier (by size only)   │
                          └───┬──────────┬───────────┬───┘
                     tiny     │  default │           │ user said "hard"
                              ▼          ▼           ▼
                        ┌─────────┐ ┌─────────┐ ┌───────────────────┐
                        │ 1 × all │ │ static  │ │ triage → static + │
                        │         │ │ dynamic │ │ 1 per slice       │
                        └────┬────┘ └────┬────┘ └─────────┬─────────┘
                             └───────────┼────────────────┘
                                         ▼  each reviewer, in parallel, isolated
                          ┌──────────────────────────────┐
                          │ review(scope)  §2            │
                          │ triage → Part A → Part B     │
                          │ → emit ReviewerReport        │
                          └──────────────┬───────────────┘
                                         ▼
                          ┌──────────────────────────────┐
                          │ format_gate  §4              │── fail ──► back to the SAME
                          └──────────────┬───────────────┘            reviewer, re-emit
                                    pass ▼
                          ┌──────────────────────────────┐
                          │ assemble  §1                 │
                          │ merge accomplices, place ✗#n │
                          └──────────────┬───────────────┘
                                         ▼
                          heading+verdict → diagram → findings → coverage
```

---

## 1. Main session

> Dispatched as a review subagent? You are the clean reviewer — skip to §2. Don't spawn
> further subagents or disclaim their absence.

```python
def run_cr(target, user_args):
    intent = requirements_only(target)          # PR text / requirement / commit message;
                                                # never the dev session's rationale
    tier = choose_tier(target, user_args)
    scopes = {
        "single":  [Scope("all")],
        "default": [Scope("static"), Scope("dynamic")],
        "hard":    [Scope("static")] + [Scope("slice", s) for s in spawn_triage(target)],
    }[tier]
    # tier == "hard" and no slices → note "no dynamic slice, fan-out degenerates to 1 static"

    reports = parallel(spawn_clean(PROMPT.format(target, intent, s)) for s in scopes)

    for r in reports:
        while (errors := format_gate(r)):        # §4 — countable checks only
            r = ask_same_reviewer(r, "fit your own findings to the format", errors)

    return assemble(reports)

def choose_tier(target, user_args):
    if "hard" in user_args:  return "hard"       # only when the user asks; never escalate,
                                                 # never suggest it
    if clearly_tiny(target): return "single"     # size only — dynamic-surface is the
    return "default"                             # reviewer's call; unsure → default

PROMPT = """Read this skill (<absolute path to this file>); review {diff range};
the change intends: {intent}; running tests is <allowed / not allowed>.
Apply §2 to {scope}, triage it yourself, emit a ReviewerReport (§3)."""
```

```python
def assemble(reports):
    # MAY:     ask a reviewer for ITS OWN missing detail; format-gate bounce
    # MUST NOT: relay one reviewer's findings / hints to another; point a reviewer at a path;
    #          downgrade, drop, re-title, rewrite, summarise, reclassify Origin
    # dispute a finding → spawn a FRESH clean subagent to re-check

    findings = merge_accomplices(f for r in reports for f in r.findings)
        # same root cause → one finding:
        #   severity = max(ratings)   origin = earliest(introduced > activated > pre-existing)
        #   body     = the block tracing more of the effect, verbatim
        #   + one line: "Independently confirmed by the <other> reviewer (<file:line>, rated <sev>)"
    findings.sort(key=(severity desc, origin order))

    diagram = static_report(reports).diagram     # static reviewer covers the whole diff
    for f in findings:
        diagram.mark_once(f.break_location, f"✗#{f.n} {f.severity} {f.break_note}")
        # mechanical placement only — no other edit to the diagram

    return render(heading_and_verdict(findings),  # the ONLY text the main session writes
                                                  # (incl. the > 5 findings index, §4),
                  diagram,                        # together with the coverage block
                  [f.block for f in findings],
                  coverage(reports))
```

---

## 2. Reviewer

```python
def review(scope):
    static_surface  = all_changes(diff)
    dynamic_surface = slices_touching(diff, "state | timing | concurrency | retries | cross-process hop")
    # A judges as-written; B judges over-time. Same spot can be in both.

    findings = []
    if scope in ("all", "static"):
        findings += part_A(static_surface)       # checklist §2.A
        diagram = draw_solution_diagram(diff)    # §3 rules; working copy for the report
    if scope in ("all", "dynamic", "slice") and dynamic_surface:
        slices = enumerate_all_slices(dynamic_surface, ARCHETYPES)   # list ALL first
        for s in slices:                         # a missed slice = all its risks missed
            model = build_model(s)               # state diagram · timeline · trajectory
            for risk in RISKS:                   # §2.B, all six, every slice
                findings += evaluate(risk, model)
            coverage.add(s, "✗#n" if s has finding else "✓")
        # slice not modelled → coverage.add(s, "— not modelled: <reason>")

    for f in findings:
        f.consequence = "When <trigger>, <the promised behaviour> does not happen."
        f.origin      = revert_counterfactual(f)     # §3
        f.severity    = rate(f)                      # §3
        if not traced_to_birth(f) and f.kind == "race":
            f.probability += " needs dynamic verification: <what's missing>"   # keep the tier

    return ReviewerReport(findings, diagram, coverage)     # working notes stay with you
```

### 2.A Static checklist — triangulate against intent / input domain / surroundings

Only semantic problems tools can't judge (style / format / unused / type errors → linter).

- **A1 vs intent** — do name / signature / PR text / comments **promise** what the code
  does? Do error / boundary branches return the right thing, not the happy-path value?
  Comments and docs in sync?
- **A2 vs input domain** (#1 bug source) — null / empty / single / duplicate / boundary /
  overflow / negative / unicode / over-length? Error path as correct as happy path,
  including the error **shapes** that actually arrive (P3)? Resources closed, state
  consistent on early return? External input treated as untrusted?
- **A3 vs surroundings** — contract drift (all consumers updated?); **dependency
  contracts** checked in the dependency's source or docs (returns / throws / internal
  behaviour / defaults / units, P3); convention / layering; types bypassed by `any` / casts;
  security checks the siblings all have.
- **Wrap-up** — duplicated decisions; dead code; local perf (N+1, IO in loop, unbounded);
  tests: boundary / error assertions, red-before-fix, **test doubles behave like the real
  boundary** (P3).

### 2.B Dynamic checklist

`ARCHETYPES` — sweep all when enumerating slices:
- shared-state init + multi-write · state reused across processes / re-entry ·
  check-then-act across an async gap (TOCTOU) · fire-and-forget write + later read ·
  implicit context across a hop · **state machines inside a dependency** (auto-retry,
  backoff, cache, pool, buffer — what does the caller observe while it runs and once it ends?)

`build_model` — read who reads / writes (across features, callers, into dependencies), then
draw for yourself: **state diagram** (who changes it under what condition), **timeline**
(all actors on one axis, traced to where the state is truly born), **change trajectory**
(created / changed / read / overwritten / lost).

`RISKS` — evaluate every one on every slice:

| Risk | Look for |
|---|---|
| Order race | a writer before the initializer; "awaited here" ≠ first touch |
| Overlap / undercount | same event recorded twice, or by nobody |
| Lost update | stale read overwrites the correct value |
| Fail-open wrong value | degradation lets a wrong / missing value through; read the guard's actual comparison (`NaN` is false both ways) |
| Cross-process / re-entry | reused state cross-talks; implicit context lost over the hop |
| Provenance break | key value no-op'd / overwritten / wrapped / type-erased between source and use |

Uncertain about ordering or arithmetic → frame as satisfiability: free variables, only real
happens-before constraints, invariant; SAT = bug with its trigger, UNSAT = safe.
Disciplines: a census isn't done until order + overlap are verified · no downgrading on local
observation · green tests ≠ verification (was the bug's layer mocked away?).

---

## 3. Finding semantics

```python
def revert_counterfactual(f):
    if gone_if_reverted(f):          return "introduced"   # incl. half-landed changes: one side
                                                           # of a contract/enum/mirror updated,
                                                           # even if the line is outside the diff
    if harmless_if_reverted(f):      return "activated"    # this change made it reachable
    return "pre-existing"
    # never blank; unsure → likeliest + what would settle it. Orthogonal to severity.

def rate(f):
    if f.impact == "big" and (f.probability != "negligible" or f.irreversible):
        return "🔴"      # irreversible = data loss / wrong money / security
    if f.should_fix:  return "🟡"
    return "⚪"
    # a safeguard failing in the very scenario it exists for is rated by the harm it was
    # meant to prevent — "no worse than before the change" is not a downgrade
```

`Consequence` — the first promised behaviour that fails, under its trigger, one clause:
**"When <trigger>, <the promised behaviour> does not happen."** Mechanism → `Break`;
downstream → `Effect`. ("X instead of Y" smuggles in a downstream effect — state Y's failure.)

**Solution diagram rules** — one ` ```text ` block, top to bottom, ≤ ~80 columns: one box per
component (name + `file:line`), decisions as branches labelled with their condition, happy
path straight down, dependencies collapsed to one box unless a break lives inside. It is a
claim about behaviour (P3): every arrow is real control flow, arms that don't join in code
don't join here, every path drawn to where it ends. Lines never cross a box or each other — repeat a terminal box (e.g. the same fail-closed exit) at the end of each path rather than route a long line across the diagram.
Annotations in a right-hand column. Each finding marked **once**: `✗#n 🔴 <what>`.

```text
Webhook dedup (this change)

        ┌───────────────────────────┐
        │ provider webhook delivery │
        └─────────────┬─────────────┘
                      ▼
        ┌───────────────────────────┐
        │ receive    handler.ts:40  │
        └─────────────┬─────────────┘
                      ▼
        ┌───────────────────────────┐
        │ dedup lookup  dedup.ts:12 │ ✗#1 🔴 key = id + timestamp:
        │ key = id + timestamp      │        a redelivery never matches
        └──────┬─────────────┬──────┘
          hit  │             │  miss
               ▼             ▼
     ┌──────────────┐  ┌──────────────────────┐
     │ ignore       │  │ process handler.ts:58│
     │ (promised    │  └──────────┬───────────┘
     │ for repeats) │             ▼
     └──────────────┘  ┌──────────────────────┐
                       │ charge billing.ts:90 │
                       └──────────────────────┘
```

---

## 4. Report format and gate

```python
REPORT = [                                  # exactly these four parts, nothing else
    "heading+verdict",   # "## Review: <target>" + "<N> findings (🔴a 🟡b ⚪c). Worst: <Consequence verbatim>"
    "diagram",           # §3; unmarked if no findings
    "findings",          # one block each, sorted
    "coverage",          # ```text block
]
# > 5 findings → index before the diagram, a Markdown list, one item per finding:
#   "- #1 🔴 introduced — <Consequence>"   (bare lines collapse into one paragraph)
# language = the user's; identifiers and file:line unchanged
# blank line before the "## Review" heading and before and after every code block
# test runs / scratch scripts / side notes → a finding's Why, or the last coverage line

def format_gate(report) -> list[str]:          # countable checks only; never judges content
    errors = []
    for f in report.findings:
        body = f.block.body
        if not body.is_fenced("text"):         errors.append(f"#{f.n}: body not in ```text")
        if body.line_count() > 8:              errors.append(f"#{f.n}: {body.line_count()} lines > 8")
        if body.max_line_width() > 100:        errors.append(f"#{f.n}: line > 100 chars")
        if body.has_sub_bullets():             errors.append(f"#{f.n}: sub-bullets")
        if f.block.heading != f"### #{f.n} {f.severity} {f.consequence}":
                                               errors.append(f"#{f.n}: heading ≠ Consequence")
    for line in report.coverage.slice_lines():
        if words(line.name) > 6:               errors.append(f"coverage: '{line.name}' > 6 words")
    if report.diagram.marks_per_finding() > 1: errors.append("a ✗#n marked more than once")
    if report.has_parts_outside(REPORT):       errors.append("content outside the four parts")
    return errors
```

Finding block — Markdown heading, body in a ` ```text ` block (plain text, no backticks,
continuation lines indented under the field):

````
### #1 🔴 When the provider redelivers the same webhook, the duplicate is not ignored

```text
introduced · every redelivery; depends on provider retry policy
Break:  ✗#1 dedup.ts:12 — the key includes the delivery timestamp,
        so a redelivery never matches
Effect: redelivery → processed again (handler.ts:58) → charged twice (billing.ts:90)
Why:    dedup must key on what stays stable across redeliveries;
        verified against the provider's retry docs
Fix:    key on the delivery id alone; add a test that redelivers the same payload
```
````

`Break` may carry a flat zoom-in of at most 3 lines when the mechanism needs it.

Coverage block — always present, one slice per line, marks `✗#n` / `✓` / `— not modelled:`:

```text
introduced 1 (🔴1) / activated 0 / pre-existing 0
S1 dedup lookup on redelivery     ✗#1
S2 concurrent first deliveries    ✓
S3 retry after handler crash      — not modelled: no retry path in diff
```

Static-only reviewer → `slices: none (static only)`.

---

## Self-check

```python
assert every reviewer triaged and judged alone; nothing relayed between tracks     # P1
assert every report passed format_gate, or was bounced to its own author           # P2
assert main session wrote only heading+verdict (+ index) and coverage; findings verbatim  # P2
assert blank line before "## Review"; index (> 5 findings) is a "- " list, one per line  # §4 —
                                                   # main-session text never passes format_gate
assert every behavioural claim rests on real code / source, not a proxy            # P3
assert diagram arrows == real control flow; each ✗#n once, right-hand column       # P4
assert every slice ✓ / ✗#n / not-modelled; every finding has an Origin             # coverage
```
