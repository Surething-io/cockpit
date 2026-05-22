<p align="center">
  <a href="https://cocking.cc">
    <img src="public/icons/icon-128x128.png" width="80" alt="Cockpit logo" />
  </a>
</p>

<h1 align="center">Cockpit —— Claude Code GUI，也接得住你想要的任何 Agent</h1>

<p align="center">
  <strong>One seat. Any AI. Everything under control.</strong><br/>
  <sub><code>/ˈkɒkpɪt/</code> —— 像飞机驾驶舱</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@surething/cockpit"><img src="https://img.shields.io/npm/v/@surething/cockpit?color=12a594&label=npm&style=flat-square" alt="npm version"/></a>
  <a href="https://www.npmjs.com/package/@surething/cockpit"><img src="https://img.shields.io/npm/dm/@surething/cockpit?color=12a594&label=downloads&style=flat-square" alt="npm downloads"/></a>
  <a href="https://github.com/Surething-io/cockpit/stargazers"><img src="https://img.shields.io/github/stars/Surething-io/cockpit?color=12a594&style=flat-square" alt="GitHub stars"/></a>
  <a href="https://github.com/Surething-io/cockpit/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-12a594?style=flat-square" alt="MIT license"/></a>
  <a href="https://cocking.cc"><img src="https://img.shields.io/badge/website-cocking.cc-12a594?style=flat-square" alt="website"/></a>
  <a href="https://github.com/anthropics/anthropic-sdk-typescript"><img src="https://img.shields.io/badge/built_on-Claude%20Agent%20SDK-12a594?style=flat-square" alt="Built on Claude Agent SDK"/></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh.md">中文</a> · <a href="https://cocking.cc">官网</a> · <a href="https://cocking.cc/zh/blog/">博客</a>
</p>

---

> **Cockpit 是开源的 Claude Code GUI** —— 也是你想接入的任何 Agent 的统一画布。多项目 Claude 会话开箱即用；想用 **OpenAI Codex、DeepSeek、Kimi 或本地 Ollama**？直接新开一个 tab。内置终端、Chrome 自动化、PostgreSQL / MySQL / Redis 气泡、代码评审与斜杠模式 —— 全部本地。

https://github.com/user-attachments/assets/18f1a5dc-64f3-4ff6-b9fc-9cd08181fbb8

```bash
npm i -g @surething/cockpit && cockpit
```

## 为什么选 Cockpit？

Anthropic 把 **Claude Code 默认做成 CLI**。这对硬核玩家是对的 —— 但只要你同时跟进 2+ 个项目，终端就成了"没有仪表盘的塔台"。

Cockpit 就是那个仪表盘。它**不替代** Claude Code，而是站在官方 Agent SDK 之上，补齐 CLI 给不了的能力：

| 裸用 Claude Code 的痛 | Cockpit 的解法 |
|---|---|
| 只能用一个模型 | **5 个引擎按 tab 并排**：Claude（默认）、OpenAI Codex、DeepSeek、Kimi、本地 Ollama —— 每个 tab 独立会话 |
| 一次只能开一个会话，3+ 项目就乱 | **多项目标签页**、并发 Agent 会话、红点收件箱、桌面通知 |
| 图片附件麻烦 | 拖拽 / 粘贴图片直接进对话 |
| "我昨天调的那个 bug 在哪？" | Cmd+K 跨项目会话浏览，会话固定 / 分叉 |
| Agent 够不到浏览器 / 数据库 | **智能气泡**：Chrome、PostgreSQL、MySQL、Redis —— Agent 可驱动 |
| 读陌生仓库就是 90 分钟"找地鼠" | **代码地图（Code Map）** chip 视图 —— caller / callee pin 一点即跳 |
| AI 输出审阅低效 | **局域网共享评审页**、行级评论、任意评论可回喂给 AI |
| 每天写一遍"做 X 但不要动代码" | **斜杠模式** `/qa /fx /review /commit` + 自定义 `~/.claude/commands/*.md` |
| 没有自动化触发器 | 一次性 / 间隔 / **Cron** **定时任务** |
| 担心"云端中转" | **完全本地**。无遥测，Codex / DeepSeek / Kimi 的 Key 仅存在本机 `~/.cockpit/settings.json` |

