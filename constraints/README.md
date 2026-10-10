# constraints

This directory holds the constraints themselves: invariants, state machines, concurrency-protocol models, property tests. Humans review them, AI reads them, machines run them.

- New constraints are added via `cdd promote` and must fail before the fix and pass after it.
- Modifying or deleting a constraint is a type-C change: it needs human review and a written rationale.
- `npx vitest run constraints/` runs every check here (it is the `constraint_check_cmd` in `.cdd/config.json`).
