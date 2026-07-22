/**
 * /cg slash command — project graph (CodeGraph) exploration mode prompt.
 *
 * Split out of slashCommands.ts because the cg content is ~4000 chars vs the
 * ~100 chars of qa/fx. Co-locating it there made the registry hard to read
 * and made the file's purpose ambiguous (is it the slash-command dispatcher,
 * or the CodeGraph documentation?). Keeping the bulk here lets
 * slashCommands.ts stay a thin registry.
 *
 * `{{BASE_URL}}` placeholder is resolved at expansion time by
 * resolveCommandPrompt in slashCommands.ts (substituted with the loopback
 * origin http://localhost:<port> — the agent runs these curls on the server
 * host, so loopback is always reachable and needs no auth token).
 *
 * Positioning vs siblings:
 *   /qa  — lightweight requirement clarification, ASKS the user back
 *   /fx  — bug evidence-chain analysis (analysis only)
 *   /ex  — heavy structured discussion (analysis only, no asking back)
 *   /go  — landing mode (writes code, self-verifies per stage)
 *   /cg  — CodeGraph exploration
 *   /cc  — Cockpit CLI operation (drive bubbles / codegraph via the CLI)
 *   /cr  — full code review (static triangulation + dynamic modelling)
 */

export const CG_PROMPT_ZH = `---
name: cg
description: "进入项目图谱（CodeGraph）探索模式：用预建的符号 + 调用图 + git 协同视图（search/callers/callees/impact/file/coedit + context/related/risk/affected）追代码、评估影响范围，返回坐标而非源码。"
---

进入项目图谱探索模式（CodeGraph）

CodeGraph = 项目预建的符号 + 调用图索引 + git 协同视图。6 个接口各回答一类问题：

| 问题 | 接口 |
|---|---|
| X 在哪定义 / 有哪些同名符号？ | search?q=X |
| 谁调用 X？ | callers?qname=X |
| X 调用了什么？ | callees?qname=X |
| 改 X 会影响哪些符号？ | impact?qname=X&depth=2 |
| 文件 F 有哪些符号？ | file?path=F |
| 文件 F 常和哪些文件一起改？（约定耦合 / 双写注册表） | coedit?filePath=F |

所有响应都是坐标 / 文件路径，不含源码——比 grep 字面匹配精确，比 Read 全文扫描省 token。

## 6 个图谱接口（{{BASE_URL}}）

# search: 按名字找符号 → file / qname / kind / startLine / endLine / params
# q 自动做命名风格归一：user_profile / userProfile / user-profile / USER_PROFILE 等价
# 加 includeLiterals=true 时，还搜源码里的字符串字面量（tool 名 / 事件名 / 配置 key / 路由路径
# 等"长得像名字但不是 identifier"的字符串），返回字段多一个 literals[]，每项含 value/filePath/line/enclosingSymbol
curl -fsS "{{BASE_URL}}/api/projectGraph/search?cwd=$PWD&q=<NAME>"
curl -fsS "{{BASE_URL}}/api/projectGraph/search?cwd=$PWD&q=<NAME>&includeLiterals=true"

# callers / callees: 1-hop 调用关系
curl -fsS "{{BASE_URL}}/api/projectGraph/callers?cwd=$PWD&qname=<QNAME>"
curl -fsS "{{BASE_URL}}/api/projectGraph/callees?cwd=$PWD&qname=<QNAME>"

# impact: 传递性 callers BFS（depth 1-5，默认 2）
curl -fsS "{{BASE_URL}}/api/projectGraph/impact?cwd=$PWD&qname=<QNAME>&depth=2"

# file: 文件符号树（无源码）
curl -fsS "{{BASE_URL}}/api/projectGraph/file?cwd=$PWD&path=<REL_PATH>"

# coedit: 与目标文件协同编辑的文件 = git log 历史 + 当前 working tree 同时被改的文件
#   抓 call-graph 抓不到的"约定耦合"(平行注册表 / 双写 / 同名 .md 配置等)
curl -fsS "{{BASE_URL}}/api/projectGraph/coedit?cwd=$PWD&filePath=<REL_PATH>"

## 技术契约
- 接口只返坐标，源码用 Read 自取：\`Read offset=startLine limit=endLine-startLine+1\`
- qname 用 \`Parent>Child\` 形式（不是 \`.\`），直接复用 search 返回的 \`qualifiedName\`
- 同名符号跨多文件时响应里 \`ambiguousIn\` 列出，加 \`&filePath=<rel>\` 消歧

## 3 个进阶接口（智能排序 / 关联 / 风险）

当基础 6 个接口的纯结构信息不够用 —— 尤其在"探索式追代码"或"评估影响范围"时 —— 用这 3 个接口拿到带相关性评分和风险标注的结果。

| 问题 | 接口 |
|---|---|
| 这个问题/光标位置相关的代码在哪？ | context?query=&cursor= |
| 看 X 时，还应该顺手看哪些相关代码？ | related?qname=X |
| 改 X 真正高风险的少数节点是哪些？哪些测试要跑？ | risk?qname=X |
| 改了这些文件，CI 应该跑哪些测试文件？（保守闭包） | affected?files=… |

# context: 多源种子语义检索（query / cursor / openFiles 任传其一）
# 返回 Top-K 相关坐标 + signals（query-match / ppr / pagerank / open）
curl -fsS "{{BASE_URL}}/api/projectGraph/context?cwd=\$PWD&query=<TEXT>&cursor=<FILE>::<QNAME>&topK=15"

# related: 比 callers/callees 更广，纳入 coedit / PPR 邻居 / Louvain 社区
# 每个结果带 relations 数组：caller / callee / ppr-neighbor / frequent-coedit / sibling-in-community
# 同名跨多文件时响应里 ambiguousIn 列出，加 &filePath=<rel> 消歧（同 callers/callees 行为）
curl -fsS "{{BASE_URL}}/api/projectGraph/related?cwd=\$PWD&qname=<QNAME>&topK=10"

# risk: impact 的风险化版本
# 返回 highRisk（按 risk.score 降序） + suggestedTests 建议运行的测试文件
# risk.score = callFreq + coeditProb + (hasTest ? 0 : penalty) + pagerank，按 depth 衰减
curl -fsS "{{BASE_URL}}/api/projectGraph/risk?cwd=\$PWD&qname=<QNAME>&depth=2&topK=20"

# affected: 给定一组改动文件，沿 importedBy 闭包返回受影响的测试文件
# 与 risk 互补：risk 给人/LLM 看（按符号、精准），affected 给 CI/管道用（按文件、保守）
# 多文件输入用 POST，URL 太长用 POST；要纯文本输出用 format=plain
curl -fsS "{{BASE_URL}}/api/projectGraph/affected?cwd=\$PWD&files=<a.ts,b.ts>&depth=10"

## 进阶接口契约
- \`score\` / \`risk.score\` 只用于排序参考，无绝对意义
- \`signals\` / \`relations\` / \`tags\` 是"为什么相关"的解释，引用时可直接告诉用户
- \`degraded: true\` 时结果仍可用，但精度降低；\`degradedReason\` 给出原因（\`analytics-warming\` 表示后台索引还在预热，\`coedit-unavailable\` 表示 git 历史信号不可用，回落手工挑测试）
- **risk / related 响应里已经带 \`coedit\` 字段**（target 文件的 coedit 历史），同一文件不要再单独发 /coedit 请求
- related 响应若有 \`ambiguousIn\`，表示同名符号跨多文件，下次调用补 \`&filePath=\`
- 这 3 个接口同样只返坐标，源码用 Read 自取`;

