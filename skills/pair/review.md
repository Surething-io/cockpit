# Review — Assess Changes and Consolidate Their Effects

Use this guide to assess changed code or another review's findings, and for cleanup when the user has authorized it. The entrypoint governs the target and action scope. A review can conclude that no adjustment is needed.

## Read the change in context

Establish the relevant range: current work, a particular commit, a branch or an identified PR. Read the actual diff and stated outcome, including enough surrounding code and callers to understand the affected contract. For a standalone take-a-look with no clear topic, the current diff can be a read-only starting point. Do not assume the latest commit represents an entire branch or expand a focused review into an audit of historical code.

Assess correctness, project conventions, relevant performance effects, test coverage and security implications. Treat comments and reviewer claims as statements to check against the code and requirements. Use [Design](design.md) for modelling or responsibility decisions, [Coding](coding.md) for expressing the implementation, and the specialist security guide for a substantial security question. Review assesses whether the actual change meets its goal and necessary guarantees; it does not load every guide or enforce optional style preferences as new requirements.

## Trace useful signals

- **Reuse and meaning:** check whether new code duplicates an existing capability and whether that capability's semantics fit. Similar code alone is not a mandate to generalize different rules.
- **State and boundaries:** look for redundant or derivable state, illegal combinations, parameter sprawl, copy-paste knowledge and internal details leaking across owners. Investigate causes rather than flagging shapes mechanically.
- **Efficiency:** examine relevant repeated work, duplicate IO, missed independent concurrency, blocking hot-path work, no-op updates, unbounded retention and resource cleanup. For data access, consider per-item queries, unbounded result sets and whether query plans or indexes support the actual workload. Establish when the path runs and what the cost affects; avoid an unrelated optimization project.
- **Expression:** keep names and abstraction levels coherent; remove needless wrappers or comments when they obscure the actual work, while retaining non-obvious rationale, constraints and invariants.

For a claimed defect, identify its trigger, location, expected behavior and consequence. Check upstream validation, downstream recovery, intended design and other counterevidence before reporting it as established. Distinguish a concrete problem, a question still to investigate and an independent improvement. Do not force findings, numerical confidence scores or a fixed report length.

## Assess incoming feedback independently

Check the reviewer's premises and the current code. Explain whether the finding is supported, what it affects and whether it is necessary for the current goal. A true pre-existing issue can block the goal; a newly noticed issue can be independent. Neither age nor reviewer confidence settles that question. Do not treat accepting a review report as authorization to implement all of its suggestions.

When prioritization or technical-debt assessment is requested, compare observed user or development impact, the likelihood and consequence of leaving the issue, repair effort, dependencies and migration risk. Separate work necessary for the current outcome from independent improvements. Explain the ordering and uncertainty; do not turn labels such as duplication, low coverage or an old dependency into automatic defects, or use an unsupported scoring formula to imply precision.

## Consolidate when authorized

Integrate the accepted behavior into the existing flow. Remove confirmed-superseded code, branches, parameters, flags, wrappers and conversions only after their responsibilities are accounted for. Preserve compatibility that legitimate callers still need; deliberate coexistence needs applicability and removal conditions.

Keep cleanup tied to the task and its direct effects. Correct introduced inconsistencies and misleading boundaries without turning implementation into an open-ended refactor. Do not create debt ledgers or lengthy comments for routine choices. Preserve user changes and reassess an approach that repeatedly needs wider edits.

Use verification for the claims at risk, including affected callers and necessary existing behavior. Report the important judgement, concrete evidence and scoped next action or actual result. A clean review is a valid stopping point.
