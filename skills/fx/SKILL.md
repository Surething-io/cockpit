---
name: fx
description: "Trace a bug to its root cause through a cited evidence chain, then fix options; analysis only, no code changes."
argument-hint: "[symptom / error / repro]"
---

Bug evidence chain analysis mode: find why it breaks, prove it, and lay out the fixes. No code changes.

```
emit a lean RCA, fixed sections in this order, empty ones omitted:
    ## Symptom       what the user sees, expected vs actual           # ≤ 3 bullets
    ## Repro         the shortest steps or input that trigger it; "not reproduced" if so
    ## Evidence      the chain from symptom back to cause, one link per line:
                         <claim> — <file:line | log line | command output>
    ## Root cause    one sentence; the link where a fix removes the whole chain
    ## Blast radius  other callers / paths that share the cause
    ## Fix options   decision blocks (below)
    ## Verify        how to prove the fix: the check that fails now and passes after
stop                                        # no code edits, no mutating commands
on reply: dig where the user points, then emit only the delta, never the unchanged RCA:
    ## New evidence  links added to the chain, same cited form
    ## Changed       each edit as <section>: <old> → <new>; a changed root cause goes first
    ## Open          what is still unproven or undecided
```

Every evidence link cites something the user can open. A link you inferred but did not observe is marked `(hypothesis)` along with the check that would confirm it — never present a guess as a finding. If the chain has a gap, say where it breaks instead of bridging it.

Root cause, not the first suspicious line: keep asking why until the next answer is outside the code (a requirement, an external system) or the fix at that link makes every symptom above it impossible.

Written for skimming: every bullet one line, each fact stated once in the section it belongs to.

**Fix options** — a condensed MADR record: the question as a bold title, then a fenced text block with the decision drivers, the options, and the recommendation last:

**1. <what to fix>**

```
Drivers: <criterion> · <criterion>
A ★ <option — where it cuts the chain>
    + <gain>
    - <cost>
B   <option>
    + <gain>
    - <cost>

★ A — <why, in terms of the drivers, one line>
```

- Options mutually exclusive, at most 3. A symptom patch is allowed as an option only if labelled as one.
- Drivers: the 1-3 criteria this choice turns on. ★ is always given, never "up to you", and argued from them.
- End with: "Reply 1A, 'as recommended', or point at a link in the chain to dig further."
