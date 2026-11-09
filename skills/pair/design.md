# Design — Make the Model and Responsibilities Fit

Use this guide when choosing domain concepts, data and state models, responsibilities, interfaces, dependencies or design patterns. Design can be the whole conversation; it does not require a project plan or authorize implementation. The entrypoint governs scope.

## Ground the design in the behavior

Identify the intended outcome and necessary guarantees, then inspect the existing implementation and affected callers. Use a concrete scenario to connect the proposed model to observable behavior. Distinguish required behavior from an implementation assumption or a hypothetical future extension.

Identify conditions that could change the decision: expected data volume and concurrency, latency, availability, recovery needs, cost, delivery time and team capabilities. Distinguish required constraints from objectives open to tradeoffs; keep estimates and unknowns visible. Include the effort to understand, diagnose and safely change the design in its maintenance cost. A local feature need not acquire distributed-system requirements, caches or queues merely because those are common design topics.

Consider existing functions, native capabilities and dependencies before designing a replacement. Verify semantic and boundary fit rather than choosing reuse from a similar name. Compare meaningful alternatives on correctness, ownership, compatibility and total change cost. A bounded repair or keeping the current design can be appropriate.

## Choose concepts, state and boundaries

Make names, data structures and legal states express the domain. Distinguish concepts with different rules or lifecycles even when their representations look similar. Prefer one authoritative representation of the same fact and derive other views where practical; make unavoidable synchronization and transitions explicit.

Give each rule and resource a clear owner. Define interfaces around what a caller needs to accomplish and the guarantees it can rely on, hiding details likely to change independently. Keep policy and side-effect dependencies visible. Extract a boundary when it isolates a real responsibility or source of change, rather than adding forwarding layers for symmetry.

## Preserve responsibilities through change

Look for concrete pressure: scattered business knowledge, contradictory state, recurring exceptions, leaked details, unclear ownership or changes that require unrelated modules to coordinate. Examine the underlying concepts and legal states rather than treating each symptom as an independent branch to add.

When a change affects the meaning of state, responsibility, observable completion or data lifetime, assess the affected guarantees regardless of patch size or whether a mechanism is added, modified or removed. Establish:

- Which necessary behaviors are affected.
- Who will enforce them, using which information, and what code, contracts or observations support that decision.
- Which existing mechanisms are replaced or remain, and how any coexistence avoids conflicting decisions or bypasses.
- Which unknowns remain and how they affect the strength of the recommendation.

When a decision relies on a flag, observation or stored evidence, establish exactly what it proves, for which object and version or lifetime. Distinguish unavailable evidence from a negative result. Retain enough information for necessary later decisions without assuming that more retained state is always better.

Finding a defect in the old implementation does not prove a candidate works. Resolve consequential uncertainty through focused investigation or [Verification](verification.md). Keep unsupported conditions and the next check explicit; do not recommend an unconditional change whose correctness depends on them. Apply the entrypoint's scope and constraint rules when a conflict remains.

Prefer clear concepts, explicit state and meaningful boundaries. Unify the same knowledge without forcing different policies or lifecycles into one configurable mechanism. An interface with one implementation, a function with one caller, a long file or a small diff does not by itself establish design quality or a defect.

## Select patterns when they earn their place

When pattern selection is requested or actual design pressure warrants it, compare the proposed pattern with ordinary functions, data structures, composition and existing mechanisms. Explain which concrete change becomes easier and weigh added concepts, indirection, dependencies, debugging and migration cost. Do not require a pattern tour or translate class diagrams mechanically into the project language.

For example, independently replaceable rules may justify a strategy; an external interface may need an adapter; scattered transitions may need an explicit state model without state classes. Clear fixed branches can remain sufficient. Retain existing patterns with real responsibilities and simplify ones whose purpose has disappeared.

Respect an explicitly chosen pattern or ordinary style preference. Raise an alternative when concrete correctness risks or necessary guarantees conflict with it, explaining the evidence and a way to preserve the intended outcome.

## Deliver the design decision

Explain the recommended model, responsibility boundaries and supported behavior, including the key causal relationships, assumptions and tradeoffs a maintainer needs. Use existing code structure and documentation where sufficient; do not require exhaustive user specifications, line-by-line explanations or duplicate documents. A small example or diagram can clarify relationships; keep it consistent with actual dependencies and guarantees.

For consequential choices under uncertainty, compare benefits and costs in the current context, the consequences of wrong assumptions, reversibility, migration burden and the ability to detect and recover from failure. Identify observable conditions that would justify revisiting the decision. Preserving options also has a cost: do not add abstractions or operational machinery solely for hypothetical futures. Use the project's ADR format when requested or required; an ordinary design discussion can stay in the conversation.

A design recommendation is ready when the affected responsibilities have supported owners and the proposal's conditions and evidence limits are clear. This establishes a recommendation, not verified implementation. Use [Planning](planning.md) when sequencing work matters and [Coding](coding.md) when implementing; neither is a mandatory ceremony for a local decision.
