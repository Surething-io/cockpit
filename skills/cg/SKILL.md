---
name: cg
description: "Trace code and assess change impact via the pre-built symbol, call-graph and co-edit index."
---

Enter project graph exploration mode (CodeGraph).

CodeGraph = pre-built symbol + call-graph index + git co-edit view. Nine endpoints, each answers one class of question:

| Question | Endpoint |
|---|---|
| Where is X defined / which files share the name? | search?q=X |
| Export every function/method, optionally within a directory? | symbols?path=src&excludeTests=true |
| Who calls X? | callers?qname=X |
| What does X call? | callees?qname=X |
| Changing X affects which symbols? | impact?qname=X&depth=2 |
| What symbols does file F contain? | file?path=F |
| Which files are commonly edited alongside F? (conventional coupling / parallel registries) | coedit?filePath=F |

All responses are coordinates / file paths — never source bodies. (One exception: `search&includeLiterals=true` echoes each matched literal's own text in `value`.) More precise than grep's textual match, cheaper in tokens than Reading whole files.

## The 7 graph endpoints ({{BASE_URL}})

```bash
# search: find symbols by name → hits carry the same node shape as every other
#   endpoint, so a hit's startLine/endLine feed Read directly.
# q is normalized for naming style: user_profile / userProfile / user-profile / USER_PROFILE are equivalent
# limit defaults to 50 per category and is capped at 500; use symbols for a full export.
# All eligible candidates are scanned. Ranking: raw exact name > normalized exact
# > normalized prefix > normalized substring; ties use path, qualifiedName, then line.
# path limits the directory (including descendants); excludeTests=true filters every category.
# Tests are included by default. Small limits still find exact definitions after many fuzzy matches.
# Pass includeLiterals=true to also search identifier-shaped string literals (tool names, event names,
# config keys, route paths — the "looks like a name but isn't an identifier" strings). The response
# then carries an extra literals[] array with value / filePath / line / enclosingSymbol per hit.
curl -fsS "{{BASE_URL}}/api/projectGraph/search?cwd=$PWD&q=<NAME>"
curl -fsS "{{BASE_URL}}/api/projectGraph/search?cwd=$PWD&q=<NAME>&includeLiterals=true"
curl -fsSG "{{BASE_URL}}/api/projectGraph/search" --data-urlencode "cwd=$PWD" \
  --data-urlencode 'q=<NAME>' --data-urlencode 'path=apps/api/src/features' \
  --data-urlencode 'excludeTests=true' --data-urlencode 'limit=5'

# Full export: defaults to function + method, including indexed nested symbols.
# path is a project-relative directory including descendants. Omit it for the whole project.
# kind accepts a comma-separated list or all (real symbols only).
# includeSynthetic=true also includes unknown UI blocks (__imports__, __code_*).
# Repeat exclude for POSIX globs rooted at cwd. Quote globs; dot paths require explicit dots.
# Start broad exploration with a summary; no result-count cap or export cache.
curl -fsSG "{{BASE_URL}}/api/projectGraph/symbols" --data-urlencode "cwd=$PWD" \
  --data-urlencode 'path=packages/feature' --data-urlencode 'excludeTests=true' \
  --data-urlencode 'kind=all' --data-urlencode 'format=summary'

# Save full exports to disk, then print only a bounded selection of candidates.
curl -fsSG "{{BASE_URL}}/api/projectGraph/symbols" --data-urlencode "cwd=$PWD" \
  --data-urlencode 'path=src' --data-urlencode 'excludeTests=true' \
  --data-urlencode 'exclude=**/generated/**' --data-urlencode 'exclude=**/*.spec.ts' \
  -o /tmp/cg-symbols.json

# callers / callees: 1-hop call relations
curl -fsS "{{BASE_URL}}/api/projectGraph/callers?cwd=$PWD&qname=<QNAME>"
curl -fsS "{{BASE_URL}}/api/projectGraph/callees?cwd=$PWD&qname=<QNAME>"

# impact: transitive callers BFS (depth 1-5, default 2; out-of-range is clamped
#   silently, not rejected). `truncated: true` = node ceiling hit, list is partial.
curl -fsS "{{BASE_URL}}/api/projectGraph/impact?cwd=$PWD&qname=<QNAME>&depth=2"

# file: file symbol tree (no source). Hierarchical: nested symbols live in
#   children[] — always an array, empty for leaves (never null / never absent).
curl -fsS "{{BASE_URL}}/api/projectGraph/file?cwd=$PWD&path=<REL_PATH>"

# coedit: files commonly edited alongside the target = git log history + current working-tree co-edits
#   catches "conventional coupling" the call-graph can't see (parallel registries / double-writes / sibling .md configs)
#   history[] entries may name PRE-RENAME paths (git --follow), so a path here need not exist today.
#   `cooccurrence` is a RAW COUNT; the ratio ships alongside as `probability`.
curl -fsS "{{BASE_URL}}/api/projectGraph/coedit?cwd=$PWD&filePath=<REL_PATH>"
```

## Response shapes

Every endpoint speaks ONE node shape (call it NODE):

`{ filePath, qualifiedName, name, kind, startLine, endLine, params?[] }`

`params` is OPTIONAL: absent for non-callables (class / interface / type / enum /
const) and for languages without a tree-sitter grammar. `params: []` is different —
it means "0 parameters", not "unknown".

```
search    { files[], symbols[], literals?[] }      # literals only with includeLiterals=true
            files[]    = { type:'file',    label, hint?, target: { filePath } }
            symbols[]  = { type:'symbol',  label, hint?, target: NODE }
            literals[] = { type:'literal', value, filePath, line, enclosingSymbol? }
            # narrow on the outer `type`
symbols   { revision, incomplete, total, symbols[]: NODE, excludedFiles[] }
            # excludedFiles[] = { filePath, reason:"source-too-large", sizeBytes, limitBytes }
            # exclusions cover the entire revision, before export filters
            # flat output; default kind=function,method; kind=all includes all real kinds
            # unknown display blocks require includeSynthetic=true
            # format=summary replaces symbols[] with files, byKind, byDirectory:
            # [{path, total, files, byKind}]; groups are immediate child directories
            # of path. Direct files use path or '.'. All export filters apply.
            # total is the count after filters; incomplete describes source-index coverage
file      { filePath, language, symbols[] }
            symbols[] = NODE plus { contentHash, children[] }
            # children[] is always an array, empty for leaves (never null / absent)
callers   { qname, target: NODE|null, callers[]: { caller: NODE, callLines[] }, ambiguousIn? }
callees   { qname, target: NODE|null, callees[]: { callee: NODE, callLines[] }, ambiguousIn? }
impact    { qname, target: NODE|null, nodes[]: { symbol: NODE, depth }, truncated, ambiguousIn? }
coedit    { target: string, totalCommits, uncommitted[],
            history[]: { filePath, cooccurrence, probability, lastCoEdit } }
            # probability = cooccurrence / totalCommits, precomputed. `cooccurrence`
            # alone is a RAW COUNT — never compare it against a ratio threshold.
related   { target, results[]: NODE + { score, relations[] }, coedit[], degraded, degradedReason?, ambiguousIn? }
affected  { testFiles[], byInput[]: { filePath, reachable, reachableTests[] },
            unresolved[], stats: { visited, bfsMs, truncated }, degraded }
```

## Related code and affected tests

Project graph endpoints share the base symbol/import/call index. Coedit reads Git on
request. There is no secondary analysis cache or warm-up phase.

Only Git working trees (including linked worktrees) are supported. Every
project-index query verifies Git membership and source content hashes, then
reuses unchanged parse facts and atomically publishes consistent relations.
Watcher events only record changes; they never trigger parsing by themselves.
Tracked `node_modules` files are excluded too. Tests remain indexed.
`symbols` and `search` with `excludeTests=true` filter test/spec/e2e names, test/tests/__tests__
directories, Python test_*.py/pyi and Go *_test.go; this recognition is heuristic.

Worktrees sharing a canonical Git common directory reuse identical per-path
parse facts and lookup maps. Relations are resolved independently, then equal
whole-file relation bundles share read-only storage. File membership, timestamps,
configuration, revisions and failures remain worktree-local. Published roots own
the shared storage; eviction releases their references, and the memory budget
counts each shared block once.

Known Git operations in progress or paused on conflicts reject ordinary
queries. Finish the operation first; an explicit UI rebuild can inspect the
current workspace. Large changes rebuild all relations at 500 changed paths,
or at least 20 paths representing 20% of the larger old/new source count.
Manual force rebuild reparses all admitted sources. Symbol-only file previews
stay local. Opening the function call graph queries the project index on demand
and waits for its relations (`file-functions&relations=1`). Source/file caps are reported as incomplete
coverage (`X-Code-Index-Incomplete: 1` on project queries). Sources exceeding
2 MiB (2,097,152 actual input bytes) are excluded; exactly 2 MiB is admitted.
The symbols response lists oversized paths, reasons and byte sizes in
`excludedFiles`, even when outside the export directory. Responses also
include `X-Code-Index-Revision`. Fingerprints do not make heuristic call
resolution exact.

```bash
# Related = direct callers, callees, and frequent coedit partners.
# include=structural skips Git; include=coedit skips direct call relations.
curl -fsS "{{BASE_URL}}/api/projectGraph/related?cwd=$PWD&qname=<QNAME>&topK=10&include=all"

# File-level reverse-import closure, with test-file recognition.
curl -fsS "{{BASE_URL}}/api/projectGraph/affected?cwd=$PWD&files=<a.ts,b.ts>&depth=10"

# For large input lists, cwd belongs in the JSON body.
curl -fsS -X POST "{{BASE_URL}}/api/projectGraph/affected" -H 'content-type: application/json' \
  -d '{"cwd":"'"$PWD"'","files":["a.ts","b.ts"],"depth":10}'

# Plain format emits test paths; diagnostics are returned in headers.
curl -fsS "{{BASE_URL}}/api/projectGraph/affected?cwd=$PWD&files=<a.ts>&format=plain"
```

`related.relations` contains `caller{callLines[]}`, `callee{callLines[]}`, or
`frequent-coedit{cooccurrence,totalCommits}`. Scores are ranking heuristics only:
0.4 per direct relation, plus 0.3 times the coedit probability. They are not risk
estimates. Coedit partners use their first real symbol as a navigation anchor;
the relation is evidence about the file, not evidence that this symbol changed.
The raw `coedit[]` includes non-code and historical paths and adds `totalCommits`
to each history row. Reuse it rather than calling `/coedit` again.

## Interpretation and limits

- Check `target !== null` before interpreting empty results. Unknown symbols
  return HTTP 200 with empty relations. Use `search` to locate the definition.
- Use `qualifiedName` verbatim (`Parent>Child`), and pass `filePath` to
  disambiguate. On ambiguity, `callers`, `callees`, `impact`, and `related`
  return HTTP 200 with target=null, empty relations and candidate paths in
  `ambiguousIn`. No target is auto-selected; no relations or coedit are computed.
  Retry with the intended filePath. The CLI exits 2 on ambiguity, including
  --json mode, while preserving the JSON response.
- For project/business overviews, query symbols with format=summary first,
  then narrow path/kind. Keep full exports on disk; never print every symbol
  into context. Read at most 30 selected coordinates per batch. Business
  ownership still requires module documentation and source confirmation.
- Static call resolution is incomplete. Exported singleton-instance methods,
  aliases such as `export const alias = original`, and dynamic dispatch can
  lack incoming edges. Empty callers or impact is not evidence of safety.
  Cross-check source/text search; `affected` offers a broader file-import view
  within the imports the index can resolve.
- `related.degradedReason` is `coedit-unavailable` when Git lookup fails, or
  `truncated` when the source index is capped. Empty successful Git history is
  a valid result. `degraded: false` does not establish complete call resolution.
- `affected` reports unresolved input paths and traversal truncation. Its test
  recognition is heuristic; returned tests do not prove behavioral coverage.
- Coedit history can contain pre-rename or non-code paths. These remain in
  `coedit[]` even when no indexed symbol is available to navigate to them.
- Read source using `startLine` / `endLine`; endpoints return coordinates.
- `context` and `risk` have been removed. Use `search` + `related` to explore,
  and `impact` / `affected` / `coedit` to inspect change evidence.

Errors are `{ error, tag }`, including ValidationError (400), NotFoundError
(404), AppError (500), and InternalError (500).
