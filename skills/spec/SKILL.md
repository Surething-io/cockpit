---
name: spec
description: "Turn agreed requirements or a QA brief into an implementation-ready specification: behavior, contracts, boundaries, acceptance, and only the decisions that need the user. Use when asked to write or refine a SPEC, not to implement it."
---

Specification mode: make agreed intent precise enough that development and testing do not have to invent product rules. Design only as far as the work needs. No implementation.

Input: a requirement, QA result, document path, or the agreement in the current conversation. QA is useful input, not a required skill dependency.

## Workflow

1. Extract confirmed requirements and decisions from the supplied sources and conversation. Keep current behavior, requested behavior, and proposed choices distinct; never present a recommendation as an agreement.
2. Read applicable repository instructions. Inspect only the existing contracts, flows, and code needed to verify specific integration assumptions. Prefer named files and targeted searches; stop exploring once the specification has enough evidence. Cite material facts by source or path; label anything unverified.
3. Resolve contradictions using explicit user corrections and confirmed decisions. If material sources still disagree, expose the conflict as a decision rather than silently choosing. Preserve earlier decisions unless new information actually invalidates them.
4. Emit the SPEC using the structure below. Make useful progress even with open decisions; mark affected sections provisional. Ask only for choices that change product behavior, scope, compatibility, cost, or an important tradeoff. Choose routine implementation details using repository conventions and record consequential assumptions.
5. Check completeness and consistency, then stop. Do not write application code, run migrations, deploy, send messages, or start implementation agents.

## Output structure

Use fixed sections in this order; omit empty sections. Match the user's language and the repository's document conventions.

```text
## Context          problem, goal, sources, verified current behavior; keep brief
## Scope            In / Out; affected actors, entry points, and surfaces
## Behavior         numbered rules (R1…); eligibility, ordering, states, transitions,
                    boundary conditions, and invariants relevant to this feature
## Interaction      entry → action → visible result; loading, empty, error, and
                    recovery states where relevant; reference supplied designs
## Contracts        affected interfaces and data; ownership, authorization,
                    validation, compatibility, and errors where relevant
## Design           proposed integration and responsibility boundaries; persistence,
                    concurrency, retries, and external dependencies only if needed
## Acceptance       scenarios (AC1…) linked to rules; precondition/action/expected
                    outcome, with verification method and external evidence needed
## Delivery         migration, configuration, rollout, and rollback requirements
                    only when this change needs them; distinguish release blockers
## Assumptions      unconfirmed defaults that materially affect what gets built
## Decisions        unresolved choices requiring the user, with recommendations
```

Scale to the work. A small UI change may need only Context, Scope, Interaction, and Acceptance. Do not manufacture APIs, data models, infrastructure, or deployment work to fill sections. When repository rules make a contract authoritative, reference it and specify the required changes rather than creating a competing source of truth.

Write for skimming: each rule has one home; use IDs to reference it elsewhere. Tables help compare states or outcomes. Include technical detail only when it closes an implementation gap or explains a tradeoff. Avoid line-by-line coding plans and speculative future extensibility.

## Decisions

Use the QA-style condensed decision record. Number questions so the user can reply with letters alone. Do not re-ask answered questions or add a generic approval gate.

**1. <question>**

```text
Drivers: <1–3 criteria>
A ★ <option>
    + <gain>
    - <cost>
B   <option>
    + <gain>
    - <cost>

★ A — <recommendation justified by the drivers>
```

Options must be mutually exclusive and cover the meaningful alternatives, at most three. End with “Reply 1A 2B, 'all as recommended', or correct anything above.” only when decisions remain.

## Follow-up and saving

On answers or corrections, emit only the delta:

```text
## Changed     <section/rule>: <old> → <new>; answered decisions as
               <chose X over Y> — <to achieve …>, accepting <cost>
## New         newly exposed assumptions or decisions, if any
## Open        still-open decision records; none → state that none remain
```

Do not treat an answer as authorization to implement. When asked for a complete or final SPEC, consolidate all accepted changes into one self-contained document, removing resolved questions and obsolete alternatives.

Default to delivering in conversation. If the user requests a saved artifact, use their path or the repository's established SPEC location; ask for a destination only if neither is available. Updating the requested SPEC is allowed; unrelated repository edits are not. Report the saved path. Do not create commits or branches unless requested.

## Verification

Before delivering, check that:

- Every confirmed in-scope requirement has an observable acceptance outcome; implementation suggestions are not reported as requirements.
- Relevant failure and boundary cases have explicit outcomes, especially conflicting actions, permission boundaries, time cutoffs, and external failures.
- Rules, interaction, contracts, design, and acceptance agree; no invented current behavior, template identifiers, credentials, or delivery guarantees.
- External configuration or real-device validation remains explicitly pending until evidenced; writing a SPEC does not prove a feature works.
- Material unknowns are visible, resolved decisions stay resolved, and no session-specific product details have leaked into this reusable workflow.
