/**
 * /cg slash command — project graph (CodeGraph) exploration mode prompt.
 *
 * Split out of slashCommands.ts because the cg content is ~2500 chars vs the
 * ~100 chars of qa/fx. Co-locating it there made the registry hard to read
 * and made the file's purpose ambiguous (is it the slash-command dispatcher,
 * or the CodeGraph documentation?). Keeping the bulk here lets
 * slashCommands.ts stay a thin registry.
 *
 * `{{BASE_URL}}` placeholder is resolved at expansion time by
 * resolveCommandPrompt in slashCommands.ts (substituted with the live request
 * origin, so deployed reverse-proxy URLs work).
 *
 * Trailing user text is labeled "探索问题：" / "Exploration:" — not the
 * neutral "问题：" / "Question:" used by qa/fx — to prime the model into
 * graph-tool mindset rather than defaulting to grep/glob/Read. See
 * `labelFor` in slashCommands.ts.
 */

export const CG_PROMPT_ZH = `进入项目图谱探索模式（CodeGraph）

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
curl -fsS "{{BASE_URL}}/api/projectGraph/search?cwd=$PWD&q=<NAME>"

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
- 同名符号跨多文件时响应里 \`ambiguousIn\` 列出，加 \`&filePath=<rel>\` 消歧`;

export const CG_PROMPT_EN = `Enter project graph exploration mode (CodeGraph).

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
curl -fsS "{{BASE_URL}}/api/projectGraph/search?cwd=$PWD&q=<NAME>"

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
- Cross-file name collisions are listed in \`ambiguousIn\` — pass \`&filePath=<rel>\` to disambiguate`;
