# Exploration — Establish What the Code Does

Use this guide to locate behavior, understand a module or investigate relevant code relationships. Exploration can be the whole task; it does not imply a defect, redesign or implementation. The entrypoint governs action scope.

## Find the evidence

Start from the question and what is already known. Read an explicitly identified file; otherwise search likely names, behavior, configuration and relevant entrypoints. If the first search fails, vary terminology and locations rather than concluding the implementation is absent. Use definitions and references where available.

Follow the relevant execution and data path: inputs, decision owners, state transitions, persistence or external effects, and the output the caller observes. Read project conventions, tests and documentation when they explain a contract or non-obvious constraint. Check callers and related entrypoints when a local reading would leave a material assumption unresolved. Do not map the whole repository for a local question.

Separate the current implementation from comments, names, intended behavior and historical context. A test shows an expectation; a code reading shows a mechanism; runtime observation establishes what happened in the conditions exercised. Identify which kind of evidence supports the answer.

## Investigate a suspected defect

Establish expected versus observed behavior before naming a cause. Trace the path that can produce the symptom and check relevant upstream guarantees and downstream handling. Distinguish an observed break from an explanation still to test. Seek evidence that differentiates plausible causes rather than accumulating speculative defensive patches.

Use onset, affected users or inputs, recent code changes, configuration, dependency versions and environment differences to narrow plausible causes. Inspect exact errors and relevant logs where available. A recent change is a lead to test, not proof of causation; check whether it can produce the observed failure and what evidence would distinguish it from alternatives.

When observation is needed, use the verification guide for the relevant interface. Use [Design](design.md) for modelling, responsibility or interface decisions, and [Planning](planning.md) for work sequencing and dependencies. Do not declare a timing problem from intermittency alone or change code merely to make a hypothesis look plausible.

## Deliver the useful understanding

Answer with the relevant locations, relationships and uncertainties. A short path or diagram can explain how the pieces connect; show actual call or data-dependency edges and distinguish evaluation order from nested calls. Keep diagrams consistent with the implementation and prose rather than reciting every file read. Match confidence to coverage and identify a focused next observation when evidence is missing.

Finish when the current question has a supported answer. If the requested work is exploratory, recommendations remain advice; optional improvements are not part of the discovery task by default.
