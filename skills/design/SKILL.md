---
name: design
description: "Produce a code-grounded technical design and implementation plan when an approach, material tradeoff, or execution sequence needs separate review. Use for requested technical design, not implementation; straightforward changes do not need a separate design stage."
---

Technical design mode: establish how the work fits the existing system, why the proposed solution holds, and how to implement and verify it. No implementation.

Input: a SPEC, agreed requirements, a document path, or the agreement in the current conversation. QA and SPEC are useful inputs, not required skill dependencies. This is an optional reviewable artifact, not a mandatory stage before coding. When invoked for a straightforward change, give a brief approach and checks rather than manufacturing a larger design exercise.

## Workflow

1. Extract confirmed behavior, constraints, acceptance criteria, and prior decisions. Reference them rather than rewriting the specification. Separate requirements from earlier implementation suggestions; do not silently turn suggestions into constraints. When revising a design or designing around an existing implementation, reconcile each established constraint: retain it, explicitly supersede it with an authorized decision, or explain with evidence why it no longer applies. Compression or already-implemented behavior is not a reason to silently omit a constraint; preserve it explicitly or by a precise source reference.
2. Read applicable repository instructions and identify the concrete unknowns that could change the approach. Investigate only the relevant code, contracts, callers, or tests needed to resolve them; reuse sufficient evidence already available in the conversation. Cite material facts by file or symbol and distinguish inspected behavior, inference, and unverified assumptions. Stop when further exploration would not affect the design or the next implementation step.
3. Judge the proposed concepts and state model: consistent meanings, legal states, invariants, lifecycles, resource ownership, and side effects where relevant. Place rules with their owner, keep things that change together close, and let independently changing concerns remain separate. When sharing a mechanism, preserve each caller's distinct policy and lifecycle; similar code alone does not establish a shared responsibility.
4. Compare existing code, standard-library and platform capabilities, and installed dependencies before introducing a new mechanism. For a proposed abstraction, identify the actual duplication, isolation need, or direction of change it addresses; weigh that benefit against new concepts, indirection, state, dependencies, and migration cost. Prefer a simple function, data structure, or existing mechanism when sufficient. Pattern names, file length, caller counts, and diff size alone do not establish design quality.
5. Before recommending replacement or consolidation, explain which existing responsibilities remain necessary, who takes them over, and which boundary paths could invalidate the proposal. A defect in the old mechanism does not prove the replacement works. Investigate technical unknowns with scoped read-only checks where possible. If necessary guarantees lack evidence, keep the proposal conditional and put validation before dependent replacement or deletion steps. Plan the resulting structure as well as the new behavior: identify obsolete rules and representations to retire, and define the scope and exit conditions for any temporary coexistence. Keep cleanup within the task and its direct effects.
6. Emit the DESIGN using the structure below. Resolve technical choices using code evidence and repository conventions, stating consequential tradeoffs. Ask the user only when a choice needs their preference or commitment about goals, behavior, scope, compatibility, or cost; complexity alone is not a reason to ask. Make progress on independent parts and mark sections affected by open decisions provisional; do not reinterpret confirmed behavior to make a design easier.
7. Check the design against the requirements and actual code, then stop. Do not edit application code, install dependencies, run migrations, deploy, send messages, or start implementation agents. A design does not authorize execution of its steps.

## Output structure

Use the following section order for a stable, reviewable DESIGN, matching the SPEC style. Omit sections that add no useful information; merge short related sections under the first applicable heading while preserving the overall order. Match the user's language and repository document conventions.

```text
## Context          goal, source requirements, confirmed constraints and decisions;
                    reference the SPEC where available, do not repeat it
## Current          relevant responsibilities, data flow, contracts, and guarantees;
                    cite code, callers, and tests that establish them
## Approach         chosen design, ownership, boundaries, and end-to-end flow;
                    distinguish reused, changed, new, and retired behavior
## Alternatives     material alternatives and why the recommended design wins;
                    include the cost and limits, omit ceremonial comparisons
## Changes          affected modules and contracts, data/state transitions,
                    error and concurrency handling only where relevant
## Migration        compatibility, data migration, transition and cleanup,
                    rollout and recovery only when required by this change
## Implementation   ordered steps (S1…); each has an outcome, affected modules,
                    dependencies, and a completion check
## Verification     map acceptance criteria and preserved guarantees to checks;
                    identify existing coverage, needed tests and manual validation
## Risks            consequential assumptions, technical unknowns, evidence gaps,
                    and how and when to resolve them before dependent work
## Decisions        unresolved choices requiring the user, with recommendations
```

Scale the detail to the work; the section list is not a requirement to write ten chapters. A small change may need only Approach, Implementation, and Verification in a few paragraphs. Do not invent abstractions, interfaces, migrations, alternatives, or a file-by-file checklist to fill sections. For a new project, mark the existing-code baseline absent and ground the design in supplied constraints and verified platform contracts instead.

Write for skimming: each decision has one home; reference rule and acceptance IDs supplied by the SPEC. Include signatures, data shapes, diagrams, or pseudocode only when they resolve an implementation ambiguity. Steps must describe concrete outcomes and dependency order, not generic phases such as "implement backend" or line-by-line editing instructions. Leave low-risk local details to implementation; specify them now only when they affect feasibility, contracts, sequencing, or verification. Keep technical design and implementation steps together so their assumptions and verification remain connected.

## Decisions

Use the QA-style condensed decision record. Number questions so the user can reply with letters alone. Do not re-ask answered questions or add a generic approval gate. Technical uncertainty that can be investigated is not a user preference question.

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
## Changed     <section/step>: <old> → <new>; answered decisions as
               <chose X over Y> — <to achieve …>, accepting <cost>
## New         newly exposed assumptions, dependencies, or decisions, if any
## Open        still-open decision records; none → state that none remain
```

Update dependent steps and verification when a design decision changes. Do not treat an answer as authorization to implement. When asked for a complete or final DESIGN, consolidate accepted changes into one self-contained document, removing resolved questions and obsolete alternatives.

Default to delivering in conversation. If the user requests a saved artifact, use their path or the repository's established technical-design location; ask for a destination only if neither is available. Updating the requested DESIGN is allowed; unrelated repository edits are not. Report the saved path. Do not create commits or branches unless requested.

## Verification

Before delivering, check that:

- The approach covers the confirmed in-scope behavior and identifies where it belongs and how it will be checked; requirements were not silently changed or expanded.
- Earlier constraints and decisions remain traceable in the revised design, directly or by precise reference. Any replacement or retirement has a stated basis; implemented constraints still have a verification path rather than disappearing from the design.
- Material claims about existing code and contracts have evidence; proposed behavior and unverified assumptions are labeled.
- Concepts, legal states, lifecycles, and ownership are coherent where affected; shared mechanisms preserve callers' distinct semantics.
- New boundaries and abstractions address demonstrated needs with stated costs; any replaced mechanism's necessary guarantees have an evidenced successor, or the recommendation and dependent steps remain conditional.
- The planned final structure retires obsolete expressions; temporary coexistence has a scope and exit condition. Structural cleanup stays within the task and does not replace behavioral verification.
- Implementation order follows actual dependencies; unresolved prerequisites are visible before the steps that rely on them.
- Verification covers changed behavior and relevant preserved guarantees, with planned checks distinguished from checks actually run.
- The next implementation step is clear and supported by enough evidence. High-risk unknowns have an explicit validation point before dependent work; low-risk details may remain for implementation. Do not imply that all uncertainty is resolved or that a design proves the feature works.
