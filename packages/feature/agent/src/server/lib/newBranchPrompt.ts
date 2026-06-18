/**
 * /new-branch slash command — create a clean branch off the latest origin/main.
 *
 * Split out per the one-file-per-command convention (see qaPrompt / goPrompt).
 * Unlike the analysis-only commands (/qa, /fx, /ex), this one ACTUALLY runs git
 * (fetch → checkout -b → rev-list verify), closer in spirit to /go.
 *
 * EN is a faithful translation of the ZH body. Label primes the trailing text
 * as an intent / requirement rather than a neutral "question".
 */

export const NEW_BRANCH_LABEL_ZH = '需求：';
export const NEW_BRANCH_LABEL_EN = 'Intent: ';

export const NEW_BRANCH_PROMPT_ZH = `---
name: new-branch
description: "创建一个基于最新 origin/main 的新分支：fetch 远端 → 从 origin/main 切出新分支 → 校验已与远端同步。用于：用户说『新建分支 / 创建分支 / new branch』，希望新分支干净地起步于最新主干。"
argument-hint: "[分支名，留空则询问]"
---

# New Branch (基于最新主干创建分支)

从最新的 \`origin/main\` 切出一个新分支，确保起点干净、与远端同步。

## 触发条件

用户要"新建分支 / 创建分支 / new branch / 切个分支"，且希望基于最新主干。

## 范围边界（重要）

本 skill **只负责快速创建一个干净的新分支**，到"切完即校验"为止。

- **只做**：fetch → 从 \`origin/main\` 切分支 → 校验同步 → 输出确认。
- **不做**：探索 / 阅读代码、起 Explore / Plan agent、生成实现计划、开始写代码。

用户在触发时附带的需求描述（如"优化 add to slack 引导流程"）**仅用于推导分支名 / 记录意图**，
不是要在这一步开始的开发任务。后续需求细化与实现由用户在新的对话里另行讨论，不属于本 skill 范围。

## 前置检查

1. 确认分支名（分支名一律用英文，遵循 \`<type>/<short-desc>\` 习惯，如 \`feat/credit-guard\`、\`fix/stream-recovery\`）：
   - 用户已给出现成分支名 → 直接用。
   - 用户给的是一句需求描述（如"优化 add to slack 引导流程"）→ **据此自动推导**一个英文分支名（如 \`feat/slack-onboarding-flow\`）直接创建，不必再问。
   - 完全没有可推导的信息 → 才询问。
2. 确认当前工作区干净（\`git status\`）。若有未提交改动，先停下来问用户如何处理，不要强行切换。

## 执行步骤

\`\`\`bash
# 1. 拉取最新远端主干
git fetch origin main

# 2. 基于最新 origin/main 创建并切换到新分支
git checkout -b <branch-name> origin/main

# 3. 校验：应领先 0、落后 0
git rev-list --left-right --count origin/main...HEAD
\`\`\`

\`git checkout -b <name> origin/main\` 一步即可保证新分支起点 = 最新远端主干，无需先更新本地 main。

## 校验标准

- \`git rev-list --left-right --count origin/main...HEAD\` 输出 \`0	0\`（领先 0、落后 0）。
- \`git status\` 显示在新分支上、工作区干净。

输出确认：分支名、当前 HEAD 提交、与 origin/main 的同步状态。

## 何时停下来问

- 既无现成分支名、也无可推导的需求描述 → 询问。
- 工作区有未提交改动 → 询问如何处理（stash / 提交 / 放弃），不要擅自丢弃。
- 已存在同名分支 → 询问是覆盖还是换名。

## 关键原则

- **起点即最新**：始终基于 \`origin/main\`，不基于可能过时的本地 main。
- **不丢改动**：任何可能丢失用户工作的操作前先确认。
- **切完即校验**：用 rev-list 确认确实同步，不靠假设。`;

export const NEW_BRANCH_PROMPT_EN = `---
name: new-branch
description: "Create a new branch off the latest origin/main: fetch remote → branch from origin/main → verify it is in sync with the remote. Use when the user says 'new branch / create a branch', wanting the new branch to start cleanly from the latest mainline."
argument-hint: "[branch name; ask if omitted]"
---

# New Branch (create a branch off the latest mainline)

Branch off the latest \`origin/main\` so the starting point is clean and in sync with the remote.

## Trigger

The user asks to "create a new branch / new branch / cut a branch" and wants it based on the latest mainline.

## Scope (important)

This skill is **only responsible for quickly creating a clean new branch**, up to "verify right after cutting".

- **Do**: fetch → branch from \`origin/main\` → verify sync → output confirmation.
- **Do NOT**: explore / read code, spawn Explore / Plan agents, produce an implementation plan, or start writing code.

Any requirement description the user includes at trigger time (e.g. "improve the add-to-slack onboarding flow") is **only used to derive the branch name / record intent**, not a dev task to start here. Follow-up requirement refinement and implementation are discussed by the user in a new conversation and are out of scope for this skill.

## Pre-checks

1. Confirm the branch name (always in English, following the \`<type>/<short-desc>\` convention, e.g. \`feat/credit-guard\`, \`fix/stream-recovery\`):
   - User already gave a ready branch name → use it directly.
   - User gave a requirement sentence (e.g. "improve the add-to-slack onboarding flow") → **derive** an English branch name from it (e.g. \`feat/slack-onboarding-flow\`) and create it directly, no need to ask.
   - No derivable information at all → only then ask.
2. Confirm the working tree is clean (\`git status\`). If there are uncommitted changes, stop and ask the user how to handle them; do not force-switch.

## Steps

\`\`\`bash
# 1. Fetch the latest remote mainline
git fetch origin main

# 2. Create and switch to the new branch off the latest origin/main
git checkout -b <branch-name> origin/main

# 3. Verify: should be 0 ahead, 0 behind
git rev-list --left-right --count origin/main...HEAD
\`\`\`

\`git checkout -b <name> origin/main\` in one step guarantees the new branch's start = the latest remote mainline; no need to update local main first.

## Verification

- \`git rev-list --left-right --count origin/main...HEAD\` outputs \`0	0\` (0 ahead, 0 behind).
- \`git status\` shows you are on the new branch with a clean working tree.

Output confirmation: branch name, current HEAD commit, and sync status against origin/main.

## When to stop and ask

- No ready branch name and no derivable requirement description → ask.
- Uncommitted changes in the working tree → ask how to handle (stash / commit / discard); never discard on your own.
- A branch with the same name already exists → ask whether to overwrite or rename.

## Key principles

- **Start from the latest**: always base on \`origin/main\`, never on a possibly stale local main.
- **Never lose changes**: confirm before any operation that could lose the user's work.
- **Verify right after cutting**: use rev-list to confirm actual sync; never assume.`;
