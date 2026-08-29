---
name: cr
description: "Full code review: triangulate every change statically, model state/timing slices dynamically."
---

# cr — Full Code Review

Do a PR's complete review in one pass: **broad static sweep + deep dynamic dig**. This skill is **self-contained** in both methods.

Most PR review is static — read the snapshot and you can judge right/wrong, **easy but must not be skipped**. The hard part, the part you can't catch line-by-line, is **deriving dynamic behaviour from static code**: timing / state evolution / concurrency. cr does both tracks.

## Execution mode (choose before you start)

**Iron rule: the actual review always runs in a 【clean subagent】; the main session only dispatches + mechanically merges, NEVER reviews in person.** Having just written the code in the main session, carrying the defensive "I know why I did it this way" context, is the worst possible reviewer. When a subagent is spawned via the Agent tool it **does not inherit the main session's history** — it sees only the diff + this skill → that is exactly the source of fresh eyes. The dev session's residual history **must not pollute** triage / modelling / downgrade judgements.

Two side-effect red lines: ① the main session **does not make substantive judgements on the subagent's behalf**; ② splitting static out also removes the "static breadth dilutes dynamic modelling" dilution of the main thread.

Three tiers by scale (**all enter at least one clean subagent**). **You pick between the first two by scale yourself; hard is enabled ONLY when the user explicitly asks for it — never escalate to it on your own** — however large the diff or however high the risk, without the user saying hard you cap at the default tier, and don't suggest switching to hard in the report either:
- **Single subagent**: no dynamic surface / tiny → 1 clean subagent runs Part A. Main session just relays the diff + collects the report.
- **Default (2 subagents)**: has a dynamic surface → 1 static + 1 dynamic, **both clean, in parallel**, each triaging on the clean diff itself (static scans all changes / dynamic lists every slice via the slice-archetype checklist).
- **hard (1 + N subagents)**: **only when the user explicitly asks for hard (e.g. `/cr hard`)** → first 1 clean triage subagent produces the slice list, then fan out 1 static + 1 subagent per slice. Deepest, slowest. Once the user asks for it, run it as asked — don't downgrade on your own because "this change is small"; if no dynamic slice can be carved out, just note "no dynamic slice, per-slice fan-out degenerates to 1 static".

Subagent prompt template: `Read this skill (cr/SKILL.md); apply only the matching Part to <your chunk (all of Part A / one dynamic slice)>, triage it yourself, and output findings in the unified format (including the origin tag)`.

**Synthesis (main session, organize only — never re-judge)**: gather each subagent's findings → dedup (mark same-root-cause as "accomplices") → sort by impact × probability → one report + gradient chart. **It is forbidden to use the main session's dev context to whitewash / downgrade any finding** — take what the subagent judged as-is. To dispute one, **spawn a fresh clean subagent to re-check**, not the main session deciding on its own. The main session may organize the result into a short summary table, but the **expanded details must preserve the subagent's key evidence density**: for dynamic findings, carry over the state diagram / timeline / change trajectory / counterexample path; for static findings, carry over the triangulation evidence. Deduplication and wording cleanup are allowed; compressing a detailed subagent model into a one-line summary is not. Origin tags are taken as-is too — reclassifying an `introduced` finding as `pre-existing` is a form of whitewashing, and the main session is the most likely to do it (it knows "I didn't touch that part").

> Trade-off: the default 2-subagent both isolates dev pollution and removes static-dilutes-dynamic; hard's per-slice fan-out is extra depth (in practice it dug image/video up to 🔴, and multiple independently-converging subagents raised confidence), expensive and slow, selected explicitly by the user (never auto-escalated).

## Step 1 — Triage (do this first in both modes)
Read the diff, cut two surfaces (may overlap):
- **Static surface** = all changes → go to **Part A**.
- **Dynamic surface** = slices touching **state / timing / concurrency / cross-process timing** → additionally go to **Part B**.

