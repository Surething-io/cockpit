# Documentation — Help the Reader Complete the Task

Use this guide to write, review or maintain technical documentation. Apply the entrypoint's target, scope and authorization rules. Use [Learning](learning.md) for conversational explanations; a request to understand code does not itself require a saved document.

## Establish the reader and purpose

Identify who will use the document, what they need to accomplish and what knowledge or access it assumes. Read the relevant implementation, existing documentation and project conventions before drafting. Choose an existing location and format when they serve the task; ask about audience or destination only when a consequential ambiguity remains.

Lead with what the reader needs to act or decide. Select content by purpose rather than filling every possible section:

- **README or quick start:** purpose, prerequisites, a short path to a useful result, and relevant configuration or further guidance.
- **API reference:** actual inputs, outputs, authentication, errors and applicable pagination, limits or compatibility behavior, with representative examples.
- **Runbook:** when it applies, required access, actionable steps, expected observations, recovery or rollback where meaningful, and the project's escalation path when one exists.
- **Architecture or onboarding:** context, responsibilities, important connections and decisions, plus the walkthroughs or tradeoffs the intended reader needs.

Do not invent a support process, operating policy or formal template merely to complete the document.

## Ground instructions and examples

Check names, paths, commands, flags, configuration and request/response examples against their actual source. Distinguish current behavior from proposals or intended behavior. Make required setup and consequential side effects clear before the step that depends on them; use explicit placeholders for credentials and environment-specific values.

Use [Verification](verification.md) to check executable examples or generated output where useful and permitted. Test with isolated data and respect action boundaries; documenting a deployment or destructive command does not authorize running it. If an example cannot be exercised, disclose the material limit instead of claiming it was tested.

## Keep one maintained explanation

Update the existing authoritative explanation and directly affected examples or links. Reference shared definitions instead of copying them into multiple documents; preserve necessary context so links do not make the page unusable. Check affected references when moving or renaming a section or file.

Keep the change focused on the requested behavior and readers. Remove confirmed-stale claims, preserve useful rationale and avoid generating parallel READMEs, process logs or design records without a clear need. Match the project's language and terminology.

Finish when the requested information is accurate, findable and usable for its intended task. Report the changed locations and relevant verification limits; a document review can conclude that no edit is needed.
