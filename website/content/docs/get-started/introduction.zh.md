OpenCockpit 是 Claude Code 的开源 GUI —— 也是你后续想接入的任何 AI agent 的统一画布。一切都在本地完成。

## 你能得到什么

- **多项目并行会话。** 跨不同项目同时跑 5+ 个 agent 会话。每个会话有自己的 tab；结束时桌面会弹 toast 通知你。
- **接入任意 agent。** Claude 开箱即用。Codex、DeepSeek、Kimi（月之暗面）、本地 Ollama 模型只需新开一个 tab —— 粘贴 API key（Ollama 连 key 都不要）。
- **不止于聊天。** 真实终端、Chrome 自动化、PostgreSQL / MySQL / Redis / Neo4j / Jupyter 气泡 —— 全部在同一个窗口里，agent 都能驱动。
- **代码感知的导航。** LSP 跳转定义、函数调用图（Code Map）、让 AI 通过 HTTP 探索项目图的 `/cg` 斜杠命令。

## 三个面板

Cockpit 整个 UI 就是三个并行渲染的面板。它们永远不卸载 —— 切换只是 CSS translate。`Cmd+1 / 2 / 3` 切换；触控设备上可以左右滑。

| 面板 | 快捷键 | 作用 |
|---|---|---|
| **Agent** | `Cmd+1` | 多 tab 对话：Claude / Codex / DeepSeek / Kimi / Ollama |
| **Explorer** | `Cmd+2` | 文件浏览、代码查看、Git、LSP、代码图 |
| **Console** | `Cmd+3` | 终端 + 浏览器 + 数据库气泡，全部命令驱动 |

### 面板 1 —— Agent（`Cmd+1`）

聊天界面。每个 tab 是一个独立会话，对接你选的引擎。

- **引擎。** Claude / Codex / DeepSeek / Kimi（月之暗面）/ Ollama —— 每 tab 独立切换。Claude 开箱即用；其它一次性配 key（Ollama 连 key 都不用）。
- **会话。** 把会话固定到侧栏、fork 一份分叉对话、通过侧栏 sessions 图标打开 Session Browser 跨项目搜索。
- **AI 模式斜杠命令。** 在聊天输入框打 `/` 弹出**六个**模式菜单，改变 AI 接下来的工作方式：`/qa`（改代码前先澄清需求）、`/fx`（bug 证据链，只分析）、`/ex`（深度结构化分析）、`/go`（落地模式 —— MVP 分阶段实现 + 自验证）、`/cg`（CodeGraph 探索）、`/cc`（Cockpit CLI 端到端验证）。通过 `SKILL.md` 安装的 Skills 也在同一菜单里以 `/skill-name` 出现。
- **Shell 前缀。** 行首 `!` 表示输入是 shell 命令，输出会拼回 prompt。
- **定时任务。** 侧栏面板支持一次性、间隔、cron 三种调度 —— 比如每天早上跑一次 prompt 总结昨天的 PR、每小时扫一次 release notes、每 5 分钟看一个长任务的进展。
- **Skills。** `SKILL.md` 文件变成跨 tab 可调用的 `/skill-name` 命令。

[了解更多 →](/zh/docs/agent/sessions/)

### 面板 2 —— Explorer（`Cmd+2`）

代码界面。顶部 **5 个 tab**:

| Tab | 用途 |
|---|---|
| **目录树** | 虚拟滚动的文件树,右键菜单(新建 / 复制 / 删除 / 复制路径)。 |
| **搜索** | 项目内全文搜索 + CodeGraph 入口。 |
| **最近** | 按访问时间排序 —— "我刚才看的是什么" 视图。 |
| **变更** | Git 工作区:staged / unstaged / untracked 分类,一键 stage / discard。 |
| **历史** | Git 提交日志;点任一提交看文件列表和 diff。 |

打开文件后：