Splitting principle: **A judges as-written** (is it written correctly), **B judges over-time** (can timing break it through); check both surfaces on the same spot. No dynamic surface → skip Part B.

---

## Part A — Static triangulation: cross-locate the change against three references

correctness, that "unknown", is triangulated against three independent references — **intent / input domain / surroundings**. Any one alone misses something (intent-only misses boundaries, input-only misses intent, surroundings-only misses both); only the three together nail it down.

Pick only the **semantic-layer problems tools can't judge** (style / format / unused vars / type mismatch go to linter & type-checker). Static bugs are almost always **the snapshot failing to match some reference**:

### A1. vs intent (did it do what it claims)
- Do the name / signature / type / PR description / comment **promises** match what the code **actually does**? (`isValid` returns true on error; PR says it changes X but actually touched Y)
- Do error / boundary branches return the **right** thing, or did they carelessly return the happy-path value?
- Are comments / docs in sync with the new code, or still describing the old behaviour?

### A2. vs input domain (did it cover the full input set) — the #1 bug source
- Is the whole set handled: null / undefined / empty / single element / duplicate / boundary value / overflow / negative / unicode / over-length?
- Is the **error path** as correct as the happy path? On early returns / exception paths, are resources closed and state consistent?
- Is external input (user text, params, deserialization, webhook) treated as **untrusted**? (injection, privilege escalation, unvalidated, secrets into logs)
- Classic disease: happy path correct, input domain not fully covered.

