<p align="center">
  <a href="https://cocking.cc">
    <img src="public/icons/icon-128x128.png" width="80" alt="Cockpit logo" />
  </a>
</p>

<h1 align="center">Cockpit —— 为并行 AI 编程而生的 Claude Code GUI</h1>

<p align="center">
  <strong>One seat. One AI. Everything under control.</strong><br/>
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

> **Cockpit 是开源的 Claude Code GUI。** 基于官方 Claude Agent SDK，支持多项目并发会话、内置终端、Chrome 自动化、PostgreSQL / MySQL / Redis 数据库气泡、代码评审与斜杠模式 —— 全部本地化，零配置。

https://github.com/user-attachments/assets/18f1a5dc-64f3-4ff6-b9fc-9cd08181fbb8

```bash
npm i -g @surething/cockpit && cockpit
```

## 为什么选 Cockpit？

Anthropic 把 **Claude Code 默认做成 CLI**。这对硬核玩家是对的 —— 但只要你同时跟进 2+ 个项目，终端就成了"没有仪表盘的塔台"。

Cockpit 就是那个仪表盘。它**不替代** Claude Code，而是站在官方 Agent SDK 之上，补齐 CLI 给不了的能力：

| 裸用 Claude Code 的痛 | Cockpit 的解法 |
|---|---|
| 一次只能开一个会话，3+ 项目就乱 | **多项目标签页**、并发 Agent 会话、红点收件箱、桌面通知 |
| 图片附件麻烦 | 拖拽 / 粘贴图片直接进对话 |
| "我昨天调的那个 bug 在哪？" | Cmd+K 跨项目会话浏览，会话固定 / 分叉 |
| Agent 够不到浏览器 / 数据库 | **智能气泡**：Chrome、PostgreSQL、MySQL、Redis —— Agent 可驱动 |
| AI 输出审阅低效 | **局域网共享评审页**、行级评论、任意评论可回喂给 AI |
| 每天写一遍"做 X 但不要动代码" | **斜杠模式** `/qa /fx /review /commit` + 自定义 `~/.claude/commands/*.md` |
| 没有自动化触发器 | 一次性 / 间隔 / **Cron** **定时任务** |
| 担心"云端中转" | **完全本地**。无遥测、无中转，复用你 `claude` CLI 已有的 API Key |

## 功能特性

### Agent —— 可扩展的 AI 对话

- 基于**官方 Claude Agent SDK** —— 零额外 API Key 配置
- **多项目并发会话**，桌面通知 + 红点徽标
- 会话**固定 / 分叉**，跨项目会话浏览（Cmd+K）
- `!command` 前缀直接执行 shell —— 输出回流为对话上下文
- 图片附件、代码引用、Token 用量统计

### Explorer —— 代码与文件

- **4 标签页文件浏览器**：目录树 · 最近 · Git 变更 · Git 历史
- 语法高亮 (Shiki) + **Vi 模式**编辑
- Git **blame**、Diff 视图、分支切换、**Worktree** 管理
- **LSP 集成** —— 跳转定义、查找引用、悬浮类型信息
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
- **二人小团队：** Senior 用局域网共享评审页 review，半成品代码不用绕 GitHub PR。
- **全栈杂活模式：** 后端 bug 一个 tab 跑 `/fx`，前端 diff 另一个 tab 跑 `/review`，最后 `/commit` 收尾 —— 三种姿态、三种 Agent 模式。
- **AI 自动化 QA：** 浏览器气泡 + 定时任务 = "每晚 2 点跑一遍 UI 冒烟流程并发摘要"。
- **隐私敏感代码：** 在你的笔记本上跑，仅与你 `claude` CLI 已配置的 Claude API 通信。无遥测、无中转。

## 在线体验

无需安装，只读沙盒（5 分钟）：

[![在线体验](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-cocking.cc%2Ftry-12a594?style=for-the-badge)](https://cocking.cc/try)

## 前置依赖

- **Node.js ≥ 20** —— [nodejs.org](https://nodejs.org/)
- **Claude Code** —— [docs.anthropic.com/en/docs/claude-code](https://docs.anthropic.com/en/docs/claude-code)
- **Git** —— 用于 Git 相关功能（blame、diff、worktree 等）
- **Chrome** *(可选)* —— 浏览器气泡需安装 `~/.cockpit/chrome-extension` 中的扩展

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
| 多项目并行 | 需 tmux | 多窗口 | 一次一个 | **一等公民** |
| 跨项目搜索 | grep | 各窗口独立 | 本地 | **Cmd+K** |
| 浏览器 / DB 控制 | ❌ | 通常 ❌ | ❌ | **✅ Bubbles** |
| 代码评审面 | git 工具 | PR 平台 | git | **局域网共享** |
| 斜杠模式 | 手动 | 各插件 | 有 | **`/qa /fx /review /commit` + 自定义** |
| 纯本地 / 不上云 | ✅ | 不一定 | ✅ | **✅** |
| 新 SDK 能力第一天可用 | ✅ | 等 | 不一定 | **✅ 官方 SDK** |
| 开源 | ✅ | 多数 ❌ | ✅ | **✅ MIT** |

详细对比：[Claude Code GUI 全景对比：CLI、Cursor、Aider 还是 Cockpit？](https://cocking.cc/zh/blog/claude-code-gui-comparison/)

## 阅读更多

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

Next.js 16 · React 19 · TypeScript · TailwindCSS · xterm.js · Shiki · i18next · Claude Agent SDK

## 贡献

欢迎 Issue 和 PR。详见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [GUIDE.md](GUIDE.md)。

## 许可证

[MIT](LICENSE) © Surething

---

<sub>如果 Cockpit 今天给你省了 10 分钟，给一颗 ⭐️ 是我们最实惠的"谢谢"。</sub>
