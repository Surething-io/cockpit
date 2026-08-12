Cockpit 开箱支持 6 个 AI 引擎。每个 Agent tab 选一个,可以跨 tab 混用,不用重启 —— 按本地是否有模型、账号在谁那、当前任务哪个最擅长来挑。

| 引擎 | 登录方式 | 何时用 |
|---|---|---|
| [Claude](#claude) | Anthropic `claude` CLI 登录 | 默认。综合能力最强。 |
| [Codex](#codex) | `codex` CLI 登录 | 已经有 Codex / GPT 订阅时。 |
| [DeepSeek](#deepseek) | 在 DeepSeek 选择器里粘 API key | 推理强、便宜。 |
| [GLM](#glm) | 在 GLM 选择器里粘 API key | 智谱的模型,国内站和国际站都能走。 |
| [Kimi](#kimi) | 在 Kimi 选择器里粘 API key | 长上下文,国内多用。 |
| [Ollama](#ollama) | 不用 —— 本地跑 | 离线、敏感数据、自定义模型。 |

> 一切都在本地完成。

## Overview

### 一览

| 引擎 | 怎么登录 | 何时用 | 钱付给谁 |
|---|---|---|---|
| **Claude** | 终端跑一次 `claude` CLI 登录 | 默认。最强通用模型。 | Anthropic |
| **Codex** | 终端跑一次 `codex` CLI 登录 | 已有 Codex / GPT 订阅时。 | OpenAI |
| **DeepSeek** | 在引擎头部的 DeepSeek 选择器里粘 API key | 推理强、价格低。 | DeepSeek |
| **GLM** | 在引擎头部的 GLM 选择器里粘 API key | 智谱的模型,国内站**或**国际站两套接入点。 | 智谱 / BigModel(按量付费或 Coding Plan) |
| **Kimi** | 在引擎头部的 Kimi 选择器里粘 API key | 长上下文,国内主用。 | 月之暗面(Kimi Code 订阅) |
| **Ollama** | 不需要 —— 本地 | 离线、敏感数据、自定义模型。 | 没人(你自己的电脑) |

### 引擎选择怎么工作

每个 Agent tab 头部有引擎选择器。新建 tab 时引擎默认是 **Claude**。给已有 tab 换引擎会开新会话 —— Claude 历史无法带到 Codex tab,因为每个引擎都有自己的对话格式。

可以同时开比如 6 个 tab:

- Tab 1:Claude 跑 `~/code/backend`
- Tab 2:DeepSeek 跑同项目做便宜的二次意见
- Tab 3:Codex 跑另一个项目
- Tab 4:Kimi 跑笔记本,吃它的长上下文窗口
- Tab 5:GLM 跑脚本,记在你的 BigModel Coding Plan 上
- Tab 6:Ollama 跑本地模型,离线写草稿

Cockpit 的会话浏览器(侧栏顶部网格图标)能看到全部。

### 各引擎能做什么

|  | Claude | Codex | DeepSeek | GLM | Kimi | Ollama |
|---|---|---|---|---|---|---|
| 能读 & 改你的文件 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ 看模型 |
| 接受图片附件 | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| 流式输出(边想边说) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 离线可用 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| 多模型变体可选 | 固定(最新版) | 固定 | 从 DeepSeek 接口实时拉取 | 从 GLM 接口实时拉取 | 按你的 Kimi 套餐实时拉取 | 你拉过的任意模型 |
| UI 里显示实时成本 | ✅ | — | — | 显示额度而非金额 —— 见[查询额度](#查询-coding-plan-额度) | 显示额度而非金额 —— 见[查询额度](#查询额度) | 免费 |

> 图片支持是引擎级。**Ollama** 收到图片附件会**静默丢弃**(不报错,但 AI 看不到)。**DeepSeek**、**GLM**、**Kimi** 跑的是内置 Agent,只吃文本 —— 见[纯 Key 引擎跑的是什么](#纯-key-引擎跑的是什么)。

### 纯 Key 引擎跑的是什么

**Claude** 和 **Codex** 由各自厂商的工具驱动 —— Claude Agent SDK 和 `codex` CLI。三个纯 API key 的引擎(**DeepSeek**、**GLM**、**Kimi**)以及 **Ollama**,跑的都是 **Cockpit 自己的内置 Agent**,打的是供应商的 OpenAI 兼容端点。**没有 per-tab 的模式开关**:你选哪个引擎,就决定了跑什么。

内置 Agent 给你的:流式回复、聊天里内联渲染的工具调用、[快照](/zh/docs/agent/snapshots/)、fork,以及落在 `~/.cockpit/<引擎>-sessions/` 下的按项目会话文件。

它没有的 —— 三个引擎都一样,所以下面各章不再重复:

- **没有图片。** 只有图片没有文字的消息会被拒绝并提示 *"The built-in agent requires a text prompt"*;文字 + 图片的消息会正常回答,但图片被丢弃。
- **只有七个工具:** `Read`、`Write`、`Edit`、`Bash`、`Glob`、`Grep`、`TodoWrite`。没有子 agent,没有 MCP,也没有联网抓取 / 搜索。
- **没有美元成本显示。** token 数照常显示,USD 合计恒为 0。用供应商自己的余额 / 额度按钮或控制台看账。

> **从旧版升级?** 早前版本给这几个引擎提供过 per-tab 的 *Claude Agent SDK / Built-in Agent* 开关。开关没了,SDK 那一半也没了。旧 SDK 模式写在 `~/.cockpit/<引擎>/projects/` 下的会话记录**在磁盘上原封不动**,但不再出现在侧栏和会话浏览器里 —— 已经没有任何循环能续上它们了。

### 各引擎接入

每个引擎都有自己的章节。快速指引:

- **Claude** —— 在终端跑一次 `claude` 按提示登录。Cockpit 自动复用你的 Claude 登录态。
- **Codex** —— 装 OpenAI 的 `codex` CLI 并用它登录一次。Cockpit 复用同一份登录态。
- **DeepSeek** —— 从 [platform.deepseek.com](https://platform.deepseek.com/) 拿 key,**在 Agent tab 头部的 DeepSeek 选择器里粘**(不是全局 Settings)。然后在同一个选择器里选模型。
- **GLM** —— 从 [BigModel 控制台](https://bigmodel.cn/apikey/platform) 拿 key,**在 Agent tab 头部的 GLM 选择器里粘**。然后在同一个选择器里选模型,顺手确认一下 **Region(区域)**那一行 —— 见[选择区域](#选择区域)。
- **Kimi** —— 从 [Kimi Code 控制台](https://www.kimi.com/code/console) 拿 key,**在 Agent tab 头部的 Kimi 选择器里粘**。然后在同一个选择器里选模型。
- **Ollama** —— 装 [Ollama](https://ollama.com/) 并拉至少一个模型(`ollama pull llama3.1`)。新建 Ollama tab 时,模型选择器会列出你拉过的所有模型。

## Claude

Claude 是 Cockpit 的默认引擎 —— 启动应用、新开一个 tab,你默认在跟 Claude 聊。Cockpit 不替你管理 Claude 登录,它复用 Anthropic 的 `claude` CLI,所以你在那边做过的事(订阅、项目设置、MCP 服务器)在 Cockpit 里也都生效。

### 接入

你需要装好并登录 Anthropic 的 `claude` CLI。

1. 还没装 Claude Code 的话先装:

```bash
npm install -g @anthropic-ai/claude-code
```

2. 登录:

```bash
claude
```

`claude` 命令会引导你完成浏览器登录。登录完成后 Cockpit 自动接管,无需再在 Cockpit 里配置什么。

就这样。打开 Cockpit,新建 Agent tab,开始聊。

### 你能用到什么

- Anthropic 推荐的最新 Claude 模型,走 Claude Agent SDK。
- **图片附件** —— 粘贴图片到聊天(`Cmd+V`),Claude 能看到。PNG / JPEG / WEBP / GIF,每张 5 MB 以内;能附多张。
- **工具调用** —— Claude 能读你的文件、跑 shell 命令、改代码、访问 URL、用 MCP 工具。
- **流式输出** —— 回复一边想一边出。
- **UI 里显示成本** —— 每条消息都显示用了多少 token,整个会话的累计 USD 也实时更新。

### 模型切换

Cockpit 始终用 Anthropic 当前推荐的 Claude 模型。**没有模型选择器** —— 服务给的最新版你就用最新版。要关注当前是哪个模型,看 Anthropic 的官方公告;官方 SDK 更新时 Cockpit 自动跟进。

### 常见问题

- **第一条消息就报"未登录"/ 直接出错** —— 在终端跑一次 `claude`,确认登录走完。Cockpit 只能用 `claude` 自己已经能用的那份登录。

## Codex

如果你有 Codex / ChatGPT 订阅,可以在 Cockpit 里用同一份登录态驱动它。Cockpit 不直接走 OpenAI API —— 这个引擎底下是 `spawn('codex', ...)` 跑 OpenAI 自己的 `codex` CLI,然后把它的输出展示给你。

### 接入

1. 装 OpenAI 的 `codex` CLI(当前安装命令以 OpenAI 官方文档为准,一般一行命令搞定)。

2. 登录:

```bash
codex
```

按提示用 OpenAI 账号登录。

3. 打开 Cockpit,新建 Agent tab,在引擎菜单选 **Codex**。这个 tab 就用你的 Codex 登录态了。

Cockpit 里不用粘任何东西 —— Cockpit 复用你机器上 `codex` 已配置好的状态。

### 你能用到什么

- CLI 自带的 Codex 模型(没有应用内模型选择器 —— 你装的 `codex` 给你什么就用什么)。
- **图片附件** —— Cockpit 把粘进来的图片落到临时文件,通过 `--image` 参数传给 `codex` CLI。PNG / JPEG / WEBP / GIF 都行。
- 流式回复。
- 工具调用 —— Codex 能读文件、跑 shell 命令、改代码。
- 多 tab 会话 —— 想开几个 Codex tab 就开几个,互相独立。

### 你拿不到什么

- **不显示实时成本。** Cockpit 无法从 `codex` CLI 读出计费信息,所以 Codex tab 的 token 条是空的(`total_cost_usd: 0`)。去 OpenAI 控制台看用量。
- **没有模型选择器。** 你的 `codex` CLI 用哪个模型就用哪个。

### 常见问题

- **"找不到 `codex`" / 发消息没反应** —— `codex` CLI 不在 PATH 里。在终端跑 `codex --version` 验证;不行的话重装。
- **登录过期** —— 在终端重跑一次 `codex` 走登录流程。Cockpit 不管登录本身。
- **CLI 版本旧了** —— OpenAI 定期更新 `codex`。行为怪怪的话升级一下。

## DeepSeek

DeepSeek 是 Cockpit 里最便宜的云端引擎。跟 Claude / Codex 不同(那些复用 CLI 登录态),DeepSeek 只走 API key —— 在 tab 头部的 DeepSeek 选择器里粘一个 key 就完事。GLM 和 Kimi 的接入方式跟它一样。

底层走 DeepSeek 的 OpenAI 兼容端点(`https://api.deepseek.com/v1`),由 Cockpit 的[内置 Agent](#纯-key-引擎跑的是什么) 驱动 —— 工具调用和流式都在,但图片、MCP、子 agent 没有。

### 接入

1. 从 [platform.deepseek.com](https://platform.deepseek.com/) 拿一个 API key。形如 `sk-...`。

2. 在 Cockpit 打开一个新 tab、在引擎菜单选 **DeepSeek**,然后**点 tab 头部的 DeepSeek 选择器图标** → 把 key 粘进 **API Key** 输入框 → 保存(key 存在它自己的凭证文件 `~/.cockpit/deepseek/credentials.json` 里,**不在** `~/.cockpit/settings.json`,也不在 Cockpit 全局 Settings 弹窗里;`settings.json` 只记你选了哪个模型)。

3. 同一个选择器里挑模型。

完事。key 永远只待在本机。

### 选 DeepSeek 模型

模型列表是拿你的 key **实时**从 DeepSeek 的 `GET /v1/models` 拉的,Cockpit 没写死任何白名单 —— DeepSeek 明天上新的模型会自己冒出来,你的账号用不了的 id 则由 DeepSeek 自己报错。

新建 DeepSeek tab 默认用 **`deepseek-v4-pro`**。列表里的 `flash` 系是又快又便宜的那一头,适合小修小补、格式化、简单问答;`pro` 慢一些但更聪明,留给架构决策、难 bug、多步重构。

### 查询余额

DeepSeek 是预充值的,所以 DeepSeek tab 在模型选择器旁边有个**余额**按钮。它需要已保存的 key,而且不轮询 —— 只在你点的时候查一次。

### 你能用到什么

- **模型选择器**,从 DeepSeek 接口实时拉取(见上)。
- 流式回复。
- 工具调用 —— DeepSeek 能读文件、跑 shell 命令、改代码。
- **Fork** 和跟其它引擎一样的[逐工具调用快照](/zh/docs/agent/snapshots/)。
- UI 里显示 token 用量。

### 你拿不到什么

[纯 Key 引擎跑的是什么](#纯-key-引擎跑的是什么)里那几条都适用:没有图片、只有七个工具,以及**没有美元合计** —— token 条里的 USD 恒为 0。用余额按钮,或者去 DeepSeek 控制台看真实账单。

### 常见问题

- **"DeepSeek API key is not configured"** —— 还没在选择器里粘 key。注意是 **tab 头部的 DeepSeek 选择器**,不是 Cockpit 的全局 Settings 弹窗。
- **"401 / 未授权"** —— key 错或失效,回选择器再粘一次,留心别夹空格。
- **回复慢 / 卡** —— `pro` 本来就比 `flash` 慢;不是真的需要推理就换个 `flash` 模型。
- **花钱比预期快** —— `pro` 比 `flash` 贵好几倍;点余额按钮看看还剩多少。

## GLM

GLM 是智谱(Zhipu AI)的模型家族,通过 **BigModel** 平台售卖。结构上它跟 [DeepSeek](#deepseek)、[Kimi](#kimi) 是同一类引擎:只走 API key,有实时模型列表、额度查询,会话可 fork。

GLM 有一件别的引擎都没有的事:它有**两套接入点** —— 一套在中国大陆,一套在国际站,选择器里多出一行 **Region(区域)**让你切。两边用同一个 key,见[选择区域](#选择区域)。

### 接入

1. 从 [BigModel 控制台](https://bigmodel.cn/apikey/platform) 拿一个 API key。GLM 的 key 是用点号分开的两段 `<id>.<secret>`,没有 `sk-` 前缀。

2. 在 Cockpit 打开一个新 tab、在引擎菜单选 **GLM**,然后**点 tab 头部的模型选择器** → 把 key 粘进 **API Key** 输入框 → 保存(key 存在它自己的凭证文件 `~/.cockpit/glm/credentials.json` 里,**不在** `~/.cockpit/settings.json`,也不在 Cockpit 全局 Settings 弹窗里)。

3. 在同一个选择器里挑模型。key 一存下,Cockpit 就按你的账号去拉模型列表。

完事。key 永远只待在本机。

### 选模型

模型列表是拿你的 key **实时**从 GLM 的 `GET /models` 拉的,Cockpit 没有写死任何东西,所以上新的模型会自己冒出来。写这份文档时接口返回 8 个:

`glm-4.5` · `glm-4.5-air` · `glm-4.6` · `glm-4.7` · `glm-5` · `glm-5-turbo` · `glm-5.1` · `glm-5.2`

新建 GLM tab 默认用 **`glm-5.2`**。

> **GLM 不提供任何单模型元信息。** 它的模型列表只有裸 id —— 没有展示名,也没有上下文窗口。所以选择器里只显示 id,Cockpit 也不给 GLM tab 设上下文窗口(Kimi tab 有,因为 Kimi 会报)。这是供应商接口的限制,不是 Cockpit 少做了什么。

> **关于 `glm-5.2[1m]`。** BigModel 的 Claude Code 文档里提到过这个表示 100 万 token 上下文的 `[1m]` 后缀。Cockpit 以前直接用不了:旧的 Anthropic 兼容链路会用 HTTP 400 *"模型不存在"* 拒掉它。现在 GLM tab 走的是 OpenAI 兼容的 coding 端点,要长上下文可以试试,让供应商自己回答 —— 账号开不了的 id 会返回 GLM 自己的报错。

### 选择区域

GLM 有两套接入点,而且**同一个 key 在两边都能用**:在 `bigmodel.cn` 上签发的 key 在 `z.ai` 上一样能通过鉴权,查到的额度也完全一致。区域纯粹是路由问题。

| 区域 | 端点 |
|---|---|
| **中国大陆** | `https://open.bigmodel.cn/api/coding/paas/v4` |
| **International**(国际站) | `https://api.z.ai/api/coding/paas/v4` |

默认值来自你的 **Cockpit 界面语言**:English → 国际站,其它(包括"跟随系统")→ 中国大陆。想改就在 GLM 选择器的 **Region** 那一行覆盖,你选的优先,而且会记住。

语言只是**给默认值定个初始档**,永远不会盖掉你自己选过的。这是刻意的:改一下界面语言不应该悄悄把你的 API 流量路由到另一个国家的服务器。如果你的语言和账号对不上,设一次区域就不用再管了。

会话**不按区域分开存**。想切随时切 —— 已有的 GLM 对话照样能续,key 也不会失效。

### 查询 Coding Plan 额度

GLM 的 **Coding Plan** 是订阅制,所以 GLM tab 在模型选择器旁边放的是**查询额度**按钮而不是金额。点一下,Cockpit 会读出两个窗口还剩多少:

- 一个滚动的 **5 小时**窗口,以及
- 一个**按周**的窗口。

两个都以 `剩余/上限` 显示,前面带上你的套餐档位,比如 `lite · 5h 1990/2000 · 1w 4980/5000`。鼠标悬停能看到较长那个窗口的重置时间;某个窗口用完时会变红。按钮需要已保存的 key,而且不轮询 —— 只在你点的时候查一次。

> **没有 Coding Plan 就查不到额度,这是正常状态。** 纯按量付费的 BigModel key 没有套餐额度可报,按钮会回一句 *"额度查询失败，请检查 API Key"*。聊天本身完全不受影响 —— 只是改成按 token 计费而已。按钮旁边的链接直达 [BigModel 用量页](https://bigmodel.cn/coding-plan/personal/usage),那里是真实数字。

### 你能用到什么

- **模型选择器**,从 GLM 接口实时拉取(见上)。
- **区域切换** —— 大陆或国际站,同一个 key,会话不受影响。
- 流式回复。
- 工具调用 —— GLM 能读文件、跑 shell 命令、改代码。
- **Fork** —— 可以从任意消息 fork 一个 GLM 会话,跟 Claude 一样。
- 跟其它引擎一样的[逐工具调用快照](/zh/docs/agent/snapshots/)。
- 多 tab 会话,互相独立。

### 你拿不到什么

[纯 Key 引擎跑的是什么](#纯-key-引擎跑的是什么)里那几条都适用 —— 没有图片、只有七个工具、没有 USD 合计。GLM 自己还多两条:

- **完全没有美元成本显示。** token 条里的 USD 恒为 0。有 Coding Plan 就用**查询额度**,按量付费就去 BigModel 控制台看。
- **选择器里没有上下文窗口和展示名** —— GLM 两样都不报。见[选模型](#选模型)下面那条说明。

### 常见问题

- **选择器显示 "Set API key"** —— 还没存 key。注意是 **tab 头部的 GLM 选择器**,不是 Cockpit 的全局 Settings 弹窗。
- **"Failed to load models — check the API key" / 401** —— key 错或失效。回 [BigModel 控制台](https://bigmodel.cn/apikey/platform) 重新复制一次,留心别夹空格;GLM 的 key 是完整的 `<id>.<secret>`,两段都要。
- **HTTP 400 "模型不存在"** —— 这个模型 id 没对你的账号开放。从选择器拉到的列表里挑一个。
- **额度查不到但聊天正常** —— 你的账号没有 Coding Plan。没坏,见[查询 Coding Plan 额度](#查询-coding-plan-额度)。
- **连接慢或不稳** —— 可能连到了远的那一边。翻一下 **Region** 那行:国内账号一般走 `open.bigmodel.cn` 最快,人在境外的话同一个 key 走 `api.z.ai` 也行。切换是安全的,会话不会丢。
- **粘进去的图片被忽略** —— GLM tab 只吃文本。需要模型看图就用 Claude 或 Codex tab。

## Kimi

Kimi 是月之暗面(Moonshot)的中文市场 AI,以长上下文窗口闻名。Cockpit 直接走 **Kimi Code** 的 API —— 在 tab 头部的 Kimi 选择器里粘一个 key 就能用。结构上它跟 [DeepSeek](#deepseek) 是同一类引擎:只走 API key,有模型选择器,会话可 fork。

> **变更:** Cockpit 不再使用月之暗面的 `kimi` CLI。你不需要装它,它的登录态也不再起作用。老用户请看[从 `kimi` CLI 升级](#从-kimi-cli-升级)。

### 接入

1. 从 [Kimi Code 控制台](https://www.kimi.com/code/console) 拿一个 API key。形如 `sk-kimi-...`。

   > 这是 **Kimi Code** 的 key,不是 `platform.moonshot.cn` 上的 Kimi 开放平台 key。两者是不同产品,key **不通用** —— 开放平台的 key 在这里会直接失败。

2. 在 Cockpit 打开一个新 tab、在引擎菜单选 **Kimi**,然后**点 tab 头部的模型选择器** → 把 key 粘进 **API Key** 输入框 → 保存(key 存在它自己的凭证文件 `~/.cockpit/kimi/credentials.json` 里,**不在** `~/.cockpit/settings.json`,也不在 Cockpit 全局 Settings 弹窗里)。

3. 在同一个选择器里挑模型。key 一存下,Cockpit 就按你的账号去拉模型列表。

完事。key 永远只待在本机。

### 选模型

模型列表是拿你的 key **实时**从 Kimi 的 `GET /coding/v1/models` 拉的,不是 Cockpit 写死的。能拉到哪些模型取决于你的**会员等级**,所以两个账号看到的列表可能不一样;Kimi 上新或下线模型时列表也会跟着变。

写这份文档时,一个 Kimi Code 账号可能看到:

| 模型 | 上下文 | 说明 |
|---|---|---|
| **`kimi-for-coding`**(K2.7 Coding) | 256K | 默认选择。 |
| **`kimi-for-coding-highspeed`** | 256K | 同款模型,更快的服务档位。需要 **Allegretto** 及以上会员。 |
| **`k3`**(K3) | 1M | 长上下文旗舰。需要 **Moderato** 及以上。 |
| **`k3-256k`** | 256K | K3 的小窗口版。需要 **Moderato** 及以上。 |

> 别把这张表当成固定清单 —— 选择器里没有某个模型,就是你的套餐不含它。选择器会显示模型 id、与 id 不同时的展示名,以及上下文窗口大小。

### 查询额度

Kimi Code 是**订阅制**,不是预充值余额,所以 Kimi tab 在模型选择器旁边放的是**查询额度**按钮而不是金额。点一下,Cockpit 会读出还剩多少:

- **套餐周期** —— 一个 7 天的窗口,以及
- 叠在上面的滚动 **5 小时窗口**。

两个都以 `剩余/上限` 显示(比如 `plan 100/100 · 5h 40/50`);鼠标悬停能看到套餐窗口的重置时间。某个窗口用完时会变红。按钮需要已保存的 key,而且不轮询 —— 只在你点的时候查一次。

### 你能用到什么

- **模型选择器**,按你的账号实时拉取(见上)。
- 流式回复,**模型的"思考"过程会折叠在 `<details>` 块里展示在最终答案之前**。
- 工具调用 —— Kimi 能读文件、跑 shell 命令、改代码。
- **Fork** —— 可以从任意消息 fork 一个 Kimi 会话,跟 Claude 一样。(走 CLI 的旧版本做不到。)
- 跟其它引擎一样的[逐工具调用快照](/zh/docs/agent/snapshots/)。
- 多 tab 会话,互相独立。

### 你拿不到什么

[纯 Key 引擎跑的是什么](#纯-key-引擎跑的是什么)里那几条都适用 —— 没有图片、只有七个工具、没有 USD 合计。Kimi 自己还多一条:

- **没有美元成本显示。** Kimi Code 按订阅计费,没有按 token 累加的账单可算 —— 用**查询额度**代替。

### 从 `kimi` CLI 升级

如果你在旧版 Cockpit 里用过 Kimi,有两处变更,都是破坏性的:

- **`kimi` CLI 的登录态不再生效。** 去拿一个 [Kimi Code key](https://www.kimi.com/code/console) 粘进选择器。CLI 本身已经完全不用了,对 Cockpit 来说你可以把它卸了。
- **旧的 Kimi 会话在 Cockpit 里看不到了。** 以前会话存在 `~/.kimi`,后来是 `~/.cockpit/kimi/projects/`(已删掉的 SDK 模式);这两个目录 Cockpit 都不再索引,所以那些对话不会出现在侧栏和会话浏览器里。**磁盘上的文件没动**,你想自己读或归档都可以。新会话落在 `~/.cockpit/kimi-sessions/` 下面。

### 常见问题

- **选择器显示 "Set API key"** —— 还没存 key。注意是 **tab 头部的 Kimi 选择器**,不是 Cockpit 的全局 Settings 弹窗。
- **"Failed to load models — check the API key" / 401** —— key 错、失效,或者拿错了产品的 key。重新粘一次(留心别夹空格),并确认这是 Kimi Code 控制台的 `sk-kimi-...`,而不是 `platform.moonshot.cn` 的那个。
- **想用的模型不在列表里** —— 列表按会员等级过滤。`k3` 需要 Moderato 及以上,`kimi-for-coding-highspeed` 需要 Allegretto 及以上。
- **用到一半没响应了** —— 可能撞上了 5 小时窗口。点**查询额度**;红了就等 tooltip 里显示的重置时间。
- **粘进去的图片被忽略** —— Kimi tab 只吃文本。需要模型看图就用 Claude 或 Codex tab。

## Ollama

Ollama 是 Cockpit 里唯一**全程跑在你自己机器上**的引擎。不要 API key,不上云,不按 token 计费。装好 Ollama、拉你要的模型,Cockpit 就在模型选择器里列出来。

什么时候选它:

- 在飞机上或断网。
- 在处理不该离开本机的敏感代码。
- 你有一台强 GPU 工作站,想把它用起来。
- 你在试自定义或微调过的模型。

### 接入

1. 从 [ollama.com](https://ollama.com/) 装 Ollama。

2. 至少拉一个模型:

```bash
ollama pull llama3.1
```

之后可以随时再拉:`ollama pull qwen3.5`、`ollama pull deepseek-coder` 等。完整列表见 [Ollama 模型库](https://ollama.com/library)。

3. 在 Cockpit 新建 Agent tab,引擎菜单选 **Ollama**。**如果 Ollama 服务没在跑,Cockpit 自动 `spawn('ollama', 'serve')` 启动它**,然后最多等 8 秒就绪。

4. 点 tab 头部的模型下拉 —— Cockpit 调 Ollama API 拿你拉过的所有模型列出。

### 你能用到什么

- 你拉过的任意模型,按 tab 选。
- 流式回复。
- 工具调用 *(取决于模型 —— 代码微调模型支持工具调用,通用聊天模型常常不支持)*。
- 完全离线运行。没有任何出网调用。
- 每条消息零成本。

### 你拿不到什么

- **没有图片附件。** Cockpit 的 Ollama tab 目前只走文本,即便你拉的是视觉模型。
- **没有"最佳实践"模型选择器。** Ollama 只给你你拉过的 —— Cockpit 不替你选。代码里有一个用于保底的默认模型,但实际使用时你应该自己挑。不确定的话从已知好用的代码模型开始,比如 `qwen3.5-coder` 或 `deepseek-coder`。

### 怎么选模型

粗略的硬件对应表 —— 实际性能取决于 GPU:

| 你的硬件 | 合理的模型规模 |
|---|---|
| MacBook Air(8 GB 统一内存) | 1B – 3B 模型(很受限,质量低) |
| MacBook Pro M 系列(16–32 GB) | 7B – 13B 模型(日常代码问答够用) |
| Mac Studio / 台式机 64+ GB | 30B+ 模型(媲美较小的云端模型) |
| 24 GB+ 独显工作站 | 70B 模型(接近 Claude Haiku 级质量) |

写代码场景特别推荐看 `qwen3-coder`、`deepseek-coder`、`codellama` 系列。同等规模下比通用聊天模型实用得多。

### 常见问题

- **下拉里"没有模型"** —— 你还没拉过。打开终端跑 `ollama pull <名字>` 至少装一个。
- **回复极慢** —— 模型太大,超出 GPU 舒适承受范围。换个小的。
- **自动启动没起来** —— 在终端手动跑 `ollama serve` 再试。
