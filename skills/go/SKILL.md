---
name: go
description: "Land converged work in self-verifying MVP slices, advancing stage to stage without interruption."
argument-hint: "[research conclusion path / brief / leave empty to reuse current session context]"
---

# Landing Mode

Take the already-converged research conclusion and land it as MVP slices continuously and automatically; each stage closes its own verification loop, with one end-to-end recap at the very end.

## Trigger conditions (all must hold)

1. The research / discussion phase has ended and the conclusion has converged
2. The user explicitly says "start landing / implement / go"
3. The user wants continuous, automatic progress without per-stage confirmation

If any condition fails, fall back to `qa` mode for clarification first.

## Pre-flight check (mandatory before starting)

Confirm the following are **in hand**; if any is missing, stop and ask — do not guess:

| Item | Source |
|---|---|
| Research conclusion | Session context / a path the user gives / pasted text |
| Landing scope | What's in, what's out |
| Acceptance criteria | What counts as "end-to-end runs" |
| Working directory and stack | Project root path, language, framework |

## Execution loop

```
while there are unfinished MVP sub-tasks:
  1. Pick the next minimum closed-loop sub-task
     - Deliverable: a standalone artifact
     - Verifiable: a clear way to run / check it
  2. Write code (minimum change, KISS)
  3. Self-verify: run commands, hit endpoints, read output — do not wait for the user's nod
  4. Emit [Stage N delivery summary + verification report]
  5. No pause; proceed to the next stage
end while

Finally emit [Overall recap: end-to-end interaction verification + total delivery list]
```

## Per-stage output format

```markdown
### Stage N: <sub-task name>

**Delivery summary**
- Goal: <what this stage achieves>
- Changes:
  - <file1>: <what was done>
  - <file2>: <what was done>
- Status: ✅ done / ⚠️ partial / ❌ blocked

**Verification report**
- How verified: <commands run / endpoints called>
- Result: <output summary / key metrics>
- Residual issues: <none / list>
```

## Final recap format

```markdown
## Overall recap

### End-to-end interaction verification
- Scenario: <full user-flow description>
- Steps: <1 → 2 → 3>
- Result: <passes / failure points>

### Total delivery list
| Stage | Sub-task | Key artifact | Status |

### Known residuals
<none / list with suggested priority>
```

## When to stop and ask (only three cases)

1. **Blocking ambiguity**: a key piece of info is missing and progress is impossible (unknown API contract, unclear business rule)
2. **Destructive operation**: deleting data, force-pushing, rewriting git history, or other irreversible actions
3. **Branching decision**: a key design choice the research did not cover

**Do NOT stop for**:
- "This step looks important, should I confirm?" → No, do the KISS default
- "Maybe this way, maybe that way" → Pick the simplest implementation and continue
- "Done with a stage, awaiting sign-off" → No, go straight to the next stage

## Key principles

- **KISS over completeness**: a minimal runnable implementation > grand-and-complete
- **Running over reading**: actually run it to verify > stare at code
- **Continuous over pausing**: auto-advance > frequent asking
- **Recap over interruption**: one final review > mid-flow breaks
