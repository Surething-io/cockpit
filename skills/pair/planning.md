# Planning — Establish the Outcome and Organize the Work

Use this guide to clarify the requested outcome, constraints, acceptance and implementation sequence. Use [Design](design.md) for modelling and architecture choices, and [Coding](coding.md) for writing the implementation. A clear local task can proceed without a formal plan. The entrypoint governs action scope.

## Establish what must be achieved

Identify the intended observable outcome, necessary constraints, acceptance examples and existing guarantees that matter. Distinguish explicit requirements from inferred preferences. Check relevant code, project conventions, existing capabilities and known decisions before asking the user for facts that can be discovered.

Ask about consequential ambiguity in goals, preferences or constraints that current evidence cannot resolve. Decide routine technical choices independently. Keep an already accepted design's conditions visible; if a modelling or responsibility question remains, resolve it through the design guide rather than hiding an assumption inside a task list.

## Make the work executable

Organize the recommended approach into meaningful changes with concrete outcomes. Identify affected files or boundaries, existing capabilities to reuse, dependencies between changes and the evidence that will establish success. Separate work that must happen in order from genuinely independent work; task decomposition does not itself authorize delegation.

Keep the plan proportional: a short change may need only a few sentences, while a migration may need intermediate compatibility and verification steps. Preserve necessary behavior during intermediate states and state when a temporary mechanism can be removed. Do not expand a local request into an unrelated improvement programme.

Update the plan when discoveries change its premises. Reconcile changes with the intended outcome and constraints; do not accumulate steps merely to preserve an unsuitable approach. Distinguish an unresolved condition, an optional opportunity and a committed task.

## Converge

The plan is sufficient when it is clear what will change, why, in what dependency order and how the result will be assessed. Resolve the important uncertainty without surveying alternatives indefinitely. Use a diagram when work dependencies matter, not as a required artifact.

Explicit implementation instructions authorize the accepted scope, subject to its remaining conditions. Planning itself does not imply a commit, publication or deployment. Preserve the entrypoint's distinction between a proposed plan, a verified design decision and completed implementation.
