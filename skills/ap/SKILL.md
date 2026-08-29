---
name: ap
description: "Implement <SPEC>, keeping a running apply-notes HTML file of out-of-spec decisions and tradeoffs."
argument-hint: "[SPEC path / empty = spec agreed in this conversation]"
---

Implement <SPEC>; and while you do, keep a running apply-notes.html file
with decisions you had to make that weren't in the spec, things you had
to change, tradeoffs you had to make, or anything else I should know.
It is not a work log — routine progress like tests passing or builds
going green doesn't belong in it.

Keep the file at `${TMPDIR%/}/apply-notes-<feature-name>.html`, never
inside the repo, one file per requirement: when a round continues the
same task, append to the existing file under a new round heading rather
than starting a fresh one; only a new requirement gets a new file.
Always update it with the Edit tool (Write only when first creating it),
never through shell redirection.
