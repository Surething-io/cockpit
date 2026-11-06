# Verification — Match Claims to Observable Evidence

Use this guide to check a claimed outcome, feature or fix, and to support completion after implementation. The entrypoint governs whether the task is assessment or also authorizes repairs. Verification findings do not independently grant permission to modify the application.

## Define what could fail

Translate the user outcome or stated claim into expected observable behavior. Establish the actual changed range when relevant and compare its effects with the claim. Read the affected contracts, existing tests and project commands as needed. Distinguish intended behavior from an assumption inferred from a PR description or an implementation's self-report.

Choose the boundary at which the claim could fail: a user interaction, API response, command, public package export, generated artifact or agent behavior. Do not substitute an internal-function probe for a claim about the complete user flow. For a bug fix, reproduce the original failure when feasible, exercise the repair and check necessary related behavior.

## Choose proportionate evidence

Use meaningful existing tests, builds and static checks where they support the change and the project requires them. Check what already ran and what it covered; do not assume CI passed, rerun everything ceremonially or ban useful tests. Reading a passing test or relying on an implementer's report is not the same as independently observing its result.

For runtime claims, reach the relevant real interface and compare output with expectations. Passing pieces in isolation may miss their integration. For a purely static document or type change, use the appropriate content, contract or build evidence rather than forcing a browser or a runtime demonstration that cannot exercise it.

Choose counterexamples from the actual risk: changed error paths, malformed or boundary inputs, repeated operations, concurrent state changes, interruption, stale persistence or adjacent unaffected behavior. Do not impose one probe per file or an exhaustive catalogue. Inspect mocks and substitutes for assumptions that bypass the boundary being claimed.

## Exercise the relevant surface

- **UI:** drive the affected user interaction and inspect the visible state and relevant errors. API calls alone do not establish that a button or navigation path works.
- **CLI:** invoke the public command with representative arguments or stdin; check stdout, stderr, exit status and resulting files/state. Preserve necessary behavior of existing flags and isolate destructive effects.
- **Server/API:** reach the changed route and branch; check status, relevant headers, body and persistence as appropriate, not just a successful status code. Confirm readiness and that the intended path actually executed.
- **Library:** exercise the public consumer boundary and relevant exported contracts rather than reaching into implementation internals to prove integration.
- **Prompt or skill:** use realistic inputs and context, observe resulting decisions/actions and inspect artifacts. Matching phrases or passing frontmatter validation does not prove collaboration behavior.

Use available project launch and verification methods. Isolate test data, ports, processes and persistent state; preserve live user work and clean up resources you created. Do not change dependencies, configuration or verifier infrastructure merely to execute a check without assessing that scope. If an environment or stale harness blocks observation, identify the specific blocker and distinguish it from an application defect.

## State only what the evidence supports

Capture enough command output, responses, observations or artifact locations to make the important result reviewable. Report what ran, expected versus observed behavior, the supported conclusion and material limits. Never claim a command ran or an interface was exercised when it was not.

Before reporting failure, check whether another part of the flow handles the case or the behavior is intentional. Before reporting success, check whether the evidence covered the actual outcome and necessary preserved guarantees. Uncertainty is an evidence gap to resolve or disclose, not an automatic PASS or FAIL. Keep unrelated discoveries separate from the verdict on the requested change.

Stop when evidence is sufficient for the requested claim and risk. If authorized implementation remains incomplete or caused a regression, continue resolving it; otherwise deliver the assessment without an automatic repair cycle.
