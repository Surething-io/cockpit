/**
 * /skillify slash command — distil a successful workflow / investigation /
 * tool-combo / habit into a reusable Skill.
 *
 * Split out per the one-file-per-command convention (see newBranchPrompt / qaPrompt).
 * This is an ANALYZE → EXTRACT → SAVE skill: step 1 is always deciding whether the
 * recent conversation holds knowledge worth distilling; the placement directory is
 * only needed at the SAVE step, so we never front-load a "where to put it?" question.
 *
 * EN is a faithful translation of the ZH body.
 */

export const SKILLIFY_PROMPT_ZH = `---
name: skillify
description: "把一次成功的处理流程 / 调研方式 / 工具组合 / 习惯，沉淀成一个可复用的 Skill。先分析历史会话有没有值得提取的知识，再提炼，最后按指定目录保存。"
argument-hint: "[放置目录] [要 skillify 的对象]"
---

# Skillify

把"刚刚做成的一件事"抽象成一个可复用 skill。这是一个 **分析 → 提取 → 保存** 的流程：

- **第一步永远是分析**：先判断历史会话 / 最近上下文里有没有值得沉淀成 skill 的知识。没有就直接说明并停下，不要硬凑。
- 放置目录等参数**只在最后保存那一步才需要**，不要一上来就追问目录。

适用于用户说："把这个能力抽象成 skill""把刚刚的经验教训写成 skill""以后遇到类似情况自动这样做""skillify 一下""把这个工作流沉淀下来"。

核心目标：**把一次成功经验变成稳定流程，而不是把临时对话复制进 prompt。**

## 参数（都可选，保存时才用）

- **尾随文本**（\`/skillify\` 后面那段）= 想 skillify 的对象 / 线索；不给就从最近上下文里自动提炼。
- **放置目录 \`<skills-dir>\`** = skill 落盘位置，canonical source 写到 \`<skills-dir>/<slug>/SKILL.md\`。**到"保存"那一步才需要**；用户没给再问，不要在分析前就先问。

## 第 1 步：分析 —— 有没有值得沉淀的知识（扫描 → 闸门）

先回答"**该不该提**"。大多数候选死在这一步，而不是写作。

### 1a. 三相扫描：别漏掉隐形 skill

复盘刚做完的事，按三相各扫一遍，每相只问一句：**这里有没有一个"非显然的动作 / 判断"？**

| 相 | 扫什么 | 为什么容易被漏 |
|---|---|---|
| 发现 | 怎么定位 / 触发 / 诊断出真问题的？triage 用了哪个信号？ | 没有可见交付物，最常被漏 |
| 决策 | 卡点上那个判断 call 凭什么？有没有可复用的判据？ | 当成"凭经验"，没意识到能固化 |
| 解决 | 执行骨架 / 工具组合 / 验证方式能复用吗？ | 看得见、最容易只盯着它 |

扫描的目的是**铺开、防漏**：人天然只注意到"解决"类（有交付物），而"发现 / 决策"类——诊断和判断的 move——才是高价值又隐形的。

> 三相只用来**扫描候选**，不写进 SKILL.md 当章节。skill 正文要按**失败模式 / 调查动作**组织，不是按这三类分章。

### 1b. 真闸门：别滥提

对每个候选，四问全过才提：

- [ ] **会复发**：以后还会遇到同类场景？（一次性的 → 写备忘就够，别提 skill）
- [ ] **非显然**：里面有一个"不查就不会"的动作 / 判断？（显然的事不值得固化）
- [ ] **代价**：做错 / 漏做的代价大？
- [ ] **稳定**：流程稳定，不绑死在这次的临时上下文 / 数据上？

缺"非显然"或"会复发"基本就别提了。

**如果分析下来没有任何候选通过闸门 → 直接告诉用户"这次不值得做 skill"并说明原因，然后停下。** 不要为了产出而硬凑，也不要在这一步追问放置目录。

### 1c. 合并还是拆分：边界问题

如果一个场景里发现 / 决策 / 解决三相**都**蹦出了候选，要决定它们装进**一个闭环 skill**还是**拆成几个组合**。按三问判：

- **会单独调用某一相吗？** 会 → 拆；永远从头进 → 倾向合并。
- **价值在相内还是相间交接？** 在交接（上游期望状态 / 契约要带给下游做验证）→ 合并；每相自成动作、交接没信息量 → 可拆。
- **合并会让一个执行单元同时扛正交的失败模式吗？** 会（如静态广度 vs 动态推演深度）→ 拆。
- **这一相在别的问题里也先跑吗？** 扇出 ≥2~3 → 拆成可复用的 leaf。

**第三态（两者都要）**：闭环不能断、但相又要深度 / 复用时，用 **orchestrator + leaf** —— 一个闭环 skill 持有契约与验证，把正交的相委派给可复用的 sub-skill。

**默认先按一个闭环 skill 写**。只有出现实测信号（某相被第二个场景复用，或注意力被摊薄导致深度不够）才拆。

### 1d. 归类：决定怎么写，不决定提不提

| 类型 | 示例 | Skill 重点 |
|---|---|---|
| 调研流程 | 拉数据源 → 建时间线 → 定位问题 | 证据源、步骤、输出模板 |
| Debug 流程 | 复现 bug → 红测 → 修复 → 验证 | 不变量、测试、验收 |
| 工具组合 | 多个日志/监控/分析工具串联 | 查询顺序、关联 ID |
| 习惯/规范 | 目录结构、命名、放置规则 | 路径规则、命名规则 |
| 写作模板 | issue / PR / 复盘报告 | 结构、语气、禁止项 |

**不要**把一次性的细节写进 skill（某个临时 session、某次具体 chat 的完整内容、临时验证码等）。

## 第 2 步：提取 —— 提炼稳定原则并起草

> 若 1c 判定为拆分或 orchestrator + leaf，对**每个**要落地的 skill 各跑一遍第 2 步（各自独立目录）。

### 2a. 提炼稳定原则

把经验拆成：

- **触发条件**：什么时候应该用这个 skill
- **输入**：用户可能提供什么，缺什么时问什么
- **证据源 / 工具**：需要查哪些 source、文件、CLI、日志
- **步骤**：稳定可复用的执行顺序
- **输出**：最终给用户什么，或创建什么 artifact
- **边界**：不要做什么，什么情况下停止/询问
- **验证**：如何确认 skill 有效

写原则，不写流水账。

### 2b. 选 slug

Slug 要 lowercase、alphanumeric + hyphen、简短清楚、动词/任务或主题导向。起草前先 \`ls <skills-dir>/\` 看一眼，避免冲突并与已有命名风格一致（保存目录已知时）。

### 2c. 起草 SKILL.md

Frontmatter 用通用兼容格式：

\`\`\`yaml
---
name: <slug-or-display-name>
description: "一句话说明 skill 做什么，什么时候用。"
argument-hint: "<可选，描述参数>"
alwaysAllow: ["Bash"]      # 可选
requiredSources: []         # 可选
---
\`\`\`

正文建议结构：

\`\`\`markdown
# <Skill Name>

一句话目标。

## 触发场景 / 适用情况
## 前置条件
## 工作流 / 步骤
## 输出格式
## 边界和禁止项
## 验证
## 示例
\`\`\`

写作风格：

- 指令要可执行，不要泛泛而谈。
- 不要写"已读后告诉用户规则已加载"这类无效行为。
- 动作型 skill 默认继续执行；只有缺关键参数才提问。
- 保留具体路径、API、命令示例，但抹掉一次性敏感数据。
- 语言与目标 skill 库的现有风格保持一致。

### 2d. icon（可选）

- 优先 3D / color / 拟物风格，和现有视觉一致。
- 推荐来源：Microsoft Fluent Emoji。
- 文件名必须是 \`icon.svg\`/\`icon.png\`/\`icon.jpg\`/\`icon.jpeg\`，放在 skill 目录里。
- 不允许临时手绘 SVG 顶替，除非用户明确要求。找不到就先问，别硬凑。

## 第 3 步：保存 —— 落盘到指定目录

**到这一步才需要放置目录 \`<skills-dir>\`：**

- 用户一开始就给了目录 → 直接用。
- 没给 → **现在**问用户放哪，不要擅自选目录。

约定：

1. **一个 skill 一个目录**：\`<skills-dir>/<slug>/SKILL.md\`（必需）+ 可选 \`icon.svg\` / \`references/\` / 辅助脚本。
2. **不要在 \`<skills-dir>\` 根目录直接放 SKILL.md**：即使单文件 skill 也要建自己的子目录。
3. **辅助数据/脚本放同目录**，让 skill 自包含。

\`\`\`bash
mkdir -p <skills-dir>/<slug>
# 写 SKILL.md 到该目录；如有辅助脚本/数据一并放入
\`\`\`

\`<skills-dir>/\` 就是 canonical source，不需要再 symlink 到别处。

## 验证

\`\`\`bash
ls -la <skills-dir>/<slug>/
\`\`\`

- [ ] \`SKILL.md\` 存在且 frontmatter 合法，\`name\`/\`description\` 非空
- [ ] 正文非空、有可执行步骤
- [ ] 没有写死敏感信息（账号、token、临时 session id）
- [ ] slug 不与已有冲突

## 输出给用户

完成后简短说明：skill slug、源文件路径（\`<skills-dir>/<slug>/SKILL.md\`）、是否加了 icon、是否含辅助脚本/数据。不要粘贴完整 SKILL.md，除非用户要求。

## 关键原则

- 用户要的是**能力沉淀**，不是复制对话。
- **分析在先**：先判断有没有值得沉淀的知识，没有就停，别硬凑，也别提前问目录。
- canonical source 永远在 \`<skills-dir>/<slug>/\`，单文件 skill 也要有自己的子目录。
- 区分事实 / 推测 / 待确认，不要过早把解决方案写死。`;

