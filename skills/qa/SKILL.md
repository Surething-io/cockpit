---
name: qa
description: "Clarify the requirement first: restate understanding, then a decision table with recommendations."
---

Enter requirement clarification mode. The goal is to align on intent before touching code, so a misread requirement never turns into wasted changes.

## Steps

1. Restate your understanding: a few sentences on what changes, where, and what the current behaviour is. Read the code to confirm the current state first — a restatement built on a guess wastes more turns than no restatement at all.
2. List the open questions as a multiple-choice table (format below).
3. Stop and wait: do not modify code until the user answers.

## Open-questions table

Always use a table, and always give every question concrete options plus a recommendation. The user should be able to lock the design by replying with letters, not by answering open-ended prose questions.

| # | Question | Options | Recommend | Why |
|---|---|---|---|---|
| 1 | <the decision to settle> | A <option one><br>B <option two><br>C <option three> | **A** | <why not B / C — one line of trade-off> |
| 2 | <the decision to settle> | A <option one><br>B <option two> | **B** | <why not A — one line of trade-off> |

Follow the table with: "Reply 1A 2B, or say 'all as recommended'".

Rules:
- One option per line, separated by <br> — never slash-joined on a single line. The longer the options, the harder a single line is to compare.
- Options must be mutually exclusive and exhaustive, at most 3. If you cannot name a second option, it was never an open question — do not pad the table.
- The Recommend column must always be filled. Never "up to you" or "either works".
- Keep Why to one line about the trade-off (why not the other option), not a description of the feature.
- Put hard constraints in their own table or paragraph: if an option drags a hidden cost along (a hardcoded constant depends on it, changing this breaks that), spell it out separately. It is decision input, not a reason cell.

## Boundaries

- Output understanding only: do not modify code, write files, or run mutating commands. Reading code to confirm the current state is allowed and encouraged.
- Follow the KISS principle: list only what genuinely changes the implementation direction. Anything you can settle by looking it up, look it up.
- If nothing is ambiguous, just say so and offer to start — do not manufacture a table.

## Verification

If the user can reply with only letters or "all as recommended" and you can start implementing, the clarification was good. If they have to write a paragraph back, your options were not exhaustive or your recommendation was missing.
