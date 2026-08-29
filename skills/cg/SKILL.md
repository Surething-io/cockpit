---
name: cg
description: "Trace code and assess change impact via the pre-built symbol, call-graph and co-edit index."
---

Enter project graph exploration mode (CodeGraph).

CodeGraph = pre-built symbol + call-graph index + git co-edit view. Six endpoints, each answers one class of question:

| Question | Endpoint |
|---|---|
| Where is X defined / which files share the name? | search?q=X |
| Who calls X? | callers?qname=X |
| What does X call? | callees?qname=X |
| Changing X affects which symbols? | impact?qname=X&depth=2 |
| What symbols does file F contain? | file?path=F |
| Which files are commonly edited alongside F? (conventional coupling / parallel registries) | coedit?filePath=F |

All responses are coordinates / file paths — never source. More precise than grep's textual match, cheaper in tokens than Reading whole files.

## The 6 graph endpoints ({{BASE_URL}})

# search: find symbols by name → file / qname / kind / startLine / endLine / params
# q is normalized for naming style: user_profile / userProfile / user-profile / USER_PROFILE are equivalent
# Pass includeLiterals=true to also search identifier-shaped string literals (tool names, event names,
# config keys, route paths — the "looks like a name but isn't an identifier" strings). The response
# then carries an extra literals[] array with value / filePath / line / enclosingSymbol per hit.
curl -fsS "{{BASE_URL}}/api/projectGraph/search?cwd=$PWD&q=<NAME>"
curl -fsS "{{BASE_URL}}/api/projectGraph/search?cwd=$PWD&q=<NAME>&includeLiterals=true"

# callers / callees: 1-hop call relations
curl -fsS "{{BASE_URL}}/api/projectGraph/callers?cwd=$PWD&qname=<QNAME>"
curl -fsS "{{BASE_URL}}/api/projectGraph/callees?cwd=$PWD&qname=<QNAME>"

# impact: transitive callers BFS (depth 1-5, default 2)
curl -fsS "{{BASE_URL}}/api/projectGraph/impact?cwd=$PWD&qname=<QNAME>&depth=2"

# file: file symbol tree (no source)
curl -fsS "{{BASE_URL}}/api/projectGraph/file?cwd=$PWD&path=<REL_PATH>"

# coedit: files commonly edited alongside the target = git log history + current working-tree co-edits
#   catches "conventional coupling" the call-graph can't see (parallel registries / double-writes / sibling .md configs)
curl -fsS "{{BASE_URL}}/api/projectGraph/coedit?cwd=$PWD&filePath=<REL_PATH>"

## Technical contract
- Endpoints return coordinates only. Fetch source with Read: `Read offset=startLine limit=endLine-startLine+1`
- qname uses `Parent>Child` form (not `.`); copy `qualifiedName` from search's response directly
- Cross-file name collisions are listed in `ambiguousIn` — pass `&filePath=<rel>` to disambiguate

## Three advanced endpoints (smart ranking / relatedness / risk)

When the six base endpoints' pure structural data isn't enough — especially when exploring code or evaluating change impact — use these to get scored, signal-annotated results.

| Question | Endpoint |
|---|---|
| Where is the code related to this question / cursor? | context?query=&cursor= |
| What else should I read while looking at X? | related?qname=X |
| Changing X — which few nodes truly matter? Which tests to run? | risk?qname=X |
| Changed these files — which tests should CI run? (conservative closure) | affected?files=… |

# context: multi-source semantic retrieval (query / cursor / openFiles — at least one)
# Returns Top-K relevant coordinates + signals (query-match / ppr / pagerank / open)
curl -fsS "{{BASE_URL}}/api/projectGraph/context?cwd=$PWD&query=<TEXT>&cursor=<FILE>::<QNAME>&topK=15"

# related: broader than callers/callees — includes coedit / PPR neighbours / Louvain community
# Each result carries a relations[] array: caller / callee / ppr-neighbor / frequent-coedit / sibling-in-community
# Cross-file name collisions are listed in ambiguousIn — pass &filePath=<rel> to disambiguate (same as callers/callees)
curl -fsS "{{BASE_URL}}/api/projectGraph/related?cwd=$PWD&qname=<QNAME>&topK=10"

# risk: risk-scored impact
# Returns highRisk (sorted by risk.score desc) + suggestedTests
# risk.score = callFreq + coeditProb + (hasTest ? 0 : penalty) + pagerank, decayed by depth
curl -fsS "{{BASE_URL}}/api/projectGraph/risk?cwd=$PWD&qname=<QNAME>&depth=2&topK=20"

# affected: file-level reverse-import closure → test files transitively affected
# Sister to /risk: risk is symbol-centric + precision-oriented (for analysis),
# affected is file-centric + recall-oriented (for CI / selective-test pipelines).
# Use POST when files list is large; use format=plain for newline-separated paths.
curl -fsS "{{BASE_URL}}/api/projectGraph/affected?cwd=$PWD&files=<a.ts,b.ts>&depth=10"

## Advanced endpoint contract
- `score` / `risk.score` are for ranking only; absolute values have no meaning
- `signals` / `relations` / `tags` explain WHY each result is relevant — feel free to cite them to the user
- `degraded: true` means results are still usable but lower precision; `degradedReason` gives the cause (`analytics-warming` = backing index warming up; `coedit-unavailable` = git history signal unavailable, fall back to manually picking tests)
- **risk / related responses already include a `coedit` field** (target file's coedit history) — DO NOT issue a separate /coedit request for the same file
- If related returns `ambiguousIn`, the same qname exists in multiple files — retry with `&filePath=<rel>`
- These three endpoints also return coordinates only; fetch source with Read
