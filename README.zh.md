<p align="center">
  <a href="https://opencockpit.dev">
    <img src="public/icons/icon-128x128.png" width="80" alt="OpenCockpit logo" />
  </a>
</p>

<h1 align="center">OpenCockpit —— 开源 Claude Code GUI，兼容任意 Agent</h1>

<p align="center">
  <strong>One seat. One AI. Everything under control.</strong><br/>
  <sub><code>/ˈkɒkpɪt/</code> —— 像飞机驾驶舱</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@surething/cockpit"><img src="https://img.shields.io/npm/v/@surething/cockpit?color=12a594&label=npm&style=flat-square" alt="npm version"/></a>
  <a href="https://www.npmjs.com/package/@surething/cockpit"><img src="https://img.shields.io/npm/dm/@surething/cockpit?color=12a594&label=downloads&style=flat-square" alt="npm downloads"/></a>
  <a href="https://github.com/Surething-io/cockpit/stargazers"><img src="https://img.shields.io/github/stars/Surething-io/cockpit?color=12a594&style=flat-square" alt="GitHub stars"/></a>
  <a href="https://github.com/Surething-io/cockpit/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-12a594?style=flat-square" alt="MIT license"/></a>
  <a href="https://opencockpit.dev"><img src="https://img.shields.io/badge/website-opencockpit.dev-12a594?style=flat-square" alt="website"/></a>
  <a href="https://github.com/anthropics/anthropic-sdk-typescript"><img src="https://img.shields.io/badge/built_on-Claude%20Agent%20SDK-12a594?style=flat-square" alt="Built on Claude Agent SDK"/></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh.md">中文</a> · <a href="https://opencockpit.dev">官网</a> · <a href="https://opencockpit.dev/zh/blog/">博客</a>
</p>

---

> **OpenCockpit 是开源的 Claude Code GUI** —— 贴合研发全流程的 IDE 式工作台，也是你想接入的任何 Agent 的统一画布。多项目 Claude 会话开箱即用；想用 **Codex、DeepSeek、GLM、Kimi 或本地 Ollama**？直接新开一个 tab。内置终端、Chrome 自动化、PostgreSQL / MySQL / Redis 气泡、代码评审与斜杠模式 —— 全部本地。Web client-server 架构：**自托管到共享开发机，全队一起飞。**

https://github.com/user-attachments/assets/18f1a5dc-64f3-4ff6-b9fc-9cd08181fbb8

```bash
npm i -g @surething/cockpit && cockpit
```

## 为什么选 Cockpit？

Anthropic 把 **Claude Code 默认做成 CLI**。这对硬核玩家是对的 —— 但只要你同时跟进 2+ 个项目，终端就成了"没有仪表盘的塔台"。

Cockpit 就是那个仪表盘。它**不替代** Claude Code，而是站在官方 Agent SDK 之上，补齐 CLI 给不了的能力：

| 裸用 Claude Code 的痛 | Cockpit 的解法 |
|---|---|
| 只能用一个模型 | **6 个引擎按 tab 并排**：Claude（默认）、Codex、DeepSeek、GLM、Kimi、本地 Ollama —— 每个 tab 独立会话 |
| 一次只能开一个会话，3+ 项目就乱 | **多项目标签页**、并发 Agent 会话、红点收件箱、桌面通知 |
| 图片附件麻烦 | 拖拽 / 粘贴图片直接进对话 |
| "我昨天调的那个 bug 在哪？" | Cmd+K 跨项目会话浏览，会话固定 / 分叉 |
| Agent 够不到浏览器 / 数据库 | **智能气泡**：Chrome、PostgreSQL、MySQL、Redis —— Agent 可驱动 |
| 读陌生仓库就是 90 分钟"找地鼠" | **代码地图（Code Map）** chip 视图 —— caller / callee pin 一点即跳 |
| AI 输出审阅低效 | **局域网共享评审页**、行级评论、任意评论可回喂给 AI |
| 每天写一遍"做 X 但不要动代码" | **斜杠模式** `/qa /fx /ex /go /cg /cc /cr` + 通过 Skills 侧边栏自定义 `SKILL.md` |
| 没有自动化触发器 | 一次性 / 间隔 / **Cron** **定时任务** |
| 担心"云端中转" | **完全本地**。无遥测，DeepSeek / GLM / Kimi 的 API Key 仅存在本机 `~/.cockpit/<引擎>/credentials.json` |

### 横向对比

