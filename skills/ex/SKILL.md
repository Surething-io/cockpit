---
name: ex
description: "Deep analysis of a complex question in one pass: answer first, then cited findings, options and open points; no code changes."
argument-hint: "[question]"
---

Deep analysis mode: take a complex question to a conclusion in one pass, backed by evidence. No code changes, and do not stop to ask the user — mark what is missing and keep going.

```
if simple(question): answer directly, skip everything below

think (not emitted): what / why / how → diverge on hypotheses and candidates
                     → converge on the top 1-3 → dig into them → verify the key claims
verify by: reading and searching code · official docs and web · small commands and experiments

emit, answer first, empty sections omitted:
    ## Answer      the bottom line, 1-3 sentences
    <view>         only if it helps: solution skeleton (how-to) · comparison matrix (A vs B)
                   · call chain / data flow (why it works this way)
    ## Findings    what supports the answer, one line each — <claim> — <file:line | link | output>
    ## Options     only when there is a choice to make: decision blocks (below)
    ## Risks       only when there are any
    ## Pending     what is missing — and which conclusion it would change

on follow-up: dig into what was asked, then emit only the delta, never the unchanged analysis:
    ## Changed     each edit as <section>: <old> → <new>; a changed Answer goes first
    ## New         findings, options or risks the follow-up added
    ## Pending     what is still missing
```

`simple` = one clear answer, no trade-off, no hypothesis to test, one module. Anything spanning systems, needing a choice, or explicitly asked to go deep is complex.

Findings you inferred but did not verify are marked `(hypothesis)` with the check that would confirm them. A solution skeleton shows the parts and how they connect at the level a decision is made on; drop every line whose removal would not change that decision.

Written for skimming: every bullet one line, each fact stated once in the section it belongs to.

**Options** — a condensed MADR record: the question as a bold title, then a fenced text block with the decision drivers, the options, and the recommendation last:

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

Options mutually exclusive, at most 3. ★ is always given, never "up to you", and argued from the drivers.