### A3. vs surroundings (consistent with existing contracts / conventions)
- **Contract drift**: changed a signature / type / enum / return shape — did **all consumers** change with it? (grep-visible, lint won't flag)
- **Convention deviation**: should have used the project's established pattern / helper but used a raw primitive / reinvented it?
- **Layering / boundary**: bypassed a layer it should go through, introduced a forbidden dependency direction?
- **Type as source of truth**: or bypassed by `any` / assertions / casts?
- **Security alignment**: a check the siblings all have (authn, tenant isolation) — missing here?

### Wrap-up (light; don't redo what tools cover)
- Duplicated logic — especially duplicated **decisions / policies** — should converge to a single source? Dead code, over-complexity?
- **Local** performance: N+1, IO in a loop, an obviously degraded algorithm, unbounded growth? (state-evolving cases go to Part B)
- Tests: do the new logic's **boundary / error paths** have assertions? Does the red test fail before the fix and pass after?

---

## Part B — Dynamic: derive the static code into a model, then review (dynamic-surface slices only)

You can't see timing bugs in a snapshot — they live in "how things change over time once running". Derive it into a dynamic model and review that, instead of scanning line-by-line.

**Model per slice (hard rule)**: before modelling, list **all** independent dynamic slices and tick each through B1–B3 — **don't model just the most obvious one and call it done; missing one slice = all of that slice's dynamic risks are missed**. To avoid omissions, sweep these **slice archetypes**:
- **Shared-state init + multi-write** (accumulator / key / cache: who creates first, who writes many)
- **State reused across processes / re-entry** (retry / recovery / multi-worker / queue)
- **check-then-act across an async gap** (precheck → slow operation → side-effect lands late; concurrent starts collectively cross the precheck — TOCTOU)
- **fire-and-forget write + later read** (read overwrites before the write lands)
- **Implicit context across a hop** (ALS / log context: still there after crossing process / queue?)

⚠ **One piece of code can be both a static finding point and a dynamic slice** — don't stop modelling it as a dynamic slice just because Part A already scanned it statically (wording, duplication, optional params). Static "claiming" ≠ dynamic coverage.

### B1. Static read-in (input)
Read out: **what states exist** · **who reads/who writes** (across features, across upstream callers — don't stop at this file) · **contract / type** · **control flow and entry points**.

### B2. Build the dynamic model (the main artifact, written into the report as evidence)
- **State diagram** — what states + transitions exist; annotate each transition with **who changes it under what condition**.
- **Timeline** — all writers/readers on a time axis, marking who's first; **pull it through across components, across processes**, tracing back to the moment the state is **truly born** (not where it's re-referenced locally).
- **Change trajectory** — how the key state value flows along the timeline: created / changed / read by whom, ever overwritten / no-op'd / lost midway.

These two diagrams are the evidence — many bugs (a 6-second gap, a key created too early) only reveal themselves once drawn.

### B3. Evaluate 6 classes of dynamic risk on the model

| Risk | What to look for on the model |
|---|---|
| **Order race** | Is there a writer running before the initializer? "init is awaited in this function" ≠ it's the first touch of that state. Trace to the earliest cross-feature writer. |
| **Overlap / undercount** | Multiple writers to one accumulator: is the same event recorded by >1 path (double count)? Is some event class recorded by no one (undercount)? Don't trust the comment's "this only records X" division. |
| **Lost update** | fire-and-forget write + a following read: does it read a stale value and **overwrite** the locally-correct value? |
| **fail-open wrong value** | Does the degradation path let through a *wrong value* or a *missing value*? Returning a confident wrong value for poisoned input = only half safe. **To judge fail-open/fail-closed, read the guard's actual comparison (`x < threshold` vs `x >= threshold`); don't go by comment or intuition — `NaN`/`Infinity` sentinels make every `x < threshold → safe return` guard evaluate false, so both let-through and block paths break at once.** |
| **Cross-process / re-entry** | Does retry / recovery / multi-worker reusing the same state cross-talk? Does implicit context (ALS / log context) survive a cross-process hop? |
| **Provenance break** | From source to landing point, is the key value no-op'd / overwritten / type-erased midway? (Seeing dedup / skip / idempotency guards → ask what failure they prevent → go to the path **without** them, or an older version, to find that failure.) |

**Escalation: frame hard ordering / arithmetic as satisfiability** (optional — only for **order race** and **extreme value / cancellation**, and only when informal reasoning is uncertain):
1. **Free variables** — what can vary? Order (writer interleaving), values (key numeric variables / inputs / counts).
2. **Write only real constraints** — which happens-before relations truly hold (await / lock / queue order)? Which are just your **assumption**? + the invariant to hold.
3. **∃ counterexample?** — **SAT** (found an order/value that breaks the invariant) = bug, the counterexample is the trigger scenario; **UNSAT** = proven safe under this model (only if the model is faithful to the code).

**Three disciplines (they decide findings quality)**
1. **A census isn't done until both order + overlap relations are verified.** Listing writers ≠ census complete.
2. **No downgrading on local observation.** For ordering / race findings, before downgrading you must trace the timeline to the state's birth. SMT phrasing: did you treat a non-existent happens-before as a constraint? ("some step is awaited in this function" ≠ it globally precedes other components' writes to the same state.) Not traced → mark `needs dynamic verification`, keep the tier, don't drop to ⚪.
3. **Green tests ≠ verification.** Ask: is there an **adversarial-order** test (shuffled / retry / write-before-init)? Was the layer the bug lives in mocked away? With a real trace, reconcile against the timeline.

---

## Produce findings (summary table + details)

Severity = **impact × probability**; give the product conclusion directly, don't make the reader do the math. Merge and dedup findings from both tracks. First output a **short summary table** for scanning, then expand each finding by number. Do not put long evidence into table cells; chat windows squeeze wide Markdown tables into unreadable narrow columns.

**Every finding carries an `Origin` tag.** The first question a reader has is "which of these did this change cause, and which were already there" — the report answers that itself instead of waiting to be asked. The test is a **revert counterfactual** (revert this change: is the problem still there?), NOT "is the offending code inside the diff":

