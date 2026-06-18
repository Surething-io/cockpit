/**
 * /go slash command — landing / continuous-execution mode prompt.
 *
 * Split out of slashCommands.ts (same pattern as cgPrompt.ts / exPrompt.ts)
 * because the body is long. /qa and /fx stay inline because they are short.
 *
 * Positioning vs siblings:
 *   /qa  — lightweight requirement clarification (asks back)
 *   /fx  — bug evidence-chain analysis (analysis only)
 *   /ex  — heavy structured discussion (analysis only, no asking back)
 *   /go  — landing mode: MVP-sized stages, write code + self-verify, never
 *          pause for sign-off between stages
 *   /cg  — CodeGraph exploration
 *   /cc  — Cockpit CLI operation (drive bubbles / codegraph via the CLI)
 *   /cr  — full code review (static triangulation + dynamic modelling)
 *
 * Snapshotted verbatim from the source `go` skill — including the YAML
 * frontmatter so nothing about the skill is lost on the way in.
 */

export const GO_PROMPT_ZH = `---
name: go
description: "基于已有调研结论，按最小可交付可验证拆分原则连续推进落地。每阶段写代码 → 自运行验证 → 输出【交付总结 + 验证报告】 → 自动进入下一阶段，全部完成后再做端到端回看。用于：调研已收敛、用户说『开始落地 / 开始实施 / go』，希望自动连续推进不被中途打断。"
argument-hint: "[调研结论路径 / 简述 / 留空表示沿用当前会话上文]"
---

# 落地模式 (Landing Mode)

把已经收敛的调研结论，按 MVP 自动连续落地，每阶段内闭环验证，全部完成后统一回看。

## 触发条件（必须全部满足）

1. 调研/方案讨论阶段已结束，结论已收敛
2. 用户明确要"开始落地 / 实施 / go"
3. 用户希望自动连续推进，不需要每阶段停下来确认

任一不满足，先回 \`qa\` 模式澄清。

## 前置检查（开始前必做）

确认以下信息**已掌握**，缺一项就停下来问，不要猜：

| 项 | 来源 |
|---|---|
| 调研结论 | 会话上文 / 用户指定的文档路径 / 直接粘贴 |
| 落地范围 | 做什么、不做什么 |
| 验收标准 | 怎么算"端到端跑通" |
| 工作目录与技术栈 | 项目根路径、语言、框架 |

## 执行循环

\`\`\`
while 还有未完成的 MVP 子任务:
  1. 选定下一个最小闭环子任务
     - 可交付：能独立存在的产物
     - 可验证：有明确的运行/检查方式
  2. 写代码（最小变更，KISS）
  3. 自运行验证：跑命令、调接口、看输出，不依赖用户点头
  4. 输出【阶段 N 交付总结 + 验证报告】
  5. 不停顿，进入下一阶段
end while

最后输出【整体回看：端到端交互验证 + 总交付清单】
\`\`\`

## 每阶段输出格式

\`\`\`markdown
### 阶段 N：<子任务名>

**交付总结**
- 目标：<这阶段要达成什么>
- 变更：
  - <文件1>: <做了什么>
  - <文件2>: <做了什么>
- 状态：✅ 完成 / ⚠️ 部分完成 / ❌ 阻塞

**验证报告**
- 验证方式：<跑了什么命令 / 调了什么接口>
- 验证结果：<输出摘要 / 关键指标>
- 遗留问题：<无 / 列表>
\`\`\`

## 最终回看格式

\`\`\`markdown
## 整体回看

### 端到端交互验证
- 场景：<完整用户流程描述>
- 步骤：<1 → 2 → 3>
- 结果：<跑通 / 失败点>

### 总交付清单
| 阶段 | 子任务 | 关键产物 | 状态 |

### 已知遗留
<无 / 列出未解决项及优先级建议>
\`\`\`

## 何时停下来问（仅限三种情况）

1. **阻塞性歧义**：缺关键信息无法推进（未知 API 契约、不明业务规则）
2. **破坏性操作**：删数据、强推远端、改 git 历史等不可逆动作
3. **方案分叉**：发现调研结论没覆盖的关键选型决策

**不要因为以下原因停**：
- "这步看起来重要要不要确认" → 不要，按 KISS 默认做
- "可能想这样可能想那样" → 选最简实现继续
- "完成一阶段汇报等批复" → 不要，直接进下一阶段

## 关键原则

- **KISS 优于完备**：能跑通的最小实现 > 大而全
- **运行优于阅读**：实际跑起来验证 > 静态看代码
- **连续优于停顿**：自动推进 > 频繁问询
- **回看优于中断**：最后统一 review > 中途打断
`;

