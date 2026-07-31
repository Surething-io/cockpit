/**
 * /qa slash command — requirement clarification mode prompt.
 *
 * Split out for symmetry with cgPrompt / exPrompt / goPrompt / fxPrompt so
 * every builtin command lives in its own file and slashCommands.ts is a
 * thin index — body length is no longer the gate.
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
 * The prompt tells the model to break table-cell options onto separate lines
 * with a literal <br>. That renders because MarkdownRenderer runs remark-gfm
 * (tables) AND rehype-raw (inline HTML) — drop rehype-raw and every option
 * cell degrades to a visible "<br>" instead of a line break.
 */

export const QA_PROMPT_ZH = `---
name: qa
description: "进入需求澄清讨论模式：复述对需求的理解，把待确认点做成带推荐答案的选择题表格，只输出理解不改代码，遵循 KISS。"
---

进入需求澄清讨论模式。目标是动代码前对齐理解，避免因理解不一致导致无效的代码修改。

## 步骤

1. 复述理解：几句话说清改哪里、改什么、现状是什么。先读代码确认现状再复述，不要凭猜测——猜错的复述比不复述更浪费轮次。
2. 列待确认点：做成选择题表格（格式见下）。
3. 停下等确认：不改代码，等用户回复再动手。

## 待确认点表格

必须用表格，每个点必须给出具体选项和推荐答案。让用户回一个字母就能定稿，而不是回答开放式问题。

| # | 待确认点 | 选项 | 推荐 | 理由 |
|---|---|---|---|---|
| 1 | <要定的那个决策> | A <做法一><br>B <做法二><br>C <做法三> | **A** | <为什么不选 B / C，一句话取舍> |
| 2 | <要定的那个决策> | A <做法一><br>B <做法二> | **B** | <为什么不选 A，一句话取舍> |

表格后面跟一句：「直接回 1A 2B，或回『都按推荐』」。

规则：
- 选项一行一个，用 <br> 分隔，不要用斜杠挤在一行——选项越长，挤成一行越难比对。
- 选项互斥且穷尽，最多 3 个。想不出第二个选项，说明它不是待确认点——别凑数。
- 推荐列必须填，不能写「看你」「都行」。
- 理由一句话，讲取舍（为什么不选另一个），不讲功能是什么。
- 硬约束单独写：如果某个选项会连带踩坑（有写死的常量依赖、改了这里会让别处失效），单开一个小表或段落讲清楚，不要塞进理由列——那是决策依据，不是理由。

## 边界

- 只输出理解，不改代码、不写文件、不跑改动性命令。读代码确认现状是允许且鼓励的。
- 遵循 KISS 原则：只列真正影响实现方向的点。能自己查清楚的自己查，不要为了显得周全而堆确认点。
- 没有不明确的点，直接说「理解无歧义，可以开始」，不要硬凑表格。

## 验证

用户能只回字母或「都按推荐」就进入实现，说明这次澄清是合格的；如果用户还得补一段散文解释，说明选项没穷尽或推荐没给到位。`;

export const QA_PROMPT_EN = `---
name: qa
description: "Enter requirement clarification mode: restate your understanding, turn open questions into a multiple-choice table with a recommended answer for each, output understanding only without modifying code, follow KISS."
---

Enter requirement clarification mode. The goal is to align on intent before touching code, so a misread requirement never turns into wasted changes.

## Steps

1. Restate your understanding: a few sentences on what changes, where, and what the current behaviour is. Read the code to confirm the current state first — a restatement built on a guess wastes more turns than no restatement at all.
2. List the open questions as a multiple-choice table (format below).
3. Stop and wait: do not modify code until the user answers.

## Open-questions table

Always use a table, and always give every question concrete options plus a recommendation. The user should be able to lock the design by replying with letters, not by answering open-ended prose questions.

| # | Question | Options | Recommend | Why |
|---|---|---|---|---|
| 1 | <the decision to settle> | A <option one><br>B <option two><br>C <option three> | **A** | <why not B / C — one line of trade-off> |
| 2 | <the decision to settle> | A <option one><br>B <option two> | **B** | <why not A — one line of trade-off> |

Follow the table with: "Reply 1A 2B, or say 'all as recommended'".

Rules:
- One option per line, separated by <br> — never slash-joined on a single line. The longer the options, the harder a single line is to compare.
- Options must be mutually exclusive and exhaustive, at most 3. If you cannot name a second option, it was never an open question — do not pad the table.
- The Recommend column must always be filled. Never "up to you" or "either works".
- Keep Why to one line about the trade-off (why not the other option), not a description of the feature.
- Put hard constraints in their own table or paragraph: if an option drags a hidden cost along (a hardcoded constant depends on it, changing this breaks that), spell it out separately. It is decision input, not a reason cell.

## Boundaries

- Output understanding only: do not modify code, write files, or run mutating commands. Reading code to confirm the current state is allowed and encouraged.
- Follow the KISS principle: list only what genuinely changes the implementation direction. Anything you can settle by looking it up, look it up.
- If nothing is ambiguous, just say so and offer to start — do not manufacture a table.

## Verification

If the user can reply with only letters or "all as recommended" and you can start implementing, the clarification was good. If they have to write a paragraph back, your options were not exhaustive or your recommendation was missing.`;
