Cockpit CLI 是运行中的 Cockpit 服务器 HTTP API 的一层薄包装。`npm install -g @surething/cockpit` 装两个等价的二进制:**`cockpit`**(完整名)和 **`cock`**(短别名)。服务器本身常驻;子命令通过 HTTP 调 `localhost:3457` 来查看或驱动你面板里开着的东西。

| 命令 | 作用 |
|---|---|
| [`cockpit`](#cockpit-and-cock) | 启动服务器(主入口) |
| [`cockpit browser`](#cockpit-browser) | 驱动浏览器气泡 —— 导航、点击、执行 JS、抓网络 |
| [`cockpit terminal`](#cockpit-terminal) | 读终端气泡的输出(只读;无 stdin) |
| [`cockpit codegraph`](#cockpit-codegraph) | 在 shell 里查项目级代码索引 |
| [`cockpit connection`](#cockpit-connection) | 列出所有气泡(终端 + 浏览器)及其标题 |
| [`cockpit update`](#cockpit-update) | 升级到最新版本 |

## cockpit 和 cock

`cockpit` 是主命令。短别名是 `cock` —— `npm install -g @surething/cockpit` 时两个都装。

### 用法

```text
cockpit [path] [options]
cock    [path] [options]
```

两个命令完全等价，选你喜欢打的。

### 常见形式

在当前目录启动：

```bash
cockpit
```

在指定项目启动：

```bash
cockpit ~/code/my-project
```

启动但不自动开浏览器：

```bash
cockpit . --no-open
```

用别的端口启动：

```bash
cockpit . --port 4000
```

显示版本：

```bash
cockpit -v
```

### 选项

| 标志 | 说明 |
|---|---|
| `-v`、`--version` | 打印版本并退出。 |
| `-h`、`--help` | 显示帮助。 |
| `--port <n>` | 用非默认端口监听。默认 `3457`。 |
| `--no-open` | 启动后不自动开浏览器。 |
| `--token <value>` | 要求**远程**访问携带共享令牌(本机 loopback 仍豁免)。会设置 `COCKPIT_TOKEN`;不传则完全关闭。见[共享令牌访问网关](#共享令牌访问网关)。 |
| `[path]` | 打开的工作目录。默认 `process.cwd()`。 |

### 默认端口

Cockpit 监听 **3457**(dev 模式 **3456**)。可单次用 `--port` 覆盖,或用 `COCKPIT_PORT` 环境变量永久设置:

```bash
COCKPIT_PORT=4000 cockpit
```

两者都设时 `--port` 优先。(`<数据目录>/server.json` 由运行中的服务写入,记录活实例的 pid/端口,供 `cock` 子命令和单实例保护使用;服务**不会**回读它来决定端口,手动改无效。)

### 子命令

`cockpit` 本身启动服务。两个子命令用于从外部脚本驱动 Cockpit（CI、ChatOps、自动化）：

| 子命令 | 用途 |
|---|---|
| `cockpit browser <id> <action>` | 驱动正在跑的浏览器气泡（导航、点击、执行 JS、抓网络等） |
| `cockpit terminal <id> <action>` | 读正在跑的终端气泡(`list` / `output` / `wait`;只读) |

两者都连 `localhost:3457` 上正在跑的 Cockpit 服务。这些是 UI 内部用的同一套 API；暴露为 CLI 让你能从任何地方脚本化驱动气泡。

详见：

- [`cockpit browser`](#cockpit-browser) —— 全部 action 列表（25+ 个：snapshot、click、type、network、perf 等）
- [`cockpit terminal`](#cockpit-terminal) —— list / output / wait(只读)

### 升级

```bash
cockpit update
```

等同于 `npm install -g @surething/cockpit@latest`。升级时保留什么见 [`cockpit update`](#cockpit-update)。

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 正常退出（服务干净停了） |
| `1` | 服务启动失败（端口被占、权限拒绝、缺 Node 等） |
| `130` | 被 `Ctrl+C` 杀掉（`SIGINT`） |

### 环境变量

| 变量 | 效果 |
|---|---|
| `COCKPIT_HOME` | 数据目录,默认 `~/.cockpit`。指向别处可隔离某个实例的数据 —— 会话、定时任务、终端历史、设置、Skills —— 例如让 dev 实例与 prod 并存而不共享数据。支持 `~`、相对、绝对路径。 |
| `COCKPIT_PORT` | 服务端口(同 `--port`);也被 `cock` 子命令与 `/cg` 片段读取。 |
| `PORT` | `COCKPIT_PORT` 未设时的兜底。 |
| `COCKPIT_HOST` | 绑定 host。默认 `127.0.0.1`(仅本机);设 `0.0.0.0` 可在局域网 / 云沙盒暴露。 |
| `COCKPIT_TOKEN` | 共享访问令牌(同 `--token`)。设置后,远程 HTTP/WS 请求必须携带它(cookie / `Authorization: Bearer` / `?token=`);本机 loopback 请求豁免。未设 = 不鉴权(完全开放)。详见[下文](#共享令牌访问网关)。 |
| `COCKPIT_NO_OPEN` | 启动后不自动开浏览器(同 `--no-open`)。 |
| `COCKPIT_LOG_LEVEL` | 服务日志级别。 |
| `COCKPIT_FORCE` | 跳过单实例保护(见下)。 |

#### 数据目录与起第二个实例

Cockpit 持久化的一切都在数据目录下 —— 默认 `~/.cockpit`,或 `COCKPIT_HOME` 指向的位置。**一份数据目录同时只允许一个实例**:启动时 Cockpit 探测 `/api/health`,若同一数据目录已有活实例,则拒绝启动并提示用 `COCKPIT_HOME`。

要起第二个实例(如 dev 与 prod 并存),给它独立的数据目录:

```bash
COCKPIT_HOME=~/.cockpit-dev cockpit
```

设 `COCKPIT_FORCE=1` 跳过该保护(若是崩溃残留的过期锁,删 `<数据目录>/server.json` 也可)。

#### 共享令牌访问网关

默认 Cockpit **完全开放** —— 任何能连到端口的人都能用。纯本机安装没问题,但当你把 Cockpit 暴露到局域网或云沙盒(`COCKPIT_HOST=0.0.0.0`)时,打开共享令牌网关:

```bash
cockpit --token 你的密钥        # 或:COCKPIT_TOKEN=你的密钥 cockpit
```

设置令牌后:

- **本机(loopback)请求仍然豁免** —— CLI、`/cg` 片段、自探测,以及跑在本机上的浏览器都无需令牌照常工作。只信任没有转发头的真正 loopback。
- **远程请求必须携带令牌**,可用以下任一方式:
  - `cockpit_token` **cookie**;
  - `Authorization: Bearer <值>` **请求头**(方便 API / WebSocket 客户端);或
  - `?token=<值>` **查询参数** —— 首次访问时服务会写入 cookie 并重定向到干净 URL,让密钥不残留在地址栏 / 历史里。
- 令牌用常数时间比较;错误或缺失一律拒绝。
- 不设 `--token` / `COCKPIT_TOKEN` 即保持旧的完全开放行为(向后兼容)。

在网络上共享时与 `COCKPIT_HOST=0.0.0.0` 搭配:

```bash
COCKPIT_HOST=0.0.0.0 cockpit --token 你的密钥
```

## cockpit browser

`cockpit browser <id> <action>`（或短名 `cock browser`）从外部驱动你正在跑的 Cockpit 里的浏览器气泡 —— 从聊天里的 AI、从 shell 脚本、从 CI、从任何地方。

`<id>` 是浏览器气泡标题栏上的短 ID 徽章。点徽章注册气泡，把入门命令复制到剪贴板。

CLI 是为 **AI 驱动的 E2E** 设计的：每个命令都带可执行的错误模板，沉默失败会被捕获并告警，act/wait/assert 循环能组合成原子步骤。优先用基于 selector 的交互（`--text`、`--selector`），别依赖 snapshot 返回的 ref —— 任何重渲染都会让 ref 失效。

### 快速示例

```bash
# 诊断 AI 当前停在哪（轻量，永不阻塞）
cock browser xa7k2 health
cock browser xa7k2 status

# 找元素并交互（selector 优先；ref 易失效）
cock browser xa7k2 snapshot --filter 'role=button' --include-hidden-text
cock browser xa7k2 click --text "Sign in"
cock browser xa7k2 click --selector 'button[type="submit"]'
cock browser xa7k2 fill --selector 'input[name="email"]' --value "user@example.com"
cock browser xa7k2 submit --form-selector 'form#login'

# 探后端（继承页面登录态）
cock browser xa7k2 fetch /api/users/me
cock browser xa7k2 fetch /api/items --method POST --body '{"name":"hello"}'
cock browser xa7k2 fetch /api/items --json '$.data[0].id'

# act → wait → assert（E2E 原子步骤）
cock browser xa7k2 click --text "Save"
cock browser xa7k2 wait --network-idle --quiet-ms 500
cock browser xa7k2 assert --selector '[role="status"]' --text "Saved"
cock browser xa7k2 assert --fetch /api/items --jsonpath '$.count' --equals 5

# 测试隔离
cock browser xa7k2 reset --cookies --storage --reload
cock browser xa7k2 set --type cookie --name token --value abc123 --path /

# 跑任意 JS（逃生口 —— 能用 fetch/click-by-selector 就别用 evaluate）
cock browser xa7k2 evaluate "document.title"
cock browser xa7k2 evaluate --all-frames "await fetch('/api/x').then(r=>r.json())"
```

### 完整 action 列表

#### 检查

| Action | 做什么 |
|---|---|
| `list` | 列出所有当前注册的浏览器气泡 |
| `snapshot [--filter <regex>] [--include-hidden-text] [--max-depth N]` | 无障碍树。开头几行 banner 解释格式。`--filter` 在服务端 grep；`--include-hidden-text` 把 `<summary>`、容器节点折叠的文本展开 |
| `screenshot` | 页面 PNG，存到 `/tmp`，打印路径 |
| `url` | 当前 URL |
| `title` | 页面标题 |
| `status` | 一行摘要：URL、title、上次 console 错、上次失败请求、可见 top 按钮。隔了一段时间后用它定位 |
| `bounds <ref>` | 元素位置和尺寸 |
| `attrs <ref>` | 元素所有 HTML 属性 |
| `computed <ref>` | 元素计算后的 CSS |
| `events <ref>` | 元素绑定的事件监听器 |
| `cookies` | 页面所有 cookie |
| `storage --type local\|session` | localStorage 或 sessionStorage 内容 |
| `theme --mode dark\|light` | 强制气泡主题 |

#### 交互

基于 selector 的形式更稳 —— ref 只在 snapshot 之后到下次重渲染之前有效。

| Action | 做什么 |
|---|---|
| `click [<ref>] [--text <substr>] [--selector <css>] [--nth N] [--exact]` | 按 ref、可见文本 / aria-label、或 CSS selector 点击。Ref 重渲染就失效；selector 和 `--text` 不会 |
| `fill [<ref>] [--selector <css>] --value <v>` | 用 native setter 写值 + 派 `input` 事件（在 React 受控 input 上有效） |
| `type <ref> <text>` | 通过 CDP 键盘事件往聚焦的 input 里打字。React 受控 input 上可能静默无效 —— 优先用 `fill --selector` |
| `submit [--form-selector <css>]` | 调 `form.requestSubmit()`。在 `onKeyDown` 无视 Enter 的场景能工作 |
| `hover <ref>` | 悬停元素 |
| `focus <ref>` | 聚焦元素 |
| `scroll --direction up\|down\|left\|right` | 滚动页面 |
| `key <key>` | 按键（`Enter`、`Ctrl+A`、`Shift+Tab` …）。React input 上优先用 `submit` |

#### 等待（act 与 assert 之间的同步原语）

| Action | 做什么 |
|---|---|
| `wait --network-idle [--quiet-ms 500] [--max-request-age-ms 30000]` | 等到 in-flight HTTP 请求为 0 持续 `quiet-ms`。超过 `max-request-age-ms` 的长连接（SSE / long-poll）会被排除 |
| `wait --selector <css> [--state visible\|hidden\|attached\|detached]` | 等元素到指定状态。默认 `visible` |
| `wait --dom-stable [--quiet-ms 300]` | 用 `MutationObserver` 等 `quiet-ms` 内无 DOM 变化（在 act 后拍 snapshot 前用） |
| `wait --extension-ready [--quiet-ms 500]` | CLI 侧轮询 `health`。**不进 page**，所以 page 卡时不会被拖死。替代手写 `until evaluate "1+1"` |
| `wait --text <substr>` / `--url <pat>` / `--ref <ref>` / `--time <ms>` | 经典条件：文本出现、URL 匹配、ref 仍存在、sleep |

#### 断言（失败时非零退出）

| Action | 做什么 |
|---|---|
| `assert --selector <css> [--text <substr>] [--visible <bool>] [--attr "k=v"]` | 元素级断言。`--ref` 仍可用但易失效；selector 更稳 |
| `assert --network --method <M> --url <pat> --status <S> [--since <ms>]` | 断言 networkBuffer 里有一条匹配请求。`--status` 接整数（`200`）或范围（`2xx`） |
| `assert --fetch <url> [--fetch-method M] [--body B] [--fetch-status N]` `[--jsonpath <P> --equals V \| --contains V \| --not-contains V]` | 发一个 fetch（继承 page auth）然后断言状态码或 JSONPath 值。JSONPath 子集：`$`、`.key`、`[N]`、`[*]` |
| `assert --url <pat>` / `--title <substr>` / `--console-no-errors` | 页面级断言 |

#### 导航

| Action | 做什么 |
|---|---|
| `navigate --url <url>` | 前往 URL |
| `reload [--noCache]` | 刷新（可选跳过缓存） |
| `back` | 后退一格历史 |
| `forward` | 前进一格历史 |

#### 后端探查

| Action | 做什么 |
|---|---|
| `fetch <url> [--method <M>] [--body <B>] [--headers <JSON>]` `[--json <jsonpath>]` | 用 page 的登录态发请求。`--json` 用与 `assert --fetch` 同样的 JSONPath 子集提取值。返回 `{ status, contentType, data }` 或 `{ status, jsonpath, value }` |

AI 读 / 改后端推荐用 `fetch` —— 比把 `await fetch(...).then(r => r.json())` 裹进 `evaluate` 清晰。

#### JavaScript

| Action | 做什么 |
|---|---|
| `evaluate <js>` | 在页面里跑 JS 表达式；结果以 JSON 打印。`--all-frames` 在每个 iframe 里跑。大结果会被透明地分片传回 CLI |

把 `evaluate` 当逃生口用 —— 高层 action 不够用时才上。普通 HTTP 调用用 `fetch`；点击用 `click --text` / `--selector`；断言用 `assert --selector`。

#### 生命周期 / 夹具

| Action | 做什么 |
|---|---|
| `reset [--cookies] [--storage] [--cache] [--reload]` | 原子化测试隔离。按需组合 flag。`--cookies` 让 JS 可见的 cookie 过期；`--storage` 清 `localStorage` 与 `sessionStorage`；`--cache` 删 Cache Storage 条目；`--reload` 清完刷新 |
| `set --type cookie --name <K> --value <V>` `[--domain <D>] [--path <P>] [--secure] [--same-site Lax\|Strict\|None] [--expires <date>]` | 写一个 JS 可见的 cookie。若浏览器拒收（跨域 / `SameSite` 不符 / HTTP 下 `Secure`），返回 `verified: false` |
| `set --type local-storage --name <K> --value <V>` | 写 `localStorage` |
| `set --type session-storage --name <K> --value <V>` | 写 `sessionStorage` |

#### 诊断

| Action | 做什么 |
|---|---|
| `health` | **服务端**视角的桥接快照：WS 状态、pending 命令数、距上次成功命令的耗时。**不经 page**，所以即使页面卡在长 `evaluate` 上也工作 |
| `health --deep` | 进 page 再探一次（`readyState`、`snapshotEpoch`、page 时间戳）。page 卡时会一起卡 |

#### 网络抓取

| Action | 做什么 |
|---|---|
| `network [--status <code>] [--method <method>] [--type <type>] [--clear]` | 列出抓到的请求，带过滤。`--status` 接 `4xx,5xx` 这种逗号分隔 |
| `network_record start [--url <pat>] [--method <m>] [--status <code>]` | 开始录制请求 / 响应 body |
| `network_record stop` | 停止录制 |
| `network_record status` | 录制开了没 |
| `network_detail <reqId>` | 某个请求的完整 request / response |
| `console [--level error\|warn\|info\|debug] [--clear]` | 控制台消息 |
| `perf [--metric timing\|memory\|resources]` | 性能指标，含 Core Web Vitals |

### snapshot 输出

`snapshot` 返回纯文本无障碍树。前 4-5 行是 banner，解释格式并标注当前 **snapshot 版本**（`v=N`）：

```text
# a11y tree v=3 — refs valid until next snapshot
# Text inside <details>/<summary> and unnamed container <div>/<section> is collapsed.
# Grep on role / aria-label, NOT on user-visible emoji / text.
# Tips: --include-hidden-text surfaces collapsed innerText; --filter <regex> reduces output.
body [e0#v3]
  ...
```

每个可定位元素带形如 `e5#v3` 的 ref。`#v3` 后缀是 snapshot 的 epoch —— 来自更早 snapshot 的 ref 会被拒绝，错误信息直接指向 `click --text` / `click --selector` 这种重渲染安全的写法。**大多数 AI 流程不需要碰 ref，直接用 `--text` / `--selector` 就够了。**

### `click` / `key` / `submit` 的 post-verify

这三个 action 最容易 **沉默失败** —— CDP 报 "成功" 但框架没真反应（React 受控 input 忽略合成 `keydown`、portal 渲染的按钮没有真 handler 等）。CLI 会在 action 前后悄悄探一次页面状态；如果 verify 窗口内没有任何可观察的变化，就往 stderr 写警告 + 可执行模板（不影响 stdout 的主结果）。

| Flag | 做什么 |
|---|---|
| `--verify-ms <ms>` | 覆盖 verify 窗口。默认 `1000` 毫秒。调小 = 更快但 React 慢渲染上更容易误报；调大 = 更宽容 |
| `--skip-verify`（或 `--no-verify`）| 关闭本次命令的 post-verify（比如确认无可见副作用的合法 click） |

### 输出格式

大多数 action 在 stdout 返回 **JSON** —— 容易管道到 `jq`、`gron`，或 AI 读取。`url`、`title`、`network_detail` 返回纯文本。`screenshot` 返回文件路径。`snapshot` 返回 banner + 纯文本树。`health`、`status`、`wait`、`assert` 输出一行人类友好摘要。`fetch` 先打印 `[status] (contentType)` 再打印 body，或 `[status] $.jsonpath =` 再打印提取值。

警告（沉默失败检测、cookie 被拒收等）都写 **stderr**。主结果留在 stdout，所以 `>` 重定向能抓真数据同时让 AI 看到警告。

### 退出码

成功 `0`，失败非零（ref 失效、网络错、断言失败、selector 无匹配 …）。完整退出码列表见 [主 CLI 页](#cockpit-and-cock)。

### 何时不该用这个 CLI

- **测 LLM agent 驱动的端到端流程**。agent 的随机工具选择和 `stop_reason` 会让 UI 断言不稳定。优先写一个直接调中间件 / 服务的运行时脚本，用受控输入跑。
- **页面持续 stream / 重渲染超过 10 秒**。`evaluate` 会被 page 工作排队，可能超时（~15 秒默认）。act 与 assert 之间用 `wait --extension-ready`；如果还是挂，切到服务层测试。
- **多 tab / OAuth 弹窗**。每个浏览器气泡只跟一个 tab。把第二个 tab 开成独立气泡，或把 OAuth 流 stub 掉。

## cockpit terminal

`cockpit terminal <id> <action>`(或 `cock terminal`)从外部**读取**终端气泡的输出 —— 拿缓冲输出、等命令收尾、列出已注册的气泡。

> 注意:终端 CLI 故意设计成**只读**。**没有 `stdin`** 也**没有 `follow` 流式跟随** —— 想驱动 shell 用浏览器气泡 + `cock browser`,或在 Cockpit UI 里跟气泡直接交互。代码注释:"read-only by design; write side belongs to the Bash tool / web UI"。

`<id>` 是终端气泡标题栏的短 ID 徽章。点徽章注册气泡,把入门命令复制到剪贴板。

### 完整 action 列表

| Action | 做什么 |
|---|---|
| `list` | 列出所有当前注册的终端气泡。显示状态(running / idle)和各自的命令。 |
| `output` | 打印终端的完整缓冲输出 —— 从气泡启动起的完整历史。 |
| `wait` | 阻塞等当前运行的命令收尾后返回,适合脚本里"等 `npm run build` 跑完再继续"的场景。 |

### 快速示例

```bash
# 找你的气泡
cock terminal list

# 抓当前屏幕内容
cock terminal xy789 output

# 等 npm run build 跑完
cock terminal xy789 wait

# 跑完后看结果
cock terminal xy789 output | tail -50
```

### 什么时候用

主要场景:

- **AI 通过气泡读你 shell 在跑什么。** 在 Cockpit 终端气泡里启动 `npm run dev`。聊天里把 `cock terminal <id>` 给 AI,它可以 `output` 拿最近日志、`wait` 等命令收尾。
- **CI / 脚本里从外部观察 Cockpit 里的长跑命令。** 比如启动器脚本在 Cockpit 终端跑 `npm run dev`,然后另一个脚本 `cock terminal <id> output` 抓日志做断言。

### 限制

终端 CLI 跟浏览器 CLI 比有意做轻:

- **没有写 stdin 的能力。** 不能远程给终端进程发命令。
- 没有带结构化选择器的屏幕抓取(`output` 给你原始 buffer,自己解析)。
- 没有窗口大小调整 / 信号发送 / `Ctrl+C` 中断等 action。

要完整的交互式控制(`Ctrl+C`、打字执行命令等),直接在 Cockpit UI 里跟气泡交互。

## cockpit codegraph

`cockpit codegraph` 是产品内 [CodeGraph](/zh/docs/explorer/search/#codegraph) 功能（`/cg` 模式）背后那张项目级代码索引的 shell 入口。同一份索引、同一份 API，但跑在终端里，方便接进脚本、CI、Unix pipeline。

使用前 Cockpit 服务器需要在跑（CLI 通过本机 HTTP 端口调用）。

### 两类子命令

**Lookups（查坐标）** —— 只回文件路径 + 行号，对齐产品内 API：

| 子命令 | 作用 |
|---|---|
| `search <query>` | 按名字搜符号，返回 file + qname 命中。 |
| `callers <qname> [--file PATH]` | 谁直接调了这个符号。 |
| `callees <qname> [--file PATH]` | 这个符号调了什么。 |
| `impact <qname> [--depth N=2]` | 上游传递性调用者，BFS。需要排序版本用 `risk`。 |
| `file <path>` | 一个文件的符号树（函数 / 类）。 |
| `coedit <path> [--commits N=100]` | git 历史里和它一起被改的文件。 |

**Analytics（融合打分）** —— PPR / TF-IDF / Louvain 社区 / co-edit 混合排序：

| 子命令 | 作用 |
|---|---|
| `context --query Q [--cursor C] [--open F1,F2,…] [--top N=15]` | 针对自由问句，给出 Top-K 相关坐标。 |
| `related <qname> [--top N=10]` | 更宽的邻居：caller + callee + PPR + coedit + community。 |
| `risk <qname> [--depth N=2] [--top N=20]` | 风险打分的 impact + 推荐测试。 |
| `affected <files…\|--stdin> [--depth N=10] [--filter G] [--as-cmd RUNNER]` | 传递性受影响的测试文件，CI 友好。 |

### 通用 flag

```bash
--json             # 输出原始 JSON（完整结构；每个子命令的 --help 看 schema）
--help, -h         # 子命令级帮助（输出格式 + 退出码 + 示例）
```

### 输出格式（纯文本）

TAB 分隔，每行一条，方便 `cut` / `awk` / `fzf` 接管。

```text
search    sym\t<file>:<line>\t<kind>\t<qname>            或  file\t<file>
callers   <file>:<line>\t<qname>\t[<callLines>]
callees   <file>:<line>\t<qname>\t[<callLines>]
impact    d=<depth>\t<file>:<line>\t<qname>
file      <kind>\t<startLine>-<endLine>\t<qname>
coedit    <cooccur>/<total>\t<file>                  # 出现在 '# history' 注释之后
context   <score>\t<file>:<line>\t<qname>\t[<signals>]
related   <score>\t<file>:<line>\t<qname>\t<<relations>>
risk      <score>\td=<depth>\t<file>:<line>\t<qname>\t[<tags>]
affected  <file>                                     # 每行一个测试路径
```

需要结构化结果就加 `--json`。

### stderr 上的诊断信息

设计上不打断 pipeline：

```text
# ambiguousIn: <files…>     同名 qname 出现在多个文件 —— 用 --file 限定
# cursor: <note>            cursor 格式自动纠正（'.' → '::' 等）
# degraded: <reason>        analytics-warming / coedit-unavailable / truncated
```

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 有输出 |
| `1` | 空结果（无 caller / 无测试 / 无命中）—— 配合 shell pipeline 短路 |
| `2` | 参数错误 或 服务端 4xx |
| `3` | Cockpit 服务器无法连接。用 `cock <项目路径>` 把它拉起。 |

### 前置条件

默认连接 `http://localhost:3457`(跟主 Cockpit 服务**同一个端口**,不是单独的 codegraph 端口)。host 恒为 loopback(CLI 与 server 总在同机),只能改端口:

```bash
COCKPIT_PORT=… cock codegraph …
```

### 示例

```bash
cock codegraph search getCodeIndex
```

```bash
cock codegraph related getCodeIndex --top 5
```

```bash
cock codegraph risk searchIndex --depth 2
```

```bash
# 列出本次 diff 影响的测试路径（一行一个）：
git diff --name-only | cock codegraph affected --stdin
```

```bash
# 直接驱动 jest 跑这些测试：
git diff --name-only | cock codegraph affected --stdin --as-cmd jest
```

```bash
# 同样思路给 vitest：
git diff --name-only | cock codegraph affected --stdin --as-cmd "vitest run"
```

### 相关页面

- [CodeGraph（产品内）](/zh/docs/explorer/search/#codegraph) —— 同一份索引，AI 通过 `/cg` 斜杠模式查询。
- [LSP](/zh/docs/explorer/search/#lsp) —— 编辑器级 go-to-definition / find-references 的另一条路径。

## cockpit connection

`cockpit connection list` 列出运行中的 Cockpit 服务器里所有气泡 —— 终端 + 浏览器一起 —— 每条带上用户设的标题（通过气泡 short id 旁边的 ✎ 按钮设置）。

目的是让 LLM（或终端里的人）把不认识的 4 字符 bubble id 映射到一个人可读的含义，再用 `cockpit terminal <id> …` / `cockpit browser <id> …` 去驱动它。配合 agentic flow 的 `/cc` 斜杠模式使用。

### 用法

```bash
cockpit connection list [--cwd PATH] [--all] [--json]
```

目前只有一个子命令：`list`。

### flag

| Flag | 含义 |
|---|---|
| `--cwd PATH` | 仅列出项目 cwd 匹配 `PATH` 的气泡（路径会规范化）。用 `$PWD` 限定到当前 shell 所在项目。 |
| `--all` | 把死掉的也算进来（已退出的终端、断开的浏览器）。默认不含。 |
| `--json` | 输出原始 JSON，不输出 TAB 分隔文本。 |

### 输出（纯文本，TAB 分隔）

```text
<type>  <shortId>  <title-or-(none)>  <projectCwd-or-?>  <command-or-empty>
```

每行一个气泡。`<type>` 是 `term` 或 `browser`。

### 输出（`--json`）

数组，每条是：

```json
{
  "type": "term" | "browser",
  "shortId": "abcd",
  "title": "用户设的标签（可选）",
  "projectCwd": "/abs/path",
  "tabId": "…",
  "command": "npm run dev",
  "alive": true
}
```

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 有气泡 |
| `1` | 过滤后空（没气泡） |
| `2` | 用法 / 参数错误 |
| `3` | Cockpit 服务器连不上。用 `cock <项目路径>` 启动。 |

### 示例

```bash
# 列出所有项目里的活气泡：
cockpit connection list
```

```bash
# 仅当前项目：
cockpit connection list --cwd $PWD
```

```bash
# 全部（含死的），JSON 给程序：
cockpit connection list --all --json | jq
```

### 相关页面

- [`cockpit terminal`](#cockpit-terminal) —— 用 id 驱动一个终端气泡。
- [`cockpit browser`](#cockpit-browser) —— 用 id 驱动一个浏览器气泡。

## cockpit update

`cockpit update` 把 Cockpit 升级到最新发布版。

```bash
cockpit update
```

等同于跑：

```bash
npm install -g @surething/cockpit@latest
```

哪个都行，做的是同一件事。

### 升级时保留什么

你的 Cockpit 数据目录（`~/.cockpit/`）里的一切升级时都不动：

- API key 和引擎设置
- 会话和固定 tab
- 定时任务
- Skills 注册表
- 笔记
- 评审
- Chrome 扩展缓存

只是全局 npm 包被替换。

### 升级后

重启任何运行中的 `cockpit` 进程拿新版本。如果 Cockpit 在浏览器 tab 里开着，重启后刷新页面。

确认：

```bash
cockpit -v
```

### `cockpit update` 失败时

最常见原因：你系统上 `npm install -g` 需要 root 权限（某些环境下全局 npm 包属 root）。看到 `EACCES` 错误时用 `sudo`：

```bash
sudo npm install -g @surething/cockpit@latest
```

或者更好的方式：一次性修好 npm 权限以后不用 sudo。npm 文档有指南 —— 搜 "resolving EACCES permissions errors npm"。

### 锁定到某个版本

要装特定版本而不是最新：

```bash
npm install -g @surething/cockpit@1.0.42
```

版本列表在 [npmjs.com/package/@surething/cockpit](https://www.npmjs.com/package/@surething/cockpit)。

### 降级

同样的命令 —— 给它你想要的旧版本：

```bash
npm install -g @surething/cockpit@1.0.41
```

你的数据目录在 minor 版本之间向前向后兼容；降级安全。