截至 2026 年 7 月的实事求是快照 —— 每个工具都有赢的地方。发现错误？欢迎 PR 指正。

|  | **OpenCockpit** | Claude Code Desktop（官方） | Opcode |
|---|---|---|---|
| 定位 | **贴合研发全流程的 IDE 式工作台** | Agent 会话伴侣 | Claude Code 会话管理器 |
| 架构 | ✅ **Web client-server** —— 部署到共享开发机，全队一起飞，各占各的项目 / worktree | 单机桌面应用 | 单机桌面应用 |
| 开源 | ✅ MIT | ❌ 闭源 | ✅ AGPL-3.0 |
| 引擎 | ✅ **Claude + Codex / DeepSeek / GLM / Kimi / Ollama**（BYOK） | 仅 Claude | 仅 Claude |
| 多项目并行会话 | ✅ | ✅ | ✅ |
| Agent 可驱动浏览器 & 数据库（Chrome / Postgres / MySQL / Redis） | ✅ 智能气泡 | ❌ 仅只读预览面板 | ❌ |
| 局域网共享评审页 | ✅ | ❌ | ❌ |
| 全离线 / 内网隔离 | ✅ 走 Ollama | ❌ | ❌ |
| 手机 / 平板可用 | ✅ 局域网任意浏览器 —— 代码跑在**你自己的**机器上 | ✅ 走 Claude Code on the web（云端沙箱） | ❌ 仅桌面 |
| 原生桌面应用 | ❌ 本地 Web 应用（需 Node ≥ 20） | ✅ | ✅ Tauri |
| 第一时间跟进 Claude Code 新特性 | ⏳ 跟随 Agent SDK 发版，有滞后 | ✅ 官方第一方 | ❌ |
| 自动化触发 | 一次性 / 间隔 / cron | ✅ Routines：cron + API + GitHub 事件 | 后台 Agent |
| 会话检查点 / 回滚 | 仅固定 & 分叉 | ✅ | ✅ 检查点时间线 |
| 工具调用级变更快照（每次 Edit / Write / **Bash** / MCP 调用的真实磁盘 diff，本地保留 7 天） | ✅ | ❌ | ❌ 仅按轮次检查点 |
| 用量 / 成本分析 | 仅基础 token 计数 | 不适用（订阅制） | ✅ 完整仪表盘 |
| 费用 | GUI 免费（MIT）；AI 按所带引擎计费 —— 本地 Ollama 可 ¥0 | 应用免费；需付费 Claude 订阅或 API 计费 | GUI 免费（AGPL）；需付费 Claude 订阅或 API 计费 |
| 持续维护 | ✅ | ✅ | ⚠️ 最后发版 2025-08 |

**选官方 Desktop**：深度绑定 Anthropic 生态、要第一方打磨体验。**选 Opcode**：要原生桌面手感 + 检查点 + 成本分析。**选 OpenCockpit**：你要的不只是一个聊天窗 —— 而是开源、IDE 式、贴合研发全流程的驾驶舱（读码、驱动浏览器和数据库、评审、自动化），引擎随你带，手机也能开。

## 功能特性

### 引擎 —— 默认 Claude，也接得住你想要的任何 Agent

- **Claude** *(默认)* —— 完整官方 Agent SDK；`claude` CLI 已配置即零额外设置
- **Codex** —— 直接读 `~/.codex` 配置，聊天 / Shell / 气泡都一样
- **DeepSeek** —— 粘 DeepSeek Key，模型选择器实时列出可用模型（默认 `deepseek-v4-pro`），还能一键**查询余额**
- **GLM** *(智谱 / BigModel)* —— 粘 BigModel Key，模型选择器实时列出可用模型（默认 `glm-5.2`），还能一键**查询 Coding Plan 额度**；一个 Key 两套接入点，用 **Region** 在 `open.bigmodel.cn` 和 `api.z.ai` 之间切
- **Kimi** *(Moonshot)* —— 粘 Kimi Code Key，模型选择器实时列出可用模型（`kimi-for-coding`、`k3` …），还能一键**查询额度**；不再需要 `kimi` CLI
- **Ollama** —— 自动拉起守护进程；从聊天头部下拉任意已 pull 的模型；完全离线
- 每个引擎跑在**独立 tab，独立会话历史**；新建 tab 时下拉切换
- API Key 仅保存在本机 `~/.cockpit/<引擎>/credentials.json`，**无云端中转**