## 功能特性

### 引擎 —— 默认 Claude，也接得住你想要的任何 Agent

- **Claude** *(默认)* —— 完整官方 Agent SDK；`claude` CLI 已配置即零额外设置
- **OpenAI Codex** —— 直接读 `~/.codex` 配置，聊天 / Shell / 气泡都一样
- **DeepSeek** —— 通过 Claude SDK 走 Anthropic 兼容端点；粘 Key，选 `v4-pro` 或 `v4-flash`
- **Kimi** *(Moonshot)* —— 函数调用在聊天里完整渲染，跟 Claude 一样
- **Ollama** —— 自动拉起守护进程；从聊天头部下拉任意已 pull 的模型；完全离线
- 每个引擎跑在**独立 tab，独立会话历史**；新建 tab 时下拉切换
- API Key 仅保存在本机 `~/.cockpit/settings.json`，**无云端中转**

### Agent —— 可扩展的 AI 对话

- 默认引擎走**官方 Claude Agent SDK** —— 零额外设置
- **多项目并发会话**，桌面通知 + 红点徽标
- 会话**固定 / 分叉**，跨项目会话浏览（Cmd+K）
- `!command` 前缀直接执行 shell —— 输出回流为对话上下文
- 图片附件、代码引用、Token 用量统计

### Explorer —— 代码与文件

- **4 标签页文件浏览器**：目录树 · 最近 · Git 变更 · Git 历史
- 语法高亮 (Shiki) + **Vi 模式**编辑
- Git **blame**、Diff 视图、分支切换、**Worktree** 管理
- **LSP 集成** —— 跳转定义、查找引用、悬浮类型信息
- **代码地图（Code Map）** —— 每个函数渲染为 chip，左右两侧分别列出 caller / callee，点击 pin 即可顺着调用图走。多语言支持：TS/JS、Python、Go、Rust。无需 LSP、无需项目预热，离线可用。
- **CodeGraph（项目图谱）** —— 给 Agent 的**代码图谱（code graph）**：同一份 tree-sitter 索引开放为 6 个 HTTP 接口（`search` / `callers` / `callees` / `impact` / `file` / `coedit`），Agent 直接按坐标精确查询，无须 grep 字面。在 chat 输入 `/cg` 触发。只返坐标不返源码——比 grep 精确、比 Read 省 token，还能抓住 regex 看不见的「约定耦合」。
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
- `/review` —— 读 diff、写评审，不动手重写
- `/commit` —— 暂存改动、按你仓库的风格起草 message、提交
- `/cg` —— **CodeGraph 项目探索**：6 个 HTTP 接口按符号 / 调用关系 / 影响范围 / 协同编辑精确查询（比 grep 精准）
- **自定义**：`~/.claude/commands/` 或 `./.claude/commands/` 下任意 `*.md` 即斜杠指令

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
- **评审 AI 写的 PR：** 把改动文件切到 Code Map，**改动过的函数被高亮**，周围还画着它们的 caller / callee —— 一眼看清这次改动的爆炸半径。
- **全栈杂活模式：** 后端 bug 一个 tab 跑 `/fx`，前端 diff 另一个 tab 跑 `/review`，最后 `/commit` 收尾 —— 三种姿态、三种 Agent 模式。
- **便宜的二次意见：** 同一个 prompt 在两个 tab 跑 —— 一个 Claude、一个 **DeepSeek v4-pro**，对比答案后再决定相信谁。
- **AI 自动化 QA：** 浏览器气泡 + 定时任务 = "每晚 2 点跑一遍 UI 冒烟流程并发摘要"。
- **隐私敏感代码：** 在你的笔记本上跑。配合 **Ollama** tab 即可完全断网工作。无遥测、无中转。

## 在线体验

无需安装，只读沙盒（5 分钟）：

