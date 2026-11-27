从 `npm install` 到在你自己的项目上跑一个真实的 agent 任务 —— 一篇看完。最后的实战 walkthrough 会用到三个面板，是最快理解 OpenCockpit 在干什么的方式。

## 前置条件

| 组件 | 最低版本 | 备注 |
|---|---|---|
| **Node.js** | 22.19.0 | 检查版本用 `node -v`。 |
| **Claude Code** | 最新版 | 默认 Claude 引擎需要。`npm install -g @anthropic-ai/claude-code`，然后跑一次 `claude` 让它把 token 存到 `~/.claude/`。 |
| **Git** | 任意近期版本 | 驱动 Git 状态 / 历史 / blame 视图。 |
| **Chrome / Chromium** | 任意近期版本 | 可选 —— 仅当需要 AI 操作网页（配合 Chrome 扩展）时需要。 |
| **操作系统** | macOS / Linux / Windows | 三平台原生支持。Windows 上 WSL2 可用但非必需。 |

## 安装

```bash
npm install -g @surething/cockpit
```

会在 PATH 装两个等价的命令：

- **`cockpit`** —— 完整命令。

验证安装：

```bash
cockpit -v
```

### 可选：Chrome 扩展

仅当你需要 AI 操作网页时才需要：你的 Chrome 标签页，以及 Console 里的浏览器气泡（读取 DOM、点击输入、抓网络请求、在页面上执行 JavaScript）。Agent 和 Explorer 面板不用它也能跑。安装步骤见 [Chrome 扩展 → 安装](/zh/docs/console/chrome-extension/#安装)。

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

### 用桌面 App（macOS / Windows）

想要独立窗口和程序坞 / 开始菜单图标，就装和当前 Cockpit 版本对应的桌面 App：

```bash
cockpit app install
```

桌面 App 是本机 Cockpit 的窗口：需要时它会用 `cockpit start` 拉起服务，关掉窗口服务照样在跑。更新、卸载和常见问题见 [桌面 App](/zh/docs/get-started/desktop-app/)。

### 或者装成网页应用（PWA）

在 Linux 上，或者不想装 App，可以用 PWA：Cockpit 自带 Web App Manifest，Chrome / Edge 会把 `http://localhost:3457` 当成可安装的 PWA。装一次，之后就在独立窗口里跑，没有地址栏和标签页。

1. 在地址栏右侧点**安装图标**（或菜单 → 安装 OpenCockpit）装一次。
2. 装好后，再访问 `http://localhost:3457` 时地址栏会出现 **在应用中打开** 的按钮 —— 点它就在独立应用窗口里打开。
3. 已经开着应用窗口时点这个按钮，会复用现有窗口而不是新开一个（`launch_handler: navigate-existing`）。

窄屏（手机/平板）安装后会自动进入 `/m` 移动版，桌面安装则落在完整三面板工作台 —— 同一个安装适配两端。

### 在手机上打开

在电脑上用手机也能访问的域名或内网地址打开 Cockpit，点击顶栏二维码图标 **在手机上打开**。扫码会打开手机版，电脑上已有打开的会话时会直达该会话。通过 `localhost` 打开时，二维码入口会隐藏。启用 Token 验证后，二维码包含访问令牌，请按密码保管。

要用手机访问正在本机或 Docker 运行的 Cockpit，见 [本机远程访问](/zh/docs/get-started/remote-access/)。如果想把 Cockpit 常驻在服务器上，见 [服务端部署](/zh/docs/get-started/server-deployment/)。

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

### 需求开发 —— `/qa` → `/spec` → `/design` → `/go` → `/cr`

下面展示完整流程；简单改动可以跳过没有新增价值的阶段。前三步用于澄清、定义行为和技术设计，不执行功能实现；明确使用 `/go` 后再开始写代码。

1. **`/qa`** —— 澄清需求。AI 产出精简 PRD，明确目标、范围、假设和需要你选择的关键问题。

   ```text
   /qa 给商品详情页加一个“相关推荐”模块，数据来源是同类目下浏览量最高的 10 个商品
   ```

2. **划词评论** —— 在 AI 的回答里选中关键句加评论，Cockpit 会按顺序编号。评论先保留在本地；下一次发送消息时，所有未处理的评论及其锚定文字会自动附给 AI。也可以在选中文字后出现的 **Send to AI** 输入框里补充说明并回车，直接发起一轮对齐。

3. **`/spec`** —— 把已确认需求写成行为规则、接口契约、边界和验收标准，让开发与测试有明确依据。

   ```text
   /spec 整理相关推荐模块的规格，明确不足 10 个商品、无推荐结果和加载失败时的行为及验收标准
   ```

4. **`/design`** —— 结合现有代码确定技术方案，说明职责、数据流和关键取舍，给出按依赖排序的实施步骤与验证计划。需要单独探索影响面时，可先用 `/cg` 查询 [CodeGraph](/zh/docs/explorer/search/#codegraph)。

   ```text
   /design 根据上述规格，核实商品查询和详情页的数据流，给出技术方案、实施顺序和验证路径
   ```

5. **再划词** —— 对规格或技术设计中的分歧继续评论、补充；已确认的决定沿用，不必重复讨论。

6. **`/go`** —— 实施已确认的工作，分小步修改并验证，记录规格未覆盖的决策，汇报完成情况、阻塞和遗留项。

   ```text
   /go 按上述规格和技术设计实施
   ```

7. **`/cr`** —— 让 AI 检查静态正确性，以及状态、时序和并发等运行时行为，报告发现的问题。

   ```text
   /cr 审一下这次改动
   ```

8. **代码 review** —— 切到 Explorer 的 **变更** tab，逐文件看 AI 改了什么。不满意的地方继续划词评论，通过“发送到 AI”发起修复 —— 见 [评注](/zh/docs/explorer/file-tree/#评注)。

### 端到端验证 —— Console 拉起服务 + `/cc` 测试

代码改完先在本地跑起来:

1. 切到 **Console**(`Cmd+3`),输入 `zsh` 起一个交互式终端,再 `npm run dev`。
2. 终端气泡头部有个**短 ID 徽章**,点它把 `cockpit terminal <id>` 复制到剪贴板 —— 这样 AI 能通过 Cockpit CLI 读它的输出:`cockpit terminal <id> output`(拿最近输出)、`cockpit terminal <id> wait`(等命令收尾)、`cockpit terminal list`(列出所有注册过的终端)。
3. 还在 Console,输入应用 URL(比如 `http://localhost:3456`)。它会在 **Cockpit** 分组里以 Chrome 标签页打开,同时弹出提示给出它的命令,例如 `cockpit browser xyz789`(扩展工具栏小面板里也有 **Copy** 按钮)。**装了 [Chrome 扩展](/zh/docs/console/chrome-extension/#安装) 后**通过 `cockpit browser <id> <action>` 用真实输入操作这个标签页 —— `snapshot` / `click` / `type` / `fill` / `evaluate` / `console` / `network` / `dialog` / `upload` / `viewport` / `screenshot` 等,[完整列表](/zh/docs/reference/cli/#cockpit-browser);不装扩展页面照样会打开,但 AI 没法操作它。
4. 在 Agent 用 **`/cc`** 让 AI 端到端测一遍 —— 把两个短 ID 顺手粘进 prompt 里:

   ```text
   /cc 终端: cockpit terminal abc123
       浏览器: cockpit browser xyz789
       测一下 chat 输入框的发送功能,验证消息能正确入库且 UI 实时刷新
   ```

   `/cc` 让 AI 通过 `cockpit` CLI 直接驱动你给的终端和浏览器标签页,抓网络、读 DOM,把验证证据给你看。

### bug 修复 —— `/fx` → `/cg` → `/design` → `/go`

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

4. **`/design`** —— 根据根因和代码证据确定修复方案，明确保留的行为、实施步骤和回归验证。简单修复已有明确方案时可直接进入 `/go`。

   ```text
   /design 根据上述根因设计修复，说明影响范围、实施步骤和如何验证分页行为不受影响
   ```

5. **再划词** —— 对修复方案对齐。

6. **`/go`** —— 开干。然后回到上面的 e2e 验证流程,通过 `/cc` 端到端确认 bug 真的修了。

### 你用到了什么

- **worktree**: 并行 5 条工作线,需求 + bug 互不打扰
- **Agent**: `/qa /spec /design /go /cr /fx /cg /cc` 内置斜杠命令 + 划词评论的多轮对齐
- **Explorer**: **变更** tab + 评注驱动的代码修复循环
- **Console**: zsh 跑服务 + 网页以 Chrome 标签页打开 + 终端和标签页的**短 ID**,让 AI 能通过 `cockpit` CLI 闭环驱动它们

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

> 如果之后还会重装，先备份 `~/.cockpit/` 文件夹 —— 会话、收藏、定时任务和其他状态都在里面。

## 下一步

- [引擎概览](/zh/docs/agent/engines/) —— 接入 Codex / DeepSeek / GLM / Kimi / Ollama
- [Skills](/zh/docs/agent/skills/) —— `/qa /spec /design /fx /ex /go /cg /cc /cr` 到底干什么
- [CLI 参考](/zh/docs/reference/cli/) —— 用外部脚本驱动气泡
