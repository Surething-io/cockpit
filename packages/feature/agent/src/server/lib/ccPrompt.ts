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
 * Trailing user text is labeled "任务：" / "Task: " (vs the neutral
 * "问题：" / "Question: ") so the model treats follow-on text as an
 * action to execute via the CLI rather than a question to answer in
 * prose. `labelFor` in slashCommands.ts picks these up automatically.
 */

export const CC_LABEL_ZH = '任务：';
export const CC_LABEL_EN = 'Task: ';

export const CC_PROMPT_ZH = `进入 Cockpit CLI 操作模式

Cockpit CLI 是本机 Cockpit server 的瘦客户端：每个调用都把请求转发到正在跑的 server，复用其索引、缓存、git 视图等。

CLI 入口：**推荐用 \`cockpit\`**（prod，默认端口 3457）；dev 环境用 \`cockpit-dev\`（默认端口 3456）。\`cock\` 是 \`cockpit\` 在 prod 下的短别名，行为一致；dev 没有对应短别名。下文统一写 \`cockpit\`，dev 环境替换成 \`cockpit-dev\` 即可。

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
/cc cockpit terminal bmfb 看一下最近的错误日志
/cc cockpit browser mpcw 截图当前页面
/cc cockpit codegraph risk handleSlackMention 评估改这个的影响
\`\`\`

收到这类输入时：
1. 把 \`<id>\` 当作具体的气泡标识传给对应子命令
2. 先跑 \`cockpit <subcmd> <id>\`（或 \`<subcmd> --help\`）看支持的 action
3. 选合适的 action 执行用户任务

## 获取详细用法

每个子命令的 \`--help\` 是 canonical reference，**包含 usage / flags / 输出格式 / exit code / 示例**。先看 help 再用：

\`\`\`bash
cockpit --help
cockpit <subcommand> --help
cockpit codegraph <subsubcmd> --help
\`\`\``;

export const CC_PROMPT_EN = `Enter Cockpit CLI operation mode.

The Cockpit CLI is a thin local client over the running Cockpit server: each invocation forwards to the server and reuses its CodeIndex / caches / git views.

CLI entry point: **prefer \`cockpit\`** (prod, default port 3457); for the dev server use \`cockpit-dev\` (default port 3456). \`cock\` is the prod-only short alias of \`cockpit\`; behaviour is identical. There is no short alias for dev. Examples below use \`cockpit\`; substitute \`cockpit-dev\` for the dev environment.

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
/cc cockpit terminal bmfb look at the recent error logs
/cc cockpit browser mpcw take a screenshot of the current page
/cc cockpit codegraph risk handleSlackMention assess the impact of changing this
\`\`\`

When you receive such input:
1. Treat \`<id>\` as the concrete bubble identifier and pass it to the subcommand
2. Run \`cockpit <subcmd> <id>\` (or \`<subcmd> --help\`) first to see supported actions
3. Pick the right action to fulfil the user's task

## Getting detailed usage

Every subcommand's \`--help\` is the canonical reference — **it includes usage, flags, output format, exit codes, and examples.** Read it first:

\`\`\`bash
cockpit --help
cockpit <subcommand> --help
cockpit codegraph <subsubcmd> --help
\`\`\``;