export const CG_PROMPT_EN = `---
name: cg
description: "Enter project graph (CodeGraph) exploration mode: use the pre-built symbol + call-graph + git co-edit index (search/callers/callees/impact/file/coedit + context/related/risk/affected) to trace code and assess change impact; responses are coordinates, not source."
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
- Endpoints return coordinates only. Fetch source with Read: \`Read offset=startLine limit=endLine-startLine+1\`
- qname uses \`Parent>Child\` form (not \`.\`); copy \`qualifiedName\` from search's response directly
- Cross-file name collisions are listed in \`ambiguousIn\` — pass \`&filePath=<rel>\` to disambiguate

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
curl -fsS "{{BASE_URL}}/api/projectGraph/context?cwd=\$PWD&query=<TEXT>&cursor=<FILE>::<QNAME>&topK=15"

# related: broader than callers/callees — includes coedit / PPR neighbours / Louvain community
# Each result carries a relations[] array: caller / callee / ppr-neighbor / frequent-coedit / sibling-in-community
# Cross-file name collisions are listed in ambiguousIn — pass &filePath=<rel> to disambiguate (same as callers/callees)
curl -fsS "{{BASE_URL}}/api/projectGraph/related?cwd=\$PWD&qname=<QNAME>&topK=10"

# risk: risk-scored impact
# Returns highRisk (sorted by risk.score desc) + suggestedTests
# risk.score = callFreq + coeditProb + (hasTest ? 0 : penalty) + pagerank, decayed by depth
curl -fsS "{{BASE_URL}}/api/projectGraph/risk?cwd=\$PWD&qname=<QNAME>&depth=2&topK=20"

# affected: file-level reverse-import closure → test files transitively affected
# Sister to /risk: risk is symbol-centric + precision-oriented (for analysis),
# affected is file-centric + recall-oriented (for CI / selective-test pipelines).
# Use POST when files list is large; use format=plain for newline-separated paths.
curl -fsS "{{BASE_URL}}/api/projectGraph/affected?cwd=\$PWD&files=<a.ts,b.ts>&depth=10"

## Advanced endpoint contract
- \`score\` / \`risk.score\` are for ranking only; absolute values have no meaning
- \`signals\` / \`relations\` / \`tags\` explain WHY each result is relevant — feel free to cite them to the user
- \`degraded: true\` means results are still usable but lower precision; \`degradedReason\` gives the cause (\`analytics-warming\` = backing index warming up; \`coedit-unavailable\` = git history signal unavailable, fall back to manually picking tests)
- **risk / related responses already include a \`coedit\` field** (target file's coedit history) — DO NOT issue a separate /coedit request for the same file
- If related returns \`ambiguousIn\`, the same qname exists in multiple files — retry with \`&filePath=<rel>\`
- These three endpoints also return coordinates only; fetch source with Read`;
