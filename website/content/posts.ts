import type { Locale } from '@/lib/i18n';

/**
 * Blog post data.
 *
 * Each post ships an `en` and `zh` body. We keep the bodies inline as template
 * literals — no extra MDX/markdown loader, no extra build step. `react-markdown`
 * (already a dependency) renders them at request time / static-export time.
 */

export interface PostBody {
  title: string;
  description: string;
  body: string;
  /** Optional plain-text reading-time hint, e.g. "8 min read". */
  readingTime?: string;
}

export interface Post {
  slug: string;
  /** ISO date — used for sitemap lastModified and visible publish date. */
  date: string;
  /** SEO keywords specific to this post. */
  keywords: string[];
  /** Per-locale content. */
  content: Record<Locale, PostBody>;
}

// ---------------------------------------------------------------------------
// Posts (newest first)
// ---------------------------------------------------------------------------

export const posts: Post[] = [
  {
    slug: 'claude-code-with-glm-kimi-deepseek',
    date: '2026-10-01',
    keywords: [
      'Claude Code GLM',
      'Claude Code Kimi',
      'Claude Code DeepSeek',
      'Claude Code with any LLM',
      'Claude Code without environment variables',
      'ANTHROPIC_BASE_URL',
      'switch models Claude Code',
      'Claude Code 国产模型',
      'Claude Code 接 GLM',
      'Claude Code 接 Kimi',
      'Claude Code 接 DeepSeek',
      'OpenCockpit',
    ],
    content: {
      en: {
        title: 'Claude Code with GLM, Kimi and DeepSeek — No Env Vars',
        description:
          'Run a Claude Code-style agent on GLM, Kimi, DeepSeek or Ollama without editing ANTHROPIC_BASE_URL: one engine per tab, side by side, and what you give up.',
        readingTime: '5 min read',
        body: `Search for "Claude Code with GLM" or "Claude Code with Kimi" and almost every guide gives you the same recipe: export \`ANTHROPIC_BASE_URL\` and \`ANTHROPIC_AUTH_TOKEN\`, point them at the provider's Anthropic-compatible endpoint, restart \`claude\`.

It works. It's also global to your shell, which turns "try the same prompt on another model" into an exercise in editing variables.

## The three usual recipes

**1. Export the variables.**

\`\`\`bash
export ANTHROPIC_BASE_URL="<provider's Anthropic-compatible endpoint>"
export ANTHROPIC_AUTH_TOKEN="<your key>"
claude
\`\`\`

One model per shell. To switch, you change both variables and start over.

**2. Wrap it in shell functions.** A \`glm\`, a \`kimi\`, a \`ds\` in your \`~/.zshrc\`, each setting the variables before launching \`claude\`. Nicer to type; still one model per terminal, and the keys now live in your shell profile.

**3. Put a gateway in front.** LiteLLM or a similar proxy translates Claude Code's Anthropic protocol to whatever the provider speaks. Most flexible, and one more service to run and configure.

All three have one thing going for them: what runs is Claude Code itself, so you keep its full feature set — MCP servers, subagents, everything.

## One engine per tab instead

OpenCockpit makes the model a per-tab choice. Open a tab, pick **GLM**, **Kimi**, **DeepSeek** or **Ollama** in the header, paste the key once into that engine's picker, done. The next tab can be Claude, the one after that Codex.

![Six OpenCockpit tabs, each on a different engine, answering the same question in the same project](/opencockpit.webp)

That screenshot is the whole point: the same question, six engines, one window, one project. No variable changed, nothing restarted.

A few things come along with per-engine setup:

- **Keys stay out of your shell.** Each engine keeps its own credential file under \`~/.cockpit/<engine>/credentials.json\`.
- **The model list is live.** GLM, Kimi and DeepSeek tabs fetch the models your key can actually use, so a model the provider ships tomorrow shows up on its own.
- **Provider-specific bits are handled.** GLM tabs have a region switch (mainland or international host, same key) and a Coding Plan quota check; Kimi tabs read your plan's 5-hour and weekly windows; DeepSeek tabs show your prepaid balance.
- **Same UI for every engine.** Session history, forking and per-tool-call snapshots work the same whichever model is answering.

## What you give up

This part matters, so plainly: GLM, Kimi, DeepSeek and Ollama tabs don't run Claude Code. They run OpenCockpit's own Built-in Agent against the provider's OpenAI-compatible endpoint. It reads and edits files, runs shell commands and streams its work, but it has **seven tools** — Read, Write, Edit, Bash, Glob, Grep, TodoWrite — and **no MCP servers, no subagents, no image input**.

If you need MCP or subagents on a non-Anthropic model, the environment-variable recipe is still the right tool. OpenCockpit trades them for switching per tab without touching your shell — which, for comparing models or keeping a cheap model on routine work next to Claude on the hard parts, is usually the trade you want.

## Try it

\`\`\`bash
npm i -g @surething/cockpit && cockpit
\`\`\`

Open a project, add a tab, pick an engine. Setup details for each provider — where to get the key, which models to start with, common errors — are in [AI Engines](/en/docs/agent/engines/).`,
      },
      zh: {
        title: 'Claude Code 接 GLM、Kimi、DeepSeek，不用改环境变量',
        description:
          '不改 ANTHROPIC_BASE_URL，也能让 Claude Code 式的 Agent 跑在 GLM、Kimi、DeepSeek 或 Ollama 上：每个 tab 一个引擎、并排对比，以及要付出的代价。',
        readingTime: '阅读约 5 分钟',
        body: `搜"Claude Code 接 GLM"或"Claude Code 接 Kimi"，几乎所有教程给的都是同一套做法：导出 \`ANTHROPIC_BASE_URL\` 和 \`ANTHROPIC_AUTH_TOKEN\`，指向厂商的 Anthropic 兼容端点，重启 \`claude\`。

这能用。但它作用于整个 shell，于是"同一个问题换个模型试试"就变成了反复改环境变量。

## 常见的三种做法

**1. 直接导出环境变量。**

\`\`\`bash
export ANTHROPIC_BASE_URL="<厂商的 Anthropic 兼容端点>"
export ANTHROPIC_AUTH_TOKEN="<你的 key>"
claude
\`\`\`

一个 shell 一个模型。想换，就得改两个变量再重来。

**2. 包成 shell 函数。** 在 \`~/.zshrc\` 里写 \`glm\`、\`kimi\`、\`ds\` 几个函数，各自设好变量再启动 \`claude\`。敲起来方便了，但还是一个终端一个模型，而且 key 都写进了 shell 配置。

**3. 在前面架一层网关。** 用 LiteLLM 之类的代理，把 Claude Code 的 Anthropic 协议转成厂商的协议。最灵活，代价是多跑、多配一个服务。

这三种做法有一个共同的好处：跑的是 Claude Code 本身，功能完整 —— MCP server、子代理，一样不少。

## 换个思路：每个 tab 一个引擎

OpenCockpit 把模型变成了每个 tab 自己的选择。新开一个 tab，在顶部选 **GLM**、**Kimi**、**DeepSeek** 或 **Ollama**，把 key 粘进这个引擎的选择器，就好了。下一个 tab 可以是 Claude，再下一个可以是 Codex。

![OpenCockpit 的六个 tab，各用一个不同的引擎，在同一个项目里回答同一个问题](/opencockpit.webp)

这张截图就是全部要点：同一个问题，六个引擎，一个窗口，一个项目。没改任何变量，也没重启任何东西。

按引擎分开配置，还顺带解决了几件事：

- **key 不进 shell。** 每个引擎的 key 单独存在 \`~/.cockpit/<engine>/credentials.json\`。
- **模型列表是实时拉取的。** GLM、Kimi、DeepSeek 的 tab 会用你的 key 拉取账号实际可用的模型，厂商明天上新模型，这里自动出现。
- **各家的特殊之处都处理好了。** GLM 有区域切换（国内站或国际站，同一个 key）和 Coding Plan 额度查询；Kimi 能查套餐的 5 小时和每周额度；DeepSeek 能看预充值余额。
- **所有引擎同一套界面。** 会话历史、分叉、逐个工具调用的快照，不管哪个模型在回答都一样。

## 代价

这一点要说清楚：GLM、Kimi、DeepSeek、Ollama 的 tab 跑的不是 Claude Code，而是 OpenCockpit 自己的内置 Agent，对接厂商的 OpenAI 兼容端点。它能读写文件、跑命令、流式输出，但只有**七个工具** —— Read、Write、Edit、Bash、Glob、Grep、TodoWrite —— **没有 MCP server，没有子代理，也不支持图片输入**。

如果你需要在非 Anthropic 模型上用 MCP 或子代理，改环境变量的做法仍然是对的选择。OpenCockpit 用它们换来了按 tab 切换、不碰 shell。如果你的目的是对比模型，或者让便宜的模型干日常活、Claude 啃难题，这笔交换通常是划算的。

## 上手

\`\`\`bash
npm i -g @surething/cockpit && cockpit
\`\`\`

打开一个项目，加一个 tab，选一个引擎。每个厂商的接入细节 —— key 去哪拿、先用哪个模型、常见报错 —— 都在 [AI 引擎](/zh/docs/agent/engines/) 文档里。`,
      },
    },
  },
  {
    slug: 'openclaude-vs-opencockpit',
    date: '2026-10-01',
    keywords: [
      'OpenClaude',
      'OpenClaude GUI',
      'OpenClaude vs OpenCockpit',
      'open Claude Code',
      'Claude Code with any LLM',
      'Claude Code alternative open source',
      'Claude Code GUI any model',
      'OpenClaude 图形界面',
      'Claude Code 任意模型',
      'OpenCockpit',
    ],
    content: {
      en: {
        title: 'OpenClaude vs OpenCockpit: Claude Code on Any LLM',
        description:
          'Both bring a Claude Code-style agent to any model. OpenClaude is a terminal CLI; OpenCockpit is a browser workbench. How they differ and when to use which.',
        readingTime: '5 min read',
        body: `If you've searched for an "OpenClaude GUI", you probably already know what you want: the Claude Code way of working, on a model that isn't Claude. OpenClaude and OpenCockpit both answer that. They take very different routes to get there, and the right pick depends on where you like to work.

*Facts about OpenClaude below come from its README as of October 2026. If something has changed, the README wins.*

## OpenClaude: the CLI, opened up

[OpenClaude](https://github.com/Gitlawb/openclaude) is an open-source coding-agent CLI — "runs anywhere, uses anything". Its README says it originated from the Claude Code codebase and has since been substantially modified to support many providers: OpenAI-compatible APIs, Gemini, GitHub Models, Codex, Ollama and a long list of others.

Because it keeps the Claude Code shape, it keeps the Claude Code feature set: MCP servers, subagents, slash commands, a terminal-first workflow, plus a bundled VS Code extension. You install it with \`npm install -g @gitlawb/openclaude\` and use it where you'd use \`claude\`.

On licensing, the README is specific: MIT for OpenClaude contributors' modifications, while the Claude Code code it derives from remains Anthropic's.

## OpenCockpit: a workbench around the agent

OpenCockpit doesn't fork any CLI. It's a local web app — Agent, Explorer and Console panels in one browser window — and each Agent tab picks an engine:

- **Claude** tabs run on the official Claude Agent SDK, with your existing \`claude\` login.
- **Codex** tabs drive OpenAI's \`codex\` CLI.
- **DeepSeek, GLM, Kimi and Ollama** tabs run OpenCockpit's own Built-in Agent against the provider's API.

The point isn't one agent on many models so much as many sessions side by side: several projects in the sidebar, several tabs per project, each on whatever engine suits it, with the file browser, diffs, terminals and per-tool-call snapshots right next to the chat. It's also client–server, so you can run it once on a shared dev box and give every teammate a seat. MIT licensed.

## Side by side

|  | OpenClaude | OpenCockpit |
|---|---|---|
| Interface | Terminal CLI + VS Code extension | Browser workbench (Agent / Explorer / Console) |
| How it reaches other models | Its own CLI, many providers | Per-tab engine: Claude, Codex, DeepSeek, GLM, Kimi, Ollama |
| Provider breadth | Wider — 20+ providers incl. Gemini, GitHub Models, LM Studio | Six engines |
| MCP & subagents on non-Anthropic models | Yes | No — the Built-in Agent has seven tools |
| Parallel work | One session per terminal | Many projects × many tabs in one window |
| Reviewing what the agent changed | Your usual git workflow | Per-tool-call snapshots and a diff viewer built in |
| Team use | Each person runs their own CLI | Self-host once, every teammate gets a seat |
| License | MIT for its modifications; derived code remains Anthropic's | MIT |

## Which one, then?

**Pick OpenClaude** if you live in the terminal, want the broadest choice of providers, or need MCP servers and subagents on a non-Anthropic model. On those points it simply does more.

**Pick OpenCockpit** if what you're missing is the GUI part: running several projects and models in parallel, seeing files and diffs next to the conversation, reviewing every tool call, or sharing one setup with a team.

They don't exclude each other, either. OpenCockpit's Console panel is a real terminal, so you can run \`openclaude\` in one bubble while the Agent panel works on something else.

## Try OpenCockpit

\`\`\`bash
npm i -g @surething/cockpit && cockpit
\`\`\`

Engine setup is in [AI Engines](/en/docs/agent/engines/), and the longer comparison with the official CLI and Desktop app is in [Claude Code CLI vs GUI vs Desktop](/en/blog/claude-code-gui-comparison/).`,
      },
      zh: {
        title: 'OpenClaude 与 OpenCockpit：让 Claude Code 跑在任意模型上',
        description:
          '两者都把 Claude Code 式的 Agent 带到任意模型上。OpenClaude 是终端 CLI，OpenCockpit 是浏览器里的工作台。区别在哪、各自适合谁。',
        readingTime: '阅读约 5 分钟',
        body: `如果你搜过"OpenClaude GUI"，你多半已经清楚自己要什么：Claude Code 那种工作方式，但用的不是 Claude 模型。OpenClaude 和 OpenCockpit 都能给你这个，只是路线完全不同，选哪个取决于你习惯在哪干活。

*下文关于 OpenClaude 的事实来自它 2026 年 10 月的 README。如有变化，以 README 为准。*

## OpenClaude：把 CLI 打开

[OpenClaude](https://github.com/Gitlawb/openclaude) 是一个开源的编程 Agent CLI —— "runs anywhere, uses anything"。它的 README 说明，它源自 Claude Code 的代码库，之后做了大量修改以支持多家模型：OpenAI 兼容接口、Gemini、GitHub Models、Codex、Ollama，以及一长串其他厂商。

因为保留了 Claude Code 的形态，它也保留了 Claude Code 的功能：MCP server、子代理、斜杠命令、终端优先的工作流，另外还附带一个 VS Code 扩展。用 \`npm install -g @gitlawb/openclaude\` 安装，平时在哪用 \`claude\`，就在哪用它。

许可证方面，README 写得很明确：OpenClaude 贡献者的修改部分是 MIT，而它所源自的 Claude Code 代码仍归 Anthropic 所有。

## OpenCockpit：围绕 Agent 的工作台

OpenCockpit 不 fork 任何 CLI。它是一个本地 Web 应用 —— Agent、Explorer、Console 三个面板在一个浏览器窗口里 —— 每个 Agent tab 自己选引擎：

- **Claude** tab 跑在官方 Claude Agent SDK 上，直接复用你已有的 \`claude\` 登录。
- **Codex** tab 驱动 OpenAI 的 \`codex\` CLI。
- **DeepSeek、GLM、Kimi、Ollama** tab 跑 OpenCockpit 自己的内置 Agent，对接厂商的 API。

重点与其说是"一个 Agent 跑多个模型"，不如说是"多个会话并排跑"：侧边栏里多个项目，每个项目多个 tab，每个 tab 用最合适的引擎，文件浏览、diff、终端、逐个工具调用的快照都在对话旁边。它还是 client-server 架构，可以在共享开发机上部署一次，团队每人一个座位。MIT 协议。

## 并排对比

|  | OpenClaude | OpenCockpit |
|---|---|---|
| 界面 | 终端 CLI + VS Code 扩展 | 浏览器工作台（Agent / Explorer / Console） |
| 怎么接其他模型 | 自己的 CLI，支持很多厂商 | 每个 tab 选引擎：Claude、Codex、DeepSeek、GLM、Kimi、Ollama |
| 厂商覆盖面 | 更广 —— 20 多家，包括 Gemini、GitHub Models、LM Studio | 六个引擎 |
| 非 Anthropic 模型上的 MCP 和子代理 | 有 | 没有 —— 内置 Agent 只有七个工具 |
| 并行工作 | 一个终端一个会话 | 一个窗口里多项目 × 多 tab |
| 回看 Agent 改了什么 | 用你平时的 git 流程 | 内置逐个工具调用的快照和 diff 查看器 |
| 团队使用 | 每人各跑一个 CLI | 自托管一次，每个队友一个座位 |
| 许可证 | 修改部分 MIT，源自的代码仍归 Anthropic | MIT |

## 那该选哪个？

**选 OpenClaude**：如果你长期待在终端里，想要最多的模型选择，或者需要在非 Anthropic 模型上用 MCP server 和子代理。在这几点上，它就是能做更多。

**选 OpenCockpit**：如果你缺的是图形界面这部分 —— 多个项目、多个模型并行跑，在对话旁边看文件和 diff，回看每一次工具调用，或者和团队共用一套环境。

两者也不互斥。OpenCockpit 的 Console 面板是真正的终端，你完全可以在一个气泡里跑 \`openclaude\`，同时让 Agent 面板干别的。

## 试试 OpenCockpit

\`\`\`bash
npm i -g @surething/cockpit && cockpit
\`\`\`

引擎配置见 [AI 引擎](/zh/docs/agent/engines/)，和官方 CLI、Desktop 的更完整对比见 [Claude Code CLI vs GUI vs Desktop](/zh/blog/claude-code-gui-comparison/)。`,
      },
    },
  },
  {
    slug: 'long-term-memory-is-a-directory',
    date: '2026-09-22',
    keywords: [
      'AI agent long-term memory',
      'agent memory without vector database',
      'file based agent memory',
      'model-agnostic agent memory',
      'BOT.md',
      'OpenCockpit Bots',
      'Agent 长期记忆',
      '文件原生记忆',
      '跨模型 Agent 记忆',
      '无向量数据库 Agent 记忆',
    ],
    content: {
      en: {
        title: 'Long-Term Memory Is Just a Directory',
        description:
          'Why OpenCockpit Bots store agent memory as a plain directory the model explores like a codebase, instead of a vector database or hidden memory runtime.',
        readingTime: '7 min read',
        body: `Talk about long-term memory for AI agents and most people picture vector databases, embeddings, knowledge graphs, automatic summarization, and elaborate policies for what gets written and what gets recalled.

OpenCockpit Bots take a different path:

> Long-term memory is a directory of state and context that the model can explore.

A Bot does not try to decide for the model what counts as memory, and it does not ship a separate memory runtime. It provides one small, transparent mechanism: content worth reusing is saved, summoned, and carried forward in any session, with any model.

## A Bot is not a prompt

A Cockpit Bot is, first of all, an ordinary directory.

\`\`\`text
my-bot/
├── BOT.md
├── identity/
│   ├── persona.md
│   └── principles.md
├── relationships/
│   └── user.md
├── memory/
│   ├── facts.md
│   └── procedures.md
├── commitments/
│   └── active.md
└── projects/
    └── project-a/
        └── CONTEXT.md
\`\`\`

None of these folders are tables in a platform-defined schema. They are one way a user chose to organize things, and they can be added, removed, or restructured as needs change.

\`BOT.md\` is the entry point. It describes who the Bot is, and it also tells the model:

- what the Bot is responsible for;
- which file holds what;
- which files to read for which kind of task;
- what may be written;
- how to handle corrections, forgetting, and conflicts;
- which Skills are available on demand.

So \`BOT.md\` is not a persona prompt in the usual sense. It is closer to the index, router, and operating manual for a space of long-term context.

## Summoned, not bound

A Bot does not belong to a particular chat, and it is not tied to a particular model.

You summon it with \`@name\` from any project and any session. Cockpit hands the model the Bot's entry point together with the current task; the model reads \`BOT.md\` and then explores the relevant folders according to the index and rules it finds there.

The whole flow looks like this:

\`\`\`text
your task
  ↓
summon the Bot
  ↓
read BOT.md
  ↓
locate the folders and files this task needs
  ↓
explore, understand, and assemble the context
  ↓
do the work
  ↓
update long-term state when you authorize it
\`\`\`

The same Bot can be used by Claude today and picked up by Codex, GLM, Kimi, or a local model tomorrow. As long as a model can read files and follow \`BOT.md\`, the long-term context is never locked inside one vendor's private memory system.

## The model is the retriever

Cockpit Bots have no built-in vector search, embeddings, or knowledge graph. That does not mean there is no retrieval. The retrieval is model-driven exploration of a file system.

Modern coding agents already solve this problem well. Dropped into an unfamiliar codebase, they do not stuff every file into context. They read the entry docs, look at the directory layout, search for keywords, follow references into the relevant files, and build up an understanding step by step.

A Bot's long-term context uses exactly the same mechanism. \`BOT.md\` provides the high-level index, the directory structure provides information boundaries, file names and headings provide semantic cues, and the model decides where to dig based on the task at hand.

This is retrieval that uses what the model can already do:

- no retrieval service to deploy;
- no embeddings to precompute;
- no copy of your content in a second store;
- no need for the platform to know in advance how you will organize memory;
- no index to rebuild when the directory layout changes.

To the model, it is not querying an unfamiliar memory API. It is exploring a codebase of context.

## You define the Bot's cognitive environment

Cockpit does not impose one memory structure on every Bot.

A research Bot might organize itself around papers, evidence, conclusions, and open questions to verify. A project Bot might use decisions, progress, risks, and commitments. A personal assistant might use relationships, preferences, schedules, and long-term goals.

What you define is not a handful of static memories but the Bot's long-term cognitive environment:

- which information is worth keeping long term;
- which is only relevant to one conversation;
- where each kind of information lives;
- what to read when answering which kind of question;
- which sources are more trustworthy;
- how new facts revise old ones;
- what should expire or be forgotten;
- which state needs follow-up later.

The platform does not try to design a universal ontology that fits everyone. Files and Markdown are the lowest common denominator, and \`BOT.md\` lets each Bot have its own information architecture.

## Explicit memory, not automatic absorption

Many automatic memory systems continuously analyze conversations and decide on their own what to keep. That looks convenient, but it brings problems that are hard to avoid:

- the model can write a misunderstanding down as a fact;
- a passing thought can be stored as a lasting preference;
- untrusted web pages or tool output can contaminate memory;
- you cannot tell which memory influenced a given answer;
- after deleting a memory, it is hard to confirm it no longer survives in some summary, index, or derived data.

Cockpit Bots lean toward explicit authorization. Ordinary work is read-only by default. A Bot changes its long-term state only when you explicitly ask it to remember, update, correct, or forget something. What may be recorded, where it goes, and how older content is handled are decided by the Bot's own rules.

That gives up some of the convenience of "it remembers everything for you" in exchange for a much clearer boundary of control:

- what the long-term state is — open it and look;
- why something was recorded — the source can be kept alongside it;
- what was written wrong — fix it directly;
- what you do not want kept — delete it, for real;
- when things changed — trace it through diffs and version history.

## The file system is the interface

Plain files come with capabilities that elaborate memory systems tend to underestimate.

- **Readable.** You do not need an admin console to check what a Bot knows.
- **Editable.** Memory is not a black box that can only be changed indirectly through the model.
- **Diffable.** Git and file diffs show exactly what a task changed.
- **Portable.** Copy a directory and you have moved or backed up the Bot's identity and context.
- **Model-agnostic.** The content is not hidden state owned by one vendor.
- **Extensible.** Full-text search, embeddings, knowledge graphs, or other indexes can be layered on top later — as optional accelerators, not as a precondition for memory to exist.

Even if every add-on service disappears, the contents of the directory remain complete, readable, and recoverable.

## Minimal, but not left to sprawl

The obvious worry about memory-as-a-directory is that it only grows: more files, older facts, until exploring it becomes slow and unreliable.

Cockpit's answer is not a retrieval service bolted on top. It is having the Bot review itself:

\`\`\`text
@product review its memory
\`\`\`

A review is the one time the whole directory is read. It looks for:

- **stale** entries — expired, or time-bound numbers, versions, and status confirmed long ago;
- **contradictions** — classified first: a change over time, a difference in scope, a clash of authority, or a genuine conflict only you can settle;
- dangling commitments, missing sources, duplicated information, and broken Skills;
- **orphaned** conclusions — still marked active, though what they rested on has been superseded or disputed;
- **oversized** context — the directory has outgrown the read rules in \`BOT.md\`.

Size is handled with files too. An oversized file is split by subject, each split directory gets an \`INDEX.md\` with one line per entry, and \`BOT.md\` is rewritten to read the indexes first and open individual entries on demand. No budget arithmetic, no retrieval layer — the information architecture simply grows with the content.

The findings are saved as a report under \`.reviews/\` and returned as a numbered list; nothing in long-term memory changes until you pick the rows to apply. Housekeeping follows the same rule as everything else: the model proposes, you decide, the files record.

What remains is a genuine trade-off. Retrieval and write quality still depend on each model's tool use and instruction following. And low-latency processing of huge event streams is simply not the problem a directory is meant to solve. If it ever needs to be, caches or search can sit on top as rebuildable accelerators, with plain files still the source of truth.

The key is not to invert that relationship: a vector database, a private schema, or one model's hidden state should never become the only place a Bot's memory lives.

## Not a memory platform, but a memory substrate

Judged as a complete memory platform that learns, organizes, and recalls automatically, Cockpit Bots would look like they are missing a lot of features. But that is not what they are trying to be.

They provide a more basic layer:

> A way for long-term context to outlive any single session and any single model, persisting as an ordinary directory.

Cockpit makes a Bot findable, summonable, and hand-off-able to different sessions. \`BOT.md\` describes how the context is used. You define the structure that fits you. The model finds, understands, and updates the relevant content the way it would explore a codebase.

The value of the design is not that it decides how you should remember. It is that the memory you define always belongs to you, and any suitable model can keep using it.

The ideal long-term memory may not be an ever more complex, ever less visible intelligent database. It can just be a directory.

A directory you can understand, a model can find its way around, a session can carry with it, and you will still be able to open years from now.

[Read the Bots documentation](/en/docs/agent/bots/), or the previous post: [Bots: Persistent Subagents You Can Tag into Any Task](/en/blog/persistent-subagents-you-can-tag/).

---

**Try it:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: '把长期记忆做成一个目录：Cockpit Bots 的极简设计',
        description:
          '为什么 OpenCockpit Bots 不用向量数据库或隐藏的记忆运行时，而把长期记忆做成一个模型像探索代码库一样探索的普通目录。',
        readingTime: '阅读约 7 分钟',
        body: `谈到 AI Agent 的长期记忆，人们通常会想到向量数据库、Embedding、知识图谱、自动摘要，以及复杂的记忆写入和召回策略。

OpenCockpit Bots 选择了另一条路：

> 把长期记忆做成一个模型可以探索的状态上下文目录。

它不试图替模型决定什么是记忆，也不建立一套独立的 Memory Runtime。它只提供一个足够小、足够透明的机制，让需要长期复用的内容可以在任意会话、任意模型中被保存、召唤和继续使用。

## Bot 不是一段 Prompt

一个 Cockpit Bot 首先是一个普通目录。

\`\`\`text
my-bot/
├── BOT.md
├── identity/
│   ├── persona.md
│   └── principles.md
├── relationships/
│   └── user.md
├── memory/
│   ├── facts.md
│   └── procedures.md
├── commitments/
│   └── active.md
└── projects/
    └── project-a/
        └── CONTEXT.md
\`\`\`

这些目录并非平台规定的数据库表。它们只是用户选择的一种组织方法，可以按照实际需要增加、删除或重构。

其中，\`BOT.md\` 是整个 Bot 的入口。它不仅描述 Bot 是谁，还告诉模型：

- 这个 Bot 负责什么；
- 哪些文件保存了什么；
- 遇到不同任务时应该读取哪些文件；
- 哪些内容可以写入；
- 如何处理纠正、遗忘和冲突；
- 有哪些 Skills 可以按需使用。

因此，\`BOT.md\` 并不是传统意义上的 persona prompt。更准确地说，它是这片长期上下文空间的索引、路由器和操作手册。

## 召唤，而不是绑定

Bot 不属于某个固定聊天，也不绑定某个模型。

用户可以在任意项目、任意会话中用 \`@name\` 召唤它。Cockpit 将 Bot 的入口和当前任务交给模型，模型随后读取 \`BOT.md\`，再按照其中的索引和规则探索相关目录。

整个过程可以概括为：

\`\`\`text
用户任务
  ↓
召唤 Bot
  ↓
读取 BOT.md
  ↓
根据任务定位相关目录和文件
  ↓
探索、理解并组合所需上下文
  ↓
完成任务
  ↓
在用户授权时更新长期状态
\`\`\`

同一个 Bot 可以先由 Claude 使用，之后由 Codex、GLM、Kimi 或本地模型继续处理。只要模型能够读取文件并遵循 \`BOT.md\`，长期上下文就不会被锁在某个模型的私有记忆系统里。

## 模型本身就是检索器

Cockpit Bots 没有预设向量检索、Embedding 或知识图谱，但这不意味着它没有检索。它采用的是模型驱动的文件系统探索式检索。

现代代码 Agent 已经擅长处理类似问题：面对一个陌生代码库，它不会一次性把所有文件塞进上下文，而是先阅读入口文档，查看目录结构，搜索关键词，沿引用关系打开相关文件，再逐步形成对系统的理解。

Bot 的长期上下文可以使用相同机制。\`BOT.md\` 提供高层索引，目录结构提供信息边界，文件名和章节提供语义线索，模型则根据当前任务决定应该深入哪里。

这是一种原生利用模型能力的检索方式：

- 不需要额外部署检索服务；
- 不需要提前生成 Embedding；
- 不需要将内容复制到另一套存储；
- 不需要平台预先知道用户会如何组织记忆；
- 目录结构发生变化后，也不必重建索引。

对于模型来说，它不是在查询一个陌生的记忆 API，而是在探索一个上下文代码库。

## 用户定义 Bot 的认知环境

Cockpit 不规定所有 Bot 必须使用同一种记忆结构。

一个研究 Bot 可能按照论文、证据、研究结论和待核验问题组织目录；一个项目 Bot 可能按照决策、进度、风险和承诺组织；一个私人助理则可能按照关系、偏好、日程和长期目标组织。

用户真正定义的不是几条静态记忆，而是 Bot 的长期认知环境：

- 哪些信息值得长期保存；
- 哪些只是一次性会话内容；
- 不同类型的信息放在哪里；
- 回答什么问题时应该读取什么；
- 什么来源更可信；
- 新事实如何修正旧事实；
- 哪些内容应该过期或被遗忘；
- 哪些状态需要日后继续跟进。

平台没有试图提前设计一套能够适合所有人的统一本体。文件和 Markdown 就是最低公分母，而 \`BOT.md\` 让每个 Bot 可以拥有自己的信息架构。

## 显式记忆，而不是自动吸收

很多自动记忆系统会持续分析对话，并自行决定保存哪些内容。这看起来方便，却会引入几个难以回避的问题：

- 模型可能把误解写成事实；
- 临时想法可能被当成长期偏好；
- 不可信网页或工具输出可能污染记忆；
- 用户不知道某个回答受到了哪条记忆影响；
- 删除一条记忆后，很难确认它是否仍存在于摘要、索引或派生数据中。

Cockpit Bots 更倾向于显式授权。普通工作默认只读。只有用户明确要求记住、更新、纠正或忘记时，Bot 才改变长期状态。什么可以记录、写到哪里以及如何处理旧内容，则由 Bot 自己的规则决定。

这牺牲了一部分“什么都自动替你记住”的便利，却换来了更清楚的控制边界：

- 长期状态是什么，可以直接打开查看；
- 为什么会被记录，可以保留来源；
- 写错了什么，可以直接修正；
- 不想保留什么，可以明确删除；
- 什么时候发生变化，可以通过 diff 或版本历史追踪。

## 文件系统就是接口

普通文件带来了一些经常被复杂记忆系统低估的能力。

- **天然可读。** 用户不需要专用管理后台，就能检查 Bot 知道什么。
- **天然可编辑。** 记忆不是只能通过模型间接修改的黑箱状态。
- **天然可比较。** Git 和文件 diff 可以准确展示某次任务改变了什么。
- **天然可迁移。** 复制一个目录，就能移动或备份 Bot 的身份和上下文。
- **天然跨模型。** 内容不是某个供应商专用的隐藏状态。
- **天然可扩展。** 未来可以在文件之上增加全文搜索、Embedding、知识图谱或其他索引，但这些都可以是可选加速层，而不是记忆存在的前提。

即使所有附加服务消失，目录中的内容仍然完整、可读、可恢复。

## 极简，但不放任增长

目录式记忆最直接的担心是：它只会越积越多、越来越旧，最终让探索变得又慢又不可靠。

Cockpit 的答案不是在目录之上再加一层检索服务，而是让 Bot 复盘自己：

\`\`\`text
@product 复盘一下
\`\`\`

复盘是唯一一次通读整个目录的时候。它会检查：

- **过期**：超过有效期，或确认日期已经很旧的数字、版本、状态；
- **矛盾**：先分类——是时间上的更替、适用范围不同、权威等级不同，还是只能由你裁决的真正冲突；
- 悬空的承诺、缺失的来源、重复的内容、失效的 Skill；
- **孤立结论**：依据已被替代或存疑，自己却仍标着 active；
- **规模过大**：目录已经超出 \`BOT.md\` 的读取规则。

规模问题同样用文件解决：把过大的文件按主题拆开，为每个拆分后的目录补一份每条一行的 \`INDEX.md\`，再改写 \`BOT.md\` 的读取规则——先读索引，按需打开具体条目。没有预算计算，没有检索层，只是让信息架构随内容一起长大。

复盘结果以报告形式保存在 \`.reviews/\`，并返回一份编号清单；在你选定要应用的行之前，长期记忆不会改变。整理这件事也遵守同一条原则：模型提出，用户决定，文件记录。

剩下的才是真实的取舍：检索与写入的质量仍取决于模型的工具能力和指令遵循水平；而低延迟处理海量事件流，本就不是一个目录要解决的问题。即使将来需要，也可以在目录之上叠加缓存或搜索作为可重建的加速层，普通文件依然是权威来源。

关键是不要反过来：不应让某个向量数据库、私有 schema 或特定模型的隐藏状态成为 Bot 唯一的记忆载体。

## 不是 Memory Platform，而是 Memory Substrate

如果把 Cockpit Bots 当作一套自动学习、自动整理、自动召回的完整 Memory Platform，它会显得缺少许多复杂功能。但这并不是它试图成为的东西。

它提供的是更基础的一层：

> 一种让长期上下文脱离单次会话和单一模型，以普通目录形式持续存在的机制。

Cockpit 负责让 Bot 能被找到、召唤和交给不同会话。\`BOT.md\` 负责描述这片上下文如何使用。用户负责定义适合自己的结构。模型负责像探索代码库一样寻找、理解和更新相关内容。

这套设计的价值不在于替用户决定如何记忆，而在于确保用户定义的记忆始终属于用户，并且可以被任何合适的模型继续使用。

最理想的长期记忆，也许并不是一个越来越复杂、越来越不可见的智能数据库。它也可以只是一个目录。

一个用户看得懂、模型找得到、会话带得走、未来仍然能打开的目录。

[查看 Bots 文档](/zh/docs/agent/bots/)，或阅读上一篇：[Bot：一个可以随时 @ 进任务的持久化子代理](/zh/blog/persistent-subagents-you-can-tag/)。

---

**立即尝试：** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },
  {
    slug: 'persistent-subagents-you-can-tag',
    date: '2026-09-18',
    keywords: [
      'persistent AI agent',
      'persistent subagent',
      'file based agent memory',
      'local AI agent',
      'agent memory Markdown',
      'AI bot directory',
      'OpenCockpit Bots',
      '持久化子代理',
      '本地 Agent 记忆',
      'Bot 长期上下文',
      '文件原生 Agent',
    ],
    content: {
      en: {
        title: 'Bots: Persistent Subagents You Can Tag into Any Task',
        description:
          'Create file-native subagents with durable, reviewable context, then tag them into any OpenCockpit task with @name.',
        readingTime: '4 min read',
        body: `A subagent is useful because it gets work out of your main thread. It is also forgetful: the next one usually starts from a blank page.

OpenCockpit Bots keep the first property and change the second. A Bot is a persistent, file-native subagent. It has a name, an identity, explicit long-term context, and the Skills it knows how to use. Tag it with \`@name\`; it works in a separate session and brings the result back with a link to the full transcript.

## A Bot is a directory

There is no hosted agent object and no hidden memory database. A Bot is an ordinary directory:

\`\`\`text
product/
├── BOT.md
├── identity/
├── relationships/
├── memory/
├── projects/
├── commitments/
└── evidence/
\`\`\`

\`BOT.md\` says who the Bot is, which files it should read, which Skills it has, and where updates belong. The other files are plain Markdown. You can read them, edit them, put them in Git, move them to another machine, or stop using Cockpit without exporting anything.

Create one with the built-in Skill:

\`\`\`text
/bot create a product Bot that maintains roadmap decisions and commitments
\`\`\`

After reviewing the proposed name and directory, register it from the Bots panel or directly from its \`BOT.md\`.

## Tag the specialist, not another blank agent

\`\`\`text
@product summarize what changed in the roadmap this week
\`\`\`

The current agent turns the conversation into a self-contained brief, starts a separate session in the current project, and hands that session the shared Bot contract plus the Bot's \`BOT.md\` path. The child reads only the context it needs, does the work, and reports back. The main chat gets the conclusion and a link; the child session keeps the complete transcript and can be continued directly.

Tag several Bots in one message and OpenCockpit starts their sessions before waiting:

\`\`\`text
@product summarize the roadmap changes

@finance check the Q3 budget against them
\`\`\`

This is why the object is called a **Bot**, while \`@name\` is the action: you tag a persistent specialist into a task.

## Memory is deliberate

The easiest memory system to demo is one that records everything. It is also the fastest way to fill an agent with guesses, stale facts, copied secrets, and accidental instructions.

Bots default to read-only. They update long-term context only when you explicitly ask them to remember, update, correct, or forget something:

\`\`\`text
@product remember that mobile onboarding moved to Q4
\`\`\`

Otherwise the Bot can propose a short “Could be recorded” list for approval. Recorded entries carry a confirmation date, source, authority, and status. A user-confirmed fact outranks an inference; replaced conclusions are marked as superseded instead of disappearing; credentials are skipped entirely.

Writes use a cooperative lock, while reads remain concurrent. Every turn lists the Bot files it read and changed, so “what was this answer based on?” has a concrete answer.

## Skills stay separate from identity

A Skill is a reusable way to do something. A Bot is the persistent specialist deciding when that way applies. Attach one without copying it:

\`\`\`text
@product attach /absolute/path/to/SKILL.md
\`\`\`

That adds a reference to the Bot's Skills table. It does not duplicate files, credentials, or software, and it does not create a global slash command.

## Long-term context needs maintenance

Memory ages. Commitments finish, numbers expire, and two correct statements from different months can become a contradiction. Ask a Bot to inspect itself:

\`\`\`text
@product review its memory
\`\`\`

The Bot produces a numbered review covering stale entries, contradictions, dangling commitments, missing sources, broken Skills, duplicated information, and context that has grown too large. It saves the report under \`.reviews/\` so you can choose findings in the child session or resume from any chat. Nothing in long-term memory changes until you select rows to apply.

## Persistent does not mean autonomous

A Bot does not wake itself up, silently absorb every chat, or run as a background service. If a commitment genuinely needs proactive follow-up, a Cockpit Scheduled Task can send the same \`@name\` prompt on a schedule. The normal case stays simpler: summon the right specialist when you need it, and keep its memory explicit.

[Read the Bots documentation](/en/docs/agent/bots/) or update OpenCockpit and type \`/bot\` to create your first one.

---

**Try it:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: 'Bot：一个可以随时 @ 进任务的持久化子代理',
        description:
          '用普通文件创建拥有长期、可审阅上下文的子代理，再用 @name 把它叫进任意 OpenCockpit 任务。',
        readingTime: '阅读约 4 分钟',
        body: `子代理好用，因为它把一块工作从主线对话里拿走了。子代理也容易忘：下一个通常又从白纸开始。

OpenCockpit Bot 保留了前一个特点，改变了后一个。Bot 是持久化、文件原生的子代理：有名字、身份、显式长期上下文，也知道自己会用哪些 Skills。用 \`@name\` 把它叫进任务；它在独立会话中工作，再带着结论和完整会话链接回来。

## Bot 就是一个目录

没有托管在云上的 Agent 对象，也没有藏起来的记忆数据库。Bot 是一个普通目录：

\`\`\`text
product/
├── BOT.md
├── identity/
├── relationships/
├── memory/
├── projects/
├── commitments/
└── evidence/
\`\`\`

\`BOT.md\` 说明它是谁、先读哪些文件、会哪些 Skills、各类更新该写去哪里。其他内容都是普通 Markdown。你可以读、改、放进 Git、搬到另一台机器，也可以不再使用 Cockpit，无须先导出任何东西。

用内置 Skill 创建：

\`\`\`text
/bot 创建一个维护路线图决策与承诺的 product Bot
\`\`\`

确认用途、名称和目录后，从 Bots 面板注册，或直接打开它的 \`BOT.md\` 添加。

## 叫进一个专家，不是再开一张白纸

\`\`\`text
@product 总结本周路线图变化
\`\`\`

当前 Agent 先把对话整理成一份自包含 brief，再以当前项目为工作目录创建独立会话，把通用 Bot 契约和该 Bot 的 \`BOT.md\` 路径交给子会话。子会话只读这次需要的上下文，完成工作后回报。主会话拿到结论和链接；完整过程留在子会话里，可以随时打开续问。

一条消息可以同时叫多个 Bot，OpenCockpit 会先启动各自的会话再等待：

\`\`\`text
@product 总结路线图变化

@finance 对照这些变化核对 Q3 预算
\`\`\`

所以对象叫 **Bot**，\`@name\` 才是动作：你把一个持久专家 tag 进当前任务。

## 记忆必须是有意的

最容易演示的记忆系统是“什么都记”。它也最容易让 Agent 堆满猜测、过期事实、被复制进来的密钥和偶然出现的指令。

Bot 默认只读。只有你明确要求记住、更新、纠正或删除时，它才更新长期上下文：

\`\`\`text
@product 记住：移动端 onboarding 已经移到 Q4
\`\`\`

否则 Bot 只会列一份 “Could be recorded”，留给你确认。每条记录带确认日期、来源、权威等级和状态；用户确认的事实高于模型推断；被替代的结论会标成 superseded，而不是悄悄消失；凭证则完全跳过。

写入使用协作锁，读取仍可以并发。每轮都会列出读过和改过的 Bot 文件，因此“这个回答依据了什么”有可核对的答案。

## Skill 与身份分开

Skill 是一种可复用的做法；Bot 是一个持久专家，知道这种做法何时该用。不复制文件，直接关联：

\`\`\`text
@product 装上 /absolute/path/to/SKILL.md
\`\`\`

它只在 Bot 的 Skills 表增加一行，不复制文件、凭证或软件，也不会创建全局斜杠命令。

## 长期上下文也需要保养

记忆会老化：承诺会完成，数字会过期，两句在不同月份都正确的话后来可能变成矛盾。让 Bot 检查自己：

\`\`\`text
@product 复盘一下
\`\`\`

Bot 会输出编号清单，检查过期条目、矛盾、悬空承诺、缺少来源、失效 Skill、重复内容和规模过大的上下文。报告保存在 \`.reviews/\`，你可以在子会话里选行，也可以从任何聊天恢复。选定要应用的行之前，长期记忆不会改变。

## 持久不等于自主运行

Bot 不会自己醒来，不会悄悄吸收每段聊天，也不是后台服务。某项承诺确实需要主动追踪时，可以让 Cockpit 定时任务按计划发送同样的 \`@name\` 提示词。更常见的情况保持简单：需要时叫来正确的专家，它的记忆始终显式可见。

[查看 Bots 文档](/zh/docs/agent/bots/)，或更新 OpenCockpit 后输入 \`/bot\` 创建第一个 Bot。

---

**立即尝试：** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },
  {
    slug: 'find-and-delegate-sessions',
    date: '2026-09-14',
    keywords: [
      'find past Claude Code session',
      'search AI chat history',
      'cross-project session search',
      'delegate task to another agent',
      'Claude Code subagent alternative',
      'multi-engine agent delegation',
      'Codex delegation',
      '会话搜索',
      '找回历史会话',
      '子任务委派',
      '跨引擎',
      'Claude Code GUI',
      'OpenCockpit',
      'Cockpit',
    ],
    content: {
      en: {
        title: 'Find and Delegate AI Sessions with /ss and /dl',
        description:
          'Find past AI sessions across projects with /ss. Delegate a task to a new session with /dl, then check its progress in OpenCockpit.',
        readingTime: '3 min read',
        body: `Two things get harder the longer you use OpenCockpit. You remember *talking* about something — "that session where we worked out the CSRF issue" — but not which project, which engine, or which week. And halfway through a task you spot work that belongs somewhere else — a flaky test in another repo, a job you'd rather give to Codex — and the only option is to stop, open a tab, switch directory and engine, re-explain the context, and remember to check back.

This release adds one command for each.

## \`/ss\` — find a session from one sentence

\`\`\`text
/ss the session where we worked out CSRF on the local API
\`\`\`

The agent doesn't search your sentence verbatim. It expands it into the keywords that would literally appear in that conversation — both languages for technical topics (\`跨站\` / \`CSRF\`), synonyms, the words the assistant would have used — searches, reads the snippets, and replies with 1–3 candidates:

\`\`\`markdown
1. **Local API request checks** — cockpit · claude · 2026-09-10
   Walks through the CSRF issue you described, and settles on a fix
   [Open session](/project?cwd=…&sessionId=…)
\`\`\`

Click the link and Cockpit switches to that project and opens the session in the Agent panel. The search covers every session Cockpit can read: Claude, Codex, DeepSeek, Kimi, GLM and Ollama, in every project, with no date cutoff.

## \`/dl\` — hand it off, don't wait

\`\`\`text
/dl have codex fix the flaky date test in the api project
\`\`\`

The agent writes a self-contained brief — the child sees none of your conversation — starts a new session in that directory on that engine, and gets a receipt back immediately:

\`\`\`markdown
Delegated **Fix flaky date test** to codex in \`/Users/me/work/api\` — [open session](/project?cwd=…&sessionId=…)
\`\`\`

Then you carry on. The child runs like any other session and shows up unread in your recent sessions when it finishes; open the link any time to watch it or take over. Later:

\`\`\`text
how did that delegated task go?
\`\`\`

The agent finds the receipt — in this conversation, or through \`/ss\` from any other — checks the child, and reports \`running\`, \`done\`, \`failed\` or \`incomplete\` (stopped or interrupted; open it and continue), with a summary of its last reply.

## Where it fits next to subagents

For parallel work inside one repository, Claude's own subagents are still the right tool — and \`/dl\` tells the agent so. \`/dl\` is for everything else: another directory, another engine, and a session you can open and take over rather than a read-only transcript.

## Try it

Update Cockpit, then type \`/ss\` with whatever you remember about an old conversation — or \`/dl\` something you'd rather not wait for. Details in the [Skills](/en/docs/agent/skills/) docs.

---

**Try it:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: '/ss 一句话找回会话,/dl 派出去不用等',
        description:
          'OpenCockpit 新增两个内置命令。`/ss` 用一句话在所有项目、所有引擎、全部历史里找回过去的会话;`/dl` 把子任务派给任意目录、任意引擎的新会话,立即返回,之后再问进展。',
        readingTime: '阅读约 3 分钟',
        body: `OpenCockpit 用得越久,有两件事越麻烦。你记得*聊过*某件事 ——「那次把 CSRF 问题捋清楚的会话」—— 但不记得是哪个项目、哪个引擎、哪一周。另一件是做到一半发现有活儿该在别处干 —— 另一个仓库里时好时坏的测试,或者更想交给 Codex 的任务 —— 只能停下来,开个 tab,切目录切引擎,把背景重讲一遍,还得记着回头去看。

这个版本给两件事各加了一个命令。

## \`/ss\` —— 一句话找回会话

\`\`\`text
/ss 上次把本地接口 CSRF 问题捋清楚的那个会话
\`\`\`

agent 不会拿这句话原样去搜。它先展开成那次对话里会真实出现的关键词 —— 技术话题中英文都写(\`跨站\` / \`CSRF\`),再加同义词和 AI 回答时会用的说法 —— 然后搜索、读命中片段、自己判断,给出 1–3 个候选:

\`\`\`markdown
1. **本地接口请求校验** — cockpit · claude · 2026-09-10
   正是你说的那次 CSRF 讨论,最后定下了修法
   [Open session](/project?cwd=…&sessionId=…)
\`\`\`

点链接,Cockpit 切到对应项目,在 Agent 面板打开那个会话。搜索范围是 Cockpit 能读到的全部会话:Claude、Codex、DeepSeek、Kimi、GLM、Ollama,所有项目,不限日期。

## \`/dl\` —— 派出去,不用等

\`\`\`text
/dl 让 codex 去 api 项目里把那个时好时坏的日期测试修掉
\`\`\`

agent 会写一份自包含的任务说明 —— 子会话看不到你们的对话 —— 在那个目录用那个引擎新开一个会话,并立即拿到回执:

\`\`\`markdown
Delegated **修复日期测试** to codex in \`/Users/me/work/api\` — [open session](/project?cwd=…&sessionId=…)
\`\`\`

然后你们接着聊。子会话像普通会话一样运行,结束后在最近会话里显示为未读;想看过程或中途接手,随时点链接。过一阵再问:

\`\`\`text
刚才委派的那个任务怎么样了?
\`\`\`

agent 找到回执 —— 在当前对话里,或者在别的会话里通过 \`/ss\` 搜到 —— 查询子会话,告诉你是 \`running\`、\`done\`、\`failed\` 还是 \`incomplete\`(被停止或中断,点进去继续即可),并总结它的最后一条回复。

## 和 subagent 怎么分工

同一个仓库里的并行分工,Claude 自带的 subagent 仍然是最合适的工具,\`/dl\` 的说明里也会这样提示 agent。\`/dl\` 负责剩下的:别的目录、别的引擎,以及一个你能打开、能接手的会话,而不是一份只读记录。

## 试一下

更新 Cockpit,输入 \`/ss\` 加一句你还记得的描述;或者用 \`/dl\` 把手边不想等的事派出去。细节见 [Skills](/zh/docs/agent/skills/) 文档。

---

**试一下:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },
  {
    slug: 'html-apps-that-run-bash',
    date: '2026-07-18',
    keywords: [
      'AI generated HTML app',
      'HTML app run bash',
      'interactive HTML preview',
      'cockpit.bash SDK',
      'HTML tool from prompt',
      'local dashboard from AI',
      'CORS-free HTML fetch',
      'slash command html',
      'AI 生成 HTML 应用',
      'HTML 应用',
      '网页调用 bash',
      '本地看板',
      'Claude Code GUI',
      'OpenCockpit',
      'Cockpit',
    ],
    content: {
      en: {
        title: 'Build HTML Apps That Run Bash',
        description:
          'Generate HTML apps with /html in OpenCockpit. Use the injected SDK to run shell commands, read files and save reusable tools in an HTML panel.',
        readingTime: '5 min read',
        body: `You ask an agent for "a small dashboard for my repo's stars," it writes a tidy \`.html\`, you open the preview — and it's dead. The page tries to \`fetch()\` an API and the same-origin sandbox kills it with a CORS error. A rendered HTML preview has always been a picture behind glass: it can lay out, but it can't *do* anything.

This release breaks the glass. Cockpit now injects a \`window.cockpit\` SDK into the preview — **essentially the Bash tool, exposed to the page**. A button can \`curl\` for data, read and write files, tail a log. A static file becomes a real mini-app with a backend.

## \`/html\` — generate one from a prompt

It's a built-in slash command, same menu as \`/qa\` and \`/fx\`:

\`\`\`text
/html a dashboard for the Surething-io/cockpit repo — stars, forks, recent commits
\`\`\`

Cockpit attaches a built-in prompt that teaches the model to build a **small app** and — crucially — to fetch data through \`cockpit.bash('curl ...')\` instead of a direct \`fetch()\` that CORS would block. The AI uses the \`Write\` tool, and you get something you can open and click.

By default you get a **React** app (zero-build — React, Babel and the theme are hosted locally by Cockpit, so it runs offline), styled to match Cockpit with light/dark. A trivial one-view page falls back to a single inline HTML file. In the chat preview you can flip between the rendered app and its **source** — a sidebar lists the entry file plus every sibling it pulls in (\`app.jsx\`, \`api.mjs\`, images…).

## The page can run bash

The SDK is ready on load — no library to import:

| API | What it does |
|---|---|
| \`cockpit.cwd\` | directory of the current HTML file; relative commands run here |
| \`cockpit.bash(command, opts?)\` | run one bash command, mirroring the Bash tool |

Foreground for short commands, background for long ones:

\`\`\`js
// foreground — await the full result
const { stdout, exitCode } = await cockpit.bash("curl -s https://api.github.com/repos/Surething-io/cockpit");
const repo = JSON.parse(stdout);

// background — stream a live log, kill() when done
const h = cockpit.bash("tail -f ./build.log", {
  background: true,
  onOutput: c => box.textContent += c,
});
\`\`\`

For anything more involved, the AI writes the backend as a **script file** next to the page and calls it CGI-style — \`cockpit.bash("node ./api.js")\`. HTML is the frontend, the script is the handler.

## Bookmark it, reopen it, \`/name\` it

A page earns a spot in the **HTML panel** by declaring a few \`<head>\` meta tags (\`cockpit-name\`, \`description\`, \`cockpit-icon\`). After that:

- **Bookmark** it from the chat preview, the Explorer file browser, or open it straight into a Console browser bubble — the two buttons are everywhere a \`.html\` shows up.
- The **HTML panel** (opened from the first icon in the sidebar Apps dock) is a card grid of everything you've saved — click to preview, open in a Console bubble, delete, or copy the path.
- Type \`/\` in the Console input bar and your apps appear ahead of custom commands. \`/repo-dashboard\` opens it in a bubble. The short name is the \`cockpit-name\` from the meta head.

The registry is just \`~/.cockpit/html.json\` holding absolute paths — the same mechanism as \`skills.json\`. The HTML files stay in your project; the panel is a bookmark folder.

## The honest part

\`cockpit.bash\` is a **real command-execution channel** — equivalent to a shell on your machine. So be careful: **previewing a local \`.html\` in Cockpit executes its scripts with your privileges**, exactly as risky as running the file yourself — don't preview or bookmark an \`.html\` you don't trust. It obeys Cockpit's startup [token gate](/en/blog/cockpit-access-token/): open on localhost, validated when you set \`--token\`.

## Try it

Update Cockpit, open a chat, and type \`/html\` with something you'd like to see. Click the preview, then bookmark it. Details in the [HTML Apps](/en/docs/agent/html-apps/) docs.

---

**Try it:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: '一句话生成能跑真 bash 的 HTML 应用',
        description:
          '普通 HTML 预览是静态的 —— 同源沙箱会拦掉它拉真实数据。OpenCockpit 现在往预览里注入了一个 `window.cockpit` SDK,于是 `/html` 生成的 HTML 应用,按钮就能 `curl`、读写文件、跑脚本。把它收藏进 HTML 面板,随时再打开。',
        readingTime: '阅读约 5 分钟',
        body: `你让 agent 做「一个看仓库 star 数的小看板」,它写了一个清清爽爽的 \`.html\`,你打开预览 —— 死的。页面想 \`fetch()\` 一个 API,同源沙箱一个 CORS 错误把它掐了。渲染出来的 HTML 预览一直是隔着玻璃的画:能排版,但什么也*做不了*。

这个版本把玻璃打碎了。Cockpit 现在往预览里注入一个 \`window.cockpit\` SDK —— **本质就是 Bash 工具暴露给页面**。按钮能 \`curl\` 拉数据、读写文件、tail 日志。一份静态文件变成了有后端的真正 HTML 应用。

## \`/html\` —— 一句话生成一个

这是个内置斜杠命令,和 \`/qa\`、\`/fx\` 同一个菜单:

\`\`\`text
/html 做一个 Surething-io/cockpit 仓库的看板 —— star、fork、最近提交
\`\`\`

Cockpit 会挂上一份内置 prompt,教模型做一个 **HTML 应用**,并且 —— 关键 —— 通过 \`cockpit.bash('curl ...')\` 取数据,而不是会被 CORS 拦掉的直连 \`fetch()\`。AI 用 \`Write\` 工具产出文件,你打开就能点。

默认你拿到的是一个 **React** 应用(零构建 —— React、Babel、主题都由 Cockpit 本地托管,离线可用),自动套用 Cockpit 主题、带亮/暗。极简单的单视图页则退回一份内联 HTML。聊天预览里可在**渲染**和**原文**之间切换 —— 侧边栏会列出入口文件和它牵出的每个同级文件(\`app.jsx\`、\`api.mjs\`、图片…)。

## 页面里能跑 bash

SDK 在页面加载时就绪,不用引任何库:

| API | 作用 |
|---|---|
| \`cockpit.cwd\` | 当前 HTML 文件所在目录;相对命令默认在这里执行 |
| \`cockpit.bash(command, opts?)\` | 执行一条 bash 命令,对齐 Bash 工具 |

短命令用前台,长/实时命令用后台:

\`\`\`js
// 前台 —— await 拿到完整结果
const { stdout, exitCode } = await cockpit.bash("curl -s https://api.github.com/repos/Surething-io/cockpit");
const repo = JSON.parse(stdout);

// 后台 —— 流式看日志,用完 kill()
const h = cockpit.bash("tail -f ./build.log", {
  background: true,
  onOutput: c => box.textContent += c,
});
\`\`\`

逻辑再复杂一点,AI 会把后端写成页面同目录的一个**脚本文件**,CGI 式地调它 —— \`cockpit.bash("node ./api.js")\`。HTML 管前端,脚本当处理器。

## 收藏、再打开、\`/名字\` 唤起

页面只要在 \`<head>\` 里声明几个 meta(\`cockpit-name\`、\`description\`、\`cockpit-icon\`),就能进 **HTML 面板**。之后:

- 从聊天预览、Explorer 文件浏览器**收藏**它,或直接在 Console 浏览器气泡里打开 —— 只要有 \`.html\` 露面,那两个按钮就在。
- **HTML 面板**(从侧边栏应用区域的第一个图标打开)是你存过的所有 HTML 应用的卡片墙 —— 点卡片预览,也可以在 Console 气泡打开、删除或复制路径。
- 在 Console 输入栏打 \`/\`,你的 HTML 应用排在自定义命令前面。\`/repo-dashboard\` 就在气泡里打开它。这个短名就是 meta 头里的 \`cockpit-name\`。

登记表就是 \`~/.cockpit/html.json\`,只存绝对路径 —— 和 \`skills.json\` 一样的机制。HTML 文件留在你项目里;面板只是个书签夹。

## 实话实说

\`cockpit.bash\` 是一条**真实的命令执行通道** —— 等同于在你机器上开一个 shell。所以要当心:**在 Cockpit 里预览一个本地 \`.html\`,会以你的权限执行它的脚本**,风险和你亲手运行这个文件完全一样 —— 不信任的 \`.html\` 就别去预览、也别收藏。它服从 Cockpit 启动时的[令牌门](/zh/blog/cockpit-access-token/):本机开放,设了 \`--token\` 就校验。

## 试一下

更新 Cockpit,打开一个聊天,\`/html\` 后面写点你想看的东西。点开预览,然后收藏它。细节见 [HTML 应用](/zh/docs/agent/html-apps/)文档。

---

**试试看:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },
  {
    slug: 'review-ai-changes-tool-by-tool',
    date: '2026-07-09',
    keywords: [
      'review AI code changes',
      'AI coding diff viewer',
      'Claude Code file changes',
      'per tool call snapshot',
      'AI agent change tracking',
      'what did the AI change',
      'AI code review workflow',
      'shadow git snapshot',
      'AI 修改代码 review',
      '工具调用快照',
      'AI 改了什么',
      'OpenCockpit',
    ],
    content: {
      en: {
        title: 'Review AI Changes One Tool Call at a Time',
        description:
          'Inspect the actual file changes from each Edit, Write, Bash or MCP call with OpenCockpit snapshots and per-call diffs.',
        readingTime: '5 min read',
        body: `
An agent turn ends. The reply says "done — refactored the module, updated the callers, fixed the test." Fifteen tool calls scrolled past. Now the only question that matters: **what exactly changed?**

Until now the honest answer was "sort of". You could expand each tool call and read its parameters, but that had real blind spots:

- **Bash was invisible.** A \`sed -i\`, a code generator, an \`npm install\` that patches files — the tool call showed you the *command*, never the resulting file changes. Same for MCP tools and Task subagents.
- **Parameters aren't disk truth.** When the AI edits the same file three times, replaying \`old_string → new_string\` in your head drifts from what actually landed.
- **\`git status\` shows the sum, not the story.** By the end of a long turn you get one big flattened diff — the *order* in which the change was built, which call introduced which line, is gone.

## One commit per tool call

Cockpit now takes a **project snapshot after every file-touching tool call**, on every engine — Claude, Codex, DeepSeek, Kimi, Ollama. Click the file-diff icon on any reply and you get a git-history-style timeline:

- **Left: the sequence.** One entry per tool call, in execution order — \`[Write] nebula/codes.py\`, \`[Bash] npm run build\`, each with a short hash and timestamp.
- **Right: the real diff.** File tree with per-file +/− counts, split diff view, compact mode that folds unchanged stretches. What you see is what the disk said — including everything Bash did.

This is the difference between "trust me, I changed it" and being able to **replay the edit narrative**: first it wrote the new module, then it rewired the callers one by one, then the test. When call #7 is where things went sideways, you see it — isolated, not smeared into a 400-line final diff.

## Why this cuts review cost

Reviewing AI output is quickly becoming the actual job. Two things make it expensive: **volume** (agents produce a lot of diff per prompt) and **loss of intent** (a flattened diff hides *why* each hunk exists). Per-call snapshots attack the second one:

- Each step is small and self-explaining — a tool call has a stated purpose, and its diff either matches it or it doesn't.
- The sequence carries intent. "Why is this import here?" is answered by *which step* added it.
- Changes nobody claimed stand out: files modified in the same window by another session or an external process get a **concurrent-change marker** instead of silently blending in.

You still review the final state in the Explorer's Changes tab before committing. But when something looks off, you now have the intermediate frames, not just the last one.

## Zero setup, fully local, self-cleaning

There's nothing to configure:

- Snapshots live in a **shadow git repo** under \`~/.cockpit/snapshots/\` — your project's own \`.git\` is never touched, and your \`.gitignore\` is honored (plus built-in excludes for \`.env*\`, keys, and other secrets).
- Everything stays **on your machine**. Nothing is uploaded anywhere.
- History keeps itself small: **7 days** of snapshots per project, whole repos evicted after 30 idle days, oversized files skipped. A 13 GB monorepo costs about 74 MB of shadow storage; each subsequent snapshot is ~80 ms.
- Old sessions work too — reopen last week's conversation and the diffs are still there (within the retention window).

Update to the latest release, ask your agent to change something, and click the file-diff icon on the reply. Details in the [docs](/en/docs/agent/snapshots/).
`,
      },
      zh: {
        title: '逐个工具调用，看清 AI 到底改了什么',
        description:
          'OpenCockpit 现在会在每次碰文件的工具调用后给项目打快照。打开任意一条回复，像读 git 历史一样读它的变更：一次 Edit、Write、Bash 或 MCP 调用一个条目，每条都是真实的磁盘 diff——按执行顺序排列。',
        readingTime: '5 分钟',
        body: `
一轮 Agent 对话结束，回复说"完成了——重构了模块、更新了调用方、修好了测试"。十五个工具调用刷过去了。现在只剩一个真正要紧的问题：**到底改了什么？**

在此之前，诚实的回答是"大概知道"。你可以逐个展开工具调用去读参数，但有几个真实存在的盲区：

- **Bash 是隐形的。** 一条 \`sed -i\`、一个代码生成器、一次会改文件的 \`npm install\`——工具调用只给你看*命令*，从不给你看它造成的文件变更。MCP 工具和 Task 子代理同理。
- **参数不等于磁盘真相。** AI 对同一个文件连改三次时，在脑子里回放 \`old_string → new_string\` 的结果，和磁盘上实际落下的内容会有出入。
- **\`git status\` 给的是总和，不是过程。** 一轮长对话结束，你拿到的是一坨摊平的大 diff——这个改动是按什么*顺序*搭出来的、哪一步引入了哪一行，全都没了。

## 一次工具调用 = 一个 commit

Cockpit 现在会在**每次碰文件的工具调用之后**给项目拍快照，所有引擎都覆盖——Claude、Codex、DeepSeek、Kimi、Ollama。点开任意回复上的文件变更图标，你会得到一条 git 历史式的时间线：

- **左边：时序。** 一次调用一个条目，按执行顺序排列——\`[Write] nebula/codes.py\`、\`[Bash] npm run build\`，各带短 hash 和时间。
- **右边：真实 diff。** 带每文件 +/− 行数的文件树、左右分栏对比、可折叠未变更段的精简模式。你看到的就是磁盘上发生的——包括 Bash 干的一切。

这是"相信我，我改好了"和**能够回放编辑过程**之间的差别：先写了新模块，然后逐个改接入方，最后动测试。如果是第 7 步开始跑偏，你能直接看到那一步——它是独立的，而不是被搅进 400 行的最终 diff 里。

## 为什么这能降低 review 成本

审 AI 的产出正在变成真正的工作量。贵在两点：**体量**（一句话能产出一大坨 diff）和**意图丢失**（摊平的 diff 藏起了每一块改动*为什么*存在）。按调用切分的快照攻的是第二点：

- 每一步都小而自明——工具调用有明确的目的，它的 diff 要么对得上，要么对不上。
- 时序本身携带意图。"这个 import 是哪来的？"看它出现在*哪一步*就有答案。
- 没人认领的改动会现形：同一时间窗内另一个会话或外部进程改的文件，会带上**同期变更标记**，而不是悄悄混进来。

提交前你仍然会在 Explorer 的变更 tab 里审最终状态。但当哪里看着不对时，你手里现在有中间帧，而不只有最后一帧。

## 零配置、全本地、自动清理

没有任何需要配置的东西：

- 快照存在 \`~/.cockpit/snapshots/\` 下的**影子 git 仓库**里——项目自己的 \`.git\` 完全不被触碰，\`.gitignore\` 照常生效（另有 \`.env*\`、密钥等敏感文件的内置排除）。
- 一切都在**你自己的机器上**，不上传任何东西。
- 历史会自己保持苗条：每个项目保留 **7 天**，30 天不活跃整仓移除，超大文件跳过。13 GB 的 monorepo 实测只占约 74 MB 影子存储；之后每次快照约 80 ms。
- 历史会话同样可用——重新打开上周的对话，diff 还在（保留期内）。

升级到最新版本，让 Agent 改点什么，然后点回复上的文件变更图标。细节见[文档](/zh/docs/agent/snapshots/)。
`,
      },
    },
  },
  {
    slug: 'self-host-claude-code-gui-for-your-team',
    date: '2026-07-02',
    keywords: [
      'self-host Claude Code',
      'Claude Code for teams',
      'shared dev box AI coding',
      'team Claude Code GUI',
      'self-hosted AI coding server',
      'Claude Code remote access',
      'run Claude Code on a server',
      'Tailscale Claude Code',
      'AI coding shared server',
      '自托管 Claude Code',
      '共享开发机',
      '团队 AI 编程',
      'Claude Code GUI',
      'OpenCockpit',
    ],
    content: {
      en: {
        title: 'Self-Host a Claude Code GUI for Your Team',
        description:
          'Run OpenCockpit on a shared dev box. Give teammates browser access to Claude Code, with separate projects and Git worktrees.',
        readingTime: '6 min read',
        body: `Most Claude Code GUIs are desktop apps: one install per laptop, one config per person, one machine per seat. OpenCockpit is a **web client–server** — which unlocks a deployment model the desktop apps can't do:

> Install it **once** on the machine where the code lives. Every teammate opens a browser and gets a seat.

No per-laptop installs. No "works on my machine". One box, the whole team flying together.

## Why a shared dev box?

- **The code already lives there.** Many teams keep a beefy dev box (or cloud VM) where repos are cloned, databases run, and services are wired up. Cockpit sits next to the code instead of dragging the code to each laptop.
- **One environment, zero drift.** Node version, \`claude\` CLI login, Ollama models, DB credentials — configured once, shared by everyone.
- **Shared horsepower.** A single GPU box serves everyone's local **Ollama** tabs. Laptops stay cool.
- **Any device is a seat.** A browser is the only client — that includes your phone on the same VPN.

## Setup (5 minutes)

On the dev box:

\`\`\`bash
# 1. Install (Node ≥ 20)
npm install -g @surething/cockpit

# 2. Expose on the network + require a token for remote clients
COCKPIT_HOST=0.0.0.0 cockpit --token your-shared-secret
\`\`\`

That's it. Two knobs worth knowing:

| Knob | Meaning |
|---|---|
| \`COCKPIT_HOST\` | Defaults to \`127.0.0.1\` (local-only). Set \`0.0.0.0\` to accept LAN / VPN clients. |
| \`--token\` (or \`COCKPIT_TOKEN\`) | Remote clients must present this token; **loopback stays exempt**, so local CLI use keeps working untouched. See [the access-token post](/en/blog/cockpit-access-token/). |

To keep it running, wrap it in your process manager of choice — a minimal systemd unit:

\`\`\`ini
[Unit]
Description=OpenCockpit
After=network.target

[Service]
User=dev
Environment=COCKPIT_HOST=0.0.0.0
Environment=COCKPIT_TOKEN=your-shared-secret
ExecStart=/usr/local/bin/cockpit
Restart=on-failure

[Install]
WantedBy=multi-user.target
\`\`\`

## Give every teammate a seat

Each dev opens:

\`\`\`
http://<dev-box>:3457/?token=your-shared-secret
\`\`\`

Cockpit sets a cookie and cleans the URL — the token doesn't linger in the address bar. From there, everyone:

- opens **their own project** as a tab (multi-project tabs are independent sessions),
- or, when two people work the **same repo**, each takes a **git worktree** — Cockpit manages worktrees from the Explorer, so parallel agents never trample each other's checkout,
- picks their engine per tab: Claude by default, or **Codex / DeepSeek / Kimi / Ollama** with their own key.

Every seat gets the full cockpit: agent chat, xterm.js terminal, Chrome control, PostgreSQL / MySQL / Redis bubbles, code review pages, scheduled tasks.

## The honest part: what this is and isn't

OpenCockpit's multi-seat model is **trust-based**, like SSH access to a shared box:

- The token gates *entry*; it is **not per-user accounts**. Anyone with the token sees the same projects and sessions.
- Treat it like you treat shell access: fine for a team that already shares the dev box, wrong for strangers.
- Keep it on a **LAN or VPN** (Tailscale / WireGuard work great). Don't put the port naked on the public internet.

If your team already SSHes into the same machine, Cockpit adds seats to that machine — it doesn't change your security model.

## FAQ

**Can two devs use it at the same time?**
Yes — that's the point. Each browser is an independent client; sessions run server-side in parallel.

**Same repo, two agents?**
Use git worktrees (managed in the Explorer). Each agent gets its own checkout; branches merge like normal git.

**Does it work over Tailscale / WireGuard?**
Yes. It's plain HTTP + WebSocket on one port (default \`3457\`, \`--port\` to change).

**Can I use it from a phone?**
Yes — the UI is a three-panel swipe layout designed for it. Same URL, same token.

**What about Ollama — fully offline?**
Install Ollama on the dev box and every seat can pick any pulled model. No keys, no cloud, air-gapped if you want.

---

One \`npm i -g\` on one box, and the whole team flies together. If you try it, [tell us how it went](https://github.com/Surething-io/cockpit/issues) — and if something in this guide drifts out of date, PRs welcome.`,
      },
      zh: {
        title: '把 Claude Code GUI 自托管到共享开发机：一台机器，全队一起飞',
        description:
          '用 OpenCockpit 把 Claude Code 自托管到一台共享开发机。队友通过浏览器进入各自项目或 worktree，共用环境与算力，无需逐台安装。',
        readingTime: '6 分钟',
        body: `大多数 Claude Code GUI 是桌面应用：一台笔记本装一份、一个人配一套、一台机器一个座位。OpenCockpit 是 **Web client-server** 架构 —— 这解锁了桌面应用做不到的部署方式：

> 在代码所在的机器上**装一次**。每个队友打开浏览器，就有一个席位。

不用每台笔记本都装，没有"在我机器上是好的"。一台机器，全队一起飞。

## 为什么是共享开发机？

- **代码本来就在那**。很多团队有一台配置好的开发机（或云上 VM）：仓库克隆好了、数据库跑着、服务连着。Cockpit 装在代码旁边，而不是把代码拖到每台笔记本上。
- **一套环境，零漂移**。Node 版本、\`claude\` CLI 登录、Ollama 模型、数据库凭据 —— 配一次，全队共享。
- **算力共享**。一台 GPU 机器承载所有人的 **Ollama** tab，笔记本保持凉快。
- **任何设备都是一个席位**。客户端只需要浏览器 —— 包括同一 VPN 里的手机。

## 部署（5 分钟）

在开发机上：

\`\`\`bash
# 1. 安装（Node ≥ 20）
npm install -g @surething/cockpit

# 2. 暴露到网络 + 远程客户端要求令牌
COCKPIT_HOST=0.0.0.0 cockpit --token your-shared-secret
\`\`\`

就这样。两个开关值得了解：

| 开关 | 含义 |
|---|---|
| \`COCKPIT_HOST\` | 默认 \`127.0.0.1\`（仅本机）。设为 \`0.0.0.0\` 接受局域网 / VPN 客户端。 |
| \`--token\`（或 \`COCKPIT_TOKEN\`） | 远程客户端必须出示令牌；**loopback 豁免**，本机 CLI 使用完全不受影响。详见[访问令牌一文](/zh/blog/cockpit-access-token/)。 |

想常驻运行，交给你惯用的进程管理器 —— 最小 systemd unit：

\`\`\`ini
[Unit]
Description=OpenCockpit
After=network.target

[Service]
User=dev
Environment=COCKPIT_HOST=0.0.0.0
Environment=COCKPIT_TOKEN=your-shared-secret
ExecStart=/usr/local/bin/cockpit
Restart=on-failure

[Install]
WantedBy=multi-user.target
\`\`\`

## 给每个队友一个席位

每人打开：

\`\`\`
http://<dev-box>:3457/?token=your-shared-secret
\`\`\`

Cockpit 会写入 cookie 并清理 URL —— 令牌不会留在地址栏里。接下来，每个人：

- 把**自己的项目**开成一个 tab（多项目 tab 是相互独立的会话）；
- 两个人改**同一个仓库**时，各占一个 **git worktree** —— Cockpit 在 Explorer 里直接管理 worktree，并行的 Agent 不会互踩检出；
- 每个 tab 自选引擎：默认 Claude，也可以带自己的 Key 用 **Codex / DeepSeek / Kimi / Ollama**。

每个席位都是完整驾驶舱：Agent 对话、xterm.js 终端、Chrome 控制、PostgreSQL / MySQL / Redis 气泡、代码评审页、定时任务。

## 实话实说：它是什么，不是什么

OpenCockpit 的多席位模型是**基于信任的**，就像共享机器的 SSH 权限：

- 令牌管的是*进门*，**不是按用户隔离的账号体系**。持有令牌的人看到同样的项目和会话。
- 把它当 shell 权限对待：适合本来就共用开发机的团队，不适合陌生人。
- 保持在**局域网或 VPN** 内（Tailscale / WireGuard 都很合适）。不要把端口裸暴露在公网。

如果你的团队本来就 SSH 到同一台机器，Cockpit 只是给这台机器加了席位 —— 不改变你的安全模型。

## FAQ

**两个人能同时用吗？**
能 —— 这正是设计目标。每个浏览器是独立客户端，会话在服务端并行运行。

**同一个仓库、两个 Agent？**
用 git worktree（Explorer 里可视化管理）。每个 Agent 有自己的检出，分支按正常 git 流程合并。

**过 Tailscale / WireGuard 能用吗？**
能。就是单端口的 HTTP + WebSocket（默认 \`3457\`，\`--port\` 可改）。

**手机能用吗？**
能 —— 三面板滑动布局就是为此设计的。同一个 URL、同一个令牌。

**Ollama 全离线？**
在开发机上装 Ollama，每个席位都能选任意已拉取的模型。无 Key、无云端，想断网就断网。

---

一台机器上一句 \`npm i -g\`，全队一起飞。试过之后[告诉我们体验如何](https://github.com/Surething-io/cockpit/issues)；如果文中步骤过时了，欢迎 PR 指正。`,
      },
    },
  },
  {
    slug: 'cockpit-access-token',
    date: '2026-07-02',
    keywords: [
      'Cockpit access token',
      'password protect Cockpit',
      'share Claude Code GUI securely',
      'COCKPIT_TOKEN',
      'remote access token',
      'LAN sharing',
      'cloud sandbox',
      '访问令牌',
      '远程访问鉴权',
      '安全共享',
      'Claude Code GUI',
      'OpenCockpit',
      'Cockpit',
    ],
    content: {
      en: {
        title: 'Protect Remote Access with an Access Token',
        description:
          'Set an OpenCockpit access token to guard remote connections from your LAN or cloud sandbox while keeping local access simple.',
        readingTime: '2 min read',
        body: `Cockpit has always been local-first: it binds to \`127.0.0.1\`, and on your own machine anyone on that machine can use it. That's the right default for a local tool. But sometimes you put Cockpit somewhere else — on your LAN, or in a cloud sandbox — and then "anyone who can reach the port" is too open. This release adds an optional shared access token.

## Turn it on

Pass a token when you start the server:

\`\`\`bash
cockpit --token my-secret-value
\`\`\`

Or set \`COCKPIT_TOKEN\` in the environment. It's **off by default** — existing local setups don't change at all.

## Local stays frictionless

With a token set, **loopback requests are still exempt**. The CLI, \`/cg\` snippets, and a browser on the same machine keep working with no token — only *remote* requests need it. Turning this on never gets in your own way.

## Three ways to present it

| Client | How |
|---|---|
| Browser | First visit with \`?token=<value>\` — Cockpit sets a cookie and redirects to a clean URL, so the secret doesn't linger in the address bar |
| API / WebSocket | \`Authorization: Bearer <value>\` header |
| Anything | \`?token=<value>\` query param |

A wrong or missing token is rejected, and tokens are compared in constant time.

## Use it when you go remote

The token pairs with network exposure. When you open Cockpit up with \`COCKPIT_HOST=0.0.0.0\` for a LAN or a cloud sandbox, add a token so it isn't wide open:

\`\`\`bash
COCKPIT_HOST=0.0.0.0 cockpit --token my-secret-value
\`\`\`

That's the whole feature. Full details are in the [CLI reference](/en/docs/reference/cli/#shared-token-access-gate).

---

**Try it:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: 'OpenCockpit 新增访问令牌',
        description:
          'OpenCockpit 本地优先、在自己机器上完全开放。当你把它暴露到局域网或云沙盒时,新增的可选访问令牌会保护远程访问 —— 而本机照常无感。',
        readingTime: '阅读约 2 分钟',
        body: `Cockpit 一直是本地优先的:它绑定 \`127.0.0.1\`,在你自己的机器上,这台机器上的任何人都能用。对本地工具来说,这是对的默认值。但有时你会把 Cockpit 放到别处 —— 局域网,或者云沙盒 —— 这时"任何能连到端口的人"就太开放了。这个版本新增了一个可选的共享访问令牌。

## 开启

启动服务时传一个令牌:

\`\`\`bash
cockpit --token 你的密钥
\`\`\`

或在环境里设 \`COCKPIT_TOKEN\`。它**默认关闭** —— 现有的本地用法完全不变。

## 本机照常无感

设了令牌后,**本机(loopback)请求仍然豁免**。CLI、\`/cg\` 片段,以及跑在同一台机器上的浏览器都无需令牌 —— 只有*远程*请求才需要。开了它也不会挡你自己的路。

## 三种携带方式

| 客户端 | 怎么带 |
|---|---|
| 浏览器 | 首次用 \`?token=<值>\` 访问 —— Cockpit 写入 cookie 并重定向到干净 URL,让密钥不残留在地址栏 |
| API / WebSocket | \`Authorization: Bearer <值>\` 请求头 |
| 任意 | \`?token=<值>\` 查询参数 |

错误或缺失的令牌一律拒绝,令牌用常数时间比较。

## 什么时候用:暴露到网络时

令牌和网络暴露是搭配的。当你用 \`COCKPIT_HOST=0.0.0.0\` 把 Cockpit 开放到局域网或云沙盒时,加上令牌,别让它裸奔:

\`\`\`bash
COCKPIT_HOST=0.0.0.0 cockpit --token 你的密钥
\`\`\`

这就是这个特性的全部。完整细节见 [CLI 参考](/zh/docs/reference/cli/#共享令牌访问网关)。

---

**试一下:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },
  {
    slug: 'cockpit-on-your-phone',
    date: '2026-06-23',
    keywords: [
      'mobile AI agent',
      'monitor coding agent on phone',
      'web push notifications',
      'Claude Code GUI mobile',
      'agent monitoring',
      'mobile layout',
      '移动端',
      '手机监控 agent',
      '推送通知',
      'Claude Code GUI',
      'OpenCockpit',
      'Cockpit',
    ],
    content: {
      en: {
        title: 'Use OpenCockpit on Your Phone',
        description:
          'Open your AI sessions on your phone, continue a chat and receive notifications when a run finishes with OpenCockpit’s mobile layout.',
        readingTime: '2 min read',
        body: `Agents often keep running after you've left your desk. Until now, checking on them meant coming back to a computer. This release adds a mobile layout and notifications, so you can check on your sessions from your phone.

## A mobile layout

When you open Cockpit on a phone, it shows a single-column layout instead of the desktop's three panels. On a tablet, you can switch to the desktop layout if you prefer it.

## Your sessions

The first screen lists your recent sessions and updates as their status changes. A **Frequent** tab keeps the sessions you use often in one place. Tap a session to open its chat, with full history and live streaming, and send messages from a touch input.

| On mobile | What it does |
|---|---|
| Session list | Shows recent sessions and their current status |
| Chat | Full history, live streaming, touch input |
| Diffs & previews | Open fullscreen, with a collapsible file tree |

## Notifications

Turn on notifications and Cockpit sends one to your phone when a run finishes, including when the app is closed. It doesn't require any extra accounts or setup.

## Try it

Update Cockpit and open it on your phone. Turn on notifications and start a run.

---

**Try it:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: '在手机上用 OpenCockpit',
        description:
          'OpenCockpit 新增了移动端布局。在手机上打开,可以查看会话、打开任意聊天,并在一轮跑完时收到通知。',
        readingTime: '阅读约 2 分钟',
        body: `Agent 经常在你离开桌前之后还在跑。在此之前,查看它们得回到电脑前。这个版本新增了移动端布局和通知,你可以在手机上查看自己的会话。

## 移动端布局

在手机上打开 Cockpit 时,显示的是单栏布局,而不是桌面的三栏。在平板上,如果你更习惯桌面布局,可以切换过去。

## 你的会话

第一屏列出你的最近会话,会随状态变化更新。一个 **常用会话** 标签,把你常用的会话集中在一处。点一个会话就打开它的聊天,包含完整历史和实时流式,可以用触屏输入框发消息。

| 移动端 | 作用 |
|---|---|
| 会话列表 | 显示最近会话及其当前状态 |
| 聊天 | 完整历史、实时流式、触屏输入 |
| Diff 与预览 | 全屏打开,文件树可折叠 |

## 通知

打开通知后,一轮跑完 Cockpit 会发一条到你手机上,app 关闭时也会发。不需要额外账号或配置。

## 试一下

更新 Cockpit,在手机上打开。打开通知,发起一轮任务。

---

**试一下:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },
  {
    slug: 'orchestrate-workflows-in-chat',
    date: '2026-06-18',
    keywords: [
      'AI workflow orchestration',
      'multi-step agent workflow',
      'slash command chaining',
      'subagent delegation',
      'Claude sub-agent',
      'multi-command prompt',
      'agent pipeline',
      'slash commands',
      '工作流编排',
      '多步骤 agent',
      '斜杠命令编排',
      '子代理',
      'Claude Code GUI',
      'OpenCockpit',
      'Cockpit',
    ],
    content: {
      en: {
        title: 'Run Multi-Step AI Workflows from Chat',
        description:
          'Combine slash commands and sub-agent tasks in one OpenCockpit message. Run an ordered workflow with / commands and @ delegation.',
        readingTime: '4 min read',
        body: `Most agent work isn't one instruction — it's a small sequence. *Clarify what I actually want, then fix it, then have something independent review the fix.* Until now that was three messages, sent one at a time, each waiting on the last. As of this release you can write the whole thing in one message: start lines with \`/\` or \`@\` and Cockpit reads them as an ordered workflow.

## One message, several steps

Every line that starts with a known command becomes a step. The first character picks where it runs:

| Marker | Where the step runs |
|---|---|
| \`/verb\` | the **main session** — the AI continues in this chat |
| \`@verb\` | a **sub-agent** — delegated to a separate agent, then reported back |

So this:

\`\`\`text
Here is the failing test output: payment webhook 500s on retries.
/fx
figure out why the idempotency key isn't being honored
@cr
audit the fix for race conditions and missing rollbacks
\`\`\`

…becomes a single numbered plan the AI works through in order. The text before the first command rides along as shared context — paste your log or state the goal once, up top, for the whole run. Everything under a command line, including blank lines and multiple paragraphs, belongs to that step.

You wrote four lines. The agent received a structured plan.

## \`/\` keeps it close, \`@\` sends it away

The two markers are about *attention*, not just routing:

- **\`/verb\`** keeps the work in the current chat, where you can watch it turn by turn and steer. Use it for the steps you care about.
- **\`@verb\`** hands a self-contained chunk — a review, an exploration, a focused investigation — to a sub-agent, which does it and summarizes back without cluttering the main thread.

The everyday shape is "do it here, then send someone to check it":

\`\`\`text
/go
implement the retry backoff described in the ticket
@cr
review what was just written for correctness and style
\`\`\`

## Your own skills, in the mix

Steps aren't limited to the built-ins. Any [skill](/en/docs/agent/skills/) you've installed is a verb too, and built-ins and your skills can sit side by side in the same workflow — they all resolve through the same "read this SKILL.md" path. If a skill you wrote shares a name with a built-in, yours wins, so your version is what runs.

And autocomplete now follows your cursor: type \`/\` or \`@\` at the start of *any* line — the second, the third — and the command menu pops for that line. That's what makes stacking steps feel natural instead of fiddly.

## Nothing changes for one-offs

If your message is a single \`/verb\` with no preamble and no \`@\`, it behaves exactly as before — one command, one turn, no ceremony. The numbered plan only appears when there's a real workflow to run: two or more commands, any \`@\` step, or leading context text. The simple case stays simple; the multi-step case finally gets to be one message.

## Try it

Update Cockpit, open a chat, and write two commands on two lines — say \`/qa\` then \`@cr\`. Watch the agent receive them as an ordered plan. Full details in the [Workflows](/en/docs/agent/workflows/) docs.

---

**Try it:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: '在消息框里编排一条工作流',
        description:
          'OpenCockpit 的一条消息现在可以放不止一个命令。让好几行分别以 `/` 或 `@` 开头,Cockpit 就把整条消息当成一条有序的多步工作流来读 —— `/` 在主会话执行,`@` 委派给子代理。一次规划,一次发送。',
        readingTime: '阅读约 4 分钟',
        body: `大多数 agent 活儿都不是一条指令,而是一小段序列。*先澄清我到底要什么,再修它,然后让一个独立的东西来审这个修复。* 在此之前这是三条消息,一条一条发,每条都等着上一条。从这个版本起,你可以把整件事写进一条消息:让行以 \`/\` 或 \`@\` 开头,Cockpit 就把它们读成一条有序工作流。

## 一条消息,多个步骤

每一行只要以已知命令开头,就成为一个步骤。第一个字符决定它在哪里跑:

| 标记 | 步骤在哪里执行 |
|---|---|
| \`/verb\` | **主会话** —— AI 在这个聊天里继续 |
| \`@verb\` | **子代理** —— 委派给一个独立 agent,完成后回报 |

于是这样:

\`\`\`text
这是失败的测试输出:支付 webhook 在重试时返回 500。
/fx
查清楚为什么幂等键没被尊重
@cr
审一下这个修复有没有竞态和漏掉的回滚
\`\`\`

……就变成一份带编号的计划,AI 按序推进。第一条命令之前的文字作为共享上下文一起带上 —— 把日志贴在顶部,或为整条工作流统一交代一次目标。命令行下面的所有内容,包括空行和多个段落,都属于那个步骤。

你写了四行。Agent 收到的是一份结构化计划。

## \`/\` 留在身边,\`@\` 派出去

这两个标记关乎的是*注意力*,不只是路由:

- **\`/verb\`** 把工作留在当前聊天,你能逐轮盯着、随时纠偏。用在你真正在意的步骤上。
- **\`@verb\`** 把一块自成一体的活儿 —— 一轮审查、一次探索、一段聚焦调查 —— 交给子代理,它办完并回来给小结,不塞满主线。

日常形态就是「在这儿干,再派个人来检查」:

\`\`\`text
/go
实现工单里描述的重试退避
@cr
审一下刚写的东西,看正确性和风格
\`\`\`

## 把你自己的 skill 也混进来

步骤不限于内置命令。你装过的任意 [skill](/zh/docs/agent/skills/) 也是一个 verb,内置命令和你的 skill 可以并排出现在同一条工作流里 —— 它们都走同一条「读这个 SKILL.md」的路径解析。如果你写的 skill 和某个内置同名,你的优先,所以跑的是你那一版。

而且自动补全现在跟着光标走:在*任意一行*开头打 \`/\` 或 \`@\` —— 第二行、第三行 —— 命令菜单就为那一行弹出。这正是让叠步骤变得自然、而不是别扭的关键。

## 单次命令一切照旧

如果你的消息只是一个 \`/verb\`、没有前言、也没有 \`@\`,它的行为和以前完全一样 —— 一个命令、一轮、没有多余仪式。带编号的计划只在真的有工作流要跑时才出现:两个及以上命令、任意 \`@\` 步骤、或开头有上下文文字。简单的事保持简单;多步的事终于能放进一条消息。

## 试一下

更新 Cockpit,打开一个聊天,在两行上写两个命令 —— 比如 \`/qa\` 然后 \`@cr\`。看着 agent 把它们当成一份有序计划接收。完整细节见[工作流](/zh/docs/agent/workflows/)文档。

---

**试试看:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },

  {
    slug: 'claude-code-cli-execution-mode',
    date: '2026-06-10',
    keywords: [
      'Claude Code CLI',
      'Claude Agent SDK',
      'Claude Agent SDK billing',
      'Claude Agent SDK usage limits',
      'claude -p',
      'Claude Code subscription',
      'Claude plan usage limits',
      'Claude Code billing change',
      'June 15 2026 Claude billing',
      'interactive Claude Code',
      'Claude 订阅计费',
      'Claude Code 订阅额度',
      'Claude 用量限制',
      'PTY mode',
      'execution mode',
      'Claude Code GUI',
      'OpenCockpit',
      'Cockpit',
    ],
    content: {
      en: {
        title: 'Use Claude Code CLI Mode in OpenCockpit',
        description:
          'Switch a Claude tab between the Agent SDK and an interactive CLI session. Learn how OpenCockpit’s CLI mode works with your conversation.',
        readingTime: '5 min read',
        body: `Cockpit drives Claude Code through the Claude Agent SDK — \`query()\`, headless, programmatic. That is still the default. As of this release, each Claude / Claude2 chat tab also has a second execution mode you can flip to: **Claude Code CLI**.

Here is what the two modes are, and how the new one works.

## Two ways to run the same conversation

The toggle sits right above the message list:

| Mode | What actually runs |
|---|---|
| **Claude Agent SDK** | \`query()\` — headless, programmatic |
| **Claude Code CLI** | a real interactive \`claude\` session in a PTY |

Same Claude, same project, same tools. The only difference is *how* the turn is driven.

In **Claude Code CLI** mode, every message spawns an interactive \`claude\` in a pseudo-terminal, types your prompt into the live REPL exactly like a human at a keyboard would, watches the session transcript to know when the turn is done, and exits. It is ephemeral — no daemon, no resident process — but for the duration of a turn it is, by every observable signal, an interactive Claude Code session.

Different invocation paths can be metered differently over time. We will leave you to decide which one fits; the point here is that you now have the choice, per tab, one click away.

## Same session, seamless switching

The detail that makes this painless: **both modes read and write the same session file.**

The SDK's \`query({ resume })\` and the CLI's \`claude -r\` operate on the *same* \`~/.claude/projects/.../<id>.jsonl\` transcript — they are the same underlying \`claude-code\` binary. So:

- One continuous conversation, one history. No "SDK history" vs "CLI history."
- You can flip a tab between **Claude Agent SDK** and **Claude Code CLI** mid-conversation and the next turn just continues.
- The chat panel always renders from that one transcript, so the UI does not change between modes.

You are not choosing between two products. You are choosing how the *next message* runs.

## A real terminal you can actually see

Driving an interactive TUI from code is the kind of thing that works in a demo and then quietly wedges on a dialog at 2am. So CLI mode is not a black box — it ships with a small floating terminal in the corner of the chat.

- It shows the **live, character-by-character** output of the real \`claude\` session. (The chat panel, rendered from the transcript, is block-level — the floating window is where you get the typewriter feel.)
- It **auto-expands** while a turn is running and collapses when it is done.
- If a turn ever gets stuck — say Claude is waiting on a prompt the driver did not anticipate — you get a notice in the chat bubble *and* you can **type directly into that terminal** to nudge it through by hand. Human-in-the-loop, exactly where you would want it.

Press \`ESC\` to interrupt at any time; the session is reaped cleanly, with no orphan processes left behind.

## Try it

Update Cockpit, open a Claude or Claude2 chat, and look for the **Claude Agent SDK / Claude Code CLI** toggle above the message list. Flip it to **Claude Code CLI**, send a message, and watch the floating terminal drive a real interactive session.

---

**Try it:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: 'OpenCockpit 新增 Claude Code CLI 执行模式',
        description:
          'OpenCockpit 里每个 Claude 聊天标签现在都能用两种方式跑：Claude Agent SDK（无头 `query()`），或在 PTY 里驱动一个真·交互式 `claude` 会话。两者共享同一份对话，所以你可以 per-tab、在对话中途、一键切换。这篇讲讲新增的 CLI 模式是什么、怎么工作。',
        readingTime: '阅读约 5 分钟',
        body: `Cockpit 一直是通过 Claude Agent SDK 来驱动 Claude Code 的——\`query()\`、无头、程序化。这仍然是默认。从这个版本起，每个 Claude / Claude2 聊天标签多了一个可切换的执行模式：**Claude Code CLI**。

下面讲讲这两种模式是什么，以及新的那个怎么工作。

## 同一段对话的两种跑法

切换条就在消息列表上方：

| 模式 | 实际跑什么 |
|---|---|
| **Claude Agent SDK** | \`query()\`——无头、程序化 |
| **Claude Code CLI** | PTY 里一个真·交互式 \`claude\` 会话 |

同一个 Claude、同一个项目、同一套工具。唯一的区别是这一轮**怎么被驱动**。

**Claude Code CLI** 模式下，每条消息都会在伪终端里 spawn 一个交互式 \`claude\`，像一个人坐在键盘前那样把 prompt 敲进活着的 REPL，盯着会话的 transcript 判断本轮何时结束，然后退出。它是临时的——没有守护进程、没有常驻进程——但在这一轮的整个过程里，从每一个可观测信号看，它就是一个交互式 Claude Code 会话。

不同的调用路径，未来可能被以不同方式计量。具体选哪个，留给你自己判断；这里要说的是：你现在有了这个选择，per-tab、一键即达。

## 同一份会话，无缝切换

让这一切不痛苦的关键细节是：**两种模式读写的是同一个会话文件。**

SDK 的 \`query({ resume })\` 和 CLI 的 \`claude -r\` 操作的是**同一份** \`~/.claude/projects/.../<id>.jsonl\` transcript——它们底层就是同一个 \`claude-code\` 二进制。于是：

- 一条连续的对话、一份历史。不存在「SDK 历史」和「CLI 历史」两套。
- 你可以在对话中途把某个标签在 **Claude Agent SDK** 和 **Claude Code CLI** 之间来回切，下一轮直接续上。
- 聊天面板永远从那一份 transcript 渲染，所以 UI 在两种模式间不会有任何变化。

你不是在两个产品之间做选择。你是在选**下一条消息**怎么跑。

## 一个你真能看见的终端

用代码驱动一个交互式 TUI，是那种 demo 里跑得好好的、然后凌晨两点悄悄卡在一个对话框上的活儿。所以 CLI 模式不是个黑盒——它在聊天角落带了一个小小的浮动终端。

- 它显示真 \`claude\` 会话的**逐字实时**输出。（聊天面板从 transcript 渲染、是块级的——逐字打字机的体感由浮动窗提供。）
- 它在一轮运行时**自动展开**，结束后自动折叠。
- 万一某轮卡住了——比如 Claude 在等一个驱动没预料到的对话框——你会在聊天气泡里收到提示，*而且*可以**直接在那个终端里打字**，手动把它推过去。Human-in-the-loop，正好在你想要它的地方。

任何时候按 \`ESC\` 都能中断；会话会被干净回收，不留孤儿进程。

## 试一下

更新 Cockpit，打开一个 Claude 或 Claude2 聊天，在消息列表上方找到 **Claude Agent SDK / Claude Code CLI** 切换条。切到 **Claude Code CLI** 发一条消息——看着浮动终端去驱动一个真正的交互式会话。

---

**试试看：** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },

  {
    slug: 'code-graph-for-ai-agents',
    date: '2026-05-22',
    keywords: [
      'code graph',
      'code knowledge graph',
      'AI code agent',
      'AI code intelligence',
      'code graph for AI',
      'tree-sitter',
      'project graph',
      'code navigation AI',
      'conventional coupling',
      'what is a code graph',
      'code graph for AI agents',
      '代码图谱',
      'OpenCockpit',
      'Cockpit',
    ],
    content: {
      en: {
        title: 'What Is a Code Graph? How AI Coding Agents Use One',
        description:
          'A code graph maps every symbol, caller and dependency in your project. What it is, why grep falls short for AI coding agents, and how to give them one.',
        readingTime: '6 min read',
        body: `A **code graph** is a structured map of your project's symbols and the relationships between them — who calls whom, what depends on what, which files always get edited together. It is the kind of mental model a human builds before refactoring. For an AI agent still doing \`grep -r\` to find anything, it is the missing layer.

Here is why that matters in practice.

## A small disaster

Last week I added a new slash command to Cockpit. Code change was four lines. I tested it. Worked. Committed. Pushed.

Next morning a teammate messaged: *"I can't see it in the autocomplete menu though?"*

The new command had to be registered in **two** files. One for the prompt expansion, one for the menu listing. They don't import each other. They don't share a function. They just have to stay in sync — a convention nobody documents, that the codebase enforces nowhere.

Before I made that change, I had asked the agent: *"If I change this function, what else needs updating?"* It ran \`grep\`, found five callers, summarized them confidently. The menu file wasn't a caller. \`grep\` couldn't see the relationship. Neither could the agent.

## Why grep is the agent's ceiling

When an AI agent is just driving \`grep\`, it inherits \`grep\`'s blind spots:

- **Relationships are invisible.** \`grep\` knows the string \`createOrder\` shows up 12 times. It does not know which of those are *calls* and which are comments, tests, or unrelated strings.
- **Conventions are invisible.** Two files with the same constant — one defines it, one mirrors it — look like two unrelated occurrences. \`grep\` cannot encode "these must stay in sync."

Most AI exploration runs on \`grep\` because most code questions are simple lookups. The 10% that aren't are exactly where you needed the help most.

## What a code graph gives the agent

\`/cg\` is the slash command. Type it in any Cockpit chat:

\`\`\`
/cg if I rename createOrder, what breaks?
\`\`\`

You did not learn a new tool. You did not install anything. You typed three letters. The agent now answers as if it had just spent an hour reading the codebase.

Six question shapes get sharper answers:

| You ask | The agent now actually knows |
|---|---|
| "Where is \`X\` defined?" | the file and line range, in one query |
| "Who uses \`X\`?" | real callers, not string matches |
| "What does \`X\` depend on?" | the downstream chain |
| **"What does changing \`X\` affect?"** | not just direct callers — the ripple two hops out |
| "What's in this file?" | the symbol outline, without reading the whole file |
| **"What files always get edited alongside this one?"** | the *convention* couplings \`grep\` can never see |

The last one is the one that would have saved me.

## The story, replayed

I redo the change with \`/cg\`:

> *"If I add a new slash command in this file, what else do I need to touch?"*

The agent ran the usual call-graph queries, then ran one more — "what files commonly get edited together with this one?" — and came back with:

> *"Direct callers are five chat routes; signature is stable. **One caveat: \`commands.ts\` in the same module gets edited together with this file in most recent commits. If your change adds a new command verb, you probably need to register it in \`commands.ts\` too — looks like a parallel menu list.**"*

Three lines. The whole future-bug fix.

## Code Map for your eyes, CodeGraph for the agent

If you have used Cockpit's [Code Map](/en/blog/read-code-as-a-map/), you have already seen the human side of this. Code Map renders the same project structure as clickable chips — function callers on the left, callees on the right — so *you* can walk the call graph in five clicks.

CodeGraph is the same idea, made queryable. Same tree-sitter index, same call graph, same git history. Code Map serves it to your eyes; CodeGraph serves it to your agent.

Same fact, two consumers.

## What it doesn't do

\`/cg\` is not a fixer. It does not reach into config files, JSON, or unstructured docs — for those, regular \`grep\` is still the right tool. And if you already know which file to edit, just \`Edit\` it; you don't need an exploration mode.

But the moment your question contains the words "what else" or "who depends on" — that is when the gap between \`grep\` and a code graph shows up.

## Try it

In any Cockpit chat:

\`\`\`
/cg
\`\`\`

That is the entire onboarding. Try it on a function whose impact you don't fully understand. The agent will tell you something you would not have found on your own.

---

\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: 'Code Graph 是什么？AI 编程 Agent 怎样用代码图谱',
        description:
          '代码图谱（code graph）把项目里的符号、调用和依赖画成一张图。本文讲清它是什么、grep 为什么不够，以及怎样让 AI 编程 Agent 用上它。',
        readingTime: '6 min read',
        body: `**代码图谱（code graph）**是你项目里所有符号和它们之间关系的结构化地图——谁调用谁、谁依赖谁、哪些文件总是一起被改。这本就是人在重构前画在白板上的那张图。但对一个还在 \`grep -r\` 找东西的 AI Agent 来说，这一层是缺失的。

下面讲为什么这件事在实际工作里很要命。

## 一个小翻车

上周我给 Cockpit 加了一个新的斜杠命令。代码改了四行。本地测了。能跑。提交。推送。

第二天同事消息：*"补全菜单里看不到啊？"*

原来这个新命令需要在**两个文件**登记——一个负责 prompt 展开，一个负责出现在菜单。它们不互相 import，不共用函数，**只是约定要同名同步**。没人文档化这件事，代码里也没编译时检查。

我改之前问过 Agent："如果改这个函数，还要动哪些地方？" 它 \`grep\` 一通，找出 5 个调用方，自信满满总结了一遍。菜单文件不是调用方。\`grep\` 看不见这种关系，Agent 也看不见。

## 为什么 grep 是 Agent 的天花板

当 AI 只能驱动 \`grep\`，它就继承了 \`grep\` 的所有盲区：

- **关系是看不见的。** \`grep\` 知道字符串 \`createOrder\` 出现 12 次，但不知道哪些是真调用、哪些是注释、测试或巧合同名。
- **约定是看不见的。** 两个文件用了同一个常量——一个定义、一个镜像——在 \`grep\` 眼里就是两个无关的出现。它没法表达"这俩必须同步改"。

大多数 AI 探索靠 \`grep\` 也能跑——因为大多数问题确实只是简单查找。但剩下 10% 不能跑的，恰恰是你最需要帮手的时候。

## Code Graph 给 Agent 什么

\`/cg\` 是斜杠模式。Cockpit 任意聊天里输入：

\`\`\`
/cg 如果重命名 createOrder 会牵连什么？
\`\`\`

你没学新工具，没装东西，就敲了三个字符。Agent 现在回答问题的方式，就像它刚花了一小时把代码库读完。

六种问题答得更准：

| 你问 | Agent 现在真的知道 |
|---|---|
| "X 在哪定义？" | 文件 + 行号，一次拿到 |
| "谁用了 X？" | 真实调用方，不混杂字符串巧合 |
| "X 依赖什么？" | 下游链 |
| **"改 X 会影响什么？"** | 不止直接调用方——连两跳传递性影响也展开 |
| "这个文件里有啥？" | 符号大纲，不用读全文 |
| **"哪些文件总和这个一起被改？"** | grep 永远看不到的**约定耦合** |

最后一行就是当初能救我的那条。

## 故事重演

我用 \`/cg\` 重做一次：

> *"我要在这个文件加一个新的斜杠命令，还需要动哪些地方？"*

Agent 跑了常规的调用图查询，又多跑了一个——"这个文件在最近的提交里通常和哪些文件一起改"——回我：

> *"直接调用方是 5 个 chat 路由；签名稳定。**额外注意：同模块的 \`commands.ts\` 最近几次相关提交都和这个文件一起改。如果你加了新 verb，多半也得在 \`commands.ts\` 里登记——看起来是个并行的菜单列表。**"*

三行话。一个本来会发版后才发现的 bug，提前抓住了。

## Code Map 给眼睛，CodeGraph 给 Agent

用过 Cockpit [Code Map](/zh/blog/read-code-as-a-map/) 的人，已经见过这件事的人类版——把同一份项目结构渲染成可点击的代码 chip，左边是调用者，右边是被调用，你五次点击就能走完一条调用链。

CodeGraph 是同一个想法，换成可查询接口。**同一份 tree-sitter 索引、同一张调用图、同一段 git history**——Code Map 端给你眼睛，CodeGraph 端给你的 Agent。

同一个事实，两种消费方式。

## 它不做什么

\`/cg\` 不修代码，不读 JSON / yaml / 文档——那些场景普通 \`grep\` 还是对的工具。如果你已经知道要改哪个文件，直接 Edit 就好，不需要进探索模式。

但当你的问题里出现"还会影响什么""谁依赖"这种字眼——这就是 \`grep\` 和 code graph 差距显形的时候。

## 试一下

任意 Cockpit chat 里：

\`\`\`
/cg
\`\`\`

这就是全部上手成本。挑一个你不完全确定影响范围的函数试试——Agent 会告诉你一些你自己找不到的东西。

---

\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },
  {
    slug: 'vibe-coding-needs-taste',
    date: '2026-05-12',
    keywords: [
      'vibe coding',
      'AI coding agent',
      'code taste',
      'code aesthetics',
      'package boundaries',
      'monorepo structure',
      'npm package design',
      'codebase architecture',
      'cohesion',
      'engineering discipline',
      'OpenCockpit',
      'Cockpit',
      'Claude Code',
    ],
    content: {
      en: {
        title: 'Vibe Coding Needs Software Design',
        description:
          'Keep AI-generated code maintainable with clear module boundaries, deliberate file placement and deletion of code that no longer fits.',
        readingTime: '6 min read',
        body: `The agent finishes a run. Diff is a hundred-something lines. Looks fine. You hit approve.

Two weeks later, something's broken somewhere and you can't find it. Every function is reasonable. No name is bad enough to need changing. You just don't really want to open this repo anymore.

What's hard about vibe coding isn't making the agent faster. It's the codebase still looking like a codebase after the agent has run a thousand times.

## The current shape

\`\`\`
src/                       Next.js entry, no business code
 │
 ▼
packages/feature/          agent  console  explorer
                           workspace  review  comments  skills
 │                         (may reference each other, must stay acyclic)
 ▼
packages/shared/           ui  utils  i18n
                           (leaf; cannot import feature)
\`\`\`

Three slots, that's the whole repo:

- \`src/\` is what Next.js itself needs — page files, thin shim routes that forward to the API handlers. No business code.
- \`packages/feature/\` is the business. Seven packages, each a standalone npm package.
- \`packages/shared/\` is the common floor. Three packages: UI components, utilities, the i18n dictionary.

Arrows go one way: anything on top may depend on anything below, but the bottom never imports up. ESLint watches this. Write it the wrong way and lint refuses to pass.

Every point that follows lands on a specific spot in that picture.

## A few old-school things

**Where a thing goes.** Chat — API, UI, state, scheduled jobs, slash commands — all lives under \`packages/feature/agent\`, one folder. To change anything about chat you don't hunt across the repo. This isn't for tidiness. It's so a person — or an agent — can finish a job with one folder's worth of attention.

**Boundaries.** \`shared/\` is not allowed to import from \`feature/\`. This rule isn't in a README that humans are supposed to remember; it's in ESLint, enforced by a tool. "Be considerate to the next reader" isn't a slogan — it's a lint error.

**Delete with conviction.** The dev dependencies I've removed weren't bad because they were old. They were bad because they didn't fit anywhere in the picture — not part of any feature, not part of the shared floor. Anything that doesn't fit the picture shouldn't be in the repo.

**Don't invent vocabulary.** The picture has two nouns: feature and shared. I didn't use domain, didn't use module, didn't use app or infra. An npm package is a contract everyone already understands; "feature" and "shared" are plain English. Every noun you'll find in this repo is either npm's own term or a word a middle schooler reads without thinking.

## Three pictures from this refactor

**\`src/\` got emptied out.** It used to hold components, hooks, contexts — the lot. Now it's only the top slot of the diagram — Next.js's entry. The business sits in the middle slot. When you open the repo you can tell at a glance where to look, because framework noise and business work are physically separated.

**Only two horizontal piles.** Adding a third is easy: feature, shared, then "infra"? Then "core"? Every new name needs explaining, and every explanation eventually triggers "well, which pile does this go in?" I held the line at two. Anyone who has ever installed an npm package needs zero extra training to read this repo — \`package.json\`, \`exports\`, \`dependencies\` — they already know how those work. I didn't make them learn anything new.

**The moment of deletion.** A test framework that hadn't been run in a year, a component sandbox nobody opened, a browser-automation harness from a finished experiment. One commit, all gone. I hesitated for two seconds before deleting, and nobody missed any of it after. Admitting I'd added something I shouldn't have is a thing I do faster every year.

## How the agent moves inside this picture

A human reads code with intuition. An agent reads whatever fits in its context window. The picture itself helps the agent in two specific ways.

**Blast radius has a ceiling.** When the agent is changing chat, it opens \`packages/feature/agent\` and nothing else. It can't see, and doesn't need to see, console or explorer. The physical separation makes "agent casually broke an unrelated feature" structurally hard, not just unlikely.

**The arrow direction teaches the agent how to write.** When the agent is writing inside \`shared/\`, it can't see any feature — it literally cannot import a feature's internals. That forces it to write something genuinely general. When it's writing inside \`feature/\`, it knows it can't reach beyond \`shared/\`, and that knowledge lets it work without hedging.

A codebase's habits, the agent learns fast. That shortcut you took six months ago — it's already in the context window, presented as the project's style, and the agent will follow it. A repo without taste teaches the agent to be tasteless, fast. The flip side: when the words in the repo are ones the agent has read a million times — \`package.json\`, \`exports\`, \`dependencies\` — it just works. It hasn't read your homemade module system.

## Last thing

Taste isn't a synonym for slowness. It's what lets "fast" last past the second month.

Set the boundaries, keep the vocabulary as small as you can, pull out what isn't being used. Let the agent run inside that shape — it can keep up. A year later you come back and you still want to open the repo. That's not a thing that lands in the changelog, but it's the thing that decides whether this project stays fun to work on.

---

\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: 'Vibe coding 需要一点品味',
        description:
          '现在的 OpenCockpit 仓库就两堆代码：`packages/feature/` 是业务，`packages/shared/` 是公共底子，箭头只有一个方向。从这张图能讲清楚为什么 vibe coding 时代反而更需要品味——把东西放对、划清边界、敢删没用的东西，三件老掉牙的事在 agent 改代码的当下比以前更值钱。',
        readingTime: '阅读约 6 分钟',
        body: `agent 跑完一轮，diff 一百多行，看着没毛病，你点了通过。

两周以后某个角落坏了。回去看，每个函数都说得过去，没有哪个名字烂到必须改，但你就是不太愿意再打开这个仓库。

vibe coding 真正难的不是怎么让 agent 跑得更快。是跑了一千次以后，仓库还像个仓库。

## 现在的架构

\`\`\`
src/                       Next.js 入口，没有业务
 │
 ▼
packages/feature/          agent  console  explorer
                           workspace  review  comments  skills
 │                         （彼此可以互相依赖，必须无环）
 ▼
packages/shared/           ui  utils  i18n
                           （叶子，不允许反过来 import feature）
\`\`\`

整个仓库就这三块：

- \`src/\` 是 Next.js 框架自己需要的入口——页面文件、API route 的转发 shim——没有业务代码。
- \`packages/feature/\` 是业务，七个包，每个包是一个独立的 npm package。
- \`packages/shared/\` 是公共底子，三个包：UI 组件、工具函数、翻译字典。

箭头只有一个方向：上面的可以依赖下面的，下面的不允许反过来 import 上面。这一条规则由 ESLint 盯着，写反了过不了 lint。

后面要说的事情，全都落在这张图上的某个具体位置。

## 老掉牙的几件事

**一个东西该放哪儿。** 聊天功能的 API、UI、状态、定时任务、slash 命令，全在 \`packages/feature/agent\` 一个目录里。要改聊天的任何东西都不用满仓库找。这不是为了"看着整齐"，是让人——和 agent——能用一个文件夹的注意力做完一件事。

**边界。** \`shared/\` 不允许反向 import \`feature/\`。这条规则不是写在 README 里靠人记，是写在 ESLint 里靠工具卡。"对下一个读代码的人客气" 不是口号，是 lint 报错。

**该删要狠。** 删掉过的那十几个开发依赖，它们的问题不是"老"，是它们归不进图里任何一个位置——既不是某个 feature 的事，也不是 shared 的公共底子。归不进图的东西，就说明它不该留。

**不造词。** 图里只有两个名词：feature 和 shared。我没用 domain，没用 module，没用 app 和 infra。npm package 是一个所有人都懂的契约，feature 和 shared 是大白话。仓库里你能查到的所有名词，要么是 npm 自己的术语，要么是中学生都看得懂的英文单词。

## 这次重构里的三张画面

**\`src/\` 被搬空了。** 之前那里堆着组件、hook、context，一锅端。现在它只是图最上面那一小格——Next.js 的入口。业务全在中间那一格。打开仓库的人一眼就知道往哪儿看，因为框架噪音和业务被物理分开了。

**横向只有两堆。** 加第三堆很容易：feature、shared，再来一个 "infra"？再来一个 "core"？每一个新名字都要解释，解释就会引来"那这个东西该放哪一堆"的问题。我坚持两堆。装过 npm 包的人打开仓库不需要任何额外培训——\`package.json\` 怎么读、\`exports\` 怎么写、\`dependencies\` 怎么追，他都本能地知道。我没让他多学任何东西。

**删 devDep 那一刻。** 一个一年没跑过的测试框架、一个没人打开过的组件 demo 工具、一个废弃实验留下的浏览器自动化。一个 commit 全删。删之前犹豫过两秒，删之后没人想起它们。承认当初加错了，是我这两年做得越来越快的一件事。

## agent 在这张图里改代码

人读代码靠直觉。agent 读代码靠塞进上下文的那部分。这张图本身就在两个地方帮 agent。

**爆炸半径有上限。** agent 要改聊天，它打开 \`packages/feature/agent\` 这一个目录就够。它看不到、也不需要看到 console 或 explorer。物理隔离让"agent 顺手把一个无关功能改坏"这件事在结构上变得难以发生。

**箭头方向能教 agent 怎么写。** agent 在 \`shared/\` 里写代码时，看不到任何 feature——它根本没法 import 某个 feature 的内部细节。这强迫它写出真正"通用"的东西。反过来在 \`feature/\` 里写时，它知道改不到 shared 以外的世界，下手就更放。

代码库有什么习惯，agent 会学得飞快。你半年前留下的临时方案，它会当成"这个项目的写法"沿用下去。库里没品味，agent 就跟着没品味，速度比人快得多。反过来，库里用的都是 agent 见过几百万遍的那些词——\`package.json\`、\`exports\`、\`dependencies\`——它直接上手。它没读过你自创的模块体系。

## 最后

品味不是慢工细活的代名词。它是让"快"能撑过第二个月的那个东西。

把边界划清，词汇压到最小，没在用的东西早点拔掉，剩下的让 agent 去跑就行——它跑得动。一年以后回来，你还愿意打开这个仓库。这件事不会写进 changelog，但它决定了你做这个项目快不快乐。

---

\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },
  {
    slug: 'read-code-as-a-map',
    date: '2026-05-07',
    keywords: [
      'Code Map',
      'code visualization',
      'call graph',
      'onboarding new codebase',
      'reading code',
      'code review AI',
      'AI generated code review',
      'function caller callee',
      'tree-sitter code analysis',
      'code navigation',
      'OpenCockpit',
      'Cockpit',
      'Claude Code',
    ],
    content: {
      en: {
        title: 'Explore Callers and Callees with Code Map',
        description:
          'Explore a source file as a map of functions. Follow callers and callees in OpenCockpit’s Code Map through five practical code-reading scenarios.',
        readingTime: '7 min read',
        body: `You clone a new repo. \`npm install\`. \`npm run dev\`. It works.

Now you have to actually **read** it.

The file tree opens. 47 folders. 312 files. Some named \`utils\`, some named \`lib\`, one called \`core\` and another called \`kernel\` (you suspect they overlap). Where do you start? Probably \`index.ts\`. After 20 minutes you've drifted three folders deep, you have 11 tabs open, and you still don't know which function is the entry point for the bug you came to fix.

The file tree is showing you **where files are stored**, not **how the code actually moves**.

## A different unit

Cockpit's new Code Map switches the unit. Instead of "files in folders", you see **functions, with their connections.**

Every function becomes a card on the canvas:

- The **body** — the actual code, syntax-highlighted — sits in the middle.
- On the **left**: every function that calls *this* one. (Callers.)
- On the **right**: every function that *this* one calls. (Callees.)
- Each entry on either side is clickable. Click and the canvas pans to that function.

That's the whole interface. The file tree is still there if you want it. But the moment you click into a file, you don't see "lines 1–840 of \`payment.ts\`." You see four chips: \`chargeCard\`, \`refund\`, \`webhookHandler\`, \`recordLedgerEntry\` — each with their own incoming and outgoing arrows.

## Day one in a new repo

This is the moment Code Map was built for. You join a project at 9am. By 10am you're supposed to "have a look at the auth flow." With the file tree, that's a 90-minute scavenger hunt. With Code Map:

1. Open the file you suspect is the entry point — \`routes/auth.ts\`.
2. The five route handlers each appear as their own chip.
3. Pick the one you care about: \`loginHandler\`. Its chip lights up.
4. The right column shows it calls \`validateCredentials\`, \`issueToken\`, \`recordLogin\`. Click \`validateCredentials\`.
5. The canvas pans. Now \`validateCredentials\` is the centre chip. Its callees are \`hashPassword\` and \`lookupUser\`. Its callers — left column — show you it's also called from \`resetPassword\`, which you didn't know existed.

In five clicks you've walked the auth tree. You haven't \`grep\`-ed for "login". You haven't gotten lost in \`utils/index.ts\`. The map you needed was always there in the code — you just needed someone to draw it.

## Following a call you don't trust

This is the thing every senior engineer secretly does and no junior is ever taught: when you're not sure why a function is being called, you walk **up** the call chain until you understand the entry point.

The traditional way is **grep + intuition**. \`grep -r 'createOrder'\` returns 23 hits. 19 are in tests. 2 are in comments. 2 are real call sites. You open both, scroll around, try to figure out which "happens first."

In Code Map, \`createOrder\`'s left column *is* the answer. Sorted, deduped, no test files unless you want them. Click each one to see the actual line. The whole "where does this get called" question is a 10-second visual inspection instead of a five-tab dig.

## Reviewing AI-generated PRs

You asked Claude to "fix the rate-limiter bug." It produced 8 file changes across 3 directories. The diff looks reasonable. You hit Approve.

You shouldn't.

Switch the same files into Code Map. Now the diff isn't a list of \`+/-\` lines — it's a chip view where the **changed functions are highlighted**, with their callers and callees still drawn around them. You can immediately see:

- The agent edited \`rateLimit\`. Its callers are \`apiHandler\` and \`webhookHandler\`. Did the change break the webhook path? Click the webhook caller, read the chip, done. 30 seconds.
- It also touched \`getClientIp\`, which has *eleven* callers — half of them in the auth subsystem. The agent didn't mention this. You probably want to read those eleven before approving.

For PRs you wrote yourself, this is overkill. For PRs an agent wrote at 3am while you were asleep, this is the difference between "I trust it" and "I should trust it."

## Tracing a bug across files

A user reports: "Sometimes when I refresh, the cart loses one item." You have a guess: something racy in \`syncCart\`. Open \`syncCart\` in Code Map.

Five callees. One is \`fetchCart\`. Two are flavours of \`mergeCart\`. One looks fishy: \`dedupeItems\`. Click. Its body shows a \`Set\` keyed on \`id\` — but the bug report mentions duplicate ids with **different sizes**. Found it.

Three clicks. No \`grep\`. No "open ten files in tabs and scroll." The map made the buggy node visible because the chips next to it were the right context.

## On the train, no LSP, no problem

Code Map runs on your laptop, parsed by tree-sitter. No language server, no project index, no background daemon. Open a folder, get a chip view. Close your laptop, fly to Berlin, open it on the plane — same chip view, no indexing wait.

This matters more than it sounds. LSP-based tools (VSCode's "find references", JetBrains' "show callers") all need a fully booted project: \`tsconfig\` resolved, \`pip install\` done, \`go.mod\` complete. Code Map skips that. It reads your files the way a careful human reader would. If they parse, you get a chip view. That's it.

It works on **TypeScript / JavaScript, Python, Go, Rust** today. As a user, that's all you need to know.

## When *not* to use it

To be fair: Code Map isn't trying to be your editor. If you're writing new code, you're in the regular Explorer with a cursor and the LSP popping up types. Code Map is for the moment **before** you write — when you need to read first.

A useful split:

- **File tree + editor** — when you know what you're changing and where.
- **Code Map** — when the question is "what calls what, and where do I start?"

You'll toggle between them all day. Both views look at the same files. They just answer different questions.

## Try it

Open Cockpit, go to Explorer, open any source file, hit the **Code Map** toggle. The chip view replaces the editor pane — same file, different lens. Click a callee pin to fly to the next function. Toggle back when you're done.

That repo you've been meaning to read since January? It's a five-minute walkthrough now.

---

\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: '把代码读成地图，而不是树',
        description:
          '文件树告诉你字节存在哪里，但不告诉你代码如何流动。OpenCockpit 新的 Code Map 视图把任意源文件渲染为函数 chip 画布——左侧列出谁调用了这个函数，右侧列出它调用了谁，点击 pin 即可跳转。陌生代码库五次点击就能走完一遍鉴权流程。下面是 5 个真实使用场景。',
        readingTime: '阅读约 7 分钟',
        body: `你 clone 了一个新仓库。\`npm install\`、\`npm run dev\`，跑起来了。

接下来要真正**读懂**它。

文件树展开：47 个文件夹、312 个文件。其中几个叫 \`utils\`、几个叫 \`lib\`、一个叫 \`core\` 还有一个叫 \`kernel\`（你怀疑它们重叠）。从哪开始？大概 \`index.ts\` 吧。20 分钟之后你已经飘进了第三层子目录，开了 11 个 tab，仍然不知道你要修的那个 bug 入口在哪个函数里。

文件树告诉你的是**字节存在哪里**，而不是**代码怎么流动**。

## 换一个单位

Cockpit 新的 Code Map 把"单位"换掉了。你看到的不再是"文件夹里的文件"，而是**函数 + 它们之间的连线**。

每个函数变成画布上的一张卡片：

- **中间是函数体** —— 真实代码、语法高亮。
- **左侧**：所有调用这个函数的地方（caller）。
- **右侧**：这个函数调用的所有目标（callee）。
- 两侧每一项都可点击。点一下，画布平移到那个函数。

整个界面就这么简单。文件树还在，想要随时切回去。但只要你点进一个文件，你看到的就不再是 "\`payment.ts\` 第 1–840 行"，而是四张 chip：\`chargeCard\`、\`refund\`、\`webhookHandler\`、\`recordLedgerEntry\` —— 每张都画着自己的进出箭头。

## 场景一：新仓库的第一天

这是 Code Map 最初被造出来要解决的场景。早上 9 点入职，10 点你被要求"看一下我们的鉴权流程"。靠文件树，这是一场 90 分钟的"找地鼠"。靠 Code Map：

1. 打开你猜是入口的文件 —— \`routes/auth.ts\`。
2. 文件里五个路由处理函数各自变成一张 chip。
3. 选你关心的那个：\`loginHandler\`。这张 chip 高亮。
4. 右侧列出：它调用了 \`validateCredentials\`、\`issueToken\`、\`recordLogin\`。点击 \`validateCredentials\`。
5. 画布平移。现在 \`validateCredentials\` 在中间。它的 callee 是 \`hashPassword\` 和 \`lookupUser\`；它的 caller —— 左侧 —— 告诉你它还被 \`resetPassword\` 调用，而你之前根本不知道有这个函数。

五次点击就把鉴权树走完了。没 \`grep\` 过 "login"，没在 \`utils/index.ts\` 里迷路。**这张地图本来就藏在代码里 —— 只是需要有人把它画出来。**

## 场景二：追一个你不放心的调用

这是每个资深工程师都会偷偷做、却没人教新人的事：当你对一个函数为什么被调用感到不安，你会**沿着调用链往上走**，直到看清入口。

传统做法是 **grep + 直觉**。\`grep -r 'createOrder'\` 命中 23 次：19 个在测试里，2 个在注释里，2 个是真正的调用点。你打开两个，上下翻找，琢磨哪个"先发生"。

在 Code Map 里，\`createOrder\` 左侧那一列**就是答案**。已排序、已去重，默认不混测试文件（除非你要看）。点每一项就跳到具体那行。"这个函数到底是从哪里被调用的"这个问题，从五个 tab 的挖掘变成 10 秒钟的视觉检查。

## 场景三：评审 AI 写的 PR

你让 Claude "修一下限流器的 bug"。它给你交出 8 个文件、3 个目录的改动。Diff 看上去合理。你正打算 Approve。

**先别。**

把同样这些文件切到 Code Map。Diff 不再是一长串 \`+/-\` 行，而是一张 chip 视图，**改动过的函数被高亮**，周围还画着它们的 caller 和 callee。你立刻能看到：

- Agent 改了 \`rateLimit\`。它的 caller 是 \`apiHandler\` 和 \`webhookHandler\`。这次改动会不会把 webhook 那条路径搞坏？点进去，读 chip，30 秒搞定。
- 它还改了 \`getClientIp\`，这个函数有**11 个 caller**，其中一半在鉴权子系统里。Agent 没在 PR 里提这件事。你大概率得先把这 11 处都看一遍再 approve。

你自己写的 PR 这么做有点小题大做。但凌晨 3 点 Agent 趁你睡觉时写的 PR，这就是"我相信它"和"我应该相信它"之间的差别。

## 场景四：跨文件追 bug

用户报告："偶尔刷新一下，购物车会丢一件商品。"你的猜测是 \`syncCart\` 里有竞态。在 Code Map 里打开 \`syncCart\`。

五个 callee：一个 \`fetchCart\`、两个 \`mergeCart\` 的变体、一个看上去可疑的 \`dedupeItems\`。点击 \`dedupeItems\`，函数体里有一个以 \`id\` 为 key 的 \`Set\` —— 但 bug 报告里说有些商品 id 相同、**尺寸不同**。**抓到了。**

三次点击。没 \`grep\`、没有"开十个 tab 上下翻滚"。地图把"出 bug 的那一节"放在你眼前，是因为它周围的 chip 给了你正确的上下文。

## 场景五：飞机上、没有 LSP，照样能读

Code Map 完全跑在你笔电上，由 tree-sitter 解析。没有 language server、没有项目索引、没有后台守护进程。打开一个目录，立刻有 chip 视图。合上电脑、飞去柏林，飞机上打开同一个目录 —— 还是那张 chip 视图，零索引等待。

这件事比听上去重要。基于 LSP 的工具（VSCode 的 "find references"、JetBrains 的 "show callers"）都需要项目完全启动：\`tsconfig\` 解析完、\`pip install\` 装完、\`go.mod\` 完整。Code Map 跳过这些前置。它像一个仔细的人类读者那样读你的代码：能解析就能出 chip 视图，仅此而已。

目前支持 **TypeScript / JavaScript、Python、Go、Rust**。作为用户，你只需要知道这一句。

## 什么时候*不*用它

老实说：Code Map 没打算取代你的编辑器。如果你正在**写**新代码，你应该在 Explorer 的常规视图里，带着光标和 LSP 类型提示。Code Map 是为了你**写之前**的那一刻 —— 你需要先读懂。

一个有用的分工：

- **文件树 + 编辑器**：你已经知道要改什么、改在哪。
- **Code Map**：问题是"什么调用了什么，我该从哪里下手？"

你会一整天在两者之间来回切。它们看的是同一份文件，回答的是不同的问题。

## 上手

打开 Cockpit → Explorer → 打开任意源文件 → 点 **Code Map** 切换。Chip 视图替换原来的编辑器面板 —— 同一个文件，换一个镜头。点击 callee pin 飞到下一个函数。读完了切回来。

那个你从一月就想读、一直没动的仓库？现在是 5 分钟的 walkthrough。

---

\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
    },
  },
  {
    slug: 'deepseek-in-cockpit',
    date: '2026-04-30',
    keywords: [
      'DeepSeek',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'agentic coding',
      'OpenCockpit',
      'Cockpit',
      'AI coding assistant',
      'multi-model',
      'cheap AI coding',
    ],
    content: {
      en: {
        title: 'Set Up DeepSeek in OpenCockpit',
        description:
          'Connect DeepSeek to OpenCockpit with your API key. Use it to edit files, run terminal commands and review diffs in the same workspace.',
        readingTime: '4 min read',
        body: `If you already use Cockpit with Claude, you have a workflow: open a tab, ask the agent to fix a bug, watch it edit files, run tests, hand you a clean diff. Slash commands like \`/qa\` and \`/fx\` are muscle memory.

Now you can do all of that with **DeepSeek** instead — usually at a fraction of the cost. As of v1.0.195, DeepSeek sits next to Claude in the new-tab menu, and everything you already know how to do works exactly the same.

## Setup: under a minute

1. **Get a key.** Go to [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys), create one, copy it.
2. **Open a DeepSeek tab.** Click the \`+\` on the tab bar, pick **DeepSeek**.
3. **Paste the key.** A blue **Set API key** pill appears in the chat header. Click it, paste, hit **Save**.
4. **Send a message.** That's it.

Everything runs locally. Nothing leaves your machine except the request to DeepSeek itself.

## Pick a model from the same pill

Once the key is in, that pill turns into the current model name. Click it again to switch:

- **\`deepseek-v4-pro\`** — the default. Use it for the kind of tasks you'd give Claude Sonnet: refactors, debugging, multi-file edits, writing tests.
- **\`deepseek-v4-flash\`** — faster and cheaper. Great for "do this small thing" tasks: rename a function, write a one-off script, summarize a file.

You can have one tab on \`pro\` and another on \`flash\` at the same time. Each tab remembers its own model.

## What it can do (spoiler: everything)

The whole point of plugging DeepSeek into Cockpit is that **nothing else changes**. In a DeepSeek tab the agent can still:

- **Read and edit files** in your project.
- **Run terminal commands** — install deps, run tests, start a dev server.
- **Search the codebase** with Grep / Glob.
- **Browse the web** — \`WebFetch\` and \`WebSearch\` work the same.
- **Run your slash commands** — \`/qa\` to clarify before coding, \`/fx\` to diagnose a bug, \`/cg\` to explore the project graph.
- **Spawn sub-agents** for parallel research / refactor work.
- **Take screenshots / pasted images** as input.
- **Pick up where you left off** — close the tab, reopen tomorrow, the conversation is right there.

If you've built habits around Cockpit's Claude experience, your habits transfer over wholesale. Same buttons, same shortcuts, same flow.

## A few real workflows worth trying

**The "cheap second opinion".** Open two tabs side-by-side: one Claude, one DeepSeek-v4-pro. Paste the same prompt into both. Compare answers. You'll learn fast which model your codebase prefers — and the comparison itself usually surfaces a better question.

**Bulk grunt work on Flash.** That afternoon of "rename this prop across 40 files, update the storybook stories, regenerate types" — point a Flash tab at it. It's plenty smart for mechanical changes, and noticeably faster.

**\`/fx\` on DeepSeek.** Bug-evidence mode (\`/fx The login modal sometimes flashes empty\`) works particularly well here — the agent reads the failing path, builds a hypothesis, and stays out of your code until you say go.

**Long sessions without the bill anxiety.** Long agent conversations on Claude can get expensive once the context grows. DeepSeek's pricing means you can let a session breathe — keep iterating, keep showing it more files, keep refining — without watching the meter.

## Things kept clean and separated

Two practical promises about how DeepSeek lives next to Claude on your machine:

- **Conversations don't mix.** A DeepSeek session is stored separately from your Claude history. Searching Claude history won't surface DeepSeek replies, and vice versa.
- **Credentials don't leak.** Your Claude login and your DeepSeek key live in different places. One has nothing to do with the other.

You can swap between Claude and DeepSeek tabs all day and never worry about cross-contamination.

## How to start right now

\`\`\`bash
npm i -g @surething/cockpit
cockpit
\`\`\`

Open the app, pick **DeepSeek** from the new-tab menu, paste your key, ask it to fix something. If it understands your codebase as well as Claude does, the cost per task may surprise you.

---

\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: 'OpenCockpit 用上 DeepSeek：你的 Claude 习惯一个都不用改',
        description:
          'OpenCockpit 现在能直接对接 DeepSeek：开个 Tab、贴个 Key，DeepSeek-v4 就能像 Claude 一样改你的文件、跑你的终端、评你的 diff。这篇讲怎么 1 分钟内配好，以及配好之后能做什么。',
        readingTime: '阅读约 4 分钟',
        body: `如果你已经在用 Cockpit + Claude，你已经有了一套工作流：开个 Tab、让 Agent 修个 Bug、看它改文件、跑测试、给你一份干净的 diff；\`/qa\`、\`/fx\` 这些斜杠指令早就是肌肉记忆。

现在你可以把这一整套照搬到 **DeepSeek** 上跑 —— 而且通常便宜很多。从 v1.0.195 开始，DeepSeek 跟 Claude 一起出现在新 Tab 菜单里，你已经会的所有操作都不用改。

## 配置：不到一分钟

1. **拿一个 Key。** 去 [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) 新建一个，复制下来。
2. **开一个 DeepSeek Tab。** Tab 栏点 \`+\`，选 **DeepSeek**。
3. **贴 Key。** 聊天面板顶部会出现一颗蓝色胶囊 **Set API key**，点它，把 Key 粘上去，**Save**。
4. **发消息。** 就这样。

一切都在本地完成。除了发给 DeepSeek 的那次请求，没有任何东西会离开你的电脑。

## 模型在同一颗胶囊里切换

Key 配好之后，那颗胶囊会显示当前模型名。再点它就能切换：

- **\`deepseek-v4-pro\`** —— 默认。给它的活就是你平时给 Claude Sonnet 的活：重构、Debug、多文件改动、写测试。
- **\`deepseek-v4-flash\`** —— 更快、更便宜。适合 "顺手做个小事"：改个函数名、写个一次性脚本、总结一个文件。

你可以一个 Tab 用 \`pro\`、另一个用 \`flash\` 同时开着。每个 Tab 自己记住自己用的模型。

## 它能做什么（剧透：都能）

把 DeepSeek 接进 Cockpit 的核心理由就是：**别的什么都不用变**。在 DeepSeek Tab 里，Agent 一样能：

- **读你的文件、改你的文件**。
- **跑终端命令** —— 装依赖、跑测试、起 dev server。
- **搜代码** —— Grep / Glob 都在。
- **上网** —— \`WebFetch\`、\`WebSearch\` 一样工作。
- **跑你的斜杠指令** —— \`/qa\` 上线前对齐需求、\`/fx\` 排查 Bug、\`/cg\` 探索项目图谱。
- **派生子 Agent** 做并行调研或重构。
- **吃截图 / 粘贴的图片** 作为输入。
- **断线续聊** —— 关掉 Tab，明天再打开，对话还在原地。

如果你已经围绕 Cockpit 的 Claude 体验养出了一整套习惯，这些习惯整个搬过来就行。同样的按钮、同样的快捷键、同样的流程。

## 几个值得一试的真实玩法

**"廉价的二次意见"。** 并排开两个 Tab：一个 Claude、一个 DeepSeek-v4-pro，把同一个 Prompt 粘进去，看两边的答案。你很快会摸出你的代码库更对哪个模型的胃口 —— 而且对比本身往往能让你想出更好的问题。

**Flash 跑批量琐事。** 那种 "把这个 prop 在 40 个文件里改名、顺带更新 storybook、再重新生成 types" 的下午活儿，丢给 Flash Tab。机械改动它够聪明，而且明显更快。

**用 DeepSeek 跑 \`/fx\`。** Bug 证据链模式（\`/fx 登录弹窗有时候会闪一下空白\`）在这里特别好用 —— Agent 读一遍调用路径、给出假设、在你点头之前一行代码都不动。

**长 Session 不再心疼账单。** 在 Claude 上长对话一旦上下文堆起来就开始烧钱。DeepSeek 的定价让你可以放手让 Session 自然展开 —— 多迭代几轮、多塞几个文件给它看、慢慢打磨 —— 不用一直盯着计价器。

## 干净的隔离

两个实际承诺，关于 DeepSeek 在你机器上跟 Claude 怎么共处：

- **对话不串。** DeepSeek 的会话跟 Claude 的历史分开存。在 Claude 历史里搜不到 DeepSeek 的回复，反之亦然。
- **凭据不串。** 你的 Claude 登录和你的 DeepSeek Key 存在不同的地方，互不干涉。

你可以一整天在 Claude Tab 和 DeepSeek Tab 之间来回切，完全不用担心污染。

## 现在就开始

\`\`\`bash
npm i -g @surething/cockpit
cockpit
\`\`\`

打开应用，从新 Tab 菜单里选 **DeepSeek**，把 Key 粘进去，让它修点东西。如果它对你的代码库的理解能跟 Claude 持平，每个任务的成本可能会让你有点意外。

---

\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },
  {
    slug: 'chat-to-skill',
    date: '2026-04-30',
    keywords: [
      'Claude Code skills',
      'SKILL.md',
      'Claude Code custom commands',
      'Claude Code memory',
      'prompt library',
      'AI workflow capture',
      'slash commands',
      'skillify',
      'OpenCockpit',
      'Cockpit',
      'team prompt sharing',
      'Anthropic skills',
    ],
    content: {
      en: {
        title: 'Turn an AI Chat into a Reusable Skill',
        description:
          'Save lessons from an AI coding session as a SKILL.md in your own knowledge base, then register it as a slash command in OpenCockpit.',
        readingTime: '6 min read',
        body: `Yesterday I spent **28 minutes** walking Claude through our OAuth refresh-token flow. Token endpoint, leeway window, two custom claims, the one staging-only quirk. Bug found, fixed, shipped.

This morning, almost the same problem in a sister service. I open a new chat. The agent has no memory of yesterday. **28 minutes again.**

This isn't an Anthropic limitation. Stateless agents are the right default — you don't want yesterday's wrong assumption haunting tomorrow's session. The fix isn't "give the AI memory". The fix is **give yourself memory, in a place the agent will read again.**

That place is a Skill.

## What a Skill actually is — and where it should live

A Skill is one Markdown file. Nothing more. Cockpit only cares about two things: the file's content (which becomes the system prompt for \`/skill-name\`) and an absolute path that points at it.

The path is the design choice that matters most. Anthropic's reference convention puts skills under \`~/.claude/skills/\`. Cockpit deliberately does **not** do that. **We don't scan your home directory. We don't reserve a folder name. Your skills can live anywhere you want them to live**:

- \`~/Notes/Skills/oauth-debug/SKILL.md\` — alongside your personal notes
- \`~/Documents/team-playbooks/oauth-debug/SKILL.md\` — in a synced folder
- \`~/Work/our-handbook/skills/oauth-debug/SKILL.md\` — inside a git'd team repo
- \`~/Obsidian/Vault/Skills/oauth-debug/SKILL.md\` — inside your Obsidian vault
- \`./.claude/skills/oauth-debug/SKILL.md\` — Anthropic-style, if you prefer

Each skill is its own folder. The Markdown file is named \`SKILL.md\` (Anthropic convention) and the folder name becomes the slash command. Why a folder per skill? Because skills frequently grow companion files — example transcripts, a reference cheat-sheet, a small Python helper the agent calls — and a folder gives them somewhere natural to live.

**Why this matters:** your knowledge already lives somewhere. You have a vault, a notes app, a docs repo, a "Skills" folder you've curated for years. Forcing skills into \`~/.claude/skills/\` would be Cockpit picking a fight with your existing system. We register pointers instead.

### The two-step flow

**Step 1.** Write the SKILL.md in *your* knowledge base. Whatever path you want.

**Step 2.** In Cockpit's Skills sidebar, click **+ Add Skill** and paste the absolute path. Cockpit stores it in \`~/.cockpit/skills.json\` (one file, one list of pointers, easy to back up).

That's it. The skill is now in your slash autocomplete. You can edit the source file directly in your editor of choice — Cockpit watches it, picks up changes on save, no re-import.

What Cockpit then gives you on top:

- **Skills sidebar**: lists every registered skill with name, description, icon, source path, last-used time
- **Slash autocomplete**: \`/\` in chat shows your skills mixed with built-ins like \`/qa\`, \`/fx\`, \`/cg\`
- **Validity checks**: red "Invalid" badge if the source file disappears (you renamed it, moved the vault) — fix the path, skill comes back
- **Preview**: click any skill to render the markdown full-page, or view raw source

## The crystallize loop

The trick isn't writing skills by hand. The trick is **letting the conversation that just succeeded write the skill for you.**

Three messages at the end of every productive session:

**Message 1 — distill**

> Summarize what we just figured out about the OAuth refresh flow.
> Be concrete: file paths, the actual root cause, what we'd check next time.

The agent now has the conversation in its working set. It knows what mattered.

**Message 2 — encode**

> Now write that as a SKILL.md I can drop into my knowledge base
> at \`~/Notes/Skills/oauth-debug/SKILL.md\` (or wherever you keep yours).
>
> Shape: when invoked, it should take a problem statement, walk
> through the same diagnostic steps we used today, in the same order,
> and refuse to suggest a fix until step 4. Keep it under 40 lines.

You'll get something like:

\`\`\`markdown
---
name: oauth-debug
description: Diagnose OAuth refresh-token failures using our debugging playbook.
---

You diagnose OAuth refresh-token failures in our auth stack.

When the user describes a failure, follow these steps in order:

1. Confirm which environment (dev / staging / prod). Staging has a
   60-second leeway window; prod does not.
2. Read \`auth/refresh.ts\` and identify which JWT claims are validated.
   We require both \`sub\` and \`tid\` — never just \`sub\`.
3. Ask for the failing access token (or a redacted version). Decode
   the header and check \`alg\` — must be RS256, never HS256.
4. Check \`auth/keys.ts\` for the JWKS cache TTL. We've shipped 3 bugs
   in 2 years from stale JWKS.
5. Only after the above, propose a fix.

Never edit code until step 5. If the user asks earlier, restate the
remaining diagnostic steps and ask them to choose.
\`\`\`

**Message 3 — save**

> Save it to that path.

If you've given the agent write access to your knowledge base, it'll create the file itself. Otherwise copy-paste from the chat into your editor — same outcome. The file now lives in your notes, indexed by your existing search, version-controlled by your existing git, synced by your existing Dropbox / iCloud / Syncthing. *It is not Cockpit's data.*

**Then register it.** In Cockpit's Skills sidebar, click **+ Add Skill**, paste the absolute path:

\`\`\`
/Users/you/Notes/Skills/oauth-debug/SKILL.md
\`\`\`

(One-time, takes 5 seconds.) From here on, \`/oauth-debug\` shows up in the slash autocomplete in every chat. Edit the source file from anywhere — your editor, another machine, a teammate's PR — and Cockpit picks it up on next file-system event.

## Tomorrow morning

\`\`\`
/oauth-debug Token refresh failing intermittently in staging only.
\`\`\`

The agent enters the **same posture** you trained yesterday. Same checks, same order, same refusal to jump to fixes. Not because it remembers — because **you wrote yesterday down, somewhere it will read again.**

The 28 minutes from yesterday is now a 30-second invocation.

## Three skill shapes that earn the file

Not every conversation deserves a skill. The ones that do tend to fall into three shapes:

**Diagnostic skills** — \`/oauth-debug\`, \`/db-deadlock\`, \`/cors-issue\`, \`/flaky-test\`. Freeze a debugging procedure. The agent gets a checklist instead of guessing.

**Convention skills** — \`/our-pr-style\`, \`/our-test-style\`, \`/our-error-handling\`. Freeze your team's tribal knowledge. New contributor on day one types \`/our-pr-style\` and the agent writes PRs that pass review without 4 rounds of nitpicks.

**Onboarding skills** — \`/our-stack\`, \`/our-deploy-flow\`, \`/where-does-X-live\`. Explain your codebase to a fresh agent. This is the highest-leverage one — every new chat in your repo starts with the right map.

If a conversation doesn't fit one of these, it's probably a one-off. Don't crystallize it.

## Skills as team assets

Because skills are just markdown files at paths *you* choose, the team-asset story falls out for free. Pick a repo your team already trusts:

\`\`\`
~/Work/our-handbook/skills/
├── README.md             # how to write a skill, how to register it
├── oauth-debug/
│   ├── SKILL.md
│   └── examples.md       # optional companion files the skill can reference
├── our-pr-style/
│   └── SKILL.md
└── our-deploy-flow/
    ├── SKILL.md
    └── runbook.md
\`\`\`

Now skills are diffable, reviewable, \`git blame\`-able. The senior engineer's "always do X but never Y" stops being a Slack DM and becomes a PR with a reviewer. New hires \`git pull\`, click **+ Add Skill** three times, and the team's tacit knowledge is in their slash menu before the end of day one.

Cockpit's LAN-shared review surface (see [our previous post](/en/blog/claude-code-gui-comparison/)) makes the inner loop tighter: write a skill in chat, share the review page over LAN, teammate comments line-by-line, send their comments back to the agent as context, agent revises the skill, you commit.

The point: **skills don't make a copy of your team's knowledge. They reference it.** When the handbook updates, the skill updates. There's only one source of truth, and it's already where your team keeps source of truth.

## Meta: a built-in skill that writes skills

You don't even have to write the meta-skill yourself — Cockpit ships one. At the end of a session, type \`/skillify\`:

\`\`\`
/skillify
\`\`\`

It reads the conversation, decides whether anything is *actually* worth crystallizing (most sessions aren't — it says so and stops, no file forced), and if so drafts the SKILL.md for you. Point it at a directory and it saves there — the same knowledge base you'd have chosen by hand:

\`\`\`
/skillify ~/Notes/Skills
\`\`\`

Then register it once with **+ Add Skill**, exactly as above. Now your Skills sidebar fills itself, slowly, from the conversations you actually have. Cockpit ships \`/qa\`, \`/fx\`, \`/cg\` as opinionated defaults — but the **best skills in your sidebar a year from now will be ones you didn't write by hand.**

## The bigger principle

Stateless agents are correct. They reset between conversations because that's how you avoid yesterday's wrong assumption breaking tomorrow's session.

But your **team** isn't stateless. Your team learns. The question is whether that learning lives in three engineers' heads or in 12 reviewed Markdown files in \`./.claude/skills/\`.

Skills are how you make that choice explicit.

---

\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: '把对话沉淀成技能：让昨天那 28 分钟变成今天的 /命令',
        description:
          '每一次高质量的 Claude Code 对话都会沉淀一堆"暗知识"，默认情况下随对话一起死掉。OpenCockpit 的 Skills 功能让 Agent 把对话浓缩成一个 SKILL.md —— 存到 *你的* 知识库（而不是 Cockpit 强占的目录），再注册为斜杠指令。你的笔记还住在它本来该住的地方，Cockpit 只是持有那个指针。',
        readingTime: '阅读约 6 分钟',
        body: `昨天我花了**整整 28 分钟**带着 Claude 把我们 OAuth 刷新令牌流程过了一遍。Token 端点、leeway 窗口、两个自定义 claims、那个仅 staging 环境才有的怪癖。Bug 找到、修掉、上线。

今天早上，姊妹服务里几乎一模一样的问题。我打开一个新对话。Agent 对昨天毫无记忆。**又是 28 分钟。**

这不是 Anthropic 的设计缺陷。**无状态 Agent 才是正确的默认值**——你不会希望昨天那个错的假设缠着今天的对话。解法不是"给 AI 记忆"，解法是**给你自己记忆，存在 Agent 明天会读到的地方。**

那个地方就是 Skill。

## Skill 是什么 —— 以及它该住在哪里

一个 Skill 就是一个 Markdown 文件，仅此而已。Cockpit 只关心两件事：文件正文（成为 \`/skill-name\` 的 system prompt）和指向它的绝对路径。

**路径是最重要的设计选择。** Anthropic 的官方约定是把 skills 放在 \`~/.claude/skills/\`。Cockpit **故意不这么做**。**我们不扫你的 home 目录、不预留某个文件夹名、不强占任何位置。你的 skills 想住哪里就住哪里：**

- \`~/Notes/Skills/oauth-debug/SKILL.md\` —— 跟你的个人笔记放一起
- \`~/Documents/team-playbooks/oauth-debug/SKILL.md\` —— 在同步目录里
- \`~/Work/our-handbook/skills/oauth-debug/SKILL.md\` —— 在团队 git 仓库里
- \`~/Obsidian/Vault/Skills/oauth-debug/SKILL.md\` —— 在你的 Obsidian 库里
- \`./.claude/skills/oauth-debug/SKILL.md\` —— 偏好 Anthropic 风格也行

每个 skill 是独立的子文件夹，里面放一个 \`SKILL.md\`（Anthropic 约定），文件夹名就是斜杠命令名。为什么一个 skill 一个文件夹？因为 skill 经常会带"伙伴文件" —— 示例对话、参考小抄、一个被 agent 调用的 Python 辅助脚本 —— 文件夹给它们一个自然的家。

**为什么这事重要：** 你的知识本来就住在某个地方。你有 vault、有笔记软件、有文档仓库、有自己经营多年的"Skills"目录。强迫 skills 进 \`~/.claude/skills/\` 等于让 Cockpit 跟你已有的体系打架。我们选择**只注册指针，不搬运文件。**

### 两步流

**第 1 步：** 在 *你的* 知识库里写 SKILL.md，路径随你定。

**第 2 步：** 在 Cockpit 的 Skills 侧边栏点 **+ Add Skill**，粘贴绝对路径。Cockpit 把它存进 \`~/.cockpit/skills.json\`（一个文件、一份指针列表，备份方便）。

完事。这个 skill 现在出现在你的斜杠补全里。源文件你想用什么编辑器改都行 —— Cockpit 监听文件变化、保存即生效，无需重新 import。

在此基础上，Cockpit 给你的额外能力：

- **Skills 侧边栏**：每个已注册技能的名称、描述、图标、源路径、最后使用时间
- **斜杠补全**：在对话里打 \`/\`，你的技能跟内置 \`/qa\`、\`/fx\`、\`/cg\` 混排出现
- **有效性检测**：源文件不见了（你改名、移动了 vault），红色 "Invalid" 徽标提醒你 —— 改路径就能恢复
- **预览**：点任意技能可以全屏渲染 markdown 或查看原始源码

## 沉淀循环（真正的工作流）

诀窍不是手写 skills。诀窍是**让刚刚奏效的对话自己写 skill 给你。**

每一次成功的对话末尾，加三句话：

**第 1 句：浓缩**

> 总结一下我们刚才搞清楚的 OAuth 刷新流程。
> 要具体：文件路径、真正的根因、下次该先查什么。

Agent 现在把整段对话拉到了工作集里。它知道什么是关键。

**第 2 句：编码**

> 把它写成一个 SKILL.md，我要放进我的知识库
> \`~/Notes/Skills/oauth-debug/SKILL.md\`（或者你自己习惯的位置）。
>
> 形态：被调用时接收一个问题陈述，按今天的同样顺序走完同样的诊断步骤，
> 第 4 步之前不许提修复方案。控制在 40 行以内。

你会拿到类似这样的输出：

\`\`\`markdown
---
name: oauth-debug
description: 用我们的诊断剧本排查 OAuth 刷新令牌失败。
---

你负责诊断我们鉴权栈中的 OAuth 刷新令牌失败问题。

当用户描述故障时，按以下顺序执行：

1. 确认是哪个环境（dev / staging / prod）。Staging 有 60 秒的 leeway
   窗口，prod 没有。
2. 读 \`auth/refresh.ts\`，找出验证了哪些 JWT claims。我们要求同时
   存在 \`sub\` 和 \`tid\`，绝不能只验 \`sub\`。
3. 索取失败的 access token（或脱敏版）。解码 header 检查 \`alg\`，
   必须 RS256，永远不允许 HS256。
4. 看 \`auth/keys.ts\` 里 JWKS 的缓存 TTL。两年里有 3 个 bug 来自
   过期的 JWKS 缓存。
5. 只有走完上面 4 步，才允许提修复方案。

第 5 步前绝不修改代码。如果用户提前要修，复述剩下的诊断步骤让用户选。
\`\`\`

**第 3 句：保存**

> 存到那个路径。

如果你给了 Agent 对你知识库目录的写权限，它会自己建文件。否则从对话里复制粘贴到你的编辑器 —— 效果一样。文件现在住在你的笔记里、被你已有的搜索索引、被你已有的 git 版本化、被你已有的 Dropbox / iCloud / Syncthing 同步。**它不是 Cockpit 的数据。**

**然后注册它。** 在 Cockpit 的 Skills 侧边栏点 **+ Add Skill**，粘贴绝对路径：

\`\`\`
/Users/you/Notes/Skills/oauth-debug/SKILL.md
\`\`\`

（一次性，5 秒钟。）从此 \`/oauth-debug\` 出现在所有对话的斜杠补全里。源文件你在哪儿改都行 —— 你的编辑器、另一台机器、队友的 PR —— Cockpit 在下一次文件系统事件时自动捡起来。

## 明天早上

\`\`\`
/oauth-debug 刷新令牌只在 staging 偶发失败。
\`\`\`

Agent 自动进入你昨天训练过的**同款姿态**。同样的检查、同样的顺序、同样的"先别急着修"。不是因为它记得——而是**你把昨天写下来了，写在了它会再读的地方。**

昨天的 28 分钟，今天浓缩成一次 30 秒的调用。

## 值得"立此存照"的三种 skill 形态

不是每段对话都值得做成 skill。值得的那些通常是这三类：

**诊断型** —— \`/oauth-debug\`、\`/db-deadlock\`、\`/cors-issue\`、\`/flaky-test\`。把一套排查流程冻结成 checklist，Agent 不用再瞎猜。

**约定型** —— \`/our-pr-style\`、\`/our-test-style\`、\`/our-error-handling\`。把团队的部落知识冻结下来。新人入职第一天敲 \`/our-pr-style\`，Agent 写出来的 PR 一次过 review，不用 4 轮 nitpick。

**Onboarding 型** —— \`/our-stack\`、\`/our-deploy-flow\`、\`/where-does-X-live\`。给新 Agent 解释你的代码库。**这一类杠杆最高**——每一次新对话都从一张正确的地图开始。

不属于这三类的对话，多半是一次性的，不必沉淀。

## Skill 作为团队资产

正因为 skill 只是 *你选定路径下* 的 markdown 文件，团队资产这一层几乎是白送的。挑一个团队已经信任的仓库就行：

\`\`\`
~/Work/our-handbook/skills/
├── README.md             # 怎么写技能、怎么注册到 Cockpit
├── oauth-debug/
│   ├── SKILL.md
│   └── examples.md       # 可选：技能可以引用的伙伴文件
├── our-pr-style/
│   └── SKILL.md
└── our-deploy-flow/
    ├── SKILL.md
    └── runbook.md
\`\`\`

Skill 因此可以 diff、可以 review、可以 \`git blame\`。Senior 那句"始终做 X、绝不做 Y"不再是一条 Slack 私信，而是一个有 reviewer 的 PR。新人 \`git pull\` 完，点 3 下 **+ Add Skill**，团队的隐性知识在他第一天结束前就出现在斜杠菜单里。

Cockpit 的局域网共享评审页（参见[上一篇博客](/zh/blog/claude-code-gui-comparison/)）让内循环更紧：在对话里写出 skill、把评审页面分享到局域网、队友逐行评论、把评论喂回 Agent 作为上下文、Agent 修订、你 commit。

关键是：**Skill 不是把团队的知识复制了一份，而是引用了它。** 当 handbook 更新，skill 就更新。**只有一个事实来源**，而且就是你团队本来存放事实的地方。

## 进阶：内置一个"写 skill 的 skill"

连这个 meta-skill 你都不用自己写 —— Cockpit 直接内置了。在一段对话末尾敲 \`/skillify\`：

\`\`\`
/skillify
\`\`\`

它会读这次对话，先判断有没有*真正*值得沉淀的东西（多数对话没有 —— 它会直说并停下，不硬凑文件），有的话就替你起草 SKILL.md。给它一个目录，它就存进去 —— 就是你本来会手动选的那个知识库：

\`\`\`
/skillify ~/Notes/Skills
\`\`\`

然后照上面那样用 **+ Add Skill** 注册一次即可。从此你的 Skills 侧边栏会**自己慢慢长出来**，从你真实进行的对话里长出来。Cockpit 内置的 \`/qa\`、\`/fx\`、\`/cg\` 是有主见的默认值——但**一年后你侧边栏里最好用的那些 skill，多半不是你手写的。**

## 背后的原则

无状态 Agent 是对的。它在每段对话之间重置自己，因为这样昨天那个错的假设才不会污染今天的对话。

但你的**团队**不是无状态的。团队会学习。问题只是：那些学习到的东西，是住在三位工程师的脑子里，还是住在 \`./.claude/skills/\` 下 12 个被 review 过的 Markdown 文件里。

**Skills 就是把这个选择显式化的方式。**

---

\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },

  {
    slug: 'parallel-claude-code-sessions',
    date: '2026-04-29',
    keywords: [
      'Claude Code',
      'parallel Claude Code',
      'multi-project AI',
      'Claude Agent SDK',
      'OpenCockpit',
      'Cockpit',
      'AI coding workflow',
    ],
    content: {
      en: {
        title: 'Run Claude Code Sessions in Parallel',
        description:
          'Manage parallel Claude Code sessions across projects in OpenCockpit. Organize tabs, track progress and control context switching and token use.',
        readingTime: '6 min read',
        body: `Most Claude Code users hit the same wall after a week:

> *"Once I have 3 projects on the go, my terminal is chaos."*

You spawn one \`claude\` session in project A. Spin up another in project B. Tab back. Forget which one is which. Re-paste your context twice. Your shell scrollback eats half the conversation. Eventually you give up and serialize — one project at a time — and AI productivity collapses to "single-threaded human".

This is exactly the problem **Cockpit** was built to fix.

## The mental model: one cockpit, many flights

Think of each Claude Code session as a flight. With raw \`claude\` CLI you are flying one plane at a time. **Cockpit puts every flight on a dashboard with named tabs, status badges, and notifications.**

Internally each session is a separate Claude Agent SDK process — fully isolated, with its own working directory, its own conversation, its own token budget. Your laptop is the air traffic controller; the AI is the pilot.

## Setting up parallel sessions

Install once:

\`\`\`bash
npm i -g @surething/cockpit
cockpit           # starts the cockpit at http://localhost:3457
\`\`\`

Open three projects:

\`\`\`bash
cockpit ~/work/api-server
cockpit ~/work/web-app
cockpit ~/work/data-pipeline
\`\`\`

Each \`cockpit <dir>\` adds a project tab to the same cockpit. Switching between them is one swipe / one keypress — no terminal juggling. *(The short \`cock\` alias works everywhere too — same command, fewer letters.)*

Inside each project you can spawn multiple Agent sessions. Common pattern:

| Tab | Session 1 | Session 2 |
|---|---|---|
| api-server | Refactor auth middleware | Write tests for refactor |
| web-app | Implement settings page | |
| data-pipeline | Investigate the prod-export bug | |

Each session runs concurrently. When any of them finishes (or asks a question), you get a desktop notification + a red-dot badge on the project tab.

## Why this is more than four terminal tabs

Three reasons it beats raw \`tmux\` / iTerm splits:

1. **Notifications you can trust.** Cockpit knows when an agent has actually paused for input vs. when it's still working. A red dot only shows up when *you* are the bottleneck.
2. **Cross-project session browser.** Cmd+K opens a flat list of every running and recent session across every project. "What was that thing I was debugging yesterday?" → one keystroke away.
3. **Shared shell + bubbles.** Each project gets its own xterm.js terminal, plus optional Browser / PostgreSQL / MySQL / Redis bubbles. The agent can drive any of them. So your "test the new auth flow in Chrome" task doesn't need a separate window.

## Cost: yes, you'll burn more tokens

Be honest about this. Running 5 sessions in parallel means up to 5× token spend. Two ways to keep it sane:

- Reserve cheap models for "always-on" sessions (e.g. \`/qa\` clarification mode), reserve Sonnet/Opus for the deep work tab.
- Use \`/qa\` (clarify-only) and \`/fx\` (diagnose-only) modes generously — they don't write code, so they don't compound.

## What "20× productivity" actually means

We don't actually believe in 20× productivity from AI. What we *do* believe is that AI agents are now I/O-bound on **you, the human**. Every minute you spend re-pasting context, switching terminals, or re-explaining what file you meant is a minute of agent idle time.

A cockpit is just an interface that respects how much I/O bandwidth a human has. Five quiet agents finishing tasks in the background, three coming back to you with questions in priority order — that's the actual upside.

---

**Try it:** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: '如何同时跑 5 个 Claude Code 会话不疯掉',
        description:
          'Claude Code 一次干一件事很强，但工程师真实场景常是：一个项目重构、一个项目写测试、一个项目排 bug，外加两个新需求脑暴。直接用裸 `claude` CLI 很快就会卡在终端切换上。这篇讲 OpenCockpit 是怎么用 Claude Agent SDK 把多项目并发会话跑顺的。',
        readingTime: '阅读约 6 分钟',
        body: `用了一周 Claude Code，多数人都会撞上同一个瓶颈：

> *"3 个项目同时进行的时候，我的终端就乱了。"*

A 项目里跑一个 \`claude\`。B 项目里再开一个。切回来、记不清哪个 tab 是哪个、重新粘贴上下文两遍、scrollback 吃掉了一半对话。最后你只能放弃，串行处理 —— 一次只搞一个项目 —— AI 生产力瞬间退化成"单线程人类"。

这正是 **Cockpit** 想解决的问题。

## 心智模型：一个驾驶舱，多个航班

把每一个 Claude Code 会话想成一架飞机。裸用 \`claude\` CLI 时你只能开一架。**Cockpit 把每架飞机摆到一个仪表盘上，有命名 tab、状态徽标和通知。**

内部每个会话都是一个独立的 Claude Agent SDK 进程 —— 工作目录、对话历史、Token 预算彼此完全隔离。你的笔记本是塔台，AI 是飞行员。

## 配置并发会话

安装一次：

\`\`\`bash
npm i -g @surething/cockpit
cockpit           # 启动驾驶舱，http://localhost:3457
\`\`\`

打开三个项目：

\`\`\`bash
cockpit ~/work/api-server
cockpit ~/work/web-app
cockpit ~/work/data-pipeline
\`\`\`

每个 \`cockpit <dir>\` 都会在同一个驾驶舱里加一个项目标签。项目间切换一滑动 / 一快捷键 —— 不再切终端。*（短别名 \`cock\` 同样可用 —— 同一条命令，少打几个字母。）*

每个项目内可以再开多个 Agent 会话。常见组合：

| 项目 | 会话 1 | 会话 2 |
|---|---|---|
| api-server | 重构鉴权中间件 | 给重构补测试 |
| web-app | 实现设置页 | |
| data-pipeline | 排查导出生产数据的 bug | |

所有会话并发执行。任意一个完成或提问时，你会收到桌面通知 + 项目标签的红点徽标。

## 它比开 4 个终端 tab 强在哪

三个理由：

1. **通知可信。** Cockpit 知道 Agent 是真停下等你回复，还是在干活。红点只在 *你* 成为瓶颈的时候出现。
2. **跨项目会话浏览。** Cmd+K 打开一个平铺列表，所有运行中 + 最近的会话一览无遗。"昨天我在调的那个东西去哪了？" —— 一个快捷键就能找回来。
3. **共享终端 + 气泡。** 每个项目有自己的 xterm.js 终端，外加可选的浏览器 / PostgreSQL / MySQL / Redis 气泡。Agent 都能驱动它们。"在 Chrome 里验证新登录流程"这种任务不用额外开窗。

## 代价：Token 会烧得多

实话实说。并行跑 5 个会话意味着 5 倍 Token 消耗。两个手段控制：

- 给"常驻"会话用便宜模型（比如 \`/qa\` 澄清模式），把 Sonnet / Opus 留给主力 tab。
- 大量使用 \`/qa\`（只澄清）、\`/fx\`（只诊断）模式 —— 它们不写代码、不会复利地烧 Token。

## "20× 效率"到底是什么意思

我们不真信"AI 带来 20× 效率"。我们相信的是：**AI Agent 已经被你这个人类的 I/O 卡住了。** 每一分钟你花在重新粘贴上下文、切终端、重解释"我说的是哪个文件"，都是 Agent 的空闲分钟。

驾驶舱不过是一个尊重"人类 I/O 带宽"的界面。五个安静的 Agent 在后台干活，三个按优先级排队回来问你 —— 这才是真正的提升点。

---

**试试看：** \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
      },
    },
  },

  {
    slug: 'claude-code-gui-comparison',
    date: '2026-07-02',
    keywords: [
      'Claude Code GUI',
      'Claude Code desktop',
      'Claude Code Desktop app',
      'Claude Code desktop vs Cockpit',
      'Claude Code CLI vs GUI',
      'Claude Code desktop vs CLI',
      'Claude Code 和 Claude Desktop 区别',
      'Cursor alternative',
      'Continue alternative',
      'Aider alternative',
      'Claude Code client',
      'AI IDE comparison',
    ],
    content: {
      en: {
        title: 'Claude Code CLI vs GUI vs Desktop (2026): Which to Use',
        description:
          'CLI for scripts and headless boxes, Desktop for single-machine polish, a GUI like OpenCockpit for parallel projects on any LLM. Plus IDE plugins and Aider.',
        readingTime: '8 min read',
        body: `*Updated July 2026 — added the redesigned official Claude Code Desktop app and Cockpit's self-hosting model.*

Anthropic ships Claude Code as a **CLI**. That decision is correct for power users — terminals are scriptable, composable, and don't crash. But it pushes a non-trivial chunk of "obvious wins" onto the user: history search, multi-project tab management, image attachments, in-context code review, embedded terminals.

This post is an honest comparison of the five ways most engineers actually use Claude Code in 2026.

## Option A: stay in the raw CLI

**When it wins:** scripts, CI, one-off refactors, headless servers.

The CLI is the source of truth. Everything else wraps around it. If you live in tmux + Vim and have muscle memory for shell pipes, the CLI is faster than any GUI for short tasks. Anthropic also keeps the CLI on the absolute leading edge — every new SDK feature lands here first.

**Where it hurts:** as soon as you have more than one Claude Code session active, you're in tmux territory. There's no built-in notion of "session inbox" or red-dot. Image attachment is awkward. Cross-project history is a \`grep\` exercise.

## Option B: the official Claude Code Desktop app

**When it wins:** you're all-in on Anthropic and want first-party polish on a single machine.

Anthropic rebuilt the desktop app around parallel sessions in April 2026: a sidebar for every active session, an integrated terminal, a rebuilt diff viewer, and **Routines** — automations that fire on a schedule, an API call, or a GitHub event. New Claude Code features land here first, and it needs zero setup beyond your Claude plan.

**Where it hurts:**
- Closed source, Claude only. No Codex, no DeepSeek, no local Ollama — if you want a second engine, you're running a second tool.
- Single-user desktop app. There's no "install once on the dev box, whole team connects" story.
- The agent can't drive your browser or databases — the preview pane is read-only.
- Requires a paid Claude plan or API billing.

## Option C: an IDE plugin (Cursor / Continue / Cline / Roo)

**When it wins:** you mostly edit code in one editor, in one project at a time.

Cursor in particular is a fantastic experience for the *single-file, single-project* loop. The autocomplete is integrated into the cursor (literally), the diff UX is smooth, and you can chat with your project without leaving the editor.

**Where it hurts:**
- Multi-project parallelism is the editor's "open multiple windows" feature, which is exactly the chaos Cockpit was built to fix.
- The agent doesn't easily reach into your terminal, browser, or database.
- You're tied to the editor's update cadence. Want a new Anthropic feature on day 1? You wait.

## Option D: Aider / TUI tools

**When it wins:** you want a chat-driven coding loop without leaving the terminal, but with better history than raw CLI.

Aider is great. It's older, more opinionated about commits, and a good fit for solo OSS work.

**Where it hurts:** still single-project at a time, still terminal-only, still no native multi-modal (browser, DB).

## Option E: Cockpit (an IDE-like workbench on top of the official Agent SDK)

**When it wins:**
- You manage 2+ projects in flight every day.
- You want notifications, red dots, and a real "session inbox".
- You want more engines than Claude: **Codex / DeepSeek / Kimi / local Ollama**, each in its own tab with its own key.
- Your work isn't just code — it touches a browser, a Postgres DB, or a Redis cache, and you'd like the agent to drive those too.
- Your team reviews code together, and you want a shared review surface that doesn't need a SaaS.
- You review what the agent did before trusting it: every file-touching tool call is [snapshotted](/en/docs/agent/snapshots/) — read a reply's changes like git history, including what \`Bash\` did.
- Your team shares a dev box: Cockpit is **web client–server**, so you [install it once and every teammate gets a seat](/en/blog/self-host-claude-code-gui-for-your-team/) — each in their own project or worktree.

**Where it hurts:**
- It's young (v1.0.x). You'll find rough edges.
- New Claude Code features arrive with a lag — Cockpit tracks Agent SDK releases; the CLI and official desktop app get them first.
- No cloud sync — though because it's client–server, self-hosting on one box and connecting from anywhere covers most of what people want cloud sync for.
- You still need Claude Code installed and configured. Cockpit doesn't replace the CLI, it stands on top of it.

## A side-by-side

| | Raw CLI | Official desktop | IDE plugin | Aider | **Cockpit** |
|---|---|---|---|---|---|
| Multi-project parallel | ❌ tmux required | ✅ sessions sidebar | ❌ multi-window | ❌ | ✅ first-class |
| Engines beyond Claude | ❌ | ❌ | ✅ varies | ✅ | ✅ Codex / DeepSeek / Kimi / Ollama |
| Browser / DB control | ❌ | ❌ preview only | usually ❌ | ❌ | ✅ Bubbles |
| Code review surface | git tools | diff viewer | PR provider | git | ✅ LAN-shared |
| Per-tool-call change history (what each Edit / **Bash** actually changed on disk) | ❌ | ❌ per-turn diff only | ⚠️ per-prompt checkpoints (Cursor) | ✅ auto git commits | ✅ snapshots incl. Bash, 7-day local |
| Automation | scripts | ✅ Routines (cron + API + GitHub) | ❌ | scripts | ✅ scheduled tasks (cron) |
| Self-host for a team | ❌ | ❌ | ❌ | ❌ | ✅ one dev box, every teammate a seat |
| Phone access | ssh | ✅ cloud sandbox | ❌ | ssh | ✅ any browser, your machine |
| Day-1 SDK features | ✅ | ✅ first party | wait | varies | ⏳ tracks SDK releases |
| Open source | ✅ | ❌ | mostly ❌ (Cursor) | ✅ | ✅ MIT |

## How to pick

- **Solo, one repo at a time, mostly editor-bound:** Cursor or your IDE of choice. Stop reading.
- **Solo, terminal-bound, want chat-driven coding:** Aider or raw CLI.
- **All-in on Anthropic, one machine, want first-party polish:** the official desktop app.
- **Multiple projects in flight, more engines than Claude, or your work crosses code+browser+DB:** Cockpit.
- **Team that wants a shared review surface without buying a SaaS:** Cockpit (the LAN-share review page is the single feature that justifies it on its own).
- **Team sharing one dev box:** Cockpit — [install once, every teammate gets a seat](/en/blog/self-host-claude-code-gui-for-your-team/).

The strongest argument *against* Cockpit is also the simplest: if your day is "open one project, do one thing, close laptop", you don't need a cockpit. You need a yoke.

---

Want to try? \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit)`,
      },
      zh: {
        title: 'Claude Code CLI vs GUI vs Desktop（2026）：该用哪个',
        description:
          '脚本和无界面服务器用 CLI，单机图形体验用官方 Desktop，多项目并行、接任意大模型用 OpenCockpit 这类 GUI。另附 IDE 插件与 Aider 对比。',
        readingTime: '阅读约 8 分钟',
        body: `*2026 年 7 月更新 —— 加入了改版后的官方 Claude Code Desktop，以及 Cockpit 的自托管模型。*

Anthropic 把 Claude Code 默认做成 **CLI**。这个选择对硬核玩家是对的 —— 终端可脚本、可组合、不容易崩。但它把一堆"明显该有"的能力推给了用户去自补：历史搜索、多项目 tab 管理、图片附件、嵌入式代码评审、内置终端。

这篇文章是 2026 年大家实际怎么用 Claude Code 的诚实对比。

## 方案 A：留在裸 CLI

**赢在：** 脚本、CI、一次性重构、无头服务器。

CLI 是真理之源。其他一切都是包在它外面的壳。如果你住在 tmux + Vim 里，对 shell 管道有肌肉记忆，那么短任务上 CLI 比任何 GUI 都快。Anthropic 还把 CLI 放在最前沿 —— 每个新 SDK 能力都先到这。

**痛点：** 一旦同时有 2 个以上的 Claude Code 会话，就要回到 tmux 那一套。没有"会话收件箱"、没有红点提示。图片附件麻烦。跨项目搜索靠 \`grep\`。

## 方案 B：官方 Claude Code Desktop

**赢在：** 你全押 Anthropic 生态，要单机上的第一方打磨体验。

Anthropic 在 2026 年 4 月围绕并行会话重构了桌面应用：会话侧边栏、内置终端、重做的 diff 视图，还有 **Routines** —— 可以按计划、API 调用或 GitHub 事件触发的自动化。Claude Code 新特性第一时间落在这里，有 Claude 订阅就零配置可用。

**痛点：**
- 闭源、仅 Claude。没有 Codex、没有 DeepSeek、没有本地 Ollama —— 想要第二个引擎，就得再开一个工具。
- 单机单人桌面应用。没有"开发机上装一次、全队一起飞"这回事。
- Agent 驱动不了你的浏览器和数据库 —— 预览面板是只读的。
- 需要付费 Claude 订阅或 API 计费。

## 方案 C：IDE 插件（Cursor / Continue / Cline / Roo）

**赢在：** 你主要在一个编辑器里、一次只做一个项目。

Cursor 在 *单文件、单项目* 循环里体验极佳。补全直接缝在光标里、diff UX 流畅、不离编辑器就能跟项目聊天。

**痛点：**
- 多项目并行 = 多开窗口，正是 Cockpit 想解决的乱。
- Agent 不太容易够到你的终端、浏览器、数据库。
- 你被编辑器的更新节奏绑死。想要 Anthropic 第 1 天的新能力？等吧。

## 方案 D：Aider / TUI 工具

**赢在：** 你想在终端里跑对话式编码循环，但比裸 CLI 多一些历史管理。

Aider 很好。老牌、对 commit 有自己的脾气，适合个人 OSS 项目。

**痛点：** 还是单项目、纯终端、没有原生多模态（浏览器、DB）。

## 方案 E：Cockpit（官方 Agent SDK 上的 IDE 式工作台）

**赢在：**
- 你每天同时跟进 2+ 个项目。
- 你想要通知、红点、真正的"会话收件箱"。
- 你想要 Claude 之外的引擎：**Codex / DeepSeek / Kimi / 本地 Ollama**，每个 tab 各带各的 Key。
- 你的工作不只是代码 —— 还涉及浏览器、Postgres、Redis，希望 Agent 也能驱动它们。
- 你的团队需要一起做 review，想要一个不用上 SaaS 的共享评审面。
- 你在信任 Agent 之前想先看清它干了什么：每次碰文件的工具调用都有[快照](/zh/docs/agent/snapshots/) —— 像读 git 历史一样读一条回复的变更，\`Bash\` 改了什么也看得到。
- 你的团队共用一台开发机：Cockpit 是 **Web client-server** 架构，[装一次，全队一起飞](/zh/blog/self-host-claude-code-gui-for-your-team/) —— 各自在自己的项目 / worktree 上。

**痛点：**
- 还很年轻（v1.0.x）。会有粗糙的地方。
- Claude Code 新特性到得慢一拍 —— Cockpit 跟随 Agent SDK 发版；CLI 和官方 Desktop 先拿到。
- 没有云同步 —— 不过因为是 client-server，自托管到一台机器、任意设备接入，已经覆盖了大多数人要云同步的场景。
- 仍然需要装好 Claude Code。Cockpit 不替代 CLI，是站在 CLI 上面。

## 对比表

| | 裸 CLI | 官方 Desktop | IDE 插件 | Aider | **Cockpit** |
|---|---|---|---|---|---|
| 多项目并行 | ❌ 需要 tmux | ✅ 会话侧边栏 | ❌ 多窗口 | ❌ | ✅ 一等公民 |
| Claude 之外的引擎 | ❌ | ❌ | ✅ 看插件 | ✅ | ✅ Codex / DeepSeek / Kimi / Ollama |
| 浏览器 / DB 控制 | ❌ | ❌ 仅只读预览 | 通常 ❌ | ❌ | ✅ Bubbles |
| 代码评审面 | git 工具 | diff 视图 | PR 平台 | git | ✅ 局域网共享 |
| 工具调用级变更历史（每次 Edit / **Bash** 在磁盘上到底改了什么） | ❌ | ❌ 仅按轮次 diff | ⚠️ 按轮次检查点（Cursor） | ✅ 真 git 自动提交 | ✅ 快照含 Bash，本地留 7 天 |
| 自动化 | 脚本 | ✅ Routines（cron + API + GitHub） | ❌ | 脚本 | ✅ 定时任务（cron） |
| 团队自托管 | ❌ | ❌ | ❌ | ❌ | ✅ 一台开发机，全队一起飞 |
| 手机可用 | ssh | ✅ 云端沙箱 | ❌ | ssh | ✅ 任意浏览器，代码在你机器上 |
| 新 SDK 能力第一天可用 | ✅ | ✅ 官方第一方 | 等 | 不一定 | ⏳ 跟随 SDK 发版 |
| 开源 | ✅ | ❌ | 多数 ❌（Cursor）| ✅ | ✅ MIT |

## 怎么选

- **独立开发者，单仓为主，重度编辑器派：** Cursor 或你顺手的 IDE，文章读到这就够了。
- **独立开发者，终端派，想要对话式编码：** Aider 或裸 CLI。
- **全押 Anthropic、单机作业、要第一方打磨：** 官方 Desktop。
- **同时跟进多项目、想要多引擎，或工作横跨代码 + 浏览器 + 数据库：** Cockpit。
- **团队想要一个共享评审面，但不想买 SaaS：** Cockpit（局域网共享评审页这一项就够买单了）。
- **团队共用一台开发机：** Cockpit —— [装一次，全队一起飞](/zh/blog/self-host-claude-code-gui-for-your-team/)。

反对 Cockpit 最强的论点也最朴素：**如果你一天就是"打开一个项目、干一件事、合电脑"，你不需要驾驶舱，你需要的是一根操纵杆。**

---

想试？\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit)`,
      },
    },
  },
];

export function getPostBySlug(slug: string): Post | undefined {
  return posts.find((p) => p.slug === slug);
}

export function getAllSlugs(): string[] {
  return posts.map((p) => p.slug);
}
