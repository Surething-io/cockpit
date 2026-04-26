# Cockpit 功能手册

## 目录

- [1. 工作区与项目管理](#1-工作区与项目管理)
- [2. Agent — AI 对话](#2-agent--ai-对话)
- [3. Explorer — 文件浏览器](#3-explorer--文件浏览器)
- [4. Console — 终端与气泡](#4-console--终端与气泡)
- [5. 浏览器自动化（CLI）](#5-浏览器自动化cli)
- [6. 终端自动化（CLI）](#6-终端自动化cli)
- [7. 代码评审系统](#7-代码评审系统)
- [8. 定时任务](#8-定时任务)
- [9. 笔记系统](#9-笔记系统)
- [10. Git 工具](#10-git-工具)
- [11. LSP 代码智能](#11-lsp-代码智能)
- [12. Chrome 插件](#12-chrome-插件)
- [13. 快捷键速查](#13-快捷键速查)

---

## 1. 工作区与项目管理

### 1.1 侧栏

左侧栏是全局导航入口：

- **项目列表**：显示所有已打开的项目，点击切换，拖拽排序
  - 红点表示有未读的 AI 回复
  - 加载动画表示 AI 正在回复
  - 右键可移除项目
- **固定会话**：常用会话的快捷入口，支持重命名和拖拽排序
- **定时任务面板**：查看和管理所有定时任务（详见[第 8 节](#8-定时任务)）
- **笔记按钮**：打开全局笔记
- **设置按钮**：主题切换、Chrome 插件状态、版本信息

### 1.2 顶栏

每个项目的顶部工具栏：

| 元素 | 说明 |
|------|------|
| 项目路径 | 显示当前工作目录，点击复制 |
| Git 分支 | 当前分支名，点击打开 Worktree 管理 |
| 视图切换器 | Agent / Explorer / Console 三屏切换 |
| 评审下拉框 | 管理代码评审（创建/切换/删除） |
| 会话管理 | 打开项目所有 Claude 会话列表 |
| VS Code / Cursor | 一键在编辑器中打开项目 |
| 别名管理 | 管理全局命令别名 |
| Token 统计 | 查看 Claude API 用量和费用 |

### 1.3 多项目工作流

- 侧栏 + 按钮打开文件夹选择器添加项目
- 每个项目是独立的 iframe，切换不丢失状态
- 后台项目的 AI 会话完成后，左下角弹出 Toast 通知
- WebSocket 实时推送项目状态变化

### 1.4 会话管理

- **多标签页**：每个项目可同时打开多个 Claude 对话
- **固定会话**：常用会话固定到侧栏
- **Fork 会话**：悬浮用户消息 → Fork 图标，从该消息分叉出新会话
- **会话浏览器**：侧栏按钮打开全局会话列表，跨项目浏览

---

## 2. Agent — AI 对话

快捷键 **Cmd+1** 切换到此面板。

### 2.1 发送消息

- **Enter** 发送，**Shift+Enter** 换行
- **粘贴图片**：支持 PNG/JPEG/WebP/GIF，最大 5MB，发送前显示缩略图预览
- **Escape**：AI 生成中按 Escape 停止

### 2.2 斜杠命令

输入 `/` 触发补全菜单，上下箭头选择，Enter/Tab 确认：

- **内置命令**：如 `/compact`
- **全局命令**：定义在 `~/.cockpit/commands.json`
- **项目命令**：定义在项目根目录 `.cockpit/commands.json`

### 2.3 Shell 命令集成

- 输入 `!命令` 执行 shell 命令，输出自动附加到 AI 消息
- 输入 `cock ...` 执行 cockpit CLI 命令，输出附加到消息

### 2.4 AI 消息展示

- 完整 Markdown 渲染：代码高亮、表格、列表、GitHub Alerts、数学公式、HTML
- **工具调用**：折叠显示，可展开查看输入/输出详情
- **文件变更**：Edit/Write 工具调用后显示「查看文件变更」按钮，打开 Diff 视图
- **Markdown 文件预览**：Read/Edit 的 `.md` 文件显示为预览按钮
- **Todo 列表**：如果 AI 使用了 TodoWrite，显示当前任务进度

### 2.5 输入栏工具按钮

从左到右：

| 按钮 | 功能 |
|------|------|
| Git Stage All (+) | 执行 `git add -A` |
| Git 变更 | 切换到 Explorer 的 Git 变更标签 |
| 评论列表 | 打开所有代码评论，支持批量复制/发送 AI |
| 用户消息列表 | 列出所有用户消息，点击快速定位 |
| 笔记 | 打开项目笔记 |
| 定时任务 | 创建定时 AI 任务 |

### 2.6 消息内文本选择

在 AI 回复中选中文本后弹出浮动工具栏：

- **添加评论**：将选中的 AI 回复文本保存为评论
- **提问 AI**：以选中文本为引用，向 AI 提问

---

## 3. Explorer — 文件浏览器

快捷键 **Cmd+2** 切换到此面板。

### 3.1 四个标签页

#### 目录树

- 懒加载文件树，点击展开/折叠目录
- 文件图标叠加 Git 状态标识（M 修改、A 新增、D 删除、R 重命名、? 未跟踪）
- WebSocket 文件监听，外部变更自动刷新
- 右键菜单：
  - 新建文件
  - 复制/粘贴文件
  - 删除文件/目录
  - 复制相对/绝对路径
  - 复制文件/目录名
- **Cmd+C** 复制选中文件，**Cmd+V** 粘贴

#### 最近浏览

- 按时间倒序列出最近打开的文件
- 记住每个文件的上次滚动位置

#### Git 变更

- 分区显示已暂存和未暂存的变更
- 单个文件操作：暂存、取消暂存、丢弃变更、查看 Diff
- 批量操作：复选框多选后批量暂存/取消/丢弃
- 点击文件查看 Diff，支持 Diff minimap 导航

#### Git 历史

- 分支选择下拉框（支持搜索）
- 分页加载提交记录
- 点击 commit → 查看变更文件列表和每个文件的 Diff

### 3.2 代码预览区

右侧代码查看器功能：

- **虚拟滚动**：大文件（万行级）流畅滚动
- **语法高亮**：Shiki 引擎，支持所有主流语言
- **行号显示**

#### 文件内搜索（Cmd+F）

- 大小写敏感 / 全词匹配切换
- Enter 下一个匹配，Shift+Enter 上一个
- 高亮所有匹配项

#### Git Blame

- 点击 Blame 按钮激活
- 每行左侧显示提交者、时间、commit hash
- 点击 commit hash → 底部滑出 Commit 详情面板
- Escape 退出 Blame 视图

#### 内联编辑

- 切换编辑模式后，行内容变为可编辑
- Cmd+S 保存
- 检测外部文件变更，弹出冲突提示
- 脏标记提示未保存变更

#### Vi 模式

在查看模式按 Escape 进入 Vi normal 模式：

- 移动：`h j k l`、`w b e`（词级）、`gg` / `G`（首行/末行）、`Ctrl+D/U`（半页滚动）
- 编辑：`dd` 删行、`yy` 复制行、`p` 粘贴、`x` 删字符、`o/O` 新行
- 进入插入模式：`i a I A`
- 保存：`:w`
- 搜索：`/关键词`，`n/N` 下一个/上一个

#### JSON 可读模式

`.json` 文件可切换到格式化视图，支持 Cmd+F 搜索。

#### 图片预览

图片文件直接在预览区渲染。

#### Markdown 预览

`.md` 文件显示为交互式预览，基于 TipTap 编辑器渲染。

### 3.3 快速打开文件（Cmd+P）

- 模糊匹配搜索全项目文件
- 最近打开的文件排在最前
- 上下箭头选择，Enter 打开

### 3.4 浮动选择工具栏

在代码预览区选中文本后弹出：

- **添加评论**：在选定行范围创建评论
- **发送 AI**：将选中代码作为引用发送到 AI 对话
- **搜索**：以选中文本在全项目中搜索

### 3.5 Diff 视图

Git 变更和 Commit 详情中的 Diff 查看器：

- 虚拟滚动渲染
- Diff minimap（右侧缩略导航）
- 行级评论：选中 Diff 行后添加评论或发送 AI
- Markdown/JSON 文件可切换到预览模式

---

## 4. Console — 终端与气泡

快捷键 **Cmd+3** 切换到此面板。

### 4.1 输入栏

- **Tab** 命令补全（调用 shell 的补全能力）
- **上下箭头** 翻阅命令历史
- **`/` 斜杠命令** 快速执行预设命令
- URL 格式输入自动识别为浏览器/数据库/Redis 气泡

#### 工具按钮

| 按钮 | 功能 |
|------|------|
| 快捷命令 (闪电) | 打开预设命令列表 |
| 笔记 (铅笔) | 项目笔记 |
| 双列/单列切换 | 气泡布局模式 |
| 环境变量 | 查看/编辑环境变量 |
| 启动 zsh (>_) | 创建交互式终端气泡 |

### 4.2 命令气泡

每次执行命令创建一个气泡卡片：

- **标题栏**：命令文本、ShortID 徽标、时间戳
- **输出区**：ANSI 颜色渲染
- **状态**：运行中（动画）、成功（绿色）、失败（红色退出码）
- **操作**：复制输出、复制命令、重新运行、删除
- **搜索/过滤输出**：搜索模式（高亮匹配）或过滤模式（只显示匹配行）
- **拖拽排序**：标题栏拖拽改变气泡顺序
- **放大**：Cmd+M 放大选中气泡到全屏高度

#### PTY 交互终端

输入 `zsh` 或需要交互的命令（如 `vim`、`npm`）时，创建完整的伪终端：

- 基于 xterm.js 渲染
- 支持 Ctrl+C/D/Z/L 等控制键
- 自适应调整终端尺寸

### 4.3 浏览器气泡

输入 URL（如 `https://example.com`）创建：

- **iframe 渲染**：加载目标网页，通过 Chrome 插件注入 Cookie
- **导航栏**：后退、前进、刷新、URL 输入框
- **ShortID 徽标**：4 位短标识，点击复制 CLI 命令
- **自动化桥接**：连接后可通过 `cock browser` CLI 控制
- **链接拦截**：页面内 `target="_blank"` 链接自动创建新气泡而非新标签页
- **休眠策略**：
  - 不可见且未连接 CLI 时，5 分钟后自动休眠（卸载 iframe 释放资源）
  - 已连接 CLI 时不休眠
  - 可见时不休眠
  - 休眠后点击即可唤醒

### 4.4 数据库气泡（PostgreSQL）

输入 `postgresql://user:pass@host:port/db` 创建：

- **左侧栏**：Schema 选择器、表/视图列表（带行数估算）、类型筛选（T 表 / V 视图）、刷新按钮
- **表结构**：点击表名查看列信息（名称、类型、是否可空、默认值、主键、外键、索引）
- **数据浏览**：
  - 分页表格显示
  - 列筛选：支持 =、!=、>、<、LIKE、IN、IS NULL 等运算符
  - 列排序：点击表头切换 ASC/DESC
  - 显示总行数
- **SQL 编辑器**：输入任意 SQL 查询，多语句支持
- **导出 CSV**：将查询结果导出为 CSV 文件

### 4.5 Redis 气泡

输入 `redis://...` 创建：

- **数据浏览**：键列表、类型标识、搜索/过滤、查看值（string/hash/list/set/zset）、TTL、大小
- **服务器信息**：Redis INFO 输出
- **CLI 终端**：交互式 Redis 命令行，支持历史和格式化输出
- **键操作**：删除键（带确认）

### 4.6 气泡布局

- **双列网格**（默认）：气泡 2 列并排显示
- **单列列表**：气泡纵向排列
- 通过输入栏的布局切换按钮切换，设置按项目持久化

---

## 5. 浏览器自动化（CLI）

通过 `cock browser` 命令控制 Console 中打开的浏览器气泡。

### 5.1 基本用法

```bash
cock browser list                        # 列出所有已连接的浏览器
cock browser <id>                        # 查看状态和帮助
cock browser <id> --help                 # 完整命令列表
```

`<id>` 是气泡标题栏的 4 位短标识。

### 5.2 导航

```bash
cock browser <id> navigate --url <url>   # 导航到 URL
cock browser <id> reload                 # 刷新页面
cock browser <id> reload --noCache       # 忽略缓存刷新
cock browser <id> back                   # 后退
cock browser <id> forward                # 前进
cock browser <id> url                    # 获取当前 URL
cock browser <id> title                  # 获取页面标题
```

### 5.3 页面检查

```bash
cock browser <id> snapshot               # 获取页面元素树（a11y tree，每个元素有 ref ID）
cock browser <id> screenshot             # 截图保存到 /tmp，返回路径
```

### 5.4 交互操作

```bash
cock browser <id> click --ref e5         # 点击元素
cock browser <id> type --ref e3 --text "hello"   # 输入文字
cock browser <id> fill --ref e3 --value "hello"  # 填充表单
cock browser <id> hover --ref e5         # 悬浮
cock browser <id> focus --ref e5         # 聚焦
cock browser <id> scroll --direction down        # 滚动
cock browser <id> key Enter              # 按键
cock browser <id> wait --text "Dashboard"        # 等待文本出现
```

ref ID 通过 `snapshot` 命令获取。

### 5.5 JavaScript 执行

```bash
cock browser <id> evaluate --js "return document.title"
cock browser <id> evaluate --js "return document.querySelector('.btn').textContent" --all-frames
```

`--all-frames` 在所有 iframe 中执行。执行上下文继承页面的登录态。

### 5.6 调试工具

```bash
cock browser <id> console --level error          # 查看 console 错误
cock browser <id> network --status 4xx,5xx       # 查看失败的网络请求
cock browser <id> network_record start           # 开始录制网络请求
cock browser <id> network_record stop            # 停止录制并输出
cock browser <id> perf --metric timing           # 页面加载性能
cock browser <id> cookies                        # 查看 Cookie
cock browser <id> storage --type local           # 查看 localStorage
cock browser <id> theme --mode dark              # 切换深色模式
```

### 5.7 断言

```bash
cock browser <id> assert --ref e5 --visible true
# 输出 PASS 或 FAIL，失败时 exit code 为 1
```

### 5.8 数据流

```
CLI 命令 → HTTP API → WebSocket → BrowserBubble → postMessage → iframe content script → 执行 → 结果原路返回
```

---

## 6. 终端自动化（CLI）

通过 `cock terminal` 命令控制 Console 中的终端气泡。

```bash
cock terminal list                       # 列出所有终端
cock terminal <id>                       # 查看状态和帮助
cock terminal <id> output                # 读取终端缓冲输出
cock terminal <id> stdin "npm test"      # 发送命令到终端
cock terminal <id> follow                # 实时流式输出（Ctrl+C 退出）
```

---

## 7. 代码评审系统

### 7.1 创建评审

顶栏「评审下拉框」→ 创建新评审。评审关联当前项目的 Git 变更。

### 7.2 管理评审

- 切换评审的激活/停用状态
- 拖拽调整评审顺序
- 删除评审（需确认）
- 未读评论红点提示

### 7.3 评论

- 在 Diff 视图或代码预览中选中文本 → 添加评论
- 评论按文件分组显示
- 支持回复
- 评论可以发送给 AI 作为代码上下文

### 7.4 局域网分享

评审页面通过 Share Server 暴露到局域网（端口 = 主端口 + 1000）：

- 生产环境：`http://<局域网IP>:4457/review/<id>`
- 仅开放 `/review/*` 路径，其他路由 403

---

## 8. 定时任务

### 8.1 创建任务

ChatInput 工具栏的时钟按钮打开创建面板，三种模式：

| 模式 | 配置 | 示例 |
|------|------|------|
| 一次性 | 延迟分钟数 | 30 分钟后执行 |
| 间隔 | 间隔分钟数 + 可选活跃时间窗口 | 每 60 分钟，09:00-18:00 |
| Cron | cron 表达式 | `0 9 * * 1-5`（工作日 9 点） |

任务会在指定时间自动向当前会话发送消息，Claude 自动回复。

### 8.2 管理任务

侧栏「定时任务面板」：

- 查看所有任务状态（运行中/已暂停/已完成）
- 未读红点（任务执行完成后）
- 操作：立即运行、编辑、暂停/恢复、删除
- 拖拽排序
- 点击任务跳转到对应项目和会话

### 8.3 活跃时间窗口

间隔类型支持设置活跃时间范围（如 `09:00-18:00`），在范围外的触发会被跳过。支持跨午夜（如 `22:00-06:00`）。

---

## 9. 笔记系统

### 9.1 访问方式

- ChatInput 工具栏的笔记按钮 → 项目笔记
- Console 输入栏的笔记按钮 → 项目笔记
- 侧栏笔记按钮 → 全局笔记

### 9.2 编辑器

基于 TipTap 的富文本编辑器：

- **工具栏**：加粗、斜体、代码、标题（H1-H3）、列表（有序/无序/任务）、引用、表格、撤销/重做、链接
- **斜杠命令**（输入 `/`）：插入标题、列表、任务列表、引用、代码块、表格、分割线、链接
- **自动保存**：修改后 5 秒自动保存

---

## 10. Git 工具

### 10.1 Git Worktree 管理

顶栏 Git 分支按钮打开：

- 查看所有 worktree 及其分支和 HEAD commit
- 创建新 worktree（自动建议路径和分支名）
- 切换到 worktree（在新项目 iframe 中打开）
- 删除 worktree

### 10.2 分支切换

顶栏分支名下拉框：

- 搜索过滤分支
- 显示本地和远程分支
- 点击切换分支

### 10.3 Git Stage All

ChatInput 的 + 按钮：执行 `git add -A` 暂存所有变更。

---

## 11. LSP 代码智能

支持 TypeScript（tsserver）和 Python（pyright）。

### 11.1 跳转定义

**Cmd+Click** 点击代码中的标识符，跳转到定义位置：

- 同文件内滚动到定义处
- 跨文件时自动打开目标文件

### 11.2 类型悬浮

鼠标悬浮在标识符上 300ms 后显示类型信息和文档。

### 11.3 查找引用

在浮动工具栏或右键菜单中触发，底部面板列出所有引用位置，点击跳转。

### 11.4 导航历史

跳转定义后：

- **Ctrl+-** 后退到上一个位置
- **Ctrl+Shift+-** 前进到下一个位置

---

## 12. Chrome 插件

### 12.1 安装

1. Chrome 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选 `chrome-extension/` 目录

### 12.2 功能

插件为浏览器气泡提供以下能力：

- **Cookie 注入**：将主浏览器的 Cookie 复制到 iframe 请求中，实现 iframe 内保持登录态
- **CSP/X-Frame-Options 移除**：允许任意网页在 iframe 中加载
- **链接拦截**：`target="_blank"` 和 `window.open()` 重定向到新气泡
- **URL 追踪**：监听 SPA 路由变化，更新气泡的 URL 显示
- **iframe 伪装**：让 iframe 内的页面认为自己是顶层窗口
- **自动化层**：提供元素树构建、点击、输入、截图等自动化能力

### 12.3 状态检查

设置面板（侧栏齿轮图标）显示：

- 插件是否已安装
- 插件版本号
- 插件目录路径（可复制）
- 重新加载插件按钮

---

## 13. 快捷键速查

### 全局

| 快捷键 | 作用 |
|--------|------|
| Cmd+1 | 切换到 Agent |
| Cmd+2 | 切换到 Explorer |
| Cmd+3 | 切换到 Console |

### Agent

| 快捷键 | 作用 |
|--------|------|
| Enter | 发送消息 |
| Shift+Enter | 换行 |
| Escape | 停止 AI 生成 |

### Explorer

| 快捷键 | 作用 |
|--------|------|
| Cmd+P | 快速打开文件 |
| Cmd+F | 文件内搜索 |
| Cmd+Click | 跳转定义 |
| Ctrl+- | 导航后退 |
| Ctrl+Shift+- | 导航前进 |
| Cmd+C | 复制文件 |
| Cmd+V | 粘贴文件 |
| Cmd+S | 保存编辑中的文件 |
| Cmd+Enter | 保存编辑中的文件 |
| Escape | 退出 Blame → 退出搜索 → 关闭 Explorer（3 秒内连续按）|

### Console

| 快捷键 | 作用 |
|--------|------|
| Tab | 命令补全 |
| 上/下箭头 | 命令历史 |
| Cmd+M | 放大/还原选中气泡 |
| Ctrl+C/D/Z | PTY 终端控制键 |

### Vi 模式（Explorer 代码查看器）

| 按键 | 作用 |
|------|------|
| h j k l | 左/下/上/右移动 |
| w b e | 词级移动 |
| gg / G | 跳到首行/末行 |
| Ctrl+D / Ctrl+U | 半页下滚/上滚 |
| dd | 删除行 |
| yy | 复制行 |
| p | 粘贴 |
| x | 删除字符 |
| o / O | 在下方/上方新建行 |
| i / a / I / A | 进入插入模式 |
| :w | 保存 |
| /关键词 | 搜索 |
| n / N | 下一个/上一个匹配 |
| u | 撤销 |
