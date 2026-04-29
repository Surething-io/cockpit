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
      'Cockpit',
      'team prompt sharing',
      'Anthropic skills',
    ],
    content: {
      en: {
        title: 'From chat to skill: turn yesterday\u2019s 28-minute debug into today\u2019s /command',
        description:
          'Every productive Claude Code session ends with dark knowledge that dies with the conversation. Cockpit\u2019s Skills feature lets the agent crystallize a chat into a SKILL.md \u2014 saved to *your* knowledge base (not a Cockpit-owned folder), then registered as a slash command. Your notes stay where they live; Cockpit just holds the pointer.',
        readingTime: '6 min read',
        body: `Yesterday I spent **28 minutes** walking Claude through our OAuth refresh-token flow. Token endpoint, leeway window, two custom claims, the one staging-only quirk. Bug found, fixed, shipped.

This morning, almost the same problem in a sister service. I open a new chat. The agent has no memory of yesterday. **28 minutes again.**

This isn't an Anthropic limitation. Stateless agents are the right default — you don't want yesterday's wrong assumption haunting tomorrow's session. The fix isn't "give the AI memory". The fix is **give yourself memory, in a place the agent will read again.**

That place is a Skill.

## What a Skill actually is — and where it should live

A Skill is one Markdown file. Nothing more. Cockpit only cares about two things: the file's content (which becomes the system prompt for \`/skill-name\`) and an absolute path that points at it.

The path is the design choice that matters most. Anthropic's reference convention puts skills under \`~/.claude/skills/\`. Cockpit deliberately does **not** do that. **We don't scan your home directory. We don't reserve a folder name. Your skills can live anywhere you want them to live**:

- \`~/Notes/Skills/oauth-debug.md\` — alongside your personal notes
- \`~/Documents/team-playbooks/oauth-debug/SKILL.md\` — in a synced folder
- \`~/Work/our-handbook/skills/oauth-debug.md\` — inside a git'd team repo
- \`~/Obsidian/Vault/Skills/oauth-debug.md\` — inside your Obsidian vault
- \`./.claude/skills/oauth-debug/SKILL.md\` — Anthropic-style, if you prefer

**Why this matters:** your knowledge already lives somewhere. You have a vault, a notes app, a docs repo, a "Skills" folder you've curated for years. Forcing skills into \`~/.claude/skills/\` would be Cockpit picking a fight with your existing system. We register pointers instead.

### The two-step flow

**Step 1.** Write the SKILL.md in *your* knowledge base. Whatever path you want.

**Step 2.** In Cockpit's Skills sidebar, click **+ Add Skill** and paste the absolute path. Cockpit stores it in \`~/.cockpit/skills.json\` (one file, one list of pointers, easy to back up).

That's it. The skill is now in your slash autocomplete. You can edit the source file directly in your editor of choice — Cockpit watches it, picks up changes on save, no re-import.

What Cockpit then gives you on top:

- **Skills sidebar**: lists every registered skill with name, description, icon, source path, last-used time
- **Slash autocomplete**: \`/\` in chat shows your skills mixed with built-ins like \`/qa\`, \`/fx\`, \`/review\`
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
> at \`~/Notes/Skills/oauth-debug.md\` (or wherever you keep yours).
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
/Users/you/Notes/Skills/oauth-debug.md
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
├── oauth-debug.md
├── our-pr-style.md
├── our-deploy-flow.md
└── README.md          # how to add a skill, how to register it
\`\`\`

Now skills are diffable, reviewable, \`git blame\`-able. The senior engineer's "always do X but never Y" stops being a Slack DM and becomes a PR with a reviewer. New hires \`git pull\`, click **+ Add Skill** four times, and the team's tacit knowledge is in their slash menu before the end of day one.

Cockpit's LAN-shared review surface (see [our previous post](/en/blog/claude-code-gui-comparison/)) makes the inner loop tighter: write a skill in chat, share the review page over LAN, teammate comments line-by-line, send their comments back to the agent as context, agent revises the skill, you commit.

The point: **skills don't make a copy of your team's knowledge. They reference it.** When the handbook updates, the skill updates. There's only one source of truth, and it's already where your team keeps source of truth.

## Meta: a skill that writes skills

Once you have one skill, you can write a meta-skill:

\`\`\`
/distill Read the last 50 messages in this conversation. If you
spot any pattern that repeated 3+ times, propose a SKILL.md for
it. Don't save automatically — show me the draft first.
\`\`\`

Now your Skills sidebar fills itself, slowly, from the conversations you actually have. Cockpit ships \`/qa\`, \`/fx\`, \`/review\`, \`/commit\` as opinionated defaults — but the **best skills in your sidebar a year from now will be ones you didn't write by hand.**

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
          '每一次高质量的 Claude Code 对话都会沉淀一堆"暗知识"，默认情况下随对话一起死掉。Cockpit 的 Skills 功能让 Agent 把对话浓缩成一个 SKILL.md —— 存到 *你的* 知识库（而不是 Cockpit 强占的目录），再注册为斜杠指令。你的笔记还住在它本来该住的地方，Cockpit 只是持有那个指针。',
        readingTime: '阅读约 6 分钟',
        body: `昨天我花了**整整 28 分钟**带着 Claude 把我们 OAuth 刷新令牌流程过了一遍。Token 端点、leeway 窗口、两个自定义 claims、那个仅 staging 环境才有的怪癖。Bug 找到、修掉、上线。

今天早上，姊妹服务里几乎一模一样的问题。我打开一个新对话。Agent 对昨天毫无记忆。**又是 28 分钟。**

这不是 Anthropic 的设计缺陷。**无状态 Agent 才是正确的默认值**——你不会希望昨天那个错的假设缠着今天的对话。解法不是"给 AI 记忆"，解法是**给你自己记忆，存在 Agent 明天会读到的地方。**

那个地方就是 Skill。

## Skill 是什么 —— 以及它该住在哪里

一个 Skill 就是一个 Markdown 文件，仅此而已。Cockpit 只关心两件事：文件正文（成为 \`/skill-name\` 的 system prompt）和指向它的绝对路径。

**路径是最重要的设计选择。** Anthropic 的官方约定是把 skills 放在 \`~/.claude/skills/\`。Cockpit **故意不这么做**。**我们不扫你的 home 目录、不预留某个文件夹名、不强占任何位置。你的 skills 想住哪里就住哪里：**

- \`~/Notes/Skills/oauth-debug.md\` —— 跟你的个人笔记放一起
- \`~/Documents/team-playbooks/oauth-debug/SKILL.md\` —— 在同步目录里
- \`~/Work/our-handbook/skills/oauth-debug.md\` —— 在团队 git 仓库里
- \`~/Obsidian/Vault/Skills/oauth-debug.md\` —— 在你的 Obsidian 库里
- \`./.claude/skills/oauth-debug/SKILL.md\` —— 偏好 Anthropic 风格也行

**为什么这事重要：** 你的知识本来就住在某个地方。你有 vault、有笔记软件、有文档仓库、有自己经营多年的"Skills"目录。强迫 skills 进 \`~/.claude/skills/\` 等于让 Cockpit 跟你已有的体系打架。我们选择**只注册指针，不搬运文件。**

### 两步流

**第 1 步：** 在 *你的* 知识库里写 SKILL.md，路径随你定。

**第 2 步：** 在 Cockpit 的 Skills 侧边栏点 **+ Add Skill**，粘贴绝对路径。Cockpit 把它存进 \`~/.cockpit/skills.json\`（一个文件、一份指针列表，备份方便）。

完事。这个 skill 现在出现在你的斜杠补全里。源文件你想用什么编辑器改都行 —— Cockpit 监听文件变化、保存即生效，无需重新 import。

在此基础上，Cockpit 给你的额外能力：

- **Skills 侧边栏**：每个已注册技能的名称、描述、图标、源路径、最后使用时间
- **斜杠补全**：在对话里打 \`/\`，你的技能跟内置 \`/qa\`、\`/fx\`、\`/review\` 混排出现
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
> \`~/Notes/Skills/oauth-debug.md\`（或者你自己习惯的位置）。
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
/Users/you/Notes/Skills/oauth-debug.md
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
├── oauth-debug.md
├── our-pr-style.md
├── our-deploy-flow.md
└── README.md          # 怎么写技能、怎么注册到 Cockpit
\`\`\`

Skill 因此可以 diff、可以 review、可以 \`git blame\`。Senior 那句"始终做 X、绝不做 Y"不再是一条 Slack 私信，而是一个有 reviewer 的 PR。新人 \`git pull\` 完，点 4 下 **+ Add Skill**，团队的隐性知识在他第一天结束前就出现在斜杠菜单里。

Cockpit 的局域网共享评审页（参见[上一篇博客](/zh/blog/claude-code-gui-comparison/)）让内循环更紧：在对话里写出 skill、把评审页面分享到局域网、队友逐行评论、把评论喂回 Agent 作为上下文、Agent 修订、你 commit。

关键是：**Skill 不是把团队的知识复制了一份，而是引用了它。** 当 handbook 更新，skill 就更新。**只有一个事实来源**，而且就是你团队本来存放事实的地方。

## 进阶：用 skill 写 skill

有了第一个 skill，下一步可以写一个 meta-skill：

\`\`\`
/distill 读这次对话最近 50 条消息。如果发现任何重复出现 3+ 次的
模式，给我提一个 SKILL.md 草案。先别自动保存，给我看草案再说。
\`\`\`

从此你的 Skills 侧边栏会**自己慢慢长出来**，从你真实进行的对话里长出来。Cockpit 内置的 \`/qa\`、\`/fx\`、\`/review\`、\`/commit\` 是有主见的默认值——但**一年后你侧边栏里最好用的那些 skill，多半不是你手写的。**

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
      'Cockpit',
      'AI coding workflow',
    ],
    content: {
      en: {
        title: 'How to run 5 Claude Code sessions in parallel without losing your mind',
        description:
          'Claude Code is incredible at one task at a time — but most engineers want to scope out three features while one is refactoring and another is writing tests. Here is how Cockpit lets you run multiple Claude Code Agent SDK sessions across projects at once, without context-switching pain.',
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
          'Claude Code 一次干一件事很强，但工程师真实场景常是：一个项目重构、一个项目写测试、一个项目排 bug，外加两个新需求脑暴。直接用裸 `claude` CLI 很快就会卡在终端切换上。这篇讲 Cockpit 是怎么用 Claude Agent SDK 把多项目并发会话跑顺的。',
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
    date: '2026-04-29',
    keywords: [
      'Claude Code GUI',
      'Claude Code desktop',
      'Cursor alternative',
      'Continue alternative',
      'Aider alternative',
      'Claude Code client',
      'AI IDE comparison',
    ],
    content: {
      en: {
        title: 'Claude Code GUI: CLI vs Cockpit vs IDE plugins (2026 buyer’s guide)',
        description:
          'Anthropic ships Claude Code as a CLI by default. If you want a GUI on top, you have four real options today: stick with the CLI, use an IDE plugin (Cursor, Continue), use Aider in a TUI, or run Cockpit. Here is when each one wins.',
        readingTime: '7 min read',
        body: `Anthropic ships Claude Code as a **CLI**. That decision is correct for power users — terminals are scriptable, composable, and don't crash. But it pushes a non-trivial chunk of "obvious wins" onto the user: history search, multi-project tab management, image attachments, in-context code review, embedded terminals.

This post is an honest comparison of the four ways most engineers actually use Claude Code in 2026.

## Option A: stay in the raw CLI

**When it wins:** scripts, CI, one-off refactors, headless servers.

The CLI is the source of truth. Everything else wraps around it. If you live in tmux + Vim and have muscle memory for shell pipes, the CLI is faster than any GUI for short tasks. Anthropic also keeps the CLI on the absolute leading edge — every new SDK feature lands here first.

**Where it hurts:** as soon as you have more than one Claude Code session active, you're in tmux territory. There's no built-in notion of "session inbox" or red-dot. Image attachment is awkward. Cross-project history is a \`grep\` exercise.

## Option B: an IDE plugin (Cursor / Continue / Cline / Roo)

**When it wins:** you mostly edit code in one editor, in one project at a time.

Cursor in particular is a fantastic experience for the *single-file, single-project* loop. The autocomplete is integrated into the cursor (literally), the diff UX is smooth, and you can chat with your project without leaving the editor.

**Where it hurts:**
- Multi-project parallelism is the editor's "open multiple windows" feature, which is exactly the chaos Cockpit was built to fix.
- The agent doesn't easily reach into your terminal, browser, or database.
- You're tied to the editor's update cadence. Want a new Anthropic feature on day 1? You wait.

## Option C: Aider / TUI tools

**When it wins:** you want a chat-driven coding loop without leaving the terminal, but with better history than raw CLI.

Aider is great. It's older, more opinionated about commits, and a good fit for solo OSS work.

**Where it hurts:** still single-project at a time, still terminal-only, still no native multi-modal (browser, DB).

## Option D: Cockpit (a full GUI on top of the official Agent SDK)

**When it wins:**
- You manage 2+ projects in flight every day.
- You want notifications, red dots, and a real "session inbox".
- Your work isn't just code — it touches a browser, a Postgres DB, or a Redis cache, and you'd like the agent to drive those too.
- Your team reviews code together, and you want a shared review surface that doesn't need a SaaS.

**Where it hurts:**
- It's young (v1.0.x). You'll find rough edges.
- It runs locally — there's no cloud sync (yet). Move between machines = re-clone projects.
- You still need Claude Code installed and configured. Cockpit doesn't replace the CLI, it stands on top of it.

## A side-by-side

| | Raw CLI | IDE plugin | Aider | **Cockpit** |
|---|---|---|---|---|
| Multi-project parallel | ❌ tmux required | ❌ multi-window | ❌ | ✅ first-class |
| Cross-project search | grep | per-window | local | ✅ Cmd+K |
| Browser / DB control | ❌ | usually ❌ | ❌ | ✅ Bubbles |
| Code review surface | git tools | PR provider | git | ✅ LAN-shared |
| Slash modes | manual | per-plugin | yes | ✅ \`/qa /fx /review /commit\` + custom |
| Local-only / no cloud | ✅ | varies | ✅ | ✅ |
| Day-1 SDK features | ✅ | wait | varies | ✅ (uses official SDK) |
| Open source | ✅ | mostly ❌ (Cursor) | ✅ | ✅ MIT |

## How to pick

- **Solo, one repo at a time, mostly editor-bound:** Cursor or your IDE of choice. Stop reading.
- **Solo, terminal-bound, want chat-driven coding:** Aider or raw CLI.
- **Multiple projects in flight, or your work crosses code+browser+DB:** Cockpit.
- **Team that wants a shared review surface without buying a SaaS:** Cockpit (the LAN-share review page is the single feature that justifies it on its own).

The strongest argument *against* Cockpit is also the simplest: if your day is "open one project, do one thing, close laptop", you don't need a cockpit. You need a yoke.

---

Want to try? \`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit)`,
      },
      zh: {
        title: 'Claude Code GUI 全景对比：CLI、Cursor、Aider 还是 Cockpit？（2026 选型指南）',
        description:
          'Anthropic 默认把 Claude Code 当 CLI 发布。要 GUI，2026 年其实就四条路：留在 CLI、用 IDE 插件（Cursor、Continue）、用 Aider TUI、或者上 Cockpit。这篇讲清楚每条路什么时候赢。',
        readingTime: '阅读约 7 分钟',
        body: `Anthropic 把 Claude Code 默认做成 **CLI**。这个选择对硬核玩家是对的 —— 终端可脚本、可组合、不容易崩。但它把一堆"明显该有"的能力推给了用户去自补：历史搜索、多项目 tab 管理、图片附件、嵌入式代码评审、内置终端。

这篇文章是 2026 年大家实际怎么用 Claude Code 的诚实对比。

## 方案 A：留在裸 CLI

**赢在：** 脚本、CI、一次性重构、无头服务器。

CLI 是真理之源。其他一切都是包在它外面的壳。如果你住在 tmux + Vim 里，对 shell 管道有肌肉记忆，那么短任务上 CLI 比任何 GUI 都快。Anthropic 还把 CLI 放在最前沿 —— 每个新 SDK 能力都先到这。

**痛点：** 一旦同时有 2 个以上的 Claude Code 会话，就要回到 tmux 那一套。没有"会话收件箱"、没有红点提示。图片附件麻烦。跨项目搜索靠 \`grep\`。

## 方案 B：IDE 插件（Cursor / Continue / Cline / Roo）

**赢在：** 你主要在一个编辑器里、一次只做一个项目。

Cursor 在 *单文件、单项目* 循环里体验极佳。补全直接缝在光标里、diff UX 流畅、不离编辑器就能跟项目聊天。

**痛点：**
- 多项目并行 = 多开窗口，正是 Cockpit 想解决的乱。
- Agent 不太容易够到你的终端、浏览器、数据库。
- 你被编辑器的更新节奏绑死。想要 Anthropic 第 1 天的新能力？等吧。

## 方案 C：Aider / TUI 工具

**赢在：** 你想在终端里跑对话式编码循环，但比裸 CLI 多一些历史管理。

Aider 很好。老牌、对 commit 有自己的脾气，适合个人 OSS 项目。

**痛点：** 还是单项目、纯终端、没有原生多模态（浏览器、DB）。

## 方案 D：Cockpit（官方 Agent SDK 上的完整 GUI）

**赢在：**
- 你每天同时跟进 2+ 个项目。
- 你想要通知、红点、真正的"会话收件箱"。
- 你的工作不只是代码 —— 还涉及浏览器、Postgres、Redis，希望 Agent 也能驱动它们。
- 你的团队需要一起做 review，想要一个不用上 SaaS 的共享评审面。

**痛点：**
- 还很年轻（v1.0.x）。会有粗糙的地方。
- 纯本地运行 —— 暂时没有云同步。换机器 = 重新 clone 项目。
- 仍然需要装好 Claude Code。Cockpit 不替代 CLI，是站在 CLI 上面。

## 对比表

| | 裸 CLI | IDE 插件 | Aider | **Cockpit** |
|---|---|---|---|---|
| 多项目并行 | ❌ 需要 tmux | ❌ 多窗口 | ❌ | ✅ 一等公民 |
| 跨项目搜索 | grep | 各窗口独立 | 本地 | ✅ Cmd+K |
| 浏览器 / DB 控制 | ❌ | 通常 ❌ | ❌ | ✅ Bubbles |
| 代码评审面 | git 工具 | PR 平台 | git | ✅ 局域网共享 |
| 斜杠模式 | 手动 | 各插件 | 有 | ✅ \`/qa /fx /review /commit\` + 自定义 |
| 纯本地 / 不上云 | ✅ | 不一定 | ✅ | ✅ |
| 新 SDK 能力第一天可用 | ✅ | 等 | 不一定 | ✅（用官方 SDK） |
| 开源 | ✅ | 多数 ❌（Cursor）| ✅ | ✅ MIT |

## 怎么选

- **独立开发者，单仓为主，重度编辑器派：** Cursor 或你顺手的 IDE，文章读到这就够了。
- **独立开发者，终端派，想要对话式编码：** Aider 或裸 CLI。
- **同时跟进多项目，或工作横跨代码 + 浏览器 + 数据库：** Cockpit。
- **团队想要一个共享评审面，但不想买 SaaS：** Cockpit（局域网共享评审页这一项就够买单了）。

反对 Cockpit 最强的论点也最朴素：**如果你一天就是"打开一个项目、干一件事、合电脑"，你不需要驾驶舱，你需要的是一根操纵杆。**

---

想试？\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit)`,
      },
    },
  },

  {
    slug: 'slash-modes-claude-code',
    date: '2026-04-29',
    keywords: [
      'Claude Code slash commands',
      'Claude Code modes',
      'AI debugging',
      'AI code review',
      'agent prompting',
      '/qa /fx /review',
      'Cockpit',
    ],
    content: {
      en: {
        title: 'Slash modes in Claude Code: /qa, /fx, /review, /commit',
        description:
          'A subtle but huge productivity unlock: instead of writing the same "do X but don\'t change code" prompt every time, save it once as a slash command. Cockpit ships with four built-ins — here is what each does and when to reach for it.',
        readingTime: '5 min read',
        body: `One pattern keeps re-emerging in every productive Claude Code transcript I've read: **the user starts by telling the agent what *not* to do.**

> "Don't change any code yet. Just walk me through the bug."
>
> "Don't refactor. Just review the diff."
>
> "Don't write the feature yet. Restate it back to me first."

These are *postures*, not tasks. They flip the agent from "ship code by default" to "be a particular kind of collaborator". And once you have the posture right, the actual conversation gets shorter and faster.

Slash commands let you save these postures as shortcuts. Cockpit ships four built-ins — same shape as Anthropic's \`~/.claude/commands/\` mechanism, just preinstalled.

## /qa — clarify, never code

The classic "talk first, code never" mode.

\`\`\`text
/qa I want to add a soft-delete to user accounts.
\`\`\`

The agent will:
- Restate the requirement back in its own words.
- Ask back on every ambiguity (cascade? grace period? reversible from UI?).
- Follow KISS — never propose three architectures when you asked one question.
- **Refuse to write code until you say so.**

Best for: spec'ing a new feature, debating an approach, onboarding into an unfamiliar repo.

## /fx — diagnose, never edit

Bug evidence-chain mode.

\`\`\`text
/fx The /api/users endpoint sometimes returns 500 with no log line.
\`\`\`

The agent will:
- Read the failing path end-to-end.
- Build an evidence chain: which file, which assumption, which observed behavior.
- **Refuse to edit a single file.**
- End with a concrete hypothesis you can confirm or reject.

This is the difference between "AI fixed something and broke two more things" and "AI showed me what was actually wrong, so I fixed it correctly". Use \`/fx\` when the bug surface is unfamiliar or when the cost of a wrong fix is high.

## /review — read the diff, write notes

Pre-PR review without rewriting.

\`\`\`text
/review
\`\`\`

(no argument needed — it picks up the current diff)

The agent will:
- Read \`git diff\` and the surrounding files for context.
- Write line-by-line review notes in the form a senior engineer would: tradeoffs, missing tests, edge cases, "why not X?".
- **Not touch your code.**

The trick: feed those notes into a fresh \`/qa\` round and let yourself decide which to address. You get a second pair of eyes that doesn't have ego.

## /commit — commit, in your repo's style

The least exciting one, used most.

\`\`\`text
/commit
\`\`\`

The agent will:
- Read your last 20 commit messages to learn your style (Conventional? Imperative? Emoji?).
- Stage the right files (skips lockfiles, generated dirs).
- Draft a message in your style.
- Commit.

It's a 10-second time saver per commit, but you commit 30 times a day.

## Make your own

Put any markdown file in \`~/.claude/commands/\` (or per-repo \`./.claude/commands/\`) and it becomes a slash command. The file body *is* the system prompt. Examples that work surprisingly well:

- **\`/security\`** — "Review only for security issues, no style or perf comments. List CVE-likes first."
- **\`/migrate\`** — "I'm migrating this file from X to Y. Don't change behavior. Don't reformat. Show diff only."
- **\`/why\`** — "Explain *why* this code exists. Look at git blame, surrounding tests, and any TODO/FIXME within 10 lines."

Cockpit auto-loads any file you drop in there into the slash autocomplete menu.

## The bigger principle

Default Claude Code is biased toward action — write code, save files, ship. That's a great default 60% of the time and a terrible default the other 40%. Slash modes are how you flip the default *deliberately*.

If you find yourself typing the same "don't do X" preamble more than twice in a week, that's a slash command waiting to happen.

---

\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [Try Online](/try)`,
      },
      zh: {
        title: 'Claude Code 斜杠模式实战：/qa、/fx、/review、/commit',
        description:
          '一个被低估的提效技巧：与其每次都写一遍"做 X 但不要动代码"，不如一次性把它保存为斜杠指令。Cockpit 内置 4 个 —— 这篇讲每个适合什么场景。',
        readingTime: '阅读约 5 分钟',
        body: `我读过的每个高效率 Claude Code 对话里都有同一个模式：**用户上来先告诉 Agent 什么 *不要* 做。**

> "现在先别改代码，把这个 bug 给我讲一遍。"
>
> "别重构，只评 diff。"
>
> "别先写功能，先把需求复述一遍给我听。"

这些不是任务，是**姿态**。它们把 Agent 从"默认写代码"切换到"做某种特定类型的协作者"。姿态对了，实际对话就短得多、快得多。

斜杠指令就是把这些姿态保存成快捷方式。Cockpit 内置了 4 个 —— 跟 Anthropic 的 \`~/.claude/commands/\` 机制完全一样，只是预装好了。

## /qa —— 只澄清，绝不写代码

经典的"先聊清楚，绝不动代码"模式。

\`\`\`text
/qa 我要给用户账号加软删除。
\`\`\`

Agent 会：
- 用自己的话复述需求。
- 对每一个模糊点反问（级联删除？保留期？UI 上能恢复吗？）。
- 遵循 KISS —— 你只问一个问题，它不会甩你三个架构。
- **在你点头之前不会写代码。**

适合：开新需求、推方案、上手陌生仓库。

## /fx —— 只诊断，绝不改文件

Bug 证据链模式。

\`\`\`text
/fx /api/users 接口偶发返回 500，没有日志。
\`\`\`

Agent 会：
- 端到端读一遍失败路径。
- 建一条证据链：哪个文件、哪个假设、哪个观察到的现象。
- **不会动一个文件。**
- 最后给出一个具体的可证伪假设。

这就是"AI 修了一个东西又搞坏了两个"和"AI 告诉我哪里真坏了，我自己修对了"之间的区别。Bug 面陌生、或修错代价高的时候用 \`/fx\`。

## /review —— 读 diff，写评审，不动手

PR 前自检。

\`\`\`text
/review
\`\`\`

（不用传参，它自己取当前 diff）

Agent 会：
- 读 \`git diff\` 和周边文件作为上下文。
- 像资深工程师一样逐行写评审：取舍、缺失的测试、边界、"为什么不这么做？"。
- **不会动你的代码。**

小技巧：把这些评审意见喂给一轮新的 \`/qa\`，自己决定哪些采纳。多一双眼睛，但这双眼睛没有自尊心。

## /commit —— 按你仓库的风格提交

最不性感、最常用的一个。

\`\`\`text
/commit
\`\`\`

Agent 会：
- 读最近 20 条 commit message 学你的风格（Conventional？祈使句？带 emoji？）。
- stage 正确的文件（跳过 lockfile、生成目录）。
- 按你的风格起草 message。
- commit。

每次省 10 秒，但你每天要提 30 次。

## 做你自己的

把任意 markdown 丢进 \`~/.claude/commands/\`（或者仓库本地 \`./.claude/commands/\`），它就成了斜杠指令。文件正文 *就是* system prompt。一些意外好用的例子：

- **\`/security\`** —— "只评安全问题，不要风格 / 性能评论。CVE 类的先列。"
- **\`/migrate\`** —— "我在把这个文件从 X 迁到 Y。不要改行为。不要重排。只给 diff。"
- **\`/why\`** —— "解释这段代码 *为什么* 存在。看 git blame、周围测试、上下 10 行内的 TODO/FIXME。"

Cockpit 会自动把你放进去的任意文件加到斜杠补全菜单。

## 背后的原则

默认 Claude Code 是行动偏向 —— 写代码、保存文件、交付。这是 60% 时候的好默认值，另外 40% 的烂默认值。斜杠模式是你 *有意识* 切换默认值的方式。

如果你一周里超过两次写同样的"别做 X"前言，那就是一个等着诞生的斜杠指令。

---

\`npm i -g @surething/cockpit\` · [GitHub](https://github.com/Surething-io/cockpit) · [在线体验](/try)`,
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
