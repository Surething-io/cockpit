从 `npm install` 到在你自己的项目上跑一个真实的 agent 任务 —— 一篇看完。最后的实战 walkthrough 会用到三个面板，是最快理解 Cockpit 在干什么的方式。

## 前置条件

| 组件 | 最低版本 | 备注 |
|---|---|---|
| **Node.js** | 20.x | 在 20 LTS 和 22 上测试通过；不支持更老的版本。 |
| **Claude Code** | 最新版 | 默认 Claude 引擎需要。`npm install -g @anthropic-ai/claude-code`，然后跑一次 `claude` 让它把 token 存到 `~/.claude/`。 |
| **Git** | 任意近期版本 | 驱动 Git 状态 / 历史 / blame 视图。 |
| **Chrome / Chromium** | 任意近期版本 | 可选 —— 仅当使用浏览器气泡或 Chrome 扩展时需要。 |
| **操作系统** | macOS / Linux / Windows | 三平台原生支持。Windows 上 WSL2 可用但非必需。 |

## 安装

```bash
npm install -g @surething/cockpit
```

会在 PATH 装两个等价的命令：

- **`cockpit`** —— 完整命令。
- **`cock`** —— 日常用的短别名。

验证安装：

```bash
cockpit -v
```

### 可选：Chrome 扩展