- **语法高亮**，覆盖常见语言。
- **Vi 模式** 在代码编辑器里可用 —— `i`、`Esc`、`h/j/k/l` 等。
- **Cmd+F** 当前文件内搜索（正则、大小写、整词）。
- **Cmd+P** 整项目模糊打开。
- **右键某一行** → Blame 视图，显示每行的作者 / 提交 / 时间。
- **Cmd+点击** 符号 → 跳转到定义（TypeScript / JavaScript / Python）。
- **Code Map** —— 把函数 caller / callee 关系画成图。

你在 Explorer 看到的代码图，AI 可以从 Agent 面板通过 `/cg` 查询同一份数据 —— 见 [CodeGraph](/zh/docs/explorer/search/#codegraph）。

[了解更多 →](/zh/docs/explorer/file-tree/#文件树)

### 面板 3 —— Console（`Cmd+3`）

"其它所有功能"的界面。在底部输入栏打字，Cockpit 会替你选合适的气泡类型：

| 输入这个 | 开这个气泡 |
|---|---|
| `ls`、`make build`、`pytest`…… | 一次性命令气泡 |
| `zsh`、`bash` | 完整交互式终端 —— `vim`、`top`、平时在 iTerm 跑的都能跑 |
| `https://example.com` | 浏览器气泡（驱动真实 Chrome 标签页） |
| `postgresql://...` / `postgres://...` | PostgreSQL 气泡 |
| `mysql://...` | MySQL 气泡 |
| `redis://...` | Redis 气泡 |
| 任意 `.ipynb` 路径 | Jupyter 气泡 |

每个气泡可拖动；`Cmd+M` 把当前聚焦的气泡最大化。气泡跨会话保留直到你关掉，**CLI** 允许外部脚本驱动它们（见 [CLI 参考](/zh/docs/reference/cli/)）。

[了解更多 →](/zh/docs/console/input-bar/)

## 跨面板功能

- **通过评注做代码引用。** 在 Explorer 里划选一段代码，加评注（`Cmd+/` 或浮动工具栏）。可以跨文件加多条；准备好问 AI 时，Agent 里的**评注**模态会把每条评注渲染成格式化代码块（文件路径 + 行号区间 + 代码 + 你的备注），直接复制粘贴到聊天。Cockpit "把这段代码告诉 AI" 的官方路径就是评注 —— 没有拖拽功能。
- **从搜索跳到文件。** `Cmd+P` 打开模糊文件搜索，命中后落到 Explorer 文件树对应位置，准备好评注 / 预览 / blame。
- **Browser ↔ Agent。** 每个浏览器气泡(以及一次性命令气泡、交互式终端气泡)标题栏都有一个**短 ID 徽章**。点击它注册气泡并把 `cock browser <id>` / `cock terminal <id>` 复制到剪贴板 —— 粘到聊天里 AI 就能通过 Cockpit CLI 驱动这个气泡。

## 谁应该用

如果你每天通过终端驱动 Claude Code，并且希望：

- 并行盯五个 agent 会话而不用 `tmux` 折腾
- 临时切到 Codex 或 DeepSeek 跑一个任务而无需重启 shell
- 在文件树点一行，立刻能看到那行的 Git blame
- 让 AI 查询 Postgres 并可视化结果，全程不离开聊天

……那么 Cockpit 就是你一直在用脚本手搓的那一层。

## 这不是什么

- **不是托管产品。** 一切都在本地跑，自带 key。没有 SaaS 套餐。
- **不是代码编辑器。** Cockpit 查看和评审代码，但深度编辑体验属于 VS Code / Cursor / nvim。它跟你现有编辑器无缝共存。
- **不是 Claude 套壳。** Claude 是默认值，但每个面板都不绑定模型。代码库已经内置了五种模型适配。

## 下一步

- [快速开始](/zh/docs/get-started/quickstart/) —— 安装、启动、三面板端到端实战
- [Skills](/zh/docs/agent/skills/) —— 大多数用户希望自己第一篇就读到的页
- [引擎概览](/zh/docs/agent/engines/) —— 接入 Codex / DeepSeek / Kimi / Ollama
