# Cockpit 快速上手

## 安装与启动

```bash
cd /path/to/cockpit
npm install
npm run setup       # 构建 + 注册 cockpit 与 cock 命令
cockpit             # 启动服务，自动打开浏览器 http://localhost:3457
```

开发模式：`npm run dev`（端口 3456，HMR 热更新）

## Chrome 插件（首次需要）

浏览器气泡依赖此插件注入 Cookie 和自动化脚本：

1. Chrome 打开 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选 `chrome-extension/` 目录

安装后无需重复操作，代码更新后插件自动生效。可在 Cockpit 设置页（左侧栏齿轮图标）查看插件状态。

## 界面概览

```
┌─ 侧栏 ─┬──────────────────────────────────────────────┐
│ 项目列表 │                                              │
│ 固定会话 │   三屏滑动切换（Cmd+1 / Cmd+2 / Cmd+3）      │
│ 定时任务 │                                              │
│ 设置     │   Agent(聊天) │ Explorer(文件) │ Console(终端) │
└─────────┴──────────────────────────────────────────────┘
```

- **左侧栏**：项目管理、固定会话、定时任务
- **三屏布局**：始终渲染，左右滑动切换，不卸载组件

## 三屏核心用法

### 1. Agent（Cmd+1）— AI 对话

- 多标签页，每个标签页是一个独立的 Claude 会话
- **Enter** 发送消息，**Shift+Enter** 换行
- 粘贴图片直接附加到消息
- 输入 `/` 触发斜杠命令补全（内置 + 自定义）
- 输入 `!ls -la` 执行 shell 命令并附加输出到消息
- AI 消息中的文件变更可点击「查看文件变更」看 Diff

### 2. Explorer（Cmd+2）— 文件浏览器

四个标签页：

| 标签 | 功能 |
|------|------|
| 目录树 | 文件树 + 右键菜单（新建/复制/删除/路径复制） |
| 最近浏览 | 最近打开的文件列表 |
| Git 变更 | 暂存/取消暂存/丢弃变更，点击查看 Diff |
| Git 历史 | 提交记录列表，点击查看 commit 详情 |

代码预览区：
- **Cmd+F** 文件内搜索
- **Cmd+Click** 跳转定义（TypeScript / Python）
- 悬浮显示类型信息
- 选中文本弹出工具栏：添加评论 / 发送 AI / 搜索
- **Cmd+P** 快速打开文件

### 3. Console（Cmd+3）— 终端与气泡

输入栏支持多种输入：

| 输入内容 | 行为 |
|----------|------|
| `ls -la` | 创建命令气泡，执行 shell 命令 |
| `zsh` | 创建交互式 PTY 终端（支持 vim、npm 等） |
| `https://example.com` | 创建浏览器气泡，iframe 加载网页 |
| `postgresql://...` | 创建数据库气泡，连接 PostgreSQL |
| `redis://...` | 创建 Redis 气泡 |

- **Tab** 命令补全
- **上下箭头** 翻阅历史命令
- 气泡可拖拽排序、放大（Cmd+M）、双列/单列切换

## CLI 自动化

浏览器气泡和终端气泡都有 4 位短 ID（标题栏徽标），CLI 通过它操控：

```bash
# 浏览器自动化
cockpit browser list                    # 列出所有浏览器气泡
cockpit browser abcd snapshot           # 获取页面元素树
cockpit browser abcd click --ref e5     # 点击元素
cockpit browser abcd evaluate --js "return document.title"

# 终端自动化
cockpit terminal list                   # 列出所有终端气泡
cockpit terminal abcd output            # 读取终端输出
cockpit terminal abcd stdin "npm test"  # 发送命令
```

完整命令：`cockpit browser --help` / `cockpit terminal --help`
*（短别名 `cock` 在以上每条命令里都能直接替换。）*

## 常用快捷键

| 快捷键 | 作用 |
|--------|------|
| Cmd+1/2/3 | 切换 Agent / Explorer / Console |
| Cmd+P | 快速打开文件 |
| Cmd+F | 文件内搜索 |
| Cmd+Click | 跳转定义 |
| Cmd+M | 放大/还原气泡 |
| Cmd+S | 保存编辑中的文件 |
| Ctrl+- | 导航后退 |
| Ctrl+Shift+- | 导航前进 |
| Escape | 停止 AI 生成 / 退出 Blame / 关闭面板 |

## 更多

完整功能手册见 [docs/manual.md](docs/manual.md)。

English version: [GUIDE.en.md](GUIDE.en.md)