- **Introduced** — reverting makes it disappear. **This includes half-landed changes**: a contract / enum / mirror table / bilingual copy / generated artifact updated on one side but not the other — the offending line **counts as introduced even when it is not in the diff**, because this change is what put the two sides out of sync. This is the class most often misjudged as pre-existing.
- **Activated** — reverting leaves it there, but unreachable / inconsequential. This change is what made it reachable or costly for the first time (a new entry point, caller, provider, config shape).
- **Pre-existing** — it happens either way; no causal link to this change, just spotted in passing.

`Origin` is **orthogonal** to severity: severity is decided by impact × probability alone. `Pre-existing` is not downgraded for "not being from this change", and `introduced` is not upgraded for "being freshly written" — the two answer different questions: whether to fix, versus who fixes it and when.

| # | Severity | Origin | Location | Consequence | Direction |
|---|---|---|---|---|---|
| 1 | 🔴/🟡/⚪ | introduced/activated/pre-existing | `file:line` | What happens if unfixed (one plain-language consequence, no jargon) | One-sentence repair direction |

Then expand by table number:

```
### #1 <one-line consequence>
Impact: how bad + to whom (specific: which users / tenants / callers, not a vague "users")
Probability: how likely + what it depends on; if uncertain, say how to raise/lower the tier
Origin: introduced / activated / pre-existing + a one-line counterfactual reason (what a revert would do); for "one side updated, the other not", name both sides
Evidence: static → which triangulation reference fails (intent / input domain / surroundings); dynamic → preserve the subagent's state diagram / timeline / change trajectory / counterexample path, not a one-line summary
Fix: what it should be / the broken invariant (jargon goes here)
```

- 🔴 high probability × big impact (blocks release) | 🟡 should fix but not bleeding | ⚪ nice-to-have. Sort summary table rows in descending severity, and **within the same severity order introduced → activated → pre-existing**, so "this change's bill" stays together.
- `Consequence` states the **outcome**, not the technical cause (cause goes in the expanded `Evidence` / `Fix`).
- `Location` must be a precise `file:line`; for a merged accomplice finding, use the core location in the table and mention other locations in the expanded `Evidence`.
- Keep `Direction` in the summary table to one sentence; put the complete `Fix` in the expanded detail.
- Expanded details are the complete information surface: if a subagent provided a dynamic model, timeline, path labels, or key code locations, the final report must carry those details forward; the summary table may be short, the detail must not erase evidence.
- `Origin` is one of the three, never blank. If you can't tell, put the most likely one and say in the expanded `Origin` line what is missing to settle it (usually "haven't confirmed whether this code was touched by this change" — go check `git diff`, don't guess).
- If a merged accomplice finding spans two origins (typically a newly introduced caller plus a pre-existing underlying defect), the table takes the **earlier** one (introduced > activated > pre-existing) and the detail explains both sides.
- Multiple same-root-cause → mark as **"accomplices"** in `Consequence` or expanded `Evidence` and merge into one finding; don't report the same problem twice (especially when static/dynamic each see one side of the same line).
- Expand each finding only once after the table; don't also emit a 7-column long table.
- Close with a one-line origin tally first: `introduced N (🔴a 🟡b ⚪c) / activated M / pre-existing K`, so the reader doesn't have to count back.
- Then the **impact × probability** gradient chart:

```
Impact ↑
 big  │ 🔴 #1
 mid  │            🟡 #2
 small│ 🟡 #3                  ⚪ #4
      └─────────────────────────────→ Probability
        low        mid        high
```

## Don't go through the motions
- **Don't skip escalation**: if Step 1 flagged a dynamic surface, you MUST actually run Part B on it (modelling + 6 risk classes); scanning statically once and stopping = a miss.
- **Don't compete with tools** (static): style / format go to linter & type-checker, cr only picks the semantic layer.
- **Don't hand-wave the dynamic**: seeing state / timing / concurrency, **build the model** (Part B), don't conclude from reading code.
- **Trivial changes**: no dynamic surface → skip Part B, deliver only a static report.
