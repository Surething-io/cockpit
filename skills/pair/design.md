# Design — Make the Model and Responsibilities Fit

Use this guide when choosing domain concepts, data and state models, responsibilities, interfaces, dependencies or design patterns. Design can be the whole conversation; it does not require a project plan or authorize implementation. The entrypoint governs scope.

## Ground the design in the behavior

Identify the intended outcome and necessary guarantees, then inspect the existing implementation and affected callers. Use a concrete scenario to connect the proposed model to observable behavior. Distinguish required behavior from an implementation assumption or a hypothetical future extension.

Consider existing functions, native capabilities and dependencies before designing a replacement. Verify semantic and boundary fit rather than choosing reuse from a similar name. Compare meaningful alternatives on correctness, ownership, compatibility and total change cost. A bounded repair or keeping the current design can be appropriate.

## Choose concepts, state and boundaries

Make names, data structures and legal states express the domain. Distinguish concepts with different rules or lifecycles even when their representations look similar. Prefer one authoritative representation of the same fact and derive other views where practical; make unavoidable synchronization and transitions explicit.

Give each rule and resource a clear owner. Define interfaces around what a caller needs to accomplish and the guarantees it can rely on, hiding details likely to change independently. Keep policy and side-effect dependencies visible. Extract a boundary when it isolates a real responsibility or source of change, rather than adding forwarding layers for symmetry.

## Preserve responsibilities through change


Look for concrete pressure: scattered business knowledge, contradictory state, recurring exceptions, leaked details, unclear ownership or changes that require unrelated modules to coordinate. Examine the underlying concepts and legal states rather than treating each symptom as an independent branch to add.

For a substantial removal, consolidation or replacement, establish:

- What the current mechanism is responsible for and which guarantees remain necessary.
- How a bounded repair or replacement meets those responsibilities, including who owns them afterward.
- What code, contracts or observations support that transfer, and what boundary paths could invalidate it.
- Which unknowns remain and how they affect the strength of the recommendation.

Finding a defect in the old implementation does not prove a candidate replacement works. Resolve technical uncertainty through focused investigation or verification. If the evidence is incomplete, keep the proposal conditional and identify the next check; do not make removal of the old mechanism an unconditional action. Clarify a genuine conflict in the user's goals or constraints before implementing around it.

Prefer clear concepts, explicit state and meaningful boundaries. Unify the same knowledge without forcing different policies or lifecycles into one configurable mechanism. An interface with one implementation, a function with one caller, a long file or a small diff does not by itself establish design quality or a defect.

## Select patterns when they earn their place

When pattern selection is requested or actual design pressure warrants it, compare the proposed pattern with ordinary functions, data structures, composition and existing mechanisms. Explain which concrete change becomes easier and weigh added concepts, indirection, dependencies, debugging and migration cost. Do not require a pattern tour or translate class diagrams mechanically into the project language.

For example, independently replaceable rules may justify a strategy; an external interface may need an adapter; scattered transitions may need an explicit state model without state classes. Clear fixed branches can remain sufficient. Retain existing patterns with real responsibilities and simplify ones whose purpose has disappeared.

Respect an explicitly chosen pattern or ordinary style preference. Raise an alternative when concrete correctness risks or necessary guarantees conflict with it, explaining the evidence and a way to preserve the intended outcome.

## Deliver the design decision

Explain the recommended model, responsibility boundaries and the concrete behavior it supports. Include material tradeoffs, applicability limits and unresolved evidence. Use a small example or diagram where relationships carry the decision; keep it consistent with the actual dependencies and guarantees.

A design recommendation is ready when necessary responsibilities have a supported owner and its conditions are clear. Use [Planning](planning.md) when sequencing work is itself a meaningful problem and [Coding](coding.md) when translating the chosen design into implementation. Do not add either as a mandatory ceremony for a local decision.