### Agent —— 可扩展的 AI 对话

- 默认引擎走**官方 Claude Agent SDK** —— 零额外设置
- **多项目并发会话**，桌面通知 + 红点徽标
- 会话**固定 / 分叉**，跨项目会话浏览（Cmd+K）
- **工具调用级快照** —— 每次碰文件的工具调用都会打快照（影子 git，全本地）；按 git 历史式时间线逐调用审阅每条回复的变更，`Bash` 改了什么也看得到
- `!command` 前缀直接执行 shell —— 输出回流为对话上下文
- 图片附件、代码引用、Token 用量统计

### Explorer —— 代码与文件

- **4 标签页文件浏览器**：目录树 · 最近 · Git 变更 · Git 历史
- 语法高亮 (Shiki) + **Vi 模式**编辑
- Git **blame**、Diff 视图、分支切换、**Worktree** 管理
- **LSP 集成** —— 跳转定义、查找引用、悬浮类型信息
- **代码地图（Code Map）** —— 每个函数渲染为 chip，左右两侧分别列出 caller / callee，点击 pin 即可顺着调用图走。多语言支持：TS/JS、Python、Go、Rust。无需 LSP、无需项目预热，离线可用。
- **CodeGraph（项目图谱）** —— 给 Agent 的**代码图谱（code graph）**：同一份 tree-sitter 索引开放为 10 个 HTTP 接口 —— 基础 6 个（`search` / `callers` / `callees` / `impact` / `file` / `coedit`）+ 分析 4 个（`context` / `related` / `risk` / `affected`，由 PageRank · PPR · TF-IDF · Louvain 驱动，零训练），Agent 直接按坐标精确查询，无须 grep 字面。在 chat 输入 `/cg` 触发。只返坐标不返源码——比 grep 精确、比 Read 省 token，还能抓住 regex 看不见的「约定耦合」。
- 模糊搜索 (Cmd+F)、JSON 查看器、Markdown 预览

### Console —— 终端与智能气泡

- 完整 **xterm.js** 终端，Shell 集成
- 🌐 **浏览器气泡** —— 通过无障碍树控制 Chrome（点击、输入、导航、截图、网络）
- 🐘 **PostgreSQL 气泡** —— 浏览 Schema、执行查询、导出
- 🐬 **MySQL 气泡** —— 浏览数据库与表、执行查询
- 🔴 **Redis 气泡** —— 浏览键值、查看数据、执行命令
- 拖拽排序、网格 / 放大布局，每个标签独立的环境变量与 Shell 别名

### 代码评审 —— 局域网共享，无需 SaaS

- 局域网分享评审页面 —— **队友零安装**即可参与
- 行级评论与回复线程
- **任意评论可发给 AI** 作为上下文，自动修复
- 未读评论红点提醒，跨项目可见

### 斜杠模式 —— 切换 Agent 姿态

