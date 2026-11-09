# Planning — Establish the Outcome and Organize the Work

Use this guide to clarify the requested outcome, constraints, acceptance and implementation sequence. Use [Design](design.md) for modelling and architecture choices, and [Coding](coding.md) for writing the implementation. A clear local task can proceed without a formal plan. The entrypoint governs action scope.

## Establish what must be achieved

Identify the intended observable outcome, necessary constraints, acceptance examples and existing guarantees that matter. Distinguish explicit requirements from inferred preferences. Check relevant code, project conventions, existing capabilities and known decisions before asking the user for facts that can be discovered.

Ask about consequential ambiguity in goals, preferences or constraints that current evidence cannot resolve. Decide routine technical choices independently. Keep an already accepted design's conditions visible; if a modelling or responsibility question remains, resolve it through the design guide rather than hiding an assumption inside a task list.

## Make the work executable

Organize the recommended approach into meaningful changes with concrete outcomes. Distinguish the final outcome from the current implementation step and make remaining responsibilities clear. Identify affected boundaries, existing capabilities to reuse, dependencies and the evidence needed. Separate sequential work from genuinely independent work; decomposition does not authorize delegation.

Keep the plan proportional: a short change may need only a few sentences, while a migration may need intermediate compatibility and verification steps. Preserve necessary behavior during intermediate states and state when a temporary mechanism can be removed. Do not expand a local request into an unrelated improvement programme.

Across iterations, retain the accepted outcome and constraints alongside unfinished work, following the entrypoint's continuity rules. New evidence may invalidate the approach: revise its dependencies and steps, comparing repair, replacement or withdrawal where warranted instead of accumulating patches to preserve it. Distinguish an unresolved condition, an optional opportunity and a committed task. Existing conversation or project notes suffice; no separate record is required.

## Converge

The plan is sufficient when it is clear what will change, why, in what dependency order and how the result will be assessed. Resolve the important uncertainty without surveying alternatives indefinitely. Use a diagram when work dependencies matter, not as a required artifact.

Explicit implementation instructions authorize the accepted scope, subject to its remaining conditions. Planning itself does not imply a commit, publication or deployment. Preserve the entrypoint's distinction between a proposed plan, a verified design decision and completed implementation.
