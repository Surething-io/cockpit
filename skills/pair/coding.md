# Coding — Turn the Chosen Behavior into Clear Implementation

Use this guide while writing code, discussing how an implementation should be expressed, or helping with code in progress. Apply the entrypoint's scope and action rules: a take-a-look can receive concrete coding advice without authorizing edits. Use [Design](design.md) when a decision changes the model, contracts or responsibility boundaries.

## Start from the contract and project conventions

Understand the required behavior, accepted design and relevant callers before editing. Read the project's language, framework, IO, error-handling and performance conventions. Reuse existing capabilities only when their semantics fit; do not introduce a competing implementation style merely because it is familiar.

Work on a coherent behavior through its relevant path, including necessary failure and cleanup behavior. Keep dependencies and remaining responsibilities visible during intermediate steps. Investigate a contradicted design assumption rather than silently implementing a different contract; revise the affected implementation and verification together when the approach changes.

## Establish state and ownership contracts

For changes involving persistence, asynchronous work, cancellation, retries or concurrency, establish the following before choosing or changing the mechanism. Use a short working note, timeline or state model; no separate document is required:

- Identify every writer of the affected state, its readers, and the ordering actually enforced between them, including work already in flight.
- Define when an operation becomes visible and complete, which invariant must hold at each partial state, and which observed version its decisions depend on.
- Define when a participant gains and loses authority to write, what enforces that boundary at the write itself, and what happens to outstanding work after cancellation or ownership transfer.
- Define how partial work reaches a valid terminal state after failure, permanent cancellation or re-entry, including who can recover it and whether later work can proceed.

Check dependency source or authoritative contracts wherever this reasoning relies on cancellation, retry, locking or atomicity behavior. Treat a new guard, checkpoint or recovery record as another participant in this model. Use Design when the contracts require a different responsibility or storage boundary.

Map affected guarantees to the decisions that enforce them, including relevant creation, update, replacement, cleanup and recovery paths. When a new mechanism takes responsibility, check whether existing paths can bypass or contradict it. Remove superseded branches once the transfer is supported; retain compatibility for identifiable callers or conditions. Recheck the combined paths after a model change and use Verification to challenge them. This concerns the affected behavior, not an inventory of the whole system.

## Make meaning and flow readable

Choose names that communicate domain meaning, units and important distinctions. Represent related values and valid states so that the reader can understand their relationship without reconstructing a collection of independent flags. Derive values from authoritative state when practical rather than creating another fact that every caller must keep synchronized.

Keep a function's abstraction level consistent. Let the normal flow read in a clear order, with exceptional cases visible and consequential effects easy to locate. Use early exits where they clarify preconditions rather than nesting the main work unnecessarily. Extract a function when it names a meaningful operation, gives a responsibility an owner or isolates a concern; avoid both opaque long flows and chains of trivial forwarding helpers. Function length or caller count alone does not decide this.

Pass inputs that describe what the operation needs. If parameters keep multiplying, inspect whether the operation combines unrelated responsibilities or whether a cohesive input model would express the contract better. Do not replace every parameter list with an unstructured options object, or add control flags to force different workflows into one function.

Use comments for non-obvious rationale, constraints and invariants. Prefer clearer names and flow over comments that narrate the code, while retaining explanations a future reader cannot infer from the implementation alone.

## Keep effects, errors and lifetimes explicit

Use the project's established IO and error abstractions. Validate at actual trust boundaries and respect established internal guarantees; do not add fallback branches for imagined states or remove a check without establishing the guarantee it enforces.

Make failures reach the caller responsible for handling them. Catch an error where there is meaningful recovery, translation or cleanup; do not turn a failed operation into apparent success merely to keep the main flow short. Keep error distinctions that callers rely on and avoid leaking unnecessary internal details through public interfaces.

Give mutable resources, subscriptions and background work a clear lifecycle owner. Make release and cancellation behavior traceable across success, failure and interruption. Before parallelizing work, establish independence and how results, partial failure and cleanup are handled. Avoid hidden shared state or unowned effects that require unrelated callers to coordinate implicitly.

Keep policy decisions separate from the mechanics that execute them when that distinction carries a real responsibility. Do not construct a framework or move every effect behind an interface merely to satisfy a slogan.

## Reuse and optimize for an actual need

Reuse shared knowledge with matching semantics. Similar expressions can serve different rules; a small amount of repetition can be clearer than a configuration-heavy abstraction. When consolidating, preserve caller-specific guarantees rather than retaining only the common expression.

Avoid repeated IO, redundant computation and unconditional no-op updates on relevant paths. Consider how often a path runs and the cost it creates before optimizing it. Do not add caches, mutable state, indirection or concurrency without accounting for consistency, ownership and actual benefit. Follow project-specific renderer and callback stability requirements where they apply.

## Complete the behavior and check the result

Use [Verification](verification.md) to check the required behavior and necessary existing guarantees at the appropriate boundary. Add or update tests when they protect a meaningful contract or failure mode; avoid tests that merely restate the implementation or compulsory tests for every new helper. Keep computation separable from effects when that improves the actual design and evidence, not by exposing internals solely for tests.

Inspect the resulting diff for unintended behavior, redundant state, unclear ownership and unnecessary machinery. Use [Review](review.md) for a substantive independent assessment; do not repeat a full review ceremony for every edit. Apply the entrypoint's completion criteria to the agreed outcome, not just the latest implementation step, and keep aesthetic rewrites outside the task.
