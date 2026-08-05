Cockpit 开箱支持 5 个 AI 引擎(再加一个 **Claude 2** 入口,共 6 个 tab 选项)。每个 Agent tab 选一个,可以跨 tab 混用,不用重启 —— 按本地是否有模型、账号在谁那、当前任务哪个最擅长来挑。

| 引擎 | 登录方式 | 何时用 |
|---|---|---|
| [Claude](#claude) | Anthropic `claude` CLI 登录(或 **Claude 2** 用第二个账号) | 默认。综合能力最强。 |
| [Codex](#codex) | `codex` CLI 登录 | 已经有 Codex / GPT 订阅时。 |
| [DeepSeek](#deepseek) | 在 DeepSeek 选择器里粘 API key | 推理强、便宜。 |
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
| **Kimi** | 在引擎头部的 Kimi 选择器里粘 API key | 长上下文,国内主用。 | 月之暗面(Kimi Code 订阅) |
| **Ollama** | 不需要 —— 本地 | 离线、敏感数据、自定义模型。 | 没人(你自己的电脑) |

引擎选择器里还有一个 **Claude 2** —— 它跟 Claude 是**同一个引擎**,只是用第二份配置目录(`~/.claude2`)指向**第二个 Anthropic 账号**,让你能同时跑两个 Claude tab 走不同账单。配置方式见 [Claude](#claude) 章。

### 引擎选择怎么工作

每个 Agent tab 头部有引擎选择器。新建 tab 时引擎默认是 **Claude**。给已有 tab 换引擎会开新会话 —— Claude 历史无法带到 Codex tab,因为每个引擎都有自己的对话格式。

可以同时开比如 5 个 tab:

- Tab 1:Claude 跑 `~/code/backend`
- Tab 2:DeepSeek 跑同项目做便宜的二次意见
- Tab 3:Codex 跑另一个项目
- Tab 4:Kimi 跑笔记本,吃它的长上下文窗口
- Tab 5:Ollama 跑本地模型,离线写草稿

Cockpit 的会话浏览器(侧栏顶部网格图标)能看到全部。

### 各引擎能做什么

|  | Claude | Codex | DeepSeek | Kimi | Ollama |
|---|---|---|---|---|---|
| 能读 & 改你的文件 | ✅ | ✅ | ✅ | ✅ | ⚠️ 看模型 |
| 接受图片附件 | ✅ | ✅ | ✅ | ✅(仅 SDK 模式) | ❌ |
| 流式输出(边想边说) | ✅ | ✅ | ✅ | ✅ | ✅ |
| 离线可用 | ❌ | ❌ | ❌ | ❌ | ✅ |
| 多模型变体可选 | 固定(最新版) | 固定 | flash / pro | 按你的 Kimi 套餐实时拉取 | 你拉过的任意模型 |
| UI 里显示实时成本 | ✅ | — | ✅(估算) | 显示额度而非金额 —— 见[查询额度](#查询额度) | 免费 |

> 图片支持是引擎级。**Ollama** 收到图片附件会**静默丢弃**(不报错,但 AI 看不到)。**Kimi** 在默认的 *Claude Agent SDK* 模式下能收图片;**Built-in Agent** 执行模式对所有引擎都不支持图片 —— 见[执行模式](#执行模式claude-agent-sdk-vs-built-in-agent)。

### 各引擎接入

每个引擎都有自己的章节。快速指引:

- **Claude** —— 在终端跑一次 `claude` 按提示登录。Cockpit 自动复用你的 Claude 登录态。
- **Codex** —— 装 OpenAI 的 `codex` CLI 并用它登录一次。Cockpit 复用同一份登录态。
- **DeepSeek** —— 从 [platform.deepseek.com](https://platform.deepseek.com/) 拿 key,**在 Agent tab 头部的 DeepSeek 选择器里粘**(不是全局 Settings)。然后在同一个选择器里选模型变体。
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

### 用第二个 Claude 账号:"Claude 2"

如果你有**两个** Anthropic 账号 —— 比如一个个人、一个公司账单 —— Cockpit 允许两个同时用。引擎选择器里会看到两个条目:**Claude** 和 **Claude 2**。它们是完全同一个引擎;"Claude 2" 只是把 `CLAUDE_CONFIG_DIR` 指向 `~/.claude2`,让两个 tab 不共用账单。

第二个账号的配置方式:

1. 开一个干净的终端,告诉 `claude` 用第二个配置目录:

```bash
CLAUDE_CONFIG_DIR=~/.claude2 claude
```

2. 按提示用第二个 Anthropic 账号登录。

3. 回到 Cockpit,新开一个 tab 在引擎菜单选 **Claude 2**。这个 tab 就接到第二个账号了。

可以并排开一个 **Claude** tab(个人)+ 一个 **Claude 2** tab(工作)。Cockpit 分开统计两边的 token 和成本。

> 路径**必须正好**是 `~/.claude2`(代码里硬编码)。改成别的路径 Cockpit 找不到。如果你只有一个 Claude 账号,完全无视 "Claude 2"。

### 模型切换

Cockpit 始终用 Anthropic 当前推荐的 Claude 模型。**没有模型选择器** —— 服务给的最新版你就用最新版。要关注当前是哪个模型,看 Anthropic 的官方公告;官方 SDK 更新时 Cockpit 自动跟进。

### 常见问题

- **第一条消息就报"未登录"/ 直接出错** —— 在终端跑一次 `claude`,确认登录走完。Cockpit 只能用 `claude` 自己已经能用的那份登录。
- **白天要切账号** —— 走 **Claude 2** 比登出再登入简单得多。

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

DeepSeek 是 Cockpit 里最便宜的云端引擎。跟 Claude / Codex 不同(那些复用 CLI 登录态),DeepSeek 只走 API key —— 在 tab 头部的 DeepSeek 选择器里粘一个 key 就完事。Kimi 的接入方式跟它一样。

底层走 DeepSeek 的 [Anthropic 兼容端点](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api),通过 Claude Agent SDK 路由请求,所以工具调用、流式、上下文管理跟 Claude 一样。

### 接入

1. 从 [platform.deepseek.com](https://platform.deepseek.com/) 拿一个 API key。形如 `sk-...`。

2. 在 Cockpit 打开一个新 tab、在引擎菜单选 **DeepSeek**,然后**点 tab 头部的 DeepSeek 选择器图标** → 把 key 粘进 **API Key** 输入框 → 保存(key 存在它自己的凭证文件 `~/.cockpit/deepseek/credentials.json` 里,**不在** `~/.cockpit/settings.json`,也不在 Cockpit 全局 Settings 弹窗里;`settings.json` 只记你选了哪个模型)。

3. 同一个选择器里挑模型变体。

完事。key 永远只待在本机。

### 选模型变体

| 变体 | 何时用 |
|---|---|
| **`deepseek-v4-flash`**(选择器里默认显示这个) | 快、便宜。适合小修小补、格式化、简单问答。 |
| **`deepseek-v4-pro`** | 慢、聪明。需要真推理时用 —— 架构决策、难 bug、多步重构。 |

> Cockpit 的 Agent SDK 还会用 `deepseek-v4-flash` 做后台小活(标题生成、压缩等),不管你选了哪个变体。

### 你能用到什么

- 按 tab 在下拉里选 `flash` 或 `pro`。
- **图片附件** —— `Cmd+V` 粘图片,DeepSeek 能看到(通过 Anthropic 兼容 API)。
- 流式回复。
- 工具调用 —— DeepSeek 能读文件、跑 shell 命令、改代码。
- UI 里显示 token 用量。*注意:token 条里的美元数额按 Cockpit 默认单价**估算** —— 用作跨会话相对比较有用,实际 DeepSeek 账单去 DeepSeek 控制台看。*

### 常见问题

- **"DeepSeek API key is not configured"** —— 还没在选择器里粘 key。注意是 **tab 头部的 DeepSeek 选择器**,不是 Cockpit 的全局 Settings 弹窗。
- **"401 / 未授权"** —— key 错或失效,回选择器再粘一次,留心别夹空格。
- **回复慢 / 卡** —— `pro` 本来就比 `flash` 慢;不是真的需要推理就换回 `flash`。
- **成本估算涨得比预期快** —— `pro` 比 `flash` 贵好几倍;看 token 条能发现意外用了 `pro` 的会话。

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

### 执行模式:Claude Agent SDK vs Built-in Agent

Kimi 选择器里有一个**执行模式(Execution Mode)**开关,两个选项打的是不同的 Kimi 端点,**各自存一套会话记录**。所以会话一旦有消息,模式就锁死了 —— 要换模式,新开一个 tab。

| | **Claude Agent SDK**(默认) | **Built-in Agent** |
|---|---|---|
| 谁跑这个循环 | 官方 Claude Agent SDK,指向 Kimi | Cockpit 自己的 agent 循环 |
| 端点 | `https://api.kimi.com/coding/`(Anthropic 兼容) | `https://api.kimi.com/coding/v1`(OpenAI 兼容) |
| 图片附件 | ✅ | ❌(这个模式下所有引擎都不支持图片) |
| 会话落盘位置 | `~/.cockpit/kimi/projects/<项目>/<会话>.jsonl` | `~/.cockpit/kimi-sessions/<项目>/<会话>.jsonl` |

没有特别理由就留在 **Claude Agent SDK** —— 图片、子 agent 以及 SDK 带来的其它东西都在这个模式下。

### 查询额度

Kimi Code 是**订阅制**,不是预充值余额,所以 Kimi tab 在模型选择器旁边放的是**查询额度**按钮而不是金额。点一下,Cockpit 会读出还剩多少:

- **套餐周期** —— 一个 7 天的窗口,以及
- 叠在上面的滚动 **5 小时窗口**。

两个都以 `剩余/上限` 显示(比如 `plan 100/100 · 5h 40/50`);鼠标悬停能看到套餐窗口的重置时间。某个窗口用完时会变红。按钮需要已保存的 key,而且不轮询 —— 只在你点的时候查一次。

### 你能用到什么

- **模型选择器**,按你的账号实时拉取(见上)。
- Claude Agent SDK 模式下的**图片附件** —— `Cmd+V` 粘图片,Kimi 能看到。PNG / JPEG / WEBP / GIF。
- 流式回复,**模型的"思考"过程会折叠在 `<details>` 块里展示在最终答案之前**。
- 工具调用 —— Kimi 能读文件、跑 shell 命令、改代码。
- **Fork** —— 可以从任意消息 fork 一个 Kimi 会话,跟 Claude 一样。(走 CLI 的旧版本做不到。)
- 跟其它引擎一样的[逐工具调用快照](/zh/docs/agent/snapshots/)。
- 多 tab 会话,互相独立。

### 你拿不到什么

- **没有美元成本显示。** Kimi Code 按订阅计费,没有按 token 累加的账单可算 —— 用**查询额度**代替。token 条里如果出现美元数字,那是 SDK 自带价目表算的,不是 Kimi 的账单。
- **Built-in Agent 模式下没有图片。** 只有图片没有文字的消息会被拒绝并提示 *"The built-in agent requires a text prompt"*;文字 + 图片的消息会正常回答,但图片被丢弃。

### 从 `kimi` CLI 升级

如果你在旧版 Cockpit 里用过 Kimi,有两处变更,都是破坏性的:

- **`kimi` CLI 的登录态不再生效。** 去拿一个 [Kimi Code key](https://www.kimi.com/code/console) 粘进选择器。CLI 本身已经完全不用了,对 Cockpit 来说你可以把它卸了。
- **旧的 Kimi 会话在 Cockpit 里看不到了。** 以前会话存在 `~/.kimi`,Cockpit 不再索引这个目录,所以那些对话不会出现在侧栏和会话浏览器里。**磁盘上的文件没动** —— `~/.kimi` 还在,你想自己读或归档都可以。新会话落在 `~/.cockpit/kimi/` 下面。

### 常见问题

- **选择器显示 "Set API key"** —— 还没存 key。注意是 **tab 头部的 Kimi 选择器**,不是 Cockpit 的全局 Settings 弹窗。
- **"Failed to load models — check the API key" / 401** —— key 错、失效,或者拿错了产品的 key。重新粘一次(留心别夹空格),并确认这是 Kimi Code 控制台的 `sk-kimi-...`,而不是 `platform.moonshot.cn` 的那个。
- **想用的模型不在列表里** —— 列表按会员等级过滤。`k3` 需要 Moderato 及以上,`kimi-for-coding-highspeed` 需要 Allegretto 及以上。
- **用到一半没响应了** —— 可能撞上了 5 小时窗口。点**查询额度**;红了就等 tooltip 里显示的重置时间。
- **粘进去的图片被忽略** —— 这个 tab 在 **Built-in Agent** 模式。新开一个 tab 用 **Claude Agent SDK** 模式(会话一旦有消息就不能改模式了)。

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
