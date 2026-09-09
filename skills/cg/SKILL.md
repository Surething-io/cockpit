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

All responses are coordinates / file paths — never source bodies. (One exception: `search&includeLiterals=true` echoes each matched literal's own text in `value`.) More precise than grep's textual match, cheaper in tokens than Reading whole files.

## The 6 graph endpoints ({{BASE_URL}})

```bash
# search: find symbols by name → hits carry the same node shape as every other
#   endpoint, so a hit's startLine/endLine feed Read directly.
# q is normalized for naming style: user_profile / userProfile / user-profile / USER_PROFILE are equivalent
# Pass includeLiterals=true to also search identifier-shaped string literals (tool names, event names,
# config keys, route paths — the "looks like a name but isn't an identifier" strings). The response
# then carries an extra literals[] array with value / filePath / line / enclosingSymbol per hit.
curl -fsS "{{BASE_URL}}/api/projectGraph/search?cwd=$PWD&q=<NAME>"
curl -fsS "{{BASE_URL}}/api/projectGraph/search?cwd=$PWD&q=<NAME>&includeLiterals=true"

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
context   { results[]: NODE + { score, signals[] }, seeds[]: { node, weight, from }, degraded }
related   { target, results[]: NODE + { score, relations[] }, coedit[], degraded, ambiguousIn? }
risk      { target, totalImpactedNodes, highRisk[]: NODE + { depth, risk{}, tags[] },
            suggestedTests[], coedit[], degraded, degradedReason? }   # NOTE: no ambiguousIn
affected  { testFiles[], byInput[]: { filePath, reachable, reachableTests[] },
            unresolved[], stats: { visited, bfsMs, truncated }, degraded }
```

The `coedit[]` embedded in related / risk is a strict SUPERSET of a `/coedit`
history row (same fields plus a per-row `totalCommits`) — you never need a second
request to get recency.

Errors are `{ error, tag }`. Tags seen from these routes: `ValidationError` (400),
`NotFoundError` (404), `AppError` (500 — every endpoint wraps its lookup in one, so
an index/git failure surfaces here), `InternalError` (500, uncaught defect).

## Silent-failure traps

- **An unknown qname returns HTTP 200, not 404.** `callers` / `callees` / `impact` /
  `related` / `risk` answer a typo'd or non-indexed name with `target: null` (every
  endpoint spells this slot `target`, callees included) and empty arrays — byte-identical to a real symbol that genuinely has no
  callers. **Always check `target !== null` before concluding "nothing calls this" / "this
  change is safe".** Same for `coedit` on an unknown path (200, empty). Only `file` 404s.
- **A non-null `target` with `callers: []` does NOT mean "nothing calls this".**
  `obj.method()` resolves only when the receiver's imported name directly names the
  container — a class (`Klass.method()`), a namespace import (`import * as m`), or a
  re-export chain. Two very common forms resolve to nothing and are dropped from the
  graph (kept as `methodCalls`, which are visibility-only):
    - a call on an exported singleton instance — `export const repo = new Repo()`
      then `repo.method()`. The receiver is the INSTANCE name, so the lookup misses
      the class's `Repo>method`. In a singleton-style codebase this hides the whole
      repository / service layer from inbound call queries.
    - a re-export alias (`export const estimateTokens = countTokens`) — calls are
      attributed to neither name: the alias indexes as a `const` with 0 callers,
      and the real function never sees them.
  `callers` / `impact` / `risk` fail outright here; `callees` (outbound) is fine.
  `related` only DEGRADES — it loses the `caller` relation but still returns
  ppr-neighbor / sibling-in-community / callee neighbours (measured: 10 results for
  a singleton method whose `callers` was 0). It stays usable for "what else should I
  read", just not for "who calls this". **`risk` is the dangerous one** — it does not come back empty,
  it comes back confident: `totalImpactedNodes: 0`, `highRisk: []`,
  `suggestedTests: []`, `degraded: false`, i.e. "this change is safe and needs no
  tests". `impact` likewise returns a plausible small `nodes` list (just the target
  itself) with `truncated: false`. Neither carries any signal that resolution failed.
  When the answer decides whether a change is safe, cross-check with grep, or use
  `/affected` — its file-level import closure does not depend on call resolution.
- **`risk` does NOT report `ambiguousIn`.** When several files define the same qname,
  `callers` / `callees` / `impact` / `related` list the others in `ambiguousIn` — but `risk`
  silently scores an arbitrary one of them. Before trusting a risk report on a common name
  (`render`, `handler`, `init`), resolve the name with `search` or `related` first, then
  pass `&filePath=<rel>`.
- **`frequent-coedit` relations quietly vanish in a restructured repo.** `coedit`
  history comes from `git log --follow`, so it can cite PRE-RENAME paths. `related`
  attaches a `frequent-coedit` relation only when that path still resolves in the
  index, so after a large move/rename the relation is silently dropped — while
  `related.coedit[]` (the raw echo) still lists the stale path and `degraded` stays
  `false`. Measured on two repos: every coedit partner path was stale, so no
  `frequent-coedit` relation was reachable at all, despite co-edit strengths of
  0.30-0.47 (well over the 0.2 emission threshold). The threshold is on
  `probability` (= cooccurrence / totalCommits), which the API now returns directly.
