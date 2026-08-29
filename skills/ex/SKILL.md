---
name: ex
description: "Analyze a complex problem with a fixed thinking skeleton; analysis only, no code changes."
---

# ex — structured discussion skill

Analyze complex problems with a fixed thinking skeleton. **Output analysis only; do not modify code.**

## Entry: complexity check

When the question arrives, **first judge complexity**:

- **Simple problem** → answer directly, **do not apply the methodology** (KISS)
- **Complex problem** → run the full 6-step skeleton below

Treat as complex if any of these holds:
- Multiple candidate solutions need trade-off
- Multiple hypotheses need verification
- Spans multiple modules / systems / layers
- The user explicitly asks for deep discussion

## Methodology skeleton (complex problems only)

Run in order, **in one pass, without stopping to ask the user**:

```
1. Problem study   Clarify the problem itself through What / Why / How
2. Diverge         Enumerate candidate hypotheses, solutions, perspectives
3. Converge        Pick the top 1-3
4. Diverge again   Deep-dive into the chosen ones (details, risks, edge cases)
5. Iterate-verify  Verify key hypotheses via code search / web search / bash experiments
6. Summarize       Conclude; use a comparison matrix when multiple options sit side by side
```

### What / Why / How facets (cross-cutting)

- **What**: what is the problem / solution, what is the boundary
- **Why**: why does this problem exist, why pick this solution
- **How**: how to implement / land / verify it

## Execution rules

### Run once, never interrupt the user

- **Never call AskUserQuestion**
- When information is missing → explicitly mark **"⚠️ Pending: xxx"** and let the user follow up later
- Do not stop just because info is incomplete; push as far as the evidence allows

### Verification means

Allowed verification tools:

| Means | Tools | Use case |
|---|---|---|
| Code search | Grep / Read / Glob | Find in-repo evidence for hypotheses |
| Web search | WebSearch / WebFetch | Look up official docs and external material |
| Bash experiments | Bash | Run small commands, test scripts, curl |

**Forbidden**: verifying by asking the user via AskUserQuestion.

## Output rules

- **No mandatory output template** — organize by what the problem needs
- **Comparison matrix is optional** — use it only when multiple options / hypotheses must sit side by side
- Simple questions get short answers; do not over-frame for the sake of framing

## What this skill does NOT do

- ❌ Do not modify code (this is a discussion skill, not an implementation skill)
- ❌ Do not interrupt the user mid-flow (one-shot)
- ❌ Do not force a comparison matrix on every question
- ❌ Do not compete with `/qa` or `/fx` — the three are siblings, triggered explicitly by the user
