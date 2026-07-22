/**
 * /cc slash command — Cockpit CLI (`cock` / `cockpit`) overview.
 *
 * Minimal by design: tells the model WHAT the CLI is and WHAT subcommands
 * exist, then points at \`cock <subcommand> --help\` for everything else.
 * Concrete scenarios / flag tables / exit codes / output formats are
 * baked into each subcommand's own --help (see cock-codegraph.mjs etc.)
 * so they stay co-located with the implementation — repeating them here
 * would create a second source of truth that drifts.
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

export const CC_PROMPT_ZH = `---
name: cc
description: "进入 Cockpit CLI（cock/cockpit 子命令）操作模式：通过瘦客户端驱动本机 server 的 terminal/browser 气泡与 codegraph 等子命令。"
---

进入 Cockpit CLI 操作模式

Cockpit CLI 是本机 Cockpit server 的瘦客户端：每个调用都把请求转发到正在跑的 server，复用其索引、缓存、git 视图等。

CLI 入口选择（**默认 = prod**）：

- 默认用 **\`cockpit\`**（prod，端口 3457）—— 没有明确信号就用这个
- 仅在用户**明确给出 dev 信号**时才换成 \`cockpit-dev\`（dev，端口 3456），两种信号：
  1. 任务文本里直接写了 \`cockpit-dev ...\`
  2. \`/cc\` 后第一个词是 \`dev\`（例：\`/cc dev terminal bmfb 看错误\`）
- \`cock\` 是 \`cockpit\` 的 prod 短别名，行为一致；dev 无对应短别名

下文统一写 \`cockpit\`，仅在上述 dev 信号触发时替换为 \`cockpit-dev\`。

## 子命令

| 子命令 | 用途 |
|---|---|
| (无) / \`<path>\` | 启动 server，打开项目 |
| \`browser <id> <action>\` | 控制浏览器气泡 |
| \`terminal <id> [<action>]\` | 只读观察终端 ring buffer |
| \`codegraph <subcmd>\` | 项目代码图(search/callers/callees/impact/file/coedit/context/related/risk/affected) |
| \`update\` | 升级到最新 npm 版本 |

## 典型用法模式

UI 上的 terminal / browser 气泡带一个 4 字符短 id（如 \`bmfb\` / \`mpcw\`）。用户输入 \`/cc\` 后通常跟一段 \`cockpit <subcmd> <id> <要做的事>\` 描述，例如：

\`\`\`
/cc cockpit terminal bmfb 看一下最近的错误日志           ← 默认 prod (cockpit)
/cc cockpit browser mpcw 截图当前页面                    ← 默认 prod (cockpit)
/cc cockpit codegraph risk searchIndex 评估改这个的影响  ← 默认 prod (cockpit)
/cc dev terminal aqou 看一下错误                         ← dev 信号 #2 → 用 cockpit-dev
/cc cockpit-dev codegraph file packages/...              ← dev 信号 #1 → 用 cockpit-dev
\`\`\`

收到这类输入时：
1. 把 \`<id>\` 当作具体的气泡标识传给对应子命令
2. 先跑 \`cockpit <subcmd> <id>\`（或 \`<subcmd> --help\`）看支持的 action
3. 选合适的 action 执行用户任务

## 先看气泡清单（不知道用哪个 id 时）

当用户用 "alloydb 那个 terminal" / "看一下后台" 这种**语义指代**而非具体 id 时，先用 \`connection list\` 拿到当前项目所有气泡 + 用户起的 title：

\`\`\`bash
cockpit connection list --cwd \$PWD
\`\`\`

输出每行：\`<type>  <shortId>  <title>  <projectCwd>  <command-or-url>\`（TAB 分隔）。按 title 匹配用户的语义指代挑出 \`<shortId>\`，再走「典型用法模式」。title 没设的气泡显示为 \`(none)\`，此时可结合 \`<command>\` 字段（terminal 的命令字符串 / browser 的 URL）区分。

## 获取详细用法

每个子命令的 \`--help\` 是 canonical reference，**包含 usage / flags / 输出格式 / exit code / 示例**。先看 help 再用：

\`\`\`bash
cockpit --help
cockpit <subcommand> --help
cockpit codegraph <subsubcmd> --help
\`\`\``;

export const CC_PROMPT_EN = `---
name: cc
description: "Enter Cockpit CLI (cock/cockpit subcommands) operation mode: drive the running server's terminal/browser bubbles and codegraph subcommands through the thin local client."
---

Enter Cockpit CLI operation mode.

The Cockpit CLI is a thin local client over the running Cockpit server: each invocation forwards to the server and reuses its CodeIndex / caches / git views.

CLI entry point selection (**default = prod**):

- Default: **\`cockpit\`** (prod, port 3457) — use this when no explicit dev signal is given.
- Switch to \`cockpit-dev\` (dev, port 3456) ONLY when the user explicitly signals dev mode, via one of:
  1. They write \`cockpit-dev ...\` directly in the task text.
  2. The first word after \`/cc\` is \`dev\` (e.g. \`/cc dev terminal bmfb check the errors\`).
- \`cock\` is the prod-only short alias of \`cockpit\`; behaviour is identical. There is no short alias for dev.

Examples below use \`cockpit\`; only swap in \`cockpit-dev\` when one of the two dev signals above is present.

## Subcommands

| Subcommand | Purpose |
|---|---|
| (none) / \`<path>\` | Start server, open project |
| \`browser <id> <action>\` | Drive browser bubbles |
| \`terminal <id> [<action>]\` | Read-only observation of a terminal ring buffer |
| \`codegraph <subcmd>\` | Project code graph (search/callers/callees/impact/file/coedit/context/related/risk/affected) |
| \`update\` | Upgrade to latest npm version |

## Typical usage pattern

Terminal / browser bubbles in the UI carry a 4-char short id (e.g. \`bmfb\` / \`mpcw\`). After \`/cc\` users typically follow with \`cockpit <subcmd> <id> <what to do>\`, e.g.:

\`\`\`
/cc cockpit terminal bmfb look at the recent error logs           ← default prod (cockpit)
/cc cockpit browser mpcw take a screenshot of the current page    ← default prod (cockpit)
/cc cockpit codegraph risk searchIndex assess the impact          ← default prod (cockpit)
/cc dev terminal aqou check the errors                            ← dev signal #2 → use cockpit-dev
/cc cockpit-dev codegraph file packages/...                       ← dev signal #1 → use cockpit-dev
\`\`\`

When you receive such input:
1. Treat \`<id>\` as the concrete bubble identifier and pass it to the subcommand
2. Run \`cockpit <subcmd> <id>\` (or \`<subcmd> --help\`) first to see supported actions
3. Pick the right action to fulfil the user's task

## When you don't know which id to use — list bubbles first

If the user refers to a bubble semantically ("the alloydb proxy terminal" / "the admin page") rather than by id, list every bubble in the current project — each one carries any user-set title:

\`\`\`bash
cockpit connection list --cwd \$PWD
\`\`\`

Output rows are TAB-separated: \`<type>  <shortId>  <title>  <projectCwd>  <command-or-url>\`. Match the user's reference against the title, take the \`<shortId>\`, then proceed with the typical usage pattern. Unnamed bubbles show \`(none)\` for title — fall back to the \`<command>\` column (terminal's command string / browser's URL) to disambiguate.

## Getting detailed usage

Every subcommand's \`--help\` is the canonical reference — **it includes usage, flags, output format, exit codes, and examples.** Read it first:

\`\`\`bash
cockpit --help
cockpit <subcommand> --help
cockpit codegraph <subsubcmd> --help
\`\`\``;
