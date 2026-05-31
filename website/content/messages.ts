import type { Locale } from '@/lib/i18n';

export const messages = {
  en: {
    nav: {
      docs: 'Docs',
      blog: 'Blog',
      changelog: 'Changelog',
      github: 'GitHub',
    },
    hero: {
      headline: 'The open Claude Code GUI · Bring any agent',
      subheadline: 'One seat. One AI. Everything under control.',
      pronounce: '/ˈkɒkpɪt/ — like an aircraft cockpit',
      description:
        'OpenCockpit is the open-source Claude Code GUI — and a single canvas for whatever agent you bring next. Multi-project Claude sessions out of the box; pop open a tab for Codex, DeepSeek, Kimi, or local Ollama whenever you need. Built-in terminal, Chrome control, PostgreSQL / MySQL / Redis bubbles, code review, and slash modes — all local.',
      // SEO ≤160 chars — used by metadata only, not visible on the page. Don't merge with description.
      metaDescription:
        'Open-source Claude Code GUI — parallel AI coding across projects. Codex/DeepSeek/Kimi/Ollama tabs, terminal, Chrome & DB bubbles, code graph. Local, MIT.',
      installLabel: 'Install',
      tryOnline: 'Try Online',
      githubStar: 'Star on GitHub',
      videoNotice: 'Watch the 60-second tour',
      badge: 'Claude · Codex · DeepSeek · Kimi · Ollama',
    },
    valueProp: {
      headline: 'Why Cockpit beats raw Claude Code',
      points: [
        {
          title: 'Multi-project parallel sessions',
          desc: 'Run 5+ agent sessions across projects at once. Get notified when each finishes — no terminal juggling.',
        },
        {
          title: 'Local-first, BYOK for the rest',
          desc: '`claude` CLI works out of the box. For Codex, DeepSeek, Kimi or Ollama, paste a key (or none for Ollama). Everything runs locally.',
        },
        {
          title: 'Beyond chat: terminal, browser, DBs',
          desc: 'A real xterm.js terminal, Chrome automation, PostgreSQL / MySQL / Redis — all inside one window your agent can drive.',
        },
      ],
    },
    panels: {
      agent: {
        tag: 'Panel 1',
        name: 'Agent',
        title: 'AI chat that scales with you',
        bullets: [
          'Claude out of the box via the official Agent SDK; Codex / DeepSeek / Kimi / Ollama via per-tab BYOK',
          'Multi-project concurrent sessions with desktop notifications',
          'Session pinning, forking, cross-project session browser',
          '!command prefix runs shell from chat, output piped back as context',
          'Image attachments, code references, token usage tracking',
        ],
      },
      explorer: {
        tag: 'Panel 2',
        name: 'Explorer',
        title: 'Code & files, all-in-one',
        bullets: [
          'Directory / Recent / Git Changes / Git History — 4 tabs',
          'Syntax highlighting (Shiki) with Vi mode editing',
          'Git blame, diff view, branch switching, worktree',
          'LSP integration — go to definition, find references',
          'Code Map — see who calls a function and what it calls; click to jump (TS/JS/Python/Go/Rust)',
          'Fuzzy search (Cmd+F), JSON viewer, Markdown preview',
        ],
      },
      console: {
        tag: 'Panel 3',
        name: 'Console',
        title: 'Terminal & smart Bubbles',
        bullets: [
          'Full terminal emulator (xterm.js) with shell integration',
          'Browser Bubble — control Chrome via accessibility tree',
          'Database Bubbles — PostgreSQL, MySQL, Redis',
          'Drag-to-reorder bubbles, grid / maximized layout',
          'Per-tab environment variables and shell aliases',
        ],
      },
      review: {
        tag: 'Team',
        name: 'Code Review',
        title: 'Ship faster, together',
        bullets: [
          'LAN-shareable review pages — teammates need zero install',
          'Line-level comments with reply threads',
          'Send any comment back to AI as context for an automated fix',
          'Red-dot badges keep unread feedback visible across projects',
          'Built on top of GUIDE.md / Markdown — no separate review system',
        ],
      },
    },
    bubbles: {
      headline: 'Smart Bubbles in Console',
      desc: 'Floating panes that connect to anything — controlled by AI or by you.',
      items: [
        { name: 'Browser', desc: 'Click, type, navigate, screenshot, network inspection.' },
        { name: 'PostgreSQL', desc: 'Browse schema, run queries, export data.' },
        { name: 'MySQL', desc: 'Browse databases & tables, run queries.' },
        { name: 'Redis', desc: 'Browse keys, inspect values, execute commands.' },
      ],
    },
    engines: {
      tag: '⚙ Engines',
      headline: 'Claude by default — bring any agent you want',
      desc: 'Each engine runs in its own tab, with its own session history. Pick from the new-tab dropdown.',
      items: [
        {
          name: 'Claude',
          badge: 'default',
          tagline: 'The default',
          desc: 'Full Claude Agent SDK — tools, plans, slash modes. Zero setup if your `claude` CLI is already configured.',
        },
        {
          name: 'Codex',
          tagline: 'Bring your account',
          desc: 'Reuses your `~/.codex` config. Same chat, same shell, same bubbles — just a different tab.',
        },
        {
          name: 'DeepSeek',
          tagline: 'Long sessions on a budget',
          desc: 'Anthropic-compatible endpoint via the Claude SDK. Paste a key, pick `v4-pro` or `v4-flash`.',
        },
        {
          name: 'Kimi',
          tagline: 'Tool calls, visible',
          desc: "Function calls render in chat just like Claude's — see what was called and what came back.",
        },
        {
          name: 'Ollama',
          tagline: 'Fully offline',
          desc: 'Auto-starts the daemon, pick any pulled model from the chat header. No key, no internet required.',
        },
      ],
      footnote: 'Everything runs locally.',
    },
    codeMap: {
      tag: 'Explorer · Code Map',
      headline: 'Read the codebase like a map, not a tree',
      desc: 'Get oriented in any unfamiliar codebase. Every function shows its body in the middle, who calls it on the left, what it calls on the right — click a pin to jump.',
      bullets: [
        'New to a repo? See every function and its connections at a glance — onboarding in minutes, not days.',
        'Click a caller / callee pin to follow the trail — no more grep-and-pray.',
        'Reviewing a PR? Chip-level diff shows exactly what changed inside each function, in context.',
        'Tracing a bug? Walk the call graph from entry point to root cause without losing your place.',
        'Reading AI-generated code? Spot every function it touches and how they connect, before you trust it.',
        'Works across TypeScript / JavaScript, Python, Go, Rust — open it, no project setup needed.',
      ],
      footnote: 'Open any file in Explorer → switch to Code Map view.',
    },
    codeGraph: {
      tag: 'Agent · /cg Mode',
      headline: 'Give the AI a query graph, not a grep',
      desc: 'A code graph is the missing layer between your AI agent and your codebase. Code Map is for your eyes; CodeGraph is for the agent. The same tree-sitter index that powers Code Map is exposed as 10 HTTP endpoints — symbol search, callers, callees, impact, file tree, co-edit history, plus four analytics layers (context, related, risk, affected) — so the agent queries coordinates instead of grepping text and Reading whole files.',
      bullets: [
        '10 endpoints across two tiers: 6 base shapes ("where is X" / "who calls X" / "X calls what" / "changing X affects what" / "what symbols in F" / "what files are edited with F") + 4 analytics shapes (semantic context, related symbols, risk-scored impact, test-file closure).',
        'Returns coordinates only (file / line range / qname) — agent uses Read with precise offset+limit to fetch source, not full files.',
        'Co-edit endpoint catches "must-edit-together" file pairs that no static analysis can see: parallel registries, double-writes, sibling .md configs.',
        'Analytics layer (PageRank / PPR / TF-IDF / Louvain) runs locally with no model training — ranks risk, finds semantically related code, computes affected test files.',
        'Incrementally synced via file watcher — no rebuild step; the index stays current across mid-PR edits and AI bulk changes.',
        '/cg slash command primes the agent toward graph exploration with a question→endpoint table; existing tools (grep / glob / git log) stay available alongside.',
      ],
      footnote: 'Type /cg in any chat to enter exploration mode — the agent picks endpoints based on the question shape.',
    },
    modes: {
      headline: 'One slash, one AI mindset',
      desc: 'Slash commands flip the agent into a specific posture — talk first, debug only, never touch code.',
      items: [
        {
          cmd: '/qa',
          name: 'Clarify',
          desc: 'Restate the requirement, ask back on anything ambiguous, follow KISS — talk first, never code.',
        },
        {
          cmd: '/fx',
          name: 'Diagnose',
          desc: 'Bug evidence-chain analysis. The agent reasons through the failure end-to-end and never edits a file.',
        },
        {
          cmd: '/ex',
          name: 'Explore',
          desc: 'Structured discussion mode. 6-step skeleton: problem study → diverge → converge → diverge again → iterate-verify → summarize. Never asks back mid-flow.',
        },
        {
          cmd: '/go',
          name: 'Land',
          desc: 'Landing mode: take a converged plan, slice it into MVP stages, write code + self-verify per stage, no per-stage sign-off, recap at the end.',
        },
        {
          cmd: '/cg',
          name: 'CodeGraph',
          desc: 'Project graph exploration — 10 HTTP endpoints answer symbol / callers / impact / co-edit / risk / affected questions. Precise where grep is fuzzy.',
        },
        {
          cmd: '/cc',
          name: 'Cockpit CLI',
          desc: 'Drive the cockpit CLI surface — codegraph subcommands, terminal observation, browser automation. Each subcommand self-documents via --help.',
        },
      ],
      customHint: 'Custom: drop any SKILL.md and add it via the Skills sidebar — it auto-appears in the autocomplete menu.',
    },
    extras: {
      schedule: {
        title: 'Scheduled Tasks',
        desc: 'One-time, interval, or cron-based scheduling. Pause, resume, reorder, track results across projects.',
      },
      skills: {
        title: 'Skills',
        desc: 'Drop in any SKILL.md to teach the agent a new trick — invoke with /skill-name from chat. Manage everything from a single Skills panel.',
        tag: '🧩 Extensibility',
      },
    },
    builtOn: {
      headline: 'Built on the official Claude Agent SDK',
      desc: 'Cockpit\u2019s core uses Anthropic\u2019s official Claude Agent SDK. If your `claude` CLI is configured, Cockpit works — no extra setup. Other engines (Codex, DeepSeek, Kimi, Ollama) ride on the Vercel AI SDK and the same agent loop. Everything runs locally.',
    },
    finalCta: {
      headline: 'Ready to fly?',
      desc: 'Install once, then `cockpit` from any directory. (Or `cock` if you prefer the short alias.)',
    },
    footer: {
      tagline: 'A Claude Code GUI for parallel AI coding.',
      product: 'Product',
      resources: 'Resources',
      community: 'Community',
      license: 'MIT License',
    },
    docs: {
      title: 'Documentation',
      // SEO description: ≤160 chars, used by docs page metadata + OG.
      description:
        'OpenCockpit docs — install with one npm command, run anywhere. Cockpit CLI: codegraph, terminal, browser subcommands, each self-documenting via --help.',
      readOnGithub: 'Read on GitHub',
      comingSoon: 'Coming soon',
      onThisPage: 'On this page',
      prevPage: 'Previous',
      nextPage: 'Next',
      editOnGithub: 'Edit this page on GitHub',
      sidebar: {
        // Five top-level sections: Get Started → the three swipeable panels
        // (Agent / Explorer / Console) → Reference. The "Workspace shell"
        // section is folded into Agent now that its members (notes, skills,
        // sessions, scheduled tasks) were all really chat-adjacent.
        sections: {
          getStarted: 'Get Started',
          agent: 'Agent',
          explorer: 'Explorer',
          console: 'Console',
          reference: 'Reference',
        },
        // Sub-group headings — currently no section uses groups (after the
        // big sidebar flattening pass), but the type/render path is left
        // in place for future growth.
        groups: {},
        pages: {
          // Get Started
          introduction: 'Introduction',
          quickstart: 'Quickstart',

          // Agent panel (chat)
          messageInput: 'Message Input',
          sessions: 'Sessions',
          skills: 'Skills',
          engines: 'AI Engines',
          scheduledTasks: 'Scheduled Tasks',
          notes: 'Notes',

          // Explorer panel (5 modules mirroring the panel's top tabs)
          fileTree: 'File Tree',
          search: 'Search',
          recent: 'Recent',
          changes: 'Changes',
          history: 'History',

          // Console panel
          inputBar: 'Command Input',
          terminalBubble: 'Terminal',
          browserBubble: 'Browser',
          databases: 'Database Bubbles',
          jupyterBubble: 'Jupyter',
          aliasesEnv: 'Aliases & Env Vars',

          // Reference
          cli: 'Cockpit CLI',
          chromeExtension: 'Chrome Extension',
          reviews: 'Tech Plan Review',
          keyboardShortcuts: 'Keyboard Shortcuts',
          faq: 'FAQ & Troubleshooting',
        },
      },
    },
    changelog: {
      title: 'Changelog',
      desc: 'Release notes pulled from GitHub Releases.',
      empty: 'No releases yet.',
      viewOnGithub: 'View on GitHub',
    },
    blog: {
      title: 'Blog',
      desc: 'Notes on Claude Code, the Agent SDK, and shipping AI software.',
      readMore: 'Read more →',
      backToBlog: '← Back to blog',
      publishedOn: 'Published',
      empty: 'No posts yet.',
    },
  },
  zh: {
    nav: {
      docs: '文档',
      blog: '博客',
      changelog: '更新日志',
      github: 'GitHub',
    },
    hero: {
      headline: '开源 Claude Code GUI · 接入任意 Agent',
      subheadline: 'One seat. One AI. Everything under control.',
      pronounce: '/ˈkɒkpɪt/ —— 像飞机驾驶舱',
      description:
        'OpenCockpit 是开源的 Claude Code GUI —— 也是你想接入的任何 Agent 的统一画布。多项目 Claude 会话开箱即用；想用 Codex、DeepSeek、Kimi 或本地 Ollama？直接新开一个 tab。内置终端、Chrome 自动化、PostgreSQL / MySQL / Redis 气泡、代码评审与斜杠模式 —— 全部本地。',
      // SEO ≤160 字符（CJK 计为 1.5×）—— 仅用于 metadata，不在页面展示。勿与 description 合并。
      metaDescription:
        '开源 Claude Code GUI —— 多项目并行 AI 编程。Codex/DeepSeek/Kimi/Ollama 多引擎切换，内置终端、Chrome 自动化、PostgreSQL/MySQL/Redis 气泡、代码图谱。全本地、MIT 协议。',
      badge: 'Claude · Codex · DeepSeek · Kimi · Ollama',
      installLabel: '安装',
      tryOnline: '在线体验',
      githubStar: 'GitHub 点亮 Star',
      videoNotice: '观看 60 秒演示',
    },
    valueProp: {
      headline: '为什么 Cockpit 比裸用 Claude Code 更顺手',
      points: [
        {
          title: '多项目并发会话',
          desc: '同时跑 5+ 个 Agent 会话，跨项目互不打扰。完成自动通知，不再切终端。',
        },
        {
          title: '本地优先，其他引擎 BYOK',
          desc: '`claude` CLI 已配好即开箱即用。Codex / DeepSeek / Kimi / Ollama 各自粘 Key（Ollama 无需）。一切都在本地完成。',
        },
        {
          title: '不止聊天：终端、浏览器、数据库',
          desc: '真实 xterm.js 终端、Chrome 自动化、PostgreSQL / MySQL / Redis —— 全在一个窗口里供 Agent 调度。',
        },
      ],
    },
    panels: {
      agent: {
        tag: '面板 1',
        name: 'Agent',
        title: '可扩展的 AI 对话',
        bullets: [
          '默认走官方 Claude Agent SDK；Codex / DeepSeek / Kimi / Ollama 各 tab 独立 BYOK',
          '多项目并发会话，桌面通知提醒',
          '会话固定、分叉、跨项目浏览',
          '!command 前缀直接执行 shell，输出回流为对话上下文',
          '图片附件、代码引用、Token 用量统计',
        ],
      },
      explorer: {
        tag: '面板 2',
        name: 'Explorer',
        title: '代码与文件一站直达',
        bullets: [
          '目录树 / 最近 / Git 变更 / Git 历史 —— 4 标签页',
          '语法高亮 (Shiki) + Vi 模式编辑',
          'Git blame、Diff 视图、分支切换、Worktree',
          'LSP 集成 —— 跳转定义、查找引用',
          '代码地图 —— 一眼看清函数被谁调用、又调用了谁，点击即跳（TS/JS/Python/Go/Rust）',
          '模糊搜索 (Cmd+F)、JSON 查看器、Markdown 预览',
        ],
      },
      console: {
        tag: '面板 3',
        name: 'Console',
        title: '终端与智能气泡',
        bullets: [
          '完整终端模拟器 (xterm.js)，Shell 集成',
          '浏览器气泡 —— 通过无障碍树控制 Chrome',
          '数据库气泡 —— PostgreSQL / MySQL / Redis',
          '气泡拖拽排序、网格 / 放大布局',
          '每个标签独立的环境变量与 Shell 别名',
        ],
      },
      review: {
        tag: '团队',
        name: '代码评审',
        title: '团队协作，加速发布',
        bullets: [
          '局域网分享评审页面 —— 队友零安装即可参与',
          '行级评论与回复线程',
          '任意评论可发给 AI 作为上下文，自动修复',
          '未读评论红点提醒，跨项目可见',
          '直接基于 GUIDE.md / Markdown，无需额外评审系统',
        ],
      },
    },
    bubbles: {
      headline: 'Console 中的智能气泡',
      desc: '可悬浮、可拖拽的子面板 —— 让 AI 或你自己来驾驭。',
      items: [
        { name: '浏览器', desc: '点击、输入、导航、截图、网络检查。' },
        { name: 'PostgreSQL', desc: '浏览 Schema、执行查询、导出数据。' },
        { name: 'MySQL', desc: '浏览数据库与表、执行查询。' },
        { name: 'Redis', desc: '浏览键值、查看数据、执行命令。' },
      ],
    },
    engines: {
      tag: '⚙ 引擎',
      headline: '默认 Claude —— 也接得住你想要的任何 Agent',
      desc: '每个引擎跑在独立 tab，会话历史互不串。新建 tab 时下拉切换。',
      items: [
        {
          name: 'Claude',
          badge: '默认',
          tagline: '默认引擎',
          desc: '完整的 Claude Agent SDK —— 工具、计划、斜杠模式。`claude` CLI 已配好则零额外设置。',
        },
        {
          name: 'Codex',
          tagline: '复用你的账号',
          desc: '直接读 `~/.codex` 配置。聊天、Shell、气泡都不变 —— 只是换了个 tab。',
        },
        {
          name: 'DeepSeek',
          tagline: '便宜的长会话',
          desc: '走 Anthropic 兼容端点，复用 Claude SDK。粘 Key，选 `v4-pro` 或 `v4-flash`。',
        },
        {
          name: 'Kimi',
          tagline: '工具调用可见',
          desc: '函数调用和 Claude 一样在聊天里渲染 —— 看清调用了什么、返回了什么。',
        },
        {
          name: 'Ollama',
          tagline: '完全离线',
          desc: '自动拉起守护进程，从聊天头部下拉任意已 pull 的模型。无需 Key、无需联网。',
        },
      ],
      footnote: '一切都在本地完成。',
    },
    codeMap: {
      tag: 'Explorer · 代码地图',
      headline: '把代码读成「地图」，而不是树',
      desc: '面对陌生代码库不再无从下手：每个函数中间是函数体、左侧是「谁调用了它」、右侧是「它调用了谁」，点击 pin 即可跳转。',
      bullets: [
        '刚接手新仓库？一眼看清所有函数及其调用关系 —— 上手时间从「几天」变「几分钟」。',
        '点击两侧的 caller / callee pin 顺藤摸瓜 —— 不用再 grep 大海捞针。',
        '评审 PR 时，chip 级 diff 直接展示每个函数内部到底改了什么。',
        '追 bug 时，沿着调用图从入口走到根因，不会迷失在文件之间。',
        '看 AI 写的代码不踏实？一眼看清它动了哪些函数、它们彼此怎么连的，再决定要不要信。',
        '支持 TypeScript / JavaScript、Python、Go、Rust —— 打开即用，无需项目配置。',
      ],
      footnote: '在 Explorer 中打开任意文件 → 切换到 Code Map 视图即可使用。',
    },
    codeGraph: {
      tag: 'Agent · /cg 模式',
      headline: '给 AI 一张查询图谱，而不是 grep',
      desc: '代码图谱（code graph）是 AI Agent 和你代码库之间缺失的那一层。Code Map 是给眼睛看的，CodeGraph 是给 Agent 调用的。同一份 tree-sitter 索引开放为 10 个 HTTP 接口——符号搜索、调用者、被调用、影响范围、文件符号树、协同编辑历史，再叠加四层分析（语义上下文、相关符号、风险打分影响面、受影响测试闭包）——Agent 直接按坐标精确查询，而不是 grep 字面 + Read 全文。',
      bullets: [
        '10 个接口分两层：基础 6 类问题（「X 在哪定义」「谁调用 X」「X 调用什么」「改 X 影响什么」「文件 F 有哪些符号」「跟 F 一起改的文件」）+ 分析 4 类（语义上下文、相关符号、风险打分影响面、受影响测试文件）。',
        '只返坐标（file / line range / qname）——Agent 用 Read 按 offset + limit 精读符号本身，不读整文件。',
        'coedit 接口抓住任何静态分析都看不见的「必须一起改」的文件对：平行注册表、双写、同名 .md 配置。',
        '分析层（PageRank / PPR / TF-IDF / Louvain）在本地零训练运行——给改动打风险分、找语义相关代码、算出受影响的测试文件。',
        'file watcher 增量同步——无须 rebuild；PR 半途的修改和 AI 批量改动都能保持索引新鲜。',
        '/cg 斜杠模式用「问题 → 接口」对照表把 Agent 锚向图谱探索；原有 grep / glob / git log 一个不少，按需混搭。',
      ],
      footnote: '在任意 chat 里输入 /cg 进入探索模式——Agent 会按问题形态自己选接口。',
    },
    modes: {
      headline: '一行斜杠，切换 AI 的思考姿态',
      desc: '斜杠指令把 Agent 切到指定模式——只问不写、只查不改、只评不动。',
      items: [
        {
          cmd: '/qa',
          name: '澄清',
          desc: '复述需求、对模糊点反问、遵循 KISS——先讨论清楚，绝不动代码。',
        },
        {
          cmd: '/fx',
          name: '诊断',
          desc: 'Bug 证据链分析。Agent 从头到尾推理失败原因，不改任何文件。',
        },
        {
          cmd: '/ex',
          name: '探讨',
          desc: '结构化讨论模式。6 步骨架：问题研究 → 发散 → 收敛 → 再发散 → 迭代验证 → 总结。不中途反问。',
        },
        {
          cmd: '/go',
          name: '落地',
          desc: '落地模式：把收敛后的方案切成 MVP 小阶段、每阶段自运行验证、不停顿继续推进、最后做端到端回看。',
        },
        {
          cmd: '/cg',
          name: 'CodeGraph',
          desc: '项目图谱探索——10 个 HTTP 接口精确回答符号 / 调用关系 / 影响范围 / 协同编辑 / 风险 / 受影响测试问题，比 grep 精确、比 Read 全文省 token。',
        },
        {
          cmd: '/cc',
          name: 'Cockpit CLI',
          desc: '驾驭 cockpit 命令行——codegraph 子命令、terminal 观察、browser 自动化。每个子命令通过 --help 自我说明。',
        },
      ],
      customHint: '自定义：丢入任意 SKILL.md 并通过 Skills 侧边栏添加——自动出现在补全菜单。',
    },
    extras: {
      schedule: {
        title: '定时任务',
        desc: '一次性、间隔、Cron 三种调度。暂停、恢复、拖拽排序，跨项目追踪执行结果。',
      },
      skills: {
        title: '技能 Skills',
        desc: '任意一个 SKILL.md 都能教会 Agent 新技能 —— 在对话中用 /skill-name 直接调用，所有技能在统一面板集中管理。',
        tag: '🧩 可扩展性',
      },
    },
    builtOn: {
      headline: '基于官方 Claude Agent SDK',
      desc: 'Cockpit 的核心使用 Anthropic 官方 Claude Agent SDK。本机 `claude` CLI 已配置即可使用，无需额外配置。Codex / DeepSeek / Kimi / Ollama 复用同一套 Agent loop（通过 Vercel AI SDK 适配）。一切都在本地完成。',
    },
    finalCta: {
      headline: '起飞吧',
      desc: '一次安装，任意目录 `cockpit` 一键启动。（短别名 `cock` 同样可用。）',
    },
    footer: {
      tagline: '为并行 AI 编程而生的 Claude Code GUI。',
      product: '产品',
      resources: '资源',
      community: '社区',
      license: 'MIT 协议',
    },
    docs: {
      title: '文档',
      // SEO description：≤160 字符，用于 docs 页 metadata + OG。
      description:
        'OpenCockpit 文档 —— 一行 npm 命令安装，任意目录启动。Cockpit CLI 参考：codegraph / terminal / browser 子命令，均通过 --help 自我说明。',
      readOnGithub: '在 GitHub 阅读',
      comingSoon: '即将上线',
      onThisPage: '本页内容',
      prevPage: '上一页',
      nextPage: '下一页',
      editOnGithub: '在 GitHub 编辑此页',
      sidebar: {
        // 五个一级 section：入门 → 三个左右滑动的面板 → 参考。原本的"工作区"
        // section 已经折叠进 Agent —— notes/skills/sessions/scheduled-tasks 本质都是
        // 对话邻近功能。
        sections: {
          getStarted: '开始使用',
          agent: 'Agent 面板',
          explorer: 'Explorer 面板',
          console: 'Console 面板',
          reference: '参考',
        },
        // 二级分组标题 —— 大扁平化之后已无 group 使用，但类型与渲染保留以备未来扩展。
        groups: {},
        pages: {
          // Get Started
          introduction: '简介',
          quickstart: '快速开始',

          // Agent 面板（对话）
          messageInput: '消息输入',
          sessions: '会话管理',
          skills: 'Skills',
          engines: 'AI 引擎',
          scheduledTasks: '定时任务',
          notes: '笔记',

          // Explorer 面板（5 个模块对应面板顶栏的 5 个 tab）
          fileTree: '目录树',
          search: '搜索',
          recent: '最近',
          changes: '变更',
          history: '历史',

          // Console 面板
          inputBar: '命令输入',
          terminalBubble: '终端气泡',
          browserBubble: '浏览器气泡',
          databases: '数据库气泡',
          jupyterBubble: 'Jupyter',
          aliasesEnv: '别名与环境变量',

          // Reference
          cli: 'Cockpit CLI',
          chromeExtension: 'Chrome 扩展',
          reviews: '技术方案评审',
          keyboardShortcuts: '键盘快捷键',
          faq: '常见问题与排查',
        },
      },
    },
    changelog: {
      title: '更新日志',
      desc: '从 GitHub Releases 拉取的版本说明。',
      empty: '暂无发布记录。',
      viewOnGithub: '在 GitHub 查看',
    },
    blog: {
      title: '博客',
      desc: '关于 Claude Code、Agent SDK 与 AI 软件交付的实战笔记。',
      readMore: '阅读全文 →',
      backToBlog: '← 返回博客',
      publishedOn: '发布于',
      empty: '暂无文章。',
    },
  },
};

export type Messages = typeof messages.en;

export function getMessages(locale: Locale): Messages {
  return messages[locale];
}
