# Security Review — Evaluate a Concrete Trust Boundary

Use this guide for a requested security assessment or a material security question in the current task. Apply ordinary secure implementation throughout; do not turn every code review into a comprehensive security audit. The entrypoint and active host govern scope and authorized actions.

## Understand the actual threat model

Identify who can influence the relevant inputs, what is trusted, which sensitive operation or data is involved, and where authority changes. Read current protections, established security mechanisms and the affected code paths. Compare the change with the existing boundary rather than assuming that a deviation is a vulnerability or that an existing convention is safe.

Trace a candidate issue from an actor-controlled input through transformations and checks to an observable security consequence. Depending on the question, consider injection, path traversal, unsafe evaluation/deserialization, authentication, authorization, session handling, sensitive data exposure, cryptographic misuse and resource effects. Use the applicable threat model, not a mandatory category sweep.

## Establish impact and counterevidence

Explain the required conditions, the boundary crossed and the consequence. Check upstream checks, escaping or parameterization, downstream restrictions and whether the proposed attacker actually controls the relevant value. Distinguish a concrete vulnerability from a hardening opportunity or an assumption requiring further investigation.

Do not import blanket exemptions for a language, framework, file type, local deployment, environment variable, UUID or vulnerability category. Such properties can affect exploitability but do not establish it. Likewise, the absence of an optional best practice is not enough to prove a defect.

Use non-destructive verification where it adds necessary confidence and is authorized. Source reasoning can establish an attack path without executing an exploit; state what is observed versus inferred. Do not access unrelated secrets, weaken safeguards, test external targets or send findings elsewhere merely because the topic is security.

## Report proportionately

For a supported finding, give the location, trigger or attack path, material impact, relevant conditions and a bounded remediation direction. Make severity reflect the actual consequence and prerequisites rather than an unsupported number. Identify evidence gaps as such instead of forcing a confident verdict.

Distinguish effects introduced by the change from existing issues and explain their relevance to the agreed task. A finding does not automatically authorize a repair or a broader audit. If no material issue is supported within the inspected scope, say so and state meaningful coverage limits.