- `degraded: true` results are still usable, just lower precision — but an empty
  `coedit` / `suggestedTests` under `coedit-unavailable` means "signal missing", not
  "no coupling". Do not read it as evidence of safety.

## Technical contract

- Endpoints return coordinates only. Fetch source with Read:
  `Read offset=startLine limit=endLine-startLine+1` — works off any hit, `search` included.
- qname uses `Parent>Child` form (not `.`); copy `qualifiedName` from search's response directly
- Cross-file name collisions are listed in `ambiguousIn` — pass `&filePath=<rel>` to
  disambiguate. Present on `callers` / `callees` / `impact` / `related` only.

## The 4 advanced endpoints (smart ranking / relatedness / risk)

When the six base endpoints' pure structural data isn't enough — especially when exploring code or evaluating change impact — use these to get scored, signal-annotated results.

| Question | Endpoint |
|---|---|
| Where is the code related to this question / cursor? | context?query=&cursor= |
| What else should I read while looking at X? | related?qname=X |
| Changing X — which few nodes truly matter? Which tests to run? | risk?qname=X |
| Changed these files — which tests should CI run? (conservative closure) | affected?files=… |

```bash
# context: multi-source LEXICAL + GRAPH retrieval — NOT semantic. `query` is matched
#   as tf-idf over identifier TOKENS, then expanded through the graph (PPR / pagerank).
#   There is no embedding step, so a natural-language question whose words are not
#   identifiers in this repo returns confident noise: "how do users authenticate with
#   oauth" ranks `withFileLock` first, matching the token "with". Feed it identifier-
#   shaped terms, and treat a top hit carrying only ppr/pagerank (no query-match) as
#   "the query matched nothing".
#   (query / cursor / openFiles — at least one, else 400 at-least-one-required.)
#   Returns Top-K coordinates + signals, each carrying
#   its own payload field: query-match{tfidf} / ppr{pprScore} / pagerank{pagerank} / open{filePath}.
#   seeds[] shows what drove retrieval: { node, weight, from: query|cursor|open }.
curl -fsS "{{BASE_URL}}/api/projectGraph/context?cwd=$PWD&query=<TEXT>&cursor=<FILE>::<QNAME>&topK=15"

# related: broader than callers/callees — includes coedit / PPR neighbours / Louvain community
# Each result carries relations[], each with its own payload: caller|callee{callLines[]} /
#   ppr-neighbor{pprScore} / sibling-in-community{communityId} / frequent-coedit{cooccurrence,totalCommits}
# Cross-file name collisions are listed in ambiguousIn — pass &filePath=<rel> to disambiguate (same as callers/callees)
curl -fsS "{{BASE_URL}}/api/projectGraph/related?cwd=$PWD&qname=<QNAME>&topK=10"

# risk: risk-scored impact
# Returns highRisk (sorted by risk.score desc) + suggestedTests
#   risk{}   = { score, callFreq, coeditProb, hasTest, pagerank }
#   tags[]   = high-risk | untested | frequent-coedit | core | leaf
#   suggestedTests[] = { filePath, reason, coveredNodes[] },
#                      reason = direct-test | coedit-history | sibling-test
# risk.score = callFreq + coeditProb + (hasTest ? 0 : penalty) + pagerank, decayed by depth
curl -fsS "{{BASE_URL}}/api/projectGraph/risk?cwd=$PWD&qname=<QNAME>&depth=2&topK=20"

# affected: file-level reverse-import closure → test files transitively affected
# Sister to /risk: risk is symbol-centric + precision-oriented (for analysis),
# affected is file-centric + recall-oriented (for CI / selective-test pipelines).
# depth is clamped to 1-20 (default 10). Inputs not in the index come back in unresolved[].
curl -fsS "{{BASE_URL}}/api/projectGraph/affected?cwd=$PWD&files=<a.ts,b.ts>&depth=10"

# affected via POST — for large file lists. cwd goes IN THE BODY; passing it as a
#   query param returns 400. This is the one endpoint that does not take ?cwd=.
curl -fsS -X POST "{{BASE_URL}}/api/projectGraph/affected" -H 'content-type: application/json' \
  -d '{"cwd":"'"$PWD"'","files":["a.ts","b.ts"],"depth":10}'

# format=plain → newline-separated test paths for xargs pipelines; diagnostics move to
#   headers: X-Unresolved-Count / X-Visited / X-Truncated / X-Degraded / X-Degraded-Reason
curl -fsS "{{BASE_URL}}/api/projectGraph/affected?cwd=$PWD&files=<a.ts>&format=plain"
```

## Advanced endpoint contract

- `score` / `risk.score` are for ranking only; absolute values have no meaning
- `signals` / `relations` / `tags` explain WHY each result is relevant — feel free to cite them to the user
- `degraded: true` means results are still usable but lower precision; `degradedReason` gives the cause (`analytics-warming` = backing index warming up, retry later; `coedit-unavailable` = git history signal unavailable, fall back to manually picking tests). The reason can flip between calls while the index warms.
- **risk / related responses already include a `coedit` field** (target file's coedit history) — DO NOT issue a separate /coedit request for the same file.
- If related returns `ambiguousIn`, the same qname exists in multiple files — retry with `&filePath=<rel>`
- These four endpoints also return coordinates only; fetch source with Read
