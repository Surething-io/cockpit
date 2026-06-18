/**
 * /ex slash command — structured discussion / analysis mode prompt.
 *
 * Split out of slashCommands.ts (same pattern as cgPrompt.ts) because the body
 * is long enough to drown the registry. /qa and /fx stay inline because they
 * are short; /ex is a full methodology skeleton.
 *
 * Positioning vs siblings:
 *   /qa  — lightweight requirement clarification, ASKS the user back
 *   /fx  — bug evidence-chain analysis (analysis only)
 *   /ex  — heavy structured discussion (analysis only, no asking back)
 *   /go  — landing mode (writes code, self-verifies per stage)
 *   /cg  — CodeGraph exploration
 *   /cc  — Cockpit CLI operation (drive bubbles / codegraph via the CLI)
 *   /cr  — full code review (static triangulation + dynamic modelling)
 *
 * Snapshotted verbatim from the source `ex` skill — including the YAML
 * frontmatter so nothing about the skill is lost on the way in.
 */

export const EX_PROMPT_ZH = `---
name: ex
description: "结构化讨论 skill：用'问题研究 + 假设-验证循环 + 发散-收敛-发散-迭代验证-总结 + What/Why/How + 对比矩阵'方法论分析复杂问题。用户通过 \`/ex\` 显式触发。仅分析不改代码。"
---

# ex — 结构化讨论 skill

用一套固定的思考骨架分析复杂问题。**只输出分析，不修改代码。**

## 入口：复杂度判断

收到问题后，**先判断复杂度**：

- **简单问题** → 直接简答，**不套方法论**（KISS）
- **复杂问题** → 走完整方法论骨架（下方 6 步）

判断标准（任一即视为复杂）：
- 涉及多个候选方案需要权衡
- 存在多个可能假设需要验证
- 跨多个模块/系统/层次
- 用户明确要求深入讨论

## 方法论骨架（仅复杂问题）

按顺序一次性走完，**不中途停下问用户**：

\`\`\`
1. 问题研究    用 What / Why / How 三个切面把问题本身研究清楚
2. 发散        穷举可能的假设、方案、视角
3. 收敛        筛出 Top 1-3
4. 再发散      对优选做深入展开（细节、风险、边界条件）
5. 迭代验证    用代码检索 / Web 搜索 / Bash 实验 验证关键假设
6. 总结        给结论；若多方案/多假设并排，用对比矩阵
\`\`\`

### What / Why / How 切面（贯穿全流程）

- **What**：问题/方案是什么，边界在哪
- **Why**：为什么会有这个问题、为什么选这个方案
- **How**：怎么实现、怎么落地、怎么验证

## 执行规则

### 一次性走完，不打断用户

- 全程**不调用 AskUserQuestion**
- 信息不足时 → 明确标注 **"⚠️ 待补充：xxx"**，由用户后续追问补充
- 不要因为信息不全就中断流程，能推到哪推到哪

### 验证手段

允许的验证方式：

| 手段 | 工具 | 使用场景 |
|---|---|---|
| 代码检索 | Grep / Read / Glob | 在仓库中找证据验证假设 |
| Web 搜索 | WebSearch / WebFetch | 查官方文档、外部资料 |
| Bash 实验 | Bash | 跑小命令、测试脚本、curl |

**禁止**：通过 AskUserQuestion 向用户提问验证。

## 输出规则

- **不强制固定输出结构**，按问题特点灵活组织
- **对比矩阵不是必选项**，仅在"多方案/多假设需要并排比较"时才出
- 简单问题就简短回答，不要为了套框架而套框架

## 不做什么

- ❌ 不修改代码（这是讨论 skill，不是实施 skill）
- ❌ 不中途问用户（一次走完）
- ❌ 不强制对每个问题都输出对比矩阵
- ❌ 不和 \`/qa\`、\`/fx\` 抢戏 —— 三者并列，由用户显式选择触发
`;

export const EX_PROMPT_EN = `---
name: ex
description: "Structured discussion skill: analyze complex problems with the methodology of 'problem study + hypothesis-verify loop + diverge-converge-diverge-iterate-verify-summarize + What/Why/How + comparison matrix'. Explicitly triggered by the user via \`/ex\`. Analysis only; do not modify code."
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

\`\`\`
1. Problem study   Clarify the problem itself through What / Why / How
2. Diverge         Enumerate candidate hypotheses, solutions, perspectives
3. Converge        Pick the top 1-3
4. Diverge again   Deep-dive into the chosen ones (details, risks, edge cases)
5. Iterate-verify  Verify key hypotheses via code search / web search / bash experiments
6. Summarize       Conclude; use a comparison matrix when multiple options sit side by side
\`\`\`

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
- ❌ Do not compete with \`/qa\` or \`/fx\` — the three are siblings, triggered explicitly by the user`;
