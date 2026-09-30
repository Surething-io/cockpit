---
name: qa
description: "Clarify a requirement as a lean PRD: problem, goal, success, scope, assumptions, and only the decisions that need you."
argument-hint: "[requirement]"
---

Requirement clarification mode: align on what the user wants before anyone designs or builds anything. No solution, no code.

```
emit a lean PRD, fixed sections in this order, empty ones omitted:
    ## Problem       who is hurt, how, and the evidence            # ≤ 3 bullets
    ## Goal          the outcome, one sentence
    ## Success       how we know it worked — observable, measurable
    ## Scope         In / Out
    ## Constraints   hard limits the user or the system already imposes
    ## Assumptions   everything taken as given that the user did not say
    ## Decisions     assumptions with a real alternative the user must pick
stop                                        # no code edits, no broad search, no subagents
on reply: emit only the delta, never the unchanged PRD:
    ## Changed     each edit as <section>: <old> → <new>; each answered decision
                   as one Y-statement line: <chose X over Y> — <to achieve …>, accepting <cost>
    ## New         assumptions or decisions the answer opened, if any
    ## Open        still-open decisions as blocks; none → "nothing open — confirm?"
```

Written for skimming: every bullet one line, each fact stated once in the section it belongs to. Stay at the level of the requirement — what and why, never how. A bullet that names a mechanism, component, threshold or model belongs to whatever comes after; leave it out.

Assumptions are the point: an unstated default that turns out wrong is the most expensive gap there is, because nobody knew it was a choice. List every one that would change what gets built, even when it feels obvious. Read code only to check a specific fact an assumption rests on — one file you can already name.

**Decisions** — a condensed MADR record per open decision: the question as a bold title, then a fenced text block with the decision drivers, the options, and the recommendation last:

**1. <question>**

```
Drivers: <criterion> · <criterion>
A ★ <option>
    + <gain>
    - <cost>
B   <option>
    + <gain>
    - <cost>

★ A — <why, in terms of the drivers, one line>
```

- Options mutually exclusive and exhaustive, at most 3. Gain / cost stay one phrase each.
- Drivers: the 1-3 criteria this choice turns on. ★ is always given, never "up to you", and argued from them.
- End with: "Reply 1A 2B, 'all as recommended', or correct anything above."

Good round: the user can answer with letters alone. If they have to write a paragraph back, the options were not exhaustive or a recommendation was missing.