- `/qa` —— **只澄清**：复述、反问、绝不写代码
- `/fx` —— **只诊断**：Bug 证据链分析，绝不改文件
- `/ex` —— **探讨**：6 步结构化讨论骨架（研究 → 发散 → 收敛 → 再发散 → 迭代验证 → 总结）
- `/go` —— **落地**：把收敛后的方案切成 MVP 阶段，每阶段自运行验证，最后端到端回看
- `/cg` —— **CodeGraph 项目探索**：10 个 HTTP 接口按符号 / 调用关系 / 影响范围 / 协同编辑 / 风险 / 受影响测试精确查询（比 grep 精准）
- `/cc` —— **Cockpit CLI**：驾驭 cockpit 命令行 —— codegraph 子命令、terminal 观察、browser 自动化
- `/cr` —— **代码审查**：完整 PR 审查 —— 静态三角校验（意图 / 输入域 / 周遭）+ 动态推演（状态图 + 时间线 → 6 类风险），按 影响 × 概率 排序输出 findings
- **自定义**：任意 `SKILL.md` 通过 Skills 侧边栏添加 —— 自动出现在斜杠补全菜单（见 [Skills](#skills--可扩展性)）

### 定时任务 —— 给 AI 的 Cron

- 一次性、间隔、**Cron** 三种调度
- 暂停 / 恢复、拖拽排序，跨项目追踪结果

### Skills —— 可扩展性

- 任意 `SKILL.md` 都能教 Agent 新技能
- 在对话中用 `/skill-name` 直接调用
- 所有技能在统一 Skills 侧边栏管理

## 使用场景

- **独立开发者多仓并行：** "API 在重构、Web 在写测试、Pipeline 在排 bug —— 同时跑、同时可见。"
- **新仓库的第一天：** 用 Code Map 打开它，沿着 caller / callee pin 一路点过去 —— 鉴权流程 5 次点击就走完，不再是 90 分钟的"文件树找地鼠"。
- **二人小团队：** Senior 用局域网共享评审页 review，半成品代码不用绕 GitHub PR。
- **共享开发机团队：** 在代码所在的机器上自托管一个 Cockpit —— 队友打开浏览器就能一起飞，各自在自己的项目 / worktree 上跑 AI 会话。
- **评审 AI 写的 PR：** 把改动文件切到 Code Map，**改动过的函数被高亮**，周围还画着它们的 caller / callee —— 一眼看清这次改动的爆炸半径。
- **全栈杂活模式：** 后端 bug 一个 tab 跑 `/fx`，另一个 tab 跑 `/ex` 规划前端重构，最后 `/go` 落地 —— 三种姿态、三种 Agent 模式。
- **便宜的二次意见：** 同一个 prompt 在两个 tab 跑 —— 一个 Claude、一个 **DeepSeek v4-pro**，对比答案后再决定相信谁。
- **AI 自动化 QA：** 浏览器气泡 + 定时任务 = "每晚 2 点跑一遍 UI 冒烟流程并发摘要"。
- **隐私敏感代码：** 在你的笔记本上跑。配合 **Ollama** tab 即可完全断网工作。无遥测、无中转。

## 在线体验

无需安装，只读沙盒（5 分钟）：

[![在线体验](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-opencockpit.dev%2Ftry-12a594?style=for-the-badge)](https://opencockpit.dev/try)

## 前置依赖

- **macOS、Linux 或 Windows** —— Windows 支持为实验性（[详见](#windows)）
- **Node.js ≥ 20** —— [nodejs.org](https://nodejs.org/)
- **Claude Code** —— [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code)（默认引擎）
- **Git** —— 用于 Git 相关功能（blame、diff、worktree 等）
- **Chrome** *(可选)* —— 浏览器气泡需安装 `~/.cockpit/chrome-extension` 中的扩展

### 可选，按引擎

- **Codex** —— 执行一次 `codex login` 即可生成 `~/.codex` 配置
- **DeepSeek** —— 到 [api-docs.deepseek.com](https://api-docs.deepseek.com/) 申请 API Key，在引擎选择器里粘贴
- **GLM（智谱 / BigModel）** —— 到 [bigmodel.cn/apikey/platform](https://bigmodel.cn/apikey/platform) 申请 API Key（形如 `<id>.<secret>`），粘进聊天头部模型选择器的 **API Key** 输入框。同一个 Key 在两套接入点都能用，所以 **Region**（`open.bigmodel.cn` / `api.z.ai`）只是路由：默认跟着界面语言走，也能在选择器里手动覆盖。
- **Kimi (Moonshot)** —— 到 [kimi.com/code/console](https://www.kimi.com/code/console) 申请 **Kimi Code** API Key（`sk-kimi-…`），粘进聊天头部模型选择器的 **API Key** 输入框。*（`platform.moonshot.cn` 的开放平台 Key 是另一个产品，在这里用不了。）* 不再需要 `kimi` CLI。
- **Ollama** —— 安装 [ollama.com](https://ollama.com/) 并 `ollama pull <model>`；Cockpit 会自动拉起守护进程

> API Key 仅保存在本机，每个引擎一个文件：`~/.cockpit/<引擎>/credentials.json`（例如 `~/.cockpit/kimi/credentials.json`、`~/.cockpit/glm/credentials.json`），**不写进** `settings.json`。无云端中转。

## 安装

```bash
npm install -g @surething/cockpit
cockpit                # 启动驾驶舱 → http://localhost:3457
cockpit .              # 打开当前目录为项目
cockpit ~/my-project   # 打开指定目录
cockpit -h             # 帮助
```

> `cockpit`（完整名）和 `cock`（短别名）都随包安装 —— 任选其一。文档与示例统一使用 `cockpit`，老用户的肌肉记忆 `cock` 仍然好使。

### 后台运行

`cockpit` 默认在前台运行，关掉终端服务就停了。想让它常驻：

```bash
cockpit start          # 后台启动
cockpit status         # 是否在跑：版本、端口、pid、运行时长
cockpit restart        # 原地重启
cockpit stop
```

`start` 支持与 `cockpit` 相同的参数（`--port`、`--token`）。输出写入
`~/.cockpit/logs/server.log`。

`restart` 是让运行中的服务自己完成替换，因此启动时用的端口和 token 会被保留 ——
不需要重新指定一遍。

> 没有集成 launchd/systemd：重启电脑后需要再次执行 `cockpit start`（或把它加进系统的登录启动项）。

### 升级

```bash
cockpit update
```

也可以在有新版本时点击侧边栏的版本药丸。

如果 Cockpit **正在运行**，升级会原地完成：服务把工作交接给一个辅助进程，由它在无人
占用安装目录的情况下安装，然后用相同的端口和 token 重新拉起。安装失败会回滚到原版本
并照常重启 —— 中断的升级不会让你失去一个可用的 Cockpit。

如果**没有运行**，`cockpit update` 就是单纯地安装。

新服务起来后，此前一直开着的浏览器标签页会出现"刷新"提示 —— 它持有的是旧版本的静态资源。

### Windows

Windows 支持为**实验性** —— CI 会覆盖，但实际使用量远少于 macOS 和 Linux。Cockpit
以原生方式运行；Console 面板在装有 Git Bash 时使用它，否则回落到 PowerShell，与
Claude Code 在 Windows 上的优先级一致。

- 安装 [Git for Windows](https://git-scm.com/download/win) 可获得 bash 终端。不装的话
  Console 面板会运行 PowerShell，且 HTML 应用使用的 `cockpit.bash` 通道不可用。
- 文件浏览、diff、review、chat 等面板的行为与其他平台一致。

想要 Linux 工具链？把**整个** Cockpit 放进 **WSL2** 运行，那里它就是一个普通的 Linux 安装：

```powershell
wsl --install          # 管理员 PowerShell 里执行一次，然后重启
```

```bash
wsl                                  # 进入 Linux shell
npm install -g @surething/cockpit    # 先在 WSL 内装好 Node ≥ 20
cockpit
```

两种方式都在 Windows 浏览器里打开 `http://localhost:3457` —— WSL2 会自动转发 localhost。

> **选一边，别混用。** 在 Windows 上跑 Cockpit 而项目放在 WSL 里（或者反过来），会让
> agent 和它的终端拿到两套路径：同一个目录一边是 `C:\Users\me\proj`，另一边是
> `/mnt/c/Users/me/proj`，互相传递的路径无法解析。让 Cockpit 和你的代码待在同一个世界里。

### 从源码安装

```bash
git clone https://github.com/Surething-io/cockpit.git
cd cockpit
npm install
npm run setup       # 构建 + npm link（注册 `cockpit` 与 `cock` 命令）
```

## CLI

```bash
cockpit browser <id> snapshot      # 获取页面元素树
cockpit browser <id> click <uid>   # 点击元素
cockpit terminal list              # 列出终端气泡
cockpit terminal <id> output       # 读取终端输出（支持过滤、游标）
cockpit connection list --cwd .    # 列出当前项目所有气泡（terminal + browser）含用户起的 title
```

## 阅读更多

- 📖 [Code Graph：给 AI 一张项目图谱](https://opencockpit.dev/zh/blog/code-graph-for-ai-agents/)
- 📖 [把代码读成地图，而不是树](https://opencockpit.dev/zh/blog/read-code-as-a-map/)
- 📖 [如何同时跑 5 个 Claude Code 会话不疯掉](https://opencockpit.dev/zh/blog/parallel-claude-code-sessions/)
- 📖 [完整博客](https://opencockpit.dev/zh/blog/)
- 📋 [更新日志](https://opencockpit.dev/zh/changelog/)

## 开发

```bash
npm run dev         # 开发服务 → http://localhost:3456
npm run build       # 生产构建
npm run setup       # 构建 + npm link
npm run lint        # ESLint
```

## 技术栈

Next.js 16 · React 19 · TypeScript · TailwindCSS · xterm.js · node-pty · Shiki · tree-sitter (WASM) · i18next · Claude Agent SDK · Vercel AI SDK

## 贡献

欢迎 Issue 和 PR。详见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [OpenCockpit 文档](https://opencockpit.dev/zh/docs/)。

## 许可证

[MIT](LICENSE) © Surething

---

<sub>如果 Cockpit 今天给你省了 10 分钟，给一颗 ⭐️ 是我们最实惠的"谢谢"。</sub>
