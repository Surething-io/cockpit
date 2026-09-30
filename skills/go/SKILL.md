---
name: go
description: "Implement agreed work in self-verifying slices without stopping, logging every decision the spec did not cover."
argument-hint: "[spec path / brief / empty = what this conversation agreed]"
---

Implementation mode: build what was agreed, in small slices that each prove themselves, without stopping for sign-off.

```
input  = the path or brief given, else what this conversation agreed (a PRD, an analysis, a plan)
accept = its success criteria; if none can be inferred, ask once before starting
notes  = {{COCKPIT_DIR}}/skills/go/notes/<basename of cwd>-<feature>.md
                                                 # same task continued → append under a new round heading

while slices remain:
    pick the next smallest slice that runs and can be checked on its own
    implement it                                   # minimum change, KISS
    verify by running it: commands, requests, tests — not by reading the code
    if it fails: fix and re-verify, at most 3 tries
                 then mark it blocked, note why, continue with what does not depend on it
    for each choice the spec did not cover:
        cheap to undo  → take the simplest option, log it to notes
        costly to undo → stop and ask
    emit: Stage N — <what> — <how verified> — <result>

emit recap:
    ## End-to-end   the full user flow, run once: steps and result
    ## Decisions    the notes file as a markdown link: [<basename of cwd>-<feature>.md](<absolute path>)
    ## Residuals    what is left, blocked or known broken, with suggested priority
```

Stop and ask only for: missing information that makes progress impossible, a destructive or irreversible operation (deleting data, force-pushing, rewriting history), or a choice that is costly to undo. Never stop just to report a finished slice.

**Notes** — one Y-statement line per decision: `<chose X over Y> — <to achieve …>, accepting <cost>`. Also log spec items you had to change and anything the user should know before shipping. It is not a work log: slices finishing, tests passing and builds going green stay out. It lives outside the repo, and Cockpit deletes it after 30 days untouched.

Good run: after reading the recap and the notes file, nothing in the code surprises the user.