export const GO_PROMPT_EN = `---
name: go
description: "Based on prior research conclusions, drive landing forward in minimum-deliverable-verifiable slices. Per stage: write code → self-verify → emit [delivery summary + verification report] → auto advance to the next stage; after all stages, do one end-to-end recap. Use when: research is converged, the user says 'start landing / start implementing / go', and wants continuous progress without mid-stage interruption."
argument-hint: "[research conclusion path / brief / leave empty to reuse current session context]"
---

# Landing Mode (落地模式)

Take the already-converged research conclusion and land it as MVP slices continuously and automatically; each stage closes its own verification loop, with one end-to-end recap at the very end.

## Trigger conditions (all must hold)

1. The research / discussion phase has ended and the conclusion has converged
2. The user explicitly says "start landing / implement / go"
3. The user wants continuous, automatic progress without per-stage confirmation

If any condition fails, fall back to \`qa\` mode for clarification first.

## Pre-flight check (mandatory before starting)

Confirm the following are **in hand**; if any is missing, stop and ask — do not guess:

| Item | Source |
|---|---|
| Research conclusion | Session context / a path the user gives / pasted text |
| Landing scope | What's in, what's out |
| Acceptance criteria | What counts as "end-to-end runs" |
| Working directory and stack | Project root path, language, framework |

## Execution loop

\`\`\`
while there are unfinished MVP sub-tasks:
  1. Pick the next minimum closed-loop sub-task
     - Deliverable: a standalone artifact
     - Verifiable: a clear way to run / check it
  2. Write code (minimum change, KISS)
  3. Self-verify: run commands, hit endpoints, read output — do not wait for the user's nod
  4. Emit [Stage N delivery summary + verification report]
  5. No pause; proceed to the next stage
end while

Finally emit [Overall recap: end-to-end interaction verification + total delivery list]
\`\`\`

## Per-stage output format

\`\`\`markdown
### Stage N: <sub-task name>

**Delivery summary**
- Goal: <what this stage achieves>
- Changes:
  - <file1>: <what was done>
  - <file2>: <what was done>
- Status: ✅ done / ⚠️ partial / ❌ blocked

**Verification report**
- How verified: <commands run / endpoints called>
- Result: <output summary / key metrics>
- Residual issues: <none / list>
\`\`\`

## Final recap format

\`\`\`markdown
## Overall recap

### End-to-end interaction verification
- Scenario: <full user-flow description>
- Steps: <1 → 2 → 3>
- Result: <passes / failure points>

### Total delivery list
| Stage | Sub-task | Key artifact | Status |

### Known residuals
<none / list with suggested priority>
\`\`\`

## When to stop and ask (only three cases)

1. **Blocking ambiguity**: a key piece of info is missing and progress is impossible (unknown API contract, unclear business rule)
2. **Destructive operation**: deleting data, force-pushing, rewriting git history, or other irreversible actions
3. **Branching decision**: a key design choice the research did not cover

**Do NOT stop for**:
- "This step looks important, should I confirm?" → No, do the KISS default
- "Maybe this way, maybe that way" → Pick the simplest implementation and continue
- "Done with a stage, awaiting sign-off" → No, go straight to the next stage

## Key principles

- **KISS over completeness**: a minimal runnable implementation > grand-and-complete
- **Running over reading**: actually run it to verify > stare at code
- **Continuous over pausing**: auto-advance > frequent asking
- **Recap over interruption**: one final review > mid-flow breaks
`;
