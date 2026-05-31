Cockpit 识别的所有键盘快捷键，一张表搞定。macOS 用 `Cmd`；Linux 和 Windows 用 `Ctrl`。

## 全局

| 快捷键 | 动作 |
|---|---|
| `Cmd+1` | 切到 **Agent** 面板（聊天） |
| `Cmd+2` | 切到 **Explorer** 面板（文件） |
| `Cmd+3` | 切到 **Console** 面板（终端 / 气泡） |

## 文件与代码（Explorer）

| 快捷键 | 动作 |
|---|---|
| `Cmd+P` | 快速打开文件 —— 项目模糊搜索 |
| `Cmd+F` | 当前文件内搜索 |
| `Cmd+S` | 保存当前文件(只在点过工具栏 **Edit** 进入编辑模式后才生效) |
| `Cmd+C` / `Cmd+V` | 复制 / 粘贴文件树里选中的文件(系统级跨应用也工作) |
| `Ctrl+-` / `Ctrl+Shift+-` | 文件浏览导航后退 / 前进(用 `Ctrl` 而不是 `Cmd`,即便在 macOS) |
| `Esc` | 关闭文件模态 / 退出 Blame 视图 |

**Code Map** 视图里：

| 快捷键 | 动作 |
|---|---|
| `Cmd+K` | 在 Code Map 里跳到另一个文件或函数 |

## Console 与气泡

| 快捷键 | 动作 |
|---|---|
| `Cmd+M` | 把聚焦的气泡撑满 Console 面板 |
| `Cmd+F` | 在气泡输出里搜索 |
| `Esc` | 退出最大化气泡视图 |

Console 输入栏：

| 快捷键 | 动作 |
|---|---|
| `↑` / `↓` | 走最近的输入历史 |
| `Tab` | 自动补全当前输入 |
| `Enter` | 执行 |

## 聊天输入

| 快捷键 | 动作 |
|---|---|
| `Enter` | 发送消息 |
| `Shift+Enter` | 消息内换行 |
| `Esc`(光标在聊天区时) | 中断当前正在生成的 AI 回复 |
| `Cmd+V` | 粘贴 —— 文本或图片附件 |
| 行首 `/` | 打开 AI 模式 / Skills 斜杠菜单 |
| 第一行首字符 `!` | 第一行作为 shell 命令执行,输出作为附件 |

> **中文 / 日文输入法**:候选窗口开着时 `Enter` 和 `Shift+Enter` 都不会触发发送 —— 留给输入法选词。

## 笔记编辑器

| 快捷键 | 动作 |
|---|---|
| `/` | 打开格式化斜杠菜单（标题、列表、代码块、表格 …） |
| `Cmd+V` | 粘贴 |

## **没有**的快捷键

省得你找不存在的东西：

- **没有 `Cmd+T`** 新建 tab —— 用 tab 条旁边的 `+` 按钮。
- **没有 `Cmd+W`** 关闭 tab —— 点 tab 上的 `×`。
- **没有全局 `Cmd+K`** 打开 Session Browser —— 点侧栏的 sessions 图标。`Cmd+K` 是 Code Map 内导航用的。
- **没有全局"命令面板"** —— Cockpit 是面板驱动的，不是 palette 驱动。
- **不能自定义快捷键** —— 上面的绑定是写死的。

## Linux / Windows

这一页所有 `Cmd` 在 Linux 和 Windows 上对应 `Ctrl`。所以 `Ctrl+P`、`Ctrl+F`、`Ctrl+S`、`Ctrl+M` 等。

## 下一步

- [三栏布局总览](/zh/docs/get-started/introduction/) —— 每个面板做什么
- [快速开始](/zh/docs/get-started/quickstart/) —— 快捷键在上下文里
