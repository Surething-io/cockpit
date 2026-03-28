<p align="center">
  <img src="public/icons/icon-128x128.png" width="80" />
</p>

# 驱动 AI 的驾驶舱

**One seat. One AI. Everything under control.**

https://github.com/user-attachments/assets/18f1a5dc-64f3-4ff6-b9fc-9cd08181fbb8

基于 **Claude Code (Agent SDK)** 构建的一站式开发座舱 — 对话、代码、终端、浏览器、数据库全部集成在一个界面中。能跑 Claude Code 就能用，零配置、零云端依赖。

**20× AI 算力，20× 你的效率。** 多项目 AI 会话并发执行，红点徽标和通知系统让你不错过任何完成的任务，局域网协作评审系统让团队无缝配合 — 在驾驶舱中完成所有工作，专注心流。

## 功能特性

### Agent — AI 对话

- 基于 Claude Code (Agent SDK) — 已配置 Claude Code 即可直接使用，无需额外设置
- 多项目并发会话 — 多个 AI 任务并行执行，完成后自动通知
- 会话固定、分叉、跨项目会话浏览器
- `!command` 前缀执行 shell 命令，输出自动附加到对话
- 图片附件、代码引用、Token 用量统计

### Explorer — 代码与文件

- 目录树 / 最近浏览 / Git 变更 / Git 历史 — 四标签页文件浏览器
- 语法高亮 (Shiki) + Vi 模式编辑
- Git blame、Diff 视图、分支切换、Worktree 管理
- LSP 集成 — 跳转定义、查找引用、悬浮类型信息
- 模糊搜索 (Cmd+F)、JSON 可读视图、Markdown 预览、Mermaid 图表

### Console — 终端与气泡

- 完整终端模拟器 (xterm.js)，支持 Shell 集成
- **浏览器气泡** — 通过无障碍树控制 Chrome：点击、输入、导航、截图、网络检查
- **数据库气泡** — 连接 PostgreSQL，浏览 Schema、执行查询、导出数据
- **MySQL 气泡** — 连接 MySQL，浏览数据库/表、执行查询、导出数据
- **Redis 气泡** — 浏览键值、查看数据、执行命令
- 气泡拖拽排序、网格 / 放大布局
- 每个标签页独立的环境变量和 Shell 别名

### 代码评审 — 团队协作

- 局域网分享评审页面 — 团队成员无需安装即可评审
- 行级评论与回复线程
- 评论可发送给 AI 作为上下文，自动修复
- 未读评论红点提醒

### 定时任务

- 一次性、间隔、Cron 表达式三种调度模式
- 暂停/恢复、拖拽排序、结果追踪

### 专注心流

- 三屏滑动 UI — Agent / Explorer / Console 始终渲染，即时切换
- 红点徽标 & Toast 通知 — 不错过任何完成的 AI 任务
- 多项目工作区 — 项目独立隔离，切换不丢失状态
- 深色 / 浅色主题，中英双语
- Chrome 插件 (Manifest V3) 浏览器自动化桥接
- CLI 工具：`cock browser` / `cock terminal` 无头自动化

## 在线体验

无需安装 — 在浏览器中直接体验 Cockpit（5 分钟沙盒，无 AI 对话）：

[![在线体验](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E4%BD%93%E9%AA%8C-Cockpit%20Demo-blue?style=for-the-badge)](https://e2b-nu.vercel.app/api/try)

## 前置依赖

- **Node.js ≥ 20** — [nodejs.org](https://nodejs.org/)
- **Claude Code** — [docs.anthropic.com](https://docs.anthropic.com/en/docs/claude-code)（Cockpit 底层使用 Claude Code Agent SDK）
- **Git** — 用于 Git 相关功能（blame、diff、分支切换等）
- **Chrome** —（可选）浏览器气泡自动化，需安装 `~/.cockpit/chrome-extension` 中的扩展

## 安装

```bash
npm install -g @surething/cockpit
cock                # 启动服务 → http://localhost:3457
cock .              # 打开当前目录为项目
cock ~/my-project   # 打开指定目录
cock -h             # 查看帮助
```

### 从源码安装

```bash
git clone https://github.com/Surething-io/cockpit.git
cd cockpit
npm install
npm run setup       # 构建 + npm link（注册 cock 命令）
```

## CLI

```bash
cock browser <id> snapshot    # 获取页面元素树
cock browser <id> click <uid> # 点击元素
cock terminal <id> exec "ls"  # 执行命令
cock terminal <id> output     # 获取终端输出
```

## 开发

```bash
npm run dev         # 开发服务 → http://localhost:3456
npm run build       # 生产构建
npm run setup       # 构建 + npm link
npm run lint        # ESLint
```

## 技术栈

Next.js 16 · React 19 · TypeScript · TailwindCSS · xterm.js · Shiki · i18next