仅当你想用浏览器气泡接管真实 Chrome 标签页（读取 DOM、抓网络请求、在页面上执行 JavaScript）时才需要。Agent 和 Explorer 面板不用它也能跑。四步安装见 [Chrome 扩展 → 安装与自动重载](/zh/docs/console/chrome-extension/#安装与自动重载)。

### 可选：换端口

默认 **3457**。每次启动用 `--port 4000` 换。

## 启动

在任意项目目录里：

```bash
cockpit .
```

或者指定一个目录：

```bash
cockpit ~/code/my-project
```

服务在 3457 端口启动，并自动打开 `http://localhost:3457`。加 `--no-open` 阻止自动开浏览器。

## 开始聊天

UI 加载完会落在 **Agent** 面板，默认是 Claude tab。

1. 在底部输入框打字，`Enter` 发送。
2. `Shift+Enter` 换行。
3. 粘贴图片自动作为附件。
4. 行首加 `!` 直接执行 shell 命令 —— 输出作为上下文回传给 AI。

每个 tab 独立 —— 点 tab 旁边的 `+` 按钮新开一个，点侧栏里的 sessions 图标打开跨项目的 Session Browser。

## 要记住的快捷键

| 快捷键 | 作用 |
|---|---|
| `Cmd+1 / 2 / 3` | 切面板：Agent / Explorer / Console |
| `Cmd+P` | 快速打开文件（项目内模糊匹配） |
| `Cmd+F` | 当前文件内搜索 |
| `Cmd+M` | 当前气泡最大化 |

## 实战：从需求到上线（用满三个面板）

Cockpit 真正发挥威力的地方是**并行工作流** —— 同时开多个分支跑需求和修 bug。下面这个流程贯穿三个面板,是最快理解它在干什么的方式。

### 准备工作 —— 用 worktree 并行

打开项目(main 分支),Cockpit **顶栏**(TabManager 那一行,在三面板之上)能看到当前分支名 **main**。点它,弹出 **worktree 对话框**,逐个加 5 个 worktree(对话框每次创建一个,点 5 次)。

现在同一个 Cockpit 窗口里可以并行 5 个项目 tab:3 个跑需求开发、2 个修 bug,互不打扰。每个 worktree 是独立的工作区 + 独立的 chat session。

### 需求开发 —— `/qa` → `/cg` → `/ex` → `/go` → review

1. **`/qa`** —— 描述需求。Claude 切到"需求澄清"模式,先反问待澄清点,而不是直接动手。

   ```text
   /qa 给商品详情页加一个"相关推荐"模块,数据来源是同类目下浏览量最高的 10 个商品
   ```

2. **划词评论** —— 在 AI 的回答里选中关键句加评论,Cockpit 会按顺序编号(1、2、3……)。每条评论先**只贴在本地**作为待办;**等你下一次在聊天框发消息时,Cockpit 自动把所有未处理的评论(连同被锚定的文字)一并附在消息里发给 AI**。

   想直接对评论触发一次新请求,选中 AI 回复里的文字时会出现一个 **Send to AI** 小输入框 —— 输入补充说明 + 回车,这条选中文字 + 当前未处理的所有评论一起作为新一轮 prompt 推过去。

3. **`/cg`** —— 影响面评估,基于 [CodeGraph](/zh/docs/explorer/search/#codegraph) 索引。

   ```text
   /cg 这个改动会牵动哪些文件、哪些 API、哪些测试?
   ```

4. **`/ex`** —— 让 AI 总结一下对需求的理解。

   ```text
   /ex 总结一下你对这个需求的理解,以及计划怎么实现
   ```

5. **再划词** —— 对 AI 的总结划词评论,把分歧点对齐。

6. **`/go`** —— 开干。Claude 把改动切成 MVP 阶段、写代码、每个阶段自验证,**完成后给一个决策树**说明每个分支选了哪条路径、为什么。

   ```text
   /go 按上面的方案落地
   ```

7. **代码 review** —— 切到 Explorer 的 **变更** tab,逐文件看 AI 改了什么。不满意的地方继续**划词评论**(多轮);评论支持"发送到 AI"动作触发代码修复 —— 见 [评注](/zh/docs/explorer/file-tree/#评注)。

### 端到端验证 —— Console 拉起服务 + `/cc` 测试

代码改完先在本地跑起来:

1. 切到 **Console**(`Cmd+3`),输入 `zsh` 起一个交互式终端,再 `npm run dev`。
2. 终端气泡头部有个**短 ID 徽章**,点它把 `cock terminal <id>` 复制到剪贴板 —— 这样 AI 能通过 Cockpit CLI 读它的输出:`cock terminal <id> output`(拿最近输出)、`cock terminal <id> wait`(等命令收尾)、`cock terminal list`(列出所有注册过的终端)。
3. 还在 Console,输入应用 URL(比如 `http://localhost:3456`)打开浏览器气泡。点浏览器气泡头部的短 ID 徽章拿到 `cock browser <id>`。**装了 [Chrome 扩展](/zh/docs/console/chrome-extension/#安装与自动重载) 后**通过 `cock browser <id> <action>` 真驱动 Chrome 标签页 —— 支持的 action 包括 `snapshot` / `navigate` / `click` / `type` / `fill` / `hover` / `evaluate` / `console` / `network` / `cookies` / `storage` / `perf`;不装也能在 iframe 里显示页面但功能有限。
4. 在 Agent 用 **`/cc`** 让 AI 端到端测一遍 —— 把两个短 ID 顺手粘进 prompt 里:

   ```text
   /cc 终端: cock terminal abc123
       浏览器: cock browser xyz789
       测一下 chat 输入框的发送功能,验证消息能正确入库且 UI 实时刷新
   ```

   `/cc` 让 AI 通过 `cock` CLI 直接驱动你给的终端和浏览器气泡,抓网络、读 DOM,把验证证据给你看。

### bug 修复 —— `/fx` → `/cg` → `/ex` → `/go`

切到另一个 worktree 的 tab 修 bug。流程和需求开发对称,只是入口换成 `/fx`:

1. **`/fx`** —— 描述 bug。Claude 进 **bug 证据链模式**,只分析不写代码。

   ```text
   /fx 用户报"商品列表分页第 3 页加载慢",定位根因
   ```

2. **划词评论** —— 同需求开发那套(评论 1、2、3 按顺序编号,下一次发消息自动连同附上;或选 AI 回复里的文字弹出 Send to AI 输入框立即触发)。

3. **`/cg`** —— 二次确认假设(调用关系、co-edit 历史等)。

   ```text
   /cg 看一下 PaginatedList 的 callers 和 N+1 查询风险
   ```

4. **`/ex`** —— 输出修复方案,含权衡。

5. **再划词** —— 对修复方案对齐。

6. **`/go`** —— 开干。然后回到上面的 e2e 验证流程,通过 `/cc` 端到端确认 bug 真的修了。

### 你用到了什么

- **worktree**: 并行 5 条工作线,需求 + bug 互不打扰
- **Agent**: `/qa /cg /ex /go /fx /cc` 六个内置斜杠命令 + 划词评论的多轮对齐
- **Explorer**: **变更** tab + 评注驱动的代码修复循环
- **Console**: zsh 跑服务 + 浏览器气泡 + 气泡的**短 ID 徽章**注册,让 AI 能通过 `cock` CLI 闭环驱动它们

## 升级

```bash
npm install -g @surething/cockpit@latest
```

或者用内置帮手：

```bash
cockpit update
```

两者等价。设置、会话、Skills 和 API key 都存在 `~/.cockpit/` 下，升级时保留。

## 卸载

```bash
npm uninstall -g @surething/cockpit
```

要连本地状态一起删：

```bash
rm -rf ~/.cockpit
```

> 如果之后还会重装，先备份 `~/.cockpit/` 文件夹 —— 会话、钉住 tab、定时任务和其他状态都在里面。

## 下一步

- [引擎概览](/zh/docs/agent/engines/) —— 接入 Codex / DeepSeek / Kimi / Ollama
- [Skills](/zh/docs/agent/skills/) —— `/qa /fx /ex /go /cg /cc` 到底干什么
- [CLI 参考](/zh/docs/reference/cli/) —— 用外部脚本驱动气泡