[![在线体验](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-cocking.cc%2Ftry-12a594?style=for-the-badge)](https://cocking.cc/try)

## 前置依赖

- **Node.js ≥ 20** —— [nodejs.org](https://nodejs.org/)
- **Claude Code** —— [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code)（默认引擎）
- **Git** —— 用于 Git 相关功能（blame、diff、worktree 等）
- **Chrome** *(可选)* —— 浏览器气泡需安装 `~/.cockpit/chrome-extension` 中的扩展

### 可选，按引擎

- **OpenAI Codex** —— 执行一次 `codex login` 即可生成 `~/.codex` 配置
- **DeepSeek** —— 到 [api-docs.deepseek.com](https://api-docs.deepseek.com/) 申请 API Key，在引擎选择器里粘贴
- **Kimi (Moonshot)** —— 到 [platform.moonshot.cn](https://platform.moonshot.cn/) 申请 API Key，在引擎选择器里粘贴
- **Ollama** —— 安装 [ollama.com](https://ollama.com/) 并 `ollama pull <model>`；Cockpit 会自动拉起守护进程

> 所有 API Key 仅保存在本机 `~/.cockpit/settings.json`。无云端中转。

## 安装

```bash
npm install -g @surething/cockpit
cockpit                # 启动驾驶舱 → http://localhost:3457
cockpit .              # 打开当前目录为项目
cockpit ~/my-project   # 打开指定目录
cockpit -h             # 帮助
```

> `cockpit`（完整名）和 `cock`（短别名）都随包安装 —— 任选其一。文档与示例统一使用 `cockpit`，老用户的肌肉记忆 `cock` 仍然好使。

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
cockpit terminal <id> exec "ls"    # 执行命令
cockpit terminal <id> output       # 获取终端输出
```

## 与同类产品对比

| | 裸 Claude Code CLI | IDE 插件（Cursor、Continue）| Aider TUI | **Cockpit** |
|---|---|---|---|---|
| 多引擎内置 | 仅 Claude | 不一定 | 配置驱动 | **内置 5 个：Claude、Codex、DeepSeek、Kimi、Ollama** |
| 多项目并行 | 需 tmux | 多窗口 | 一次一个 | **一等公民** |
| 跨项目搜索 | grep | 各窗口独立 | 本地 | **Cmd+K** |
| 浏览器 / DB 控制 | ❌ | 通常 ❌ | ❌ | **✅ Bubbles** |
| 代码评审面 | git 工具 | PR 平台 | git | **局域网共享** |
| 斜杠模式 | 手动 | 各插件 | 有 | **`/qa /fx /review /commit /cg` + 自定义** |
| 给 Agent 用的项目图谱 API | ❌ | LSP（IDE 内） | ❌ | **✅ CodeGraph —— 6 个接口，AI 优先，只返坐标** |
| 纯本地 / 不上云 | ✅ | 不一定 | ✅ | **✅** |
| 开源 | ✅ | 多数 ❌ | ✅ | **✅ MIT** |

详细对比：[Claude Code GUI 全景对比：CLI、Cursor、Aider 还是 Cockpit？](https://cocking.cc/zh/blog/claude-code-gui-comparison/)

## 阅读更多

- 📖 [Code Graph：给 AI 一张项目图谱](https://cocking.cc/zh/blog/code-graph-for-ai-agents/)
- 📖 [把代码读成地图，而不是树](https://cocking.cc/zh/blog/read-code-as-a-map/)
- 📖 [如何同时跑 5 个 Claude Code 会话不疯掉](https://cocking.cc/zh/blog/parallel-claude-code-sessions/)
- 📖 [Claude Code 斜杠模式实战：/qa、/fx、/review、/commit](https://cocking.cc/zh/blog/slash-modes-claude-code/)
- 📖 [完整博客](https://cocking.cc/zh/blog/)
- 📋 [更新日志](https://cocking.cc/zh/changelog/)

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

欢迎 Issue 和 PR。详见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [GUIDE.md](GUIDE.md)。

## 许可证

[MIT](LICENSE) © Surething

---

<sub>如果 Cockpit 今天给你省了 10 分钟，给一颗 ⭐️ 是我们最实惠的"谢谢"。</sub>
