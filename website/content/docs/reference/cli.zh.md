OpenCockpit CLI 是运行中的 Cockpit 服务器 HTTP API 的一层薄包装。`npm install -g @surething/cockpit` 装一个二进制:**`cockpit`**。服务器本身常驻;子命令通过 HTTP 调 `localhost:3457` 来查看或驱动你面板里开着的东西。

| 命令 | 作用 |
|---|---|
| [`cockpit`](#cockpit) | 启动服务器(主入口) |
| [`cockpit browser`](#cockpit-browser) | 操作你的 Chrome 标签页和 Console 浏览器气泡 —— 点击、输入、执行 JS、抓网络、模拟设备 |
| [`cockpit terminal`](#cockpit-terminal) | 读终端气泡的输出(只读;无 stdin) |
| [`cockpit codegraph`](#cockpit-codegraph) | 在 shell 里查项目级代码索引 |
| [`cockpit connection`](#cockpit-connection) | 列出所有气泡(终端 + 浏览器)及其标题 |
| [`cockpit update`](#cockpit-update) | 升级到最新版本 |

## cockpit

`cockpit` 是主命令，由 `npm install -g @surething/cockpit` 安装。

### 用法

```text
cockpit [path] [options]
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

两者都设时 `--port` 优先。(`<数据目录>/server.json` 由运行中的服务写入,记录活实例的 pid/端口,供 `cockpit` 子命令和单实例保护使用;服务**不会**回读它来决定端口,手动改无效。)

### 子命令

`cockpit` 本身启动服务。两个子命令用于从外部脚本驱动 Cockpit（CI、ChatOps、自动化）：

| 子命令 | 用途 |
|---|---|
| `cockpit browser <id> <action>` | 操作 Chrome 标签页或 Console 浏览器气泡（导航、点击、执行 JS、抓网络等） |
| `cockpit terminal <id> <action>` | 读正在跑的终端气泡(`list` / `output` / `wait`;只读) |

两者都连 `localhost:3457` 上正在跑的 Cockpit 服务。这些是 UI 内部用的同一套 API；暴露为 CLI 让你能从任何地方脚本化驱动气泡。

详见：

- [`cockpit browser`](#cockpit-browser) —— 全部 action 列表（snapshot、click、type、upload、dialog、viewport、network 等）
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
| `COCKPIT_PORT` | 服务端口(同 `--port`);也被 `cockpit` 子命令与 `/cg` 片段读取。 |
| `PORT` | `COCKPIT_PORT` 未设时的兜底。 |
| `COCKPIT_HOST` | 绑定 host。默认 `127.0.0.1`(仅本机);设 `0.0.0.0` 可在局域网 / 云沙盒暴露。 |
| `COCKPIT_TOKEN` | 共享访问令牌(同 `--token`)。设置后,远程 HTTP/WS 请求必须携带它(cookie / `Authorization: Bearer` / `?token=`);本机 loopback 请求豁免。未设 = 不鉴权(完全开放)。详见[下文](#共享令牌访问网关)。 |
| `COCKPIT_TRUSTED_PROXIES` | 可信反向代理的 IPv4、IPv6 地址或 CIDR 网段，用逗号分隔，例如 `10.0.0.5,2001:db8:100::/48`。直接通过回环地址连接的代理会自动识别。 |
| `COCKPIT_NO_OPEN` | 启动后不自动开浏览器(同 `--no-open`)。 |
| `COCKPIT_LOG_LEVEL` | 服务日志级别。 |
| `COCKPIT_FORCE` | 跳过单实例保护(见下)。 |
| `COCKPIT_SNAPSHOT_KEEP_DAYS` | [工具快照](/zh/docs/agent/snapshots/)保留天数。默认 `7`。 |
| `COCKPIT_SNAPSHOT_REPO_TTL_DAYS` | 项目多少天不活跃后整个快照仓库被移除。默认 `30`。 |
| `COCKPIT_SNAPSHOT_MAX_FILE_KB` | 快照跟踪的单文件大小上限(KB)。默认 `2048`(2 MB)。 |
| `COCKPIT_ALLOWED_HOSTS` | 逗号分隔的额外 host 名(不带协议、不带端口),经 loopback 到达的请求可以在 `Host` 头里使用 —— 例如未开令牌的隧道的公网域名。见下文「Host 与 Origin 校验」。 |
| `COCKPIT_DELEGATE_MAX` | 同时运行的委派会话([`/dl`](/zh/docs/agent/skills/))上限。默认 `4`,必须 ≥ 1。超出的请求直接拒绝。 |

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
- 同一客户端 IP 连续输错 5 次会被封禁 10 分钟。HTTP 和 WebSocket 共用计数。
- 不设 `--token` / `COCKPIT_TOKEN` 即保持旧的完全开放行为(向后兼容)。

直连时，Cockpit 使用 TCP 对端地址。经回环地址或 `COCKPIT_TRUSTED_PROXIES` 中的代理接入时，Cockpit 从右向左读取 `X-Forwarded-For`，取第一个不在可信列表中的地址。列表只填写你管理或信任的代理。每层可信代理都必须用已验证的客户端地址覆盖该请求头，或在末尾追加它看到的连接来源。代理链无法提供有效的客户端地址时，Cockpit 仍验证令牌，此次失败不计入 IP 封禁。

在网络上共享时与 `COCKPIT_HOST=0.0.0.0` 搭配:

```bash
COCKPIT_HOST=0.0.0.0 cockpit --token 你的密钥
```

#### Host 与 Origin 校验

与令牌无关,所有 HTTP 请求和 WebSocket 升级都先经过一道 Host / Origin 校验,挡住浏览器里的网页够到本机 Cockpit 的两条路 —— DNS 重绑定和跨站请求伪造。被拒的请求返回 `403 Forbidden`。

- **经 loopback 到达的请求,必须用允许的 host 名访问 Cockpit:** `localhost`(或 `*.localhost`)、`127.x.x.x` / `::1` 地址、本机主机名(及 `<主机名>.local`)、`COCKPIT_HOST` 设为具体地址时的该值,或 `COCKPIT_ALLOWED_HOSTS` 里列出的名字。来自其他机器的请求(局域网,`COCKPIT_HOST=0.0.0.0`)不做 host 校验。
- **写操作请求(`GET` / `HEAD` / `OPTIONS` 以外)和 WebSocket 升级,若带 `Origin` 头,必须与 `Host` 同源。** 浏览器发这类请求总会带 `Origin`;`curl`、CLI、skill 不带,不受影响。

**隧道(ngrok、cloudflared 等)—— 行为变更。** 隧道客户端跑在同一台机器上,经 loopback 连进来,而 `Host` 是隧道的公网域名,所以这类请求现在会被拒绝,除非:

- 把该域名加进 `COCKPIT_ALLOWED_HOSTS`;或
- 开启令牌 —— 令牌模式下,带转发头(`X-Forwarded-For`、`X-Real-IP` 或 `Forwarded`)的请求交给令牌网关处理,由它要求令牌。

```bash
COCKPIT_ALLOWED_HOSTS=my-box.ngrok.app cockpit     # 不开令牌:拿到 URL 的人都能进
cockpit --token 你的密钥                            # 令牌模式:隧道需转发 X-Forwarded-For
```

保留隧道原始的 `Host` 头。若被改写成 `localhost`,浏览器的 `Origin` 就对不上,POST 和 WebSocket 会被 403。

## cockpit browser

`cockpit browser` 用来操作**你的 Chrome** 里的网页，以及 Cockpit Console 里的**浏览器气泡**：聊天里的 AI、shell 脚本、CI 都可以调用。需要先安装 [OpenCockpit Bridge 扩展](/zh/docs/console/chrome-extension/#安装)。

- **网页是 Chrome 标签页。** `cockpit browser open <url>` 会在 **Cockpit** 标签页分组里打开它（默认在后台，加 `--show` 切到前台），带着你的登录状态。你已经打开的标签页也能按 id 操作；对一个你还没允许的标签页，第一次发命令时会在扩展小面板里询问你。
- **气泡用于本地内容。** `cockpit browser open <文件>` 会把本地 HTML 应用或文件预览打开成 Console 气泡。

每个目标都有一个短 id，例如 `qmmm`。标签页的 id 可以从 `cockpit browser tabs`、Cockpit 打开标签页时的提示、或扩展小面板（**Copy**）获得；气泡的 id 是它标题栏上的徽标。

CLI 是为 **AI 驱动的 E2E** 设计的：每个命令都带可执行的错误模板，沉默失败会被捕获并告警，act/wait/assert 循环能组合成原子步骤。优先用基于 selector 的交互（`--text`、`--selector`），别依赖 snapshot 返回的 ref —— 任何重渲染都会让 ref 失效。

### 目标管理

| 命令 | 作用 |
|---|---|
| `cockpit browser open <url> [--show]` | 在 **Cockpit** 分组里以 Chrome 标签页打开网页，直接允许 AI 操作 |
| `cockpit browser open <路径> [--cwd PATH]` | 把本地 HTML 应用或文件打开成 `--cwd` 所属项目的 Console 气泡。没有任何 Cockpit 窗口打开该项目时以退出码 `2` 结束 |
| `cockpit browser tabs` | 列出所有 Chrome 标签页及 id，标出是 Cockpit 打开的 / 已允许 / 会先询问；扩展调试器正连着时标 `[debugging]` |
| `cockpit browser list` | Cockpit 正在使用的目标：气泡，以及它打开或你允许的标签页 |
| `cockpit browser <id> show` | 把标签页切到前台 |
| `cockpit browser <id> release` | 交还你允许过的标签页，下次操作会重新询问 |
| `cockpit browser <id> close` | 关闭气泡，或关闭 Cockpit 打开的标签页（不会关你自己的） |

### 速查示例

```bash
# 打开页面、看清结构
cockpit browser open http://localhost:3000        # → "qmmm  →  tab opened in Google Chrome"
cockpit browser qmmm status
cockpit browser qmmm snapshot --filter 'button'

# 交互（优先 selector；ref 一重渲染就失效）
cockpit browser qmmm click --text "Sign in"
cockpit browser qmmm fill --selector 'input[name="email"]' --value "user@example.com"
cockpit browser qmmm submit --form-selector 'form#login'

# 通常会卡住自动化的情况
cockpit browser qmmm click --text "Delete"         # → "the page opened a confirm dialog"
cockpit browser qmmm dialog accept
cockpit browser qmmm upload e7#v2 ./fixtures/avatar.png
cockpit browser qmmm drag e3#v2 '#done-column'

# 探后端（继承页面登录态）
cockpit browser qmmm fetch /api/users/me

# act → wait → assert（原子 E2E）
cockpit browser qmmm click --text "Save"
cockpit browser qmmm wait --network-idle --quiet-ms 500
cockpit browser qmmm assert --selector '[role="status"]' --text "Saved"

# 测试环境（重置前一直生效）
cockpit browser qmmm viewport iphone --reload
cockpit browser qmmm emulate --network slow-3g --cpu 4
cockpit browser qmmm screenshot --full
cockpit browser qmmm viewport reset && cockpit browser qmmm emulate reset
```

### 标签页与气泡

下面的命令两者都能用，标了 **仅标签页** 的除外。在标签页上，`click` / `type` / `key` / `hover` / `scroll` / `drag` 走 Chrome 自己的输入通道（**真实输入**，页面收到可信事件）；加 `--dom` 改用模拟的 DOM 事件。AI 操作标签页期间，Chrome 会显示「OpenCockpit Bridge 已开始调试此浏览器」，见 [调试提示条](/zh/docs/console/chrome-extension/#使用)。

**框架（iframe）。** 在标签页上，`snapshot` 会把 iframe（包括跨域的）嵌在对应的 `<iframe>` 那一行下面，也会进入开放的 shadow DOM。iframe 里的 ref 形如 `f7:e3#v1`，所有命令都能直接用；`--frame 7` 让 `--selector` / `--text` / `evaluate` 作用在那个框架里。标签页在**后台**时，Chrome 没法把真实输入送进跨域 iframe，也不会响应滚轮；这些情况会改用 DOM 事件，并在输出里注明（要真实输入就先 `show`）。

### 全部 action

#### 查看

| Action | 作用 |
|---|---|
| `snapshot [--filter <regex>] [--include-hidden-text] [--max-depth N] [--frame N]` | 无障碍树。开头的 banner 会说明格式。`--filter` 在服务端过滤；`--include-hidden-text` 把 `<summary>` / 容器节点里折叠的文字也显示出来 |
| `screenshot` | 可见区域的 PNG，存到 `/tmp`，打印路径 |
| `screenshot --full` / `screenshot <ref>` | **仅标签页**：整页，或单个元素 |
| `url` | 当前 URL |
| `title` | 页面标题 |
| `status` | 一行概况：URL、标题、最近一条控制台错误、最近一个失败请求、可见的主要按钮。隔了很久再回来时先跑它 |
| `bounds <ref>` | 元素的位置和尺寸 |
| `attrs <ref>` | 元素的全部 HTML 属性 |
| `computed <ref>` | 元素的计算样式 |
| `events <ref>` | 元素上的事件监听器。**标签页上**：列出真实注册的全部监听器，以及祖先元素上处理的事件类型（React / Vue 把事件委托在那里） |
| `cookies` | 页面 JS 可见的 cookie（`document.cookie`） |
| `storage --type local\|session` | localStorage 或 sessionStorage 内容 |

#### 交互

优先用 selector 形式 —— ref 只在下一次 snapshot 或重渲染前有效。`--selector` 和 `--text` 只匹配**可见**元素（隐藏的同名元素，比如收起的移动端菜单，会被跳过）；`--nth` 只按可见元素计数。

| Action | 作用 |
|---|---|
| `click [<ref>] [--text <子串>] [--selector <css>] [--nth N] [--exact]` | 按 ref、可见文字/aria-label 或 CSS selector 点击 |
| `click <ref> --at X,Y` | 点元素内部的某个点，从它的左上角算起，单位 px 或 `%`（`--at 50%,50%`），适合 canvas、地图、图表。`hover` 也支持 |
| `click <ref> --hold <ms>` | 长按（鼠标，模拟手机时是手指） |
| `fill [<ref>] [--selector <css>] --value <v>` | 用原生 setter 赋值并派发 `input` 事件（对 React 受控输入框有效） |
| `type <ref> <text> [--insert]` | 往输入框里输入。标签页上每个字符都是真实按键；`--insert` 像输入法那样一次提交整段文字 |
| `submit [--form-selector <css>]` | 调用 `form.requestSubmit()`，适用于按 `Enter` 被 `onKeyDown` 吞掉的场景 |
| `hover <ref>` | 悬停在元素上（标签页上 CSS `:hover` 会生效） |
| `focus <ref>` | 聚焦元素 |
| `scroll <up\|down\|left\|right> [<ref>] [--amount PX]` | 滚动页面或 `<ref>` 所在区域。标签页上是真实的滚轮，模拟手机时是手指滑动 |
| `key <key>` | 按键（`Enter`、`Ctrl+A`、`Shift+Tab` 等）。React 输入框优先用 `submit` |
| `drag <ref> <目标 ref\|css>` / `drag <ref> --dx N --dy N` | **仅标签页**：拖放。原生 HTML5 拖放、以及基于指针事件的列表/滑块都支持 |
| `upload <ref> <文件> [文件…]` | **仅标签页**：把本地文件放进 `<input type=file>`（snapshot 里标为 `file`，可能是隐藏的，也可以用 `--selector`），或放进点击后会弹出文件选择框的按钮。不会弹出系统对话框。需要在扩展上打开「允许访问文件网址」 |

#### 弹窗

**仅标签页。** `alert` / `confirm` / `prompt` /「确定要离开此页？」弹窗会让页面暂停。打开它的那条命令会报告弹窗；在回答之前，其他命令都会立刻失败并给出弹窗内容。

| Action | 作用 |
|---|---|
| `dialog` | 显示当前打开的弹窗（如果有） |
| `dialog accept [--text <T>]` | 点确定（`--text` 用来回答 prompt） |
| `dialog dismiss` | 点取消 |

#### 测试环境

**仅标签页。** 这些设置会一直生效（Chrome 的调试提示条也会一直显示），直到重置、`release`，或在扩展小面板里点 **Stop**。

| Action | 作用 |
|---|---|
| `viewport <iphone\|android\|ipad\|WxH> [--landscape] [--reload] [--mobile] [--dpr N] [--ua UA]` | 模拟设备：尺寸、像素比、触屏和 User-Agent，点击会变成点按。网站按 User-Agent 返回手机版页面时加 `--reload`。不带参数显示当前设置；`viewport reset` 恢复 |
| `theme dark\|light\|reset` | 模拟 `prefers-color-scheme` |
| `emulate [--network offline\|slow-3g\|fast-3g\|slow-4g] [--cpu N] [--block "<模式>,…"] [--media print] [--reduced-motion on]` | 网络条件、CPU 降速、屏蔽 URL、打印样式、减少动画。每个参数都可以传 `off` 单独关闭；`emulate reset` 全部恢复；不带参数显示当前开着的项。Chrome 不允许扩展模拟时区和语言 |

#### Wait —— act 和 assert 之间的同步

| Action | 作用 |
|---|---|
| `wait --network-idle [--quiet-ms 500] [--max-request-age-ms 30000]` | 等到连续 `quiet-ms` 毫秒没有进行中的 HTTP 请求。早于 `max-request-age-ms` 的长连接（SSE / 长轮询）不计入 |
| `wait --selector <css> [--state visible\|hidden\|attached\|detached]` | 等匹配的元素达到指定状态，默认 `visible` |
| `wait --dom-stable [--quiet-ms 300]` | 等 `MutationObserver` 在 `quiet-ms` 内没再观察到 DOM 变化（适合放在 act 和 snapshot 之间） |
| `wait --extension-ready [--quiet-ms 500]` | CLI 端轮询 `health`，从不阻塞在页面上。页面忙的时候用它代替手写的 `until evaluate "1+1"` 循环 |
| `wait --text <子串>` / `--url <pat>` / `--ref <ref>` / `--time <ms>` | 经典条件：出现文字、URL 匹配、ref 仍在页面上、固定等待 |

#### Assert —— 失败时非零退出

| Action | 作用 |
|---|---|
| `assert --selector <css> [--text <子串>] [--visible <bool>] [--attr "k=v"]` | 通过 selector 做元素级断言。也接受 `--ref`，但会失效，优先用 selector |
| `assert --network --method <M> --url <pat> --status <S> [--since <ms>]` | 断言网络缓冲里出现过匹配的请求。`--status` 接受整数（`200`）或范围（`2xx`） |
| `assert --fetch <url> [--fetch-method M] [--body B] [--fetch-status N]` `[--jsonpath <P> --equals V \| --contains V \| --not-contains V]` | 发一次 fetch（继承页面登录态），断言响应状态或某个 JSONPath 的值。JSONPath 子集：`$`、`.key`、`[N]`、`[*]` |
| `assert --url <pat>` / `--title <子串>` / `--console-no-errors` | 页面级断言 |

#### 导航

| Action | 作用 |
|---|---|
| `navigate --url <url>` | 跳转到 URL |
| `reload [--noCache]` | 刷新（可绕过缓存） |
| `back` | 后退一步 |
| `forward` | 前进一步 |

#### 探后端

| Action | 作用 |
|---|---|
| `fetch <url> [--method <M>] [--body <B>] [--headers <JSON>]` `[--json <jsonpath>]` | 用页面的登录态发 GET（或其他方法）。`--json` 用和 `assert --fetch` 相同的 JSONPath 子集取值。返回 `{ status, contentType, data }` 或 `{ status, jsonpath, value }` |

让 AI 读写后端时优先用 `fetch`，比在 `evaluate` 里包一层 `await fetch(...).then(r => r.json())` 清楚。

#### JavaScript

| Action | 作用 |
|---|---|
| `evaluate <js> [--frame N] [--all-frames]` | 在页面里执行 JS 表达式，结果以 JSON 打印。`--frame` 指定某个 iframe，`--all-frames` 在所有框架里执行。页面 CSP 禁止 `eval` 时会自动处理 |

`evaluate` 是兜底手段，高层 action 都不合适时再用：纯 HTTP 调用用 `fetch`，点击用 `click --text` / `--selector`，断言用 `assert --selector`。

#### 生命周期 / 测试夹具

| Action | 作用 |
|---|---|
| `reset [--cookies] [--storage] [--cache] [--reload]` | 原子化的测试隔离工具，参数可组合。`--cookies` 让 JS 可见的 cookie 过期；`--storage` 清空 `localStorage` 和 `sessionStorage`；`--cache` 清掉 Cache Storage；`--reload` 清完后刷新 |
| `set --type cookie --name <K> --value <V>` `[--domain <D>] [--path <P>] [--secure] [--same-site Lax\|Strict\|None] [--expires <date>]` | 写一个 JS 可见的 cookie。浏览器静默拒绝时（跨域 / `SameSite` 不匹配 / HTTP 下的 `Secure`）返回 `verified: false` |
| `set --type local-storage --name <K> --value <V>` | 写 `localStorage` |
| `set --type session-storage --name <K> --value <V>` | 写 `sessionStorage` |

#### 诊断

| Action | 作用 |
|---|---|
| `health` | **服务端**的桥接状态快照：连接状态、待处理命令数、距离上次成功命令的时间。不经过页面，所以页面被长时间的 `evaluate` 卡住时也能用 |
| `health --deep` | 额外探测页面本身（`readyState`、`snapshotEpoch`、页面时间戳），页面忙时可能阻塞 |
| `perf [--metric timing\|memory\|resources\|runtime]` | 性能指标，含 Core Web Vitals。`runtime`（**仅标签页**）：布局/样式/脚本耗时、DOM 节点数、JS 堆 |
| `coverage start\|stop\|status` | **仅标签页**：`start` 到 `stop` 之间每个样式表实际用了多少（浏览器允许时也包括脚本 —— Chrome 不允许扩展采集 JS 覆盖率）。`start` 后刷新页面可以把加载过程也算进去 |

#### 网络与控制台抓取

在标签页上，抓取从第一次调用 `network` / `console` / `network_record` 时开始，只能看到之后的活动，要抓页面加载就先刷新。最后一次读取 2 分钟后自动停止（`network_record` 会一直保持到录制结束）。

| Action | 作用 |
|---|---|
| `network [--status <code>] [--method <method>] [--type <type>] [--clear]` | 按条件列出抓到的网络请求。`--status` 支持逗号分隔，如 `4xx,5xx` |
| `network_record start [--url <pat>] [--method <m>] [--status <code>]` | 开始记录请求/响应正文 |
| `network_record stop` | 停止记录 |
| `network_record status` | 是否在记录 |
| `network_detail <reqId>` | 单个请求的完整详情 |
| `console [--level error\|warn\|info\|debug] [--clear]` | 控制台消息 |

### Snapshot 输出

`snapshot` 返回纯文本的无障碍树。前 4–5 行是说明格式的 banner，包括当前的 **snapshot 版本**（`v=N`）：

```text
# a11y tree v=3 — refs valid until next snapshot
# Text inside <details>/<summary> and unnamed container <div>/<section> is collapsed.
# Grep on role / aria-label, NOT on user-visible emoji / text.
# Tips: --include-hidden-text surfaces collapsed innerText; --filter <regex> reduces output.
# Frames: refs inside an iframe look like f7:e3#v1 — pass them as-is.
body [e0#v3]
  ...
  iframe [src=checkout.example.com] [e14#v3]
    frame f7 https://checkout.example.com/…
      button "Pay" [f7:e3#v1]
```

每个可操作的元素都有一个 ref，比如 `e5#v3`。`#v3` 是 snapshot 版本号 —— 旧 snapshot 的 ref 会被明确拒绝，报错会提示改用 `click --text` / `click --selector` 这类不怕重渲染的方式。**大多数 AI 工作流应该直接跳过 ref，用 `--text` / `--selector`。**

### `click` / `key` / `submit` 的事后校验

这几个 action 最容易**沉默失败**：CDP 报告成功，但框架其实没响应（React 受控输入框忽略模拟的 `keydown`、portal 渲染的按钮没有真正的处理函数等）。CLI 会在 action 前后各探测一次页面状态；如果校验窗口内没有任何可观察的变化，就往 stderr 写警告和可执行的模板（不影响 stdout 上的主结果）。

| 参数 | 作用 |
|---|---|
| `--verify-ms <ms>` | 调整校验窗口，默认 `1000` ms。越小越快，但慢渲染的 React 页面误报越多；越大越宽容 |
| `--skip-verify`（或 `--no-verify`） | 本条命令不做事后校验（比如本来就没有可观察副作用的点击） |

### 输出格式

大多数 action 在 stdout 返回 **JSON**，方便接 `jq`、`gron` 或给 AI 读。`url`、`title`、`network_detail` 返回纯文本；`screenshot` 返回文件路径；`snapshot` 返回 banner 加纯文本无障碍树；`health`、`status`、`wait`、`assert`、`dialog`、`upload`、`drag`、`viewport`、`emulate`、`coverage` 打印简短的人类可读摘要；`fetch` 打印 `[status] (contentType)` 加正文，或 `[status] $.jsonpath =` 加取到的值。

警告（沉默失败检测、后台标签页改用 DOM 事件等）写到 **stderr**。主结果留在 stdout，用 `>` 重定向能拿到真实数据，AI 也照样能看到警告。

### 退出码

成功为 `0`，失败为非零（ref 失效、网络错误、断言失败、找不到元素、弹窗挡住页面等）。`open <路径>` 在没有 Cockpit 窗口接住气泡时以 `2` 退出。完整的退出码见 [CLI 主页面](#cockpit)。

### 什么时候不该用这个 CLI

- **端到端测试由 LLM agent 驱动的流程。** agent 选择工具的随机性和 `stop_reason` 会让 UI 断言不稳定。更好的做法是写一个薄的运行时脚本，用可控输入直接调用同样的中间件或服务。
- **持续流式输出或重渲染超过 10 秒的页面。** `evaluate` 会排在页面任务后面，可能超时（默认约 15 秒）。在 act 和 assert 之间跑 `wait --extension-ready`；还是卡住就改做服务层测试。
- **依赖时区或语言的行为。** Chrome 不允许扩展模拟这两项，这类测试用无头浏览器（例如 Playwright）。

弹出窗口和 `target="_blank"` 链接会作为普通 Chrome 标签页打开，用 `cockpit browser tabs` 找到它们。由页面（而不是 Cockpit）打开的标签页，第一次发命令时会先询问授权。

## cockpit terminal

`cockpit terminal <id> <action>`(或 `cockpit terminal`)从外部**读取**终端气泡的输出 —— 拿缓冲输出、等命令收尾、列出已注册的气泡。

> 注意:终端 CLI 故意设计成**只读**。**没有 `stdin`** 也**没有 `follow` 流式跟随** —— 想驱动 shell 用浏览器气泡 + `cockpit browser`,或在 Cockpit UI 里跟气泡直接交互。代码注释:"read-only by design; write side belongs to the Bash tool / web UI"。

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
cockpit terminal list

# 抓当前屏幕内容
cockpit terminal xy789 output

# 等 npm run build 跑完
cockpit terminal xy789 wait

# 跑完后看结果
cockpit terminal xy789 output | tail -50
```

### 什么时候用

主要场景:

- **AI 通过气泡读你 shell 在跑什么。** 在 Cockpit 终端气泡里启动 `npm run dev`。聊天里把 `cockpit terminal <id>` 给 AI,它可以 `output` 拿最近日志、`wait` 等命令收尾。
- **CI / 脚本里从外部观察 Cockpit 里的长跑命令。** 比如启动器脚本在 Cockpit 终端跑 `npm run dev`,然后另一个脚本 `cockpit terminal <id> output` 抓日志做断言。

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
| `search <query> [--limit N=50] [--path DIR] [--exclude-tests]` | 按相关性搜索符号，每类结果上限 500。 |
| `symbols [--path DIR] [--kind KINDS] [--exclude-tests] [--exclude GLOB]` | 全量导出函数、方法；支持目录、类型和重复排除规则。`--kind all` 导出全部类型。 |
| `callers <qname> [--file PATH]` | 谁直接调了这个符号。 |
| `callees <qname> [--file PATH]` | 这个符号调了什么。 |
| `impact <qname> [--depth N=2]` | 上游传递性调用者，BFS。遍历有数量上限。 |
| `file <path>` | 一个文件的符号树（函数 / 类）。 |
| `coedit <path> [--commits N=100]` | git 历史里和它一起被改的文件。 |

**Derived queries** — base-index relationships and on-demand Git history:

| 子命令 | 作用 |
|---|---|
| `related <qname> [--top N=10]` | Direct callers + callees + frequent co-edit partners. |
| `affected <files…\|--stdin> [--depth N=10] [--filter G] [--as-cmd RUNNER]` | 传递性受影响的测试文件，CI 友好。 |

### 通用 flag

```bash
--json             # 输出原始 JSON（完整结构；每个子命令的 --help 看 schema）
--help, -h         # 子命令级帮助（输出格式 + 退出码 + 示例）
```

`search` 检查全部符合条件的索引候选，每类默认保留最相关的 50 条，最多 500 条。
排序依次为名称精确匹配、归一化精确匹配、归一化前缀匹配、归一化子串匹配；
同等级按文件路径、限定名、行号稳定排序。`--path` 包含子目录，`--exclude-tests`
同时过滤文件、符号和可选的字符串结果；默认仍包含测试。HTTP 参数为 `path`
和 `excludeTests=true`。

`symbols` 默认导出 `function,method`，`--kind all` 导出全部真实符号类型。展示用的 `unknown` 节点默认排除，
需要时通过 `--include-synthetic` 包含。
目录筛选包含子目录，排除规则可重复传入。JSON 包含 `revision`、`incomplete`、
`total` 和扁平的 `symbols[]` 坐标列表。结果不设条数上限；`incomplete` 表示
源文件索引存在覆盖限制。单文件超过 2 MiB（2,097,152 字节）会被排除；
JSON 的 `excludedFiles[]` 列出整个索引版本中被排除文件的路径、原因、实际大小和上限。

`--summary` 按类型和所选目录的直接子目录统计，不返回符号坐标；沿用全部筛选条件，
文件数只计算包含匹配符号的文件。项目概览先看摘要，全量导出保存到文件再筛选阅读。
HTTP 对应参数为 `format=summary` 和 `includeSynthetic=true`。

`callers`、`callees`、`impact`、`related` 遇到同名歧义时返回 HTTP 200，
其中 `target: null`、关系为空，`ambiguousIn` 列出候选路径。使用 `filePath`
（CLI `--file`）选择目标后重试。CLI 遇到歧义退出码为 2，JSON 模式仍输出响应。

```bash
cockpit codegraph symbols --path packages/feature --kind all --exclude-tests --summary
cockpit codegraph symbols --json > symbols.json
cockpit codegraph symbols --path src --exclude-tests --exclude '**/generated/**' --json
```

### 输出格式（纯文本）

TAB 分隔，每行一条，方便 `cut` / `awk` / `fzf` 接管。

```text
search    sym\t<file>:<line>\t<kind>\t<qname>            或  file\t<file>
symbols   <file>:<startLine>-<endLine>\t<kind>\t<qname>
callers   <file>:<line>\t<qname>\t[<callLines>]
callees   <file>:<line>\t<qname>\t[<callLines>]
impact    d=<depth>\t<file>:<line>\t<qname>
file      <kind>\t<startLine>-<endLine>\t<qname>
coedit    <cooccur>/<total>\t<file>                  # 出现在 '# history' 注释之后
related   <score>\t<file>:<line>\t<qname>\t<<relations>>
affected  <file>                                     # 每行一个测试路径
```

需要结构化结果就加 `--json`。

### stderr 上的诊断信息

设计上不打断 pipeline：

```text
# ambiguousIn: <files…>     同名 qname 出现在多个文件 —— 用 --file 限定
# degraded: <reason>        coedit-unavailable / truncated
```

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 有输出 |
| `1` | 空结果（无 caller / 无测试 / 无命中）—— 配合 shell pipeline 短路 |
| `2` | 参数错误 或 服务端 4xx |
| `3` | Cockpit 服务器无法连接。用 `cockpit <项目路径>` 把它拉起。 |

### 前置条件

默认连接 `http://localhost:3457`(跟主 Cockpit 服务**同一个端口**,不是单独的 codegraph 端口)。host 恒为 loopback(CLI 与 server 总在同机),只能改端口:

```bash
COCKPIT_PORT=… cockpit codegraph …
```

### 示例

```bash
cockpit codegraph search getCodeIndex
```

```bash
cockpit codegraph related getCodeIndex --top 5
```

```bash
cockpit codegraph impact searchIndex --depth 2
```

```bash
# 列出本次 diff 影响的测试路径（一行一个）：
git diff --name-only | cockpit codegraph affected --stdin
```

```bash
# 直接驱动 jest 跑这些测试：
git diff --name-only | cockpit codegraph affected --stdin --as-cmd jest
```

```bash
# 同样思路给 vitest：
git diff --name-only | cockpit codegraph affected --stdin --as-cmd "vitest run"
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
| `3` | Cockpit 服务器连不上。用 `cockpit <项目路径>` 启动。 |

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
- 会话和收藏会话
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