export const SKILLIFY_PROMPT_EN = `---
name: skillify
description: "Distil a successful workflow / investigation / tool-combo / habit into a reusable Skill. First analyze whether the conversation holds knowledge worth extracting, then distil it, and finally save it to the given directory."
argument-hint: "[placement directory] [target to skillify]"
---

# Skillify

Abstract "the thing you just pulled off" into a reusable skill. This is an **analyze → extract → save** flow:

- **Step 1 is always analysis**: first decide whether the conversation / recent context holds knowledge worth distilling into a skill. If not, say so and stop — never force it.
- The placement directory and other args are **only needed at the final save step** — do NOT front-load a "where should it go?" question.

Applies when the user says: "abstract this into a skill", "write up what we just learned as a skill", "do this automatically next time", "skillify this", "capture this workflow".

Core goal: **turn a one-time success into a stable procedure, not copy a transient chat into a prompt.**

## Arguments (all optional; used only at save time)

- **Trailing text** (after \`/skillify\`) = the object / lead to skillify; if omitted, distil from recent context.
- **Placement directory \`<skills-dir>\`** = where the skill lands; the canonical source goes to \`<skills-dir>/<slug>/SKILL.md\`. **Only needed at the "save" step**; ask only if the user hasn't provided it — never ask before analysis.

## Step 1: Analyze — is there knowledge worth capturing (scan → gate)

Answer "**should this even be extracted**" first. Most candidates die here, not in the writing.

### 1a. Three-phase scan: don't miss invisible skills

Review what you just did, sweeping each phase once, asking one question per phase: **is there a "non-obvious action / judgement" here?**

| Phase | What to scan | Why it's easily missed |
|---|---|---|
| Discovery | How did you locate / trigger / diagnose the real problem? Which signal did triage use? | No visible deliverable — most often missed |
| Decision | What justified the judgement call at the sticking point? Any reusable criterion? | Treated as "intuition", not realized it can be codified |
| Solution | Is the execution skeleton / tool-combo / verification reusable? | Visible — easiest to fixate on |

The scan is about **breadth, anti-omission**: people naturally notice only "solution" (it has deliverables), while "discovery / decision" — the diagnosing and judging moves — are high-value yet invisible.

> The three phases are only for **scanning candidates**, not chapters in SKILL.md. The body should be organized by **failure mode / investigation action**, not by these three categories.

### 1b. The real gate: don't over-extract

For each candidate, all four must pass:

- [ ] **Recurs**: will you hit this kind of scenario again? (One-off → a note is enough, no skill.)
- [ ] **Non-obvious**: is there an action / judgement you "wouldn't know without looking it up"? (Obvious things aren't worth codifying.)
- [ ] **Cost**: is the cost of getting it wrong / missing it high?
- [ ] **Stable**: is the procedure stable, not bound to this session's transient context / data?

Missing "non-obvious" or "recurs" → basically drop it.

**If nothing passes the gate → tell the user "not worth a skill this time", explain why, and stop.** Do not force a deliverable, and do not ask for a placement directory at this step.

### 1c. Merge or split: the boundary question

If discovery / decision / solution **all** surface candidates in one scenario, decide whether they go into **one closed-loop skill** or **split into a combination**:

- **Will any single phase be invoked alone?** Yes → split; always entered from the top → lean merge.
- **Is the value inside a phase or at the handoff?** At the handoff (upstream expected-state / contract must reach downstream for verification) → merge; each phase self-contained, handoff carries no info → splittable.
- **Would merging make one unit carry orthogonal failure modes?** Yes (e.g. static breadth vs dynamic-reasoning depth) → split.
- **Does this phase run first in other problems too?** Fan-out ≥2–3 → split into a reusable leaf.

**Third state (need both)**: when the loop must stay intact but a phase needs depth / reuse, use **orchestrator + leaf** — one closed-loop skill holds the contract and verification, delegating orthogonal phases to reusable sub-skills.

**Default to one closed-loop skill.** Split only on a real signal (a phase reused by a second scenario, or attention spread too thin for depth).

### 1d. Classify: decides how to write, not whether to extract

| Type | Example | Skill focus |
|---|---|---|
| Investigation | pull sources → build timeline → locate issue | evidence sources, steps, output template |
| Debug | reproduce → red test → fix → verify | invariants, tests, acceptance |
| Tool-combo | chain multiple log/monitor/analysis tools | query order, correlation IDs |
| Habit/convention | directory structure, naming, placement | path rules, naming rules |
| Writing template | issue / PR / retro report | structure, tone, prohibitions |

**Do NOT** write one-off details into the skill (a transient session, a full specific chat, a temporary verification code, etc.).

## Step 2: Extract — distil stable principles and draft

> If 1c decided on a split or orchestrator + leaf, run Step 2 once for **each** skill to land (each its own directory).

### 2a. Distil stable principles

Break the experience into:

- **Trigger**: when this skill should be used
- **Input**: what the user might provide, what to ask when it's missing
- **Evidence sources / tools**: which sources, files, CLIs, logs to check
- **Steps**: the stable, reusable execution order
- **Output**: what to hand the user, or what artifact to create
- **Boundaries**: what NOT to do, when to stop / ask
- **Verification**: how to confirm the skill worked

Write principles, not a play-by-play.

### 2b. Choose a slug

Slug: lowercase, alphanumeric + hyphen, short and clear, verb/task- or topic-oriented. Before drafting, \`ls <skills-dir>/\` to avoid collisions and match existing naming style (when the save dir is known).

### 2c. Draft SKILL.md

Use the generic-compatible frontmatter:

\`\`\`yaml
---
name: <slug-or-display-name>
description: "One line: what the skill does and when to use it."
argument-hint: "<optional, describe args>"
alwaysAllow: ["Bash"]      # optional
requiredSources: []         # optional
---
\`\`\`

Suggested body structure:

\`\`\`markdown
# <Skill Name>

One-line goal.

## Trigger / When to use
## Preconditions
## Workflow / Steps
## Output format
## Boundaries & prohibitions
## Verification
## Examples
\`\`\`

Writing style:

- Instructions must be executable, not vague.
- Don't write dead behaviors like "after reading, tell the user the rules are loaded".
- Action-type skills proceed by default; ask only when a key argument is missing.
- Keep concrete paths, APIs, command examples, but scrub one-off sensitive data.
- Match the existing style of the target skill library.

### 2d. Icon (optional)

- Prefer 3D / color / skeuomorphic style, consistent with existing visuals.
- Recommended source: Microsoft Fluent Emoji.
- Filename must be \`icon.svg\`/\`icon.png\`/\`icon.jpg\`/\`icon.jpeg\`, placed in the skill directory.
- No ad-hoc hand-drawn SVG stand-ins unless the user explicitly asks. If none fits, ask first — don't force one.

## Step 3: Save — land it in the given directory

**Only now do you need the placement directory \`<skills-dir>\`:**

- User gave a directory up front → use it directly.
- Not given → ask **now** where to put it; do not pick a directory on your own.

Conventions:

1. **One skill, one directory**: \`<skills-dir>/<slug>/SKILL.md\` (required) + optional \`icon.svg\` / \`references/\` / helper scripts.
2. **Never drop a SKILL.md directly in the \`<skills-dir>\` root**: even a single-file skill gets its own subdirectory.
3. **Keep helper data/scripts in the same directory** so the skill is self-contained.

\`\`\`bash
mkdir -p <skills-dir>/<slug>
# write SKILL.md into that dir; include helper scripts/data if any
\`\`\`

\`<skills-dir>/\` IS the canonical source — no need to symlink elsewhere.

## Verification

\`\`\`bash
ls -la <skills-dir>/<slug>/
\`\`\`

- [ ] \`SKILL.md\` exists, frontmatter valid, \`name\`/\`description\` non-empty
- [ ] Body non-empty with executable steps
- [ ] No hardcoded sensitive info (accounts, tokens, transient session ids)
- [ ] Slug doesn't collide with an existing one

## Output to the user

When done, briefly report: skill slug, source path (\`<skills-dir>/<slug>/SKILL.md\`), whether an icon was added, whether helper scripts/data are included. Don't paste the full SKILL.md unless asked.

## Key principles

- The user wants a **captured capability**, not a copied conversation.
- **Analysis first**: decide whether there's knowledge worth capturing; if not, stop — don't force it, and don't ask for a directory early.
- The canonical source always lives in \`<skills-dir>/<slug>/\`; even a single-file skill gets its own subdirectory.
- Distinguish fact / hypothesis / to-be-confirmed; don't hardcode a solution too early.`;
