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
      // Short, punchy lead shown in the Hero. `description` below stays long for
      // JSON-LD / structured data — don't merge them.
      lead:
        'The open-source Claude Code GUI, built like an IDE for the whole dev loop — code, terminal, browser & DB in one workbench. Runs on your laptop, or on a shared dev box where every teammate gets a seat.',
      pronounce: '/ˈkɒkpɪt/ — like an aircraft cockpit',
      description:
        'OpenCockpit is the open-source Claude Code GUI — an IDE-like workbench for the whole dev loop, and a single canvas for whatever agent you bring next. Multi-project Claude sessions out of the box; pop open a tab for Codex, DeepSeek, Kimi, or local Ollama whenever you need. Built-in terminal, Chrome control, PostgreSQL / MySQL / Redis bubbles, code review, and slash modes — all local. Web client–server under the hood: self-host it on a shared dev box and every teammate gets a seat, each coding with AI in their own project or worktree.',
      // SEO ≤160 chars — used by metadata only, not visible on the page. Don't merge with description.
      metaDescription:
        'Open-source Claude Code GUI — an IDE-like workbench for parallel AI coding. Codex/DeepSeek/Kimi/Ollama, terminal, browser & DB. Self-host for your team. MIT.',
      installLabel: 'Install',
      tryOnline: 'Try Online',
      githubStar: 'Star on GitHub',
      videoNotice: 'Watch the 24-second tour',
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
          'Per-tool-call snapshots — review each reply as git history, real disk diffs incl. Bash',
          '!command runs shell from chat, output piped back as context',
        ],
      },
      explorer: {
        tag: 'Panel 2',
        name: 'Explorer',
        title: 'Code & files, all-in-one',
        bullets: [
          'Directory / Recent / Git Changes / Git History in one tree',
          'Shiki syntax highlighting with Vi-mode editing',
          'Git blame, diff, branch switching, worktree',
          'LSP go-to-definition + Code Map call graph (TS/JS/Python/Go/Rust)',
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
          'Built on plain Markdown — no separate review system',
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
          desc: 'Full Claude Agent SDK — tools, plans, slash modes. Zero setup if `claude` is already configured.',
        },
        {
          name: 'Codex',
          tagline: 'Bring your account',
          desc: 'Reuses your `~/.codex` config — same chat, shell and bubbles, different tab.',
        },
        {
          name: 'DeepSeek',
          tagline: 'Long sessions on a budget',
          desc: 'Anthropic-compatible endpoint via the Claude SDK. Paste a key, pick `v4-pro` or `v4-flash`.',
        },
        {
          name: 'Kimi',
          tagline: 'Tool calls, visible',
          desc: "Tool calls render in chat like Claude's — see calls and results inline.",
        },
        {
          name: 'Ollama',
          tagline: 'Fully offline',
          desc: 'Auto-starts the daemon; pick any pulled model. No key, no internet.',
        },
      ],
      footnote: 'Everything runs locally.',
    },
    codeMap: {
      tag: 'Explorer · Code Map',
      headline: 'Read the codebase like a map, not a tree',
      desc: 'Get oriented in any unfamiliar codebase. Every function shows its body in the middle, who calls it on the left, what it calls on the right — click a pin to jump.',
      bullets: [
        'New to a repo? See every function and its connections at a glance.',
        'Click a caller / callee pin to follow the trail — no more grep-and-pray.',
        'Trace a bug from entry point to root cause without losing your place.',
        'Works across TypeScript / JavaScript, Python, Go, Rust — no setup.',
      ],
      footnote: 'Open any file in Explorer → switch to Code Map view.',
    },
    codeGraph: {
      tag: 'Agent · /cg Mode',
      headline: 'Give the AI a query graph, not a grep',
      desc: 'The missing layer between your AI agent and your codebase. The same tree-sitter index behind Code Map, exposed as 10 HTTP endpoints — so the agent queries coordinates instead of grepping text and reading whole files.',
      bullets: [
        '10 endpoints, two tiers: 6 base shapes (where is X, who calls X, impact, co-edit…) + 4 analytics (context, related, risk, affected).',
        'Returns coordinates only (file / line / qname) — the agent Reads exact ranges, never whole files.',
        'Co-edit catches must-edit-together file pairs no static analysis sees — parallel registries, double-writes, sibling configs.',
        'Incrementally synced by a file watcher — no rebuild; current across mid-PR and bulk AI edits.',
      ],
      footnote: 'Type /cg in any chat to enter graph-exploration mode.',
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
          desc: 'Evidence-chain bug analysis — reason through the failure end-to-end, never edit a file.',
        },
        {
          cmd: '/ex',
          name: 'Explore',
          desc: 'Structured 6-step discussion: study → diverge → converge → verify → summarize. No mid-flow interruptions.',
        },
        {
          cmd: '/go',
          name: 'Land',
          desc: 'Take a converged plan, slice into MVP stages, code + self-verify each, recap at the end.',
        },
        {
          cmd: '/cg',
          name: 'CodeGraph',
          desc: 'Graph-first exploration — 10 endpoints answer symbol / callers / impact / risk questions. Precise where grep is fuzzy.',
        },
        {
          cmd: '/cc',
          name: 'Cockpit CLI',
          desc: 'Drive the cockpit CLI — codegraph, terminal, browser subcommands, each self-documenting via --help.',
        },
      ],
      customHint: 'Custom: drop any SKILL.md and add it via the Skills sidebar — it auto-appears in the autocomplete menu.',
      workflow: {
        tag: 'New · chain them',
        headline: 'Stack commands into one workflow',
        desc: 'Start several lines with / or @ and Cockpit reads the whole message as one ordered run — clarify, fix, then have a sub-agent review the fix, in a single send.',
        mainText: 'runs in the main session',
        subText: 'delegates the step to a sub-agent',
        example: '/fx\nfind why retries double-charge the card\n@cr\naudit the fix for race conditions',
        link: 'How workflows work →',
      },
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
      desc: 'Cockpit\u2019s core uses Anthropic\u2019s official Claude Agent SDK. If your `claude` CLI is configured, Cockpit works — no extra setup. Other engines ride the Vercel AI SDK and the same agent loop. All local.',
    },
    finalCta: {
      headline: 'Ready to fly?',
      desc: 'Install once, then `cockpit` from any directory. (Or `cock` if you prefer the short alias.)',
    },
    compare: {
      headline: 'How OpenCockpit compares',
      sub: 'An honest snapshot as of July 2026 — each tool wins somewhere. Spotted an error? PRs welcome.',
      columns: ['OpenCockpit', 'Claude Code Desktop (official)', 'Opcode'],
      rows: [
        {
          dim: 'Positioning',
          us: 'IDE-like workbench for the whole dev loop',
          official: 'Agent session companion',
          opcode: 'Session manager for Claude Code',
        },
        {
          dim: 'Architecture',
          us: '✅ Web client–server — self-host on a shared dev box, a seat for every teammate',
          official: 'Single-user desktop app',
          opcode: 'Single-user desktop app',
        },
        {
          dim: 'Open source',
          us: '✅ MIT',
          official: '❌ Closed source',
          opcode: '✅ AGPL-3.0',
        },
        {
          dim: 'Engines',
          us: '✅ Claude + Codex / DeepSeek / Kimi / Ollama (BYOK)',
          official: 'Claude only',
          opcode: 'Claude only',
        },
        {
          dim: 'Parallel multi-project sessions',
          us: '✅',
          official: '✅',
          opcode: '✅',
        },
        {
          dim: 'Agent-drivable browser & DB',
          us: '✅ Smart Bubbles: Chrome / Postgres / MySQL / Redis',
          official: '❌ Preview pane only',
          opcode: '❌',
        },
        {
          dim: 'LAN-shared code review pages',
          us: '✅',
          official: '❌',
          opcode: '❌',
        },
        {
          dim: 'Fully offline / air-gapped',
          us: '✅ via Ollama',
          official: '❌',
          opcode: '❌',
        },
        {
          dim: 'Phone / tablet access',
          us: '✅ Any LAN browser — code runs on your machine',
          official: '✅ Via cloud sandbox (Claude Code on the web)',
          opcode: '❌ Desktop only',
        },
        {
          dim: 'Native desktop app',
          us: '❌ Local web app (needs Node ≥ 20)',
          official: '✅',
          opcode: '✅ Tauri',
        },
        {
          dim: 'Newest Claude Code features on day one',
          us: '⏳ Tracks Agent SDK releases with a lag',
          official: '✅ First party',
          opcode: '❌',
        },
        {
          dim: 'Automation triggers',
          us: 'One-time / interval / cron',
          official: '✅ Routines: cron + API + GitHub events',
          opcode: 'Background agents',
        },
        {
          dim: 'Session checkpoints / rewind',
          us: 'Pinning & forking only',
          official: '✅',
          opcode: '✅ Checkpoint timeline',
        },
        {
          dim: 'Per-tool-call change snapshots (real disk diff incl. Bash)',
          us: '✅ 7-day local shadow-git history',
          official: '❌',
          opcode: '❌ Per-prompt checkpoints only',
        },
        {
          dim: 'Usage / cost analytics',
          us: 'Basic token counts',
          official: 'n/a (plan-based)',
          opcode: '✅ Full dashboard',
        },
        {
          dim: 'Cost',
          us: 'GUI free (MIT); AI billed by whichever engine you bring — $0 with local Ollama',
          official: 'App free; needs a paid Claude plan or API billing',
          opcode: 'GUI free (AGPL); needs a paid Claude plan or API billing',
        },
        {
          dim: 'Actively maintained',
          us: '✅',
          official: '✅',
          opcode: '⚠️ Last release Aug 2025',
        },
      ],
      picks: [
        'Pick Claude Code Desktop if you live inside the Anthropic ecosystem and want first-party polish.',
        'Pick Opcode if you want a native desktop feel with checkpoints and cost analytics.',
        'Pick OpenCockpit if you want more than a chat window — an open-source, IDE-like cockpit for the whole dev loop, with any engine you bring, even from your phone.',
      ],
    },
    footer: {
      tagline: 'The open-source, IDE-like Claude Code GUI — solo on your laptop, or a seat for every teammate.',
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
          snapshots: 'Tool Snapshots',
          skills: 'Skills',
          workflows: 'Workflows',
          htmlApps: 'HTML Apps',
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
      // 页面展示用的精简 lead；下方 description 保持长文本供 JSON-LD 使用，勿合并。
      lead:
        '开源的 Claude Code GUI —— 贴合研发全流程的 IDE 式工作台：读码、终端、浏览器与数据库一体。跑在本机，或部署到共享开发机，全队一起飞。',
      pronounce: '/ˈkɒkpɪt/ —— 像飞机驾驶舱',
      description:
        'OpenCockpit 是开源的 Claude Code GUI —— 贴合研发全流程的 IDE 式工作台，也是你想接入的任何 Agent 的统一画布。多项目 Claude 会话开箱即用；想用 Codex、DeepSeek、Kimi 或本地 Ollama？直接新开一个 tab。内置终端、Chrome 自动化、PostgreSQL / MySQL / Redis 气泡、代码评审与斜杠模式 —— 全部本地。Web client-server 架构：可自托管到共享开发机，全队一起飞，在各自项目 / worktree 上并行 AI coding。',
      // SEO ≤160 字符（CJK 计为 1.5×）—— 仅用于 metadata，不在页面展示。勿与 description 合并。
      metaDescription:
        '开源 Claude Code GUI —— IDE 式工作台，多项目并行 AI 编程。Codex/DeepSeek/Kimi/Ollama 多引擎，内置终端、浏览器与数据库气泡。可自托管供全队使用。MIT 协议。',
      badge: 'Claude · Codex · DeepSeek · Kimi · Ollama',
      installLabel: '安装',
      tryOnline: '在线体验',
      githubStar: '去 GitHub 点 Star',
      videoNotice: '观看 24 秒演示',
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
          '工具调用级快照 —— 像读 git 历史一样审每条回复的真实磁盘 diff，含 Bash',
          '!command 前缀直接执行 shell，输出回流为对话上下文',
        ],
      },
      explorer: {
        tag: '面板 2',
        name: 'Explorer',
        title: '代码与文件一站直达',
        bullets: [
          '目录树 / 最近 / Git 变更 / Git 历史 —— 4 标签页',
          'Git blame、Diff 视图、分支切换、Worktree',
          'LSP 集成 —— 跳转定义、查找引用',
          '代码地图 —— 一眼看清函数被谁调用、又调用了谁，点击即跳（TS/JS/Python/Go/Rust）',
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
          '直接基于 Markdown 文件，无需额外评审系统',
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
          desc: '函数调用和 Claude 一样在聊天里渲染 —— 调用与返回一目了然。',
        },
        {
          name: 'Ollama',
          tagline: '完全离线',
          desc: '自动拉起守护进程，下拉任意已 pull 的模型。无需 Key、无需联网。',
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
        '追 bug 时，沿着调用图从入口走到根因，不会迷失在文件之间。',
        '支持 TypeScript / JavaScript、Python、Go、Rust —— 打开即用，无需项目配置。',
      ],
      footnote: '在 Explorer 中打开任意文件 → 切换到 Code Map 视图即可使用。',
    },
    codeGraph: {
      tag: 'Agent · /cg 模式',
      headline: '给 AI 一张查询图谱，而不是 grep',
      desc: '代码图谱是 AI Agent 和你代码库之间缺失的那一层。同一份 tree-sitter 索引（Code Map 背后那份）开放为 10 个 HTTP 接口 —— Agent 直接按坐标精确查询，而不是 grep 字面 + Read 全文。',
      bullets: [
        '10 个接口分两层：基础 6 类（X 在哪定义、谁调用 X、影响什么、协同编辑…）+ 分析 4 类（语义上下文、相关符号、风险、受影响测试）。',
        '只返坐标（file / line range / qname）——Agent 用 Read 按 offset + limit 精读符号本身，不读整文件。',
        'coedit 接口抓住任何静态分析都看不见的「必须一起改」的文件对：平行注册表、双写、同名 .md 配置。',
        'file watcher 增量同步——无须 rebuild；PR 半途的修改和 AI 批量改动都能保持索引新鲜。',
      ],
      footnote: '在任意 chat 里输入 /cg 进入图谱探索模式。',
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
          desc: '结构化 6 步讨论：研究 → 发散 → 收敛 → 验证 → 总结，不中途反问。',
        },
        {
          cmd: '/go',
          name: '落地',
          desc: '把收敛后的方案切成 MVP 小阶段，逐阶段写码 + 自验证，最后端到端回看。',
        },
        {
          cmd: '/cg',
          name: 'CodeGraph',
          desc: '图谱优先探索 —— 10 个接口回答符号 / 调用 / 影响 / 风险问题，比 grep 精确。',
        },
        {
          cmd: '/cc',
          name: 'Cockpit CLI',
          desc: '驾驭 cockpit 命令行 —— codegraph、terminal、browser 子命令，各自 --help 自说明。',
        },
      ],
      customHint: '自定义：丢入任意 SKILL.md 并通过 Skills 侧边栏添加——自动出现在补全菜单。',
      workflow: {
        tag: '新 · 串起来',
        headline: '把命令叠成一条工作流',
        desc: '让多行分别以 / 或 @ 开头，Cockpit 就把整条消息当成一条有序流程来跑——澄清、修复、再让子代理审一遍修复，一次发送搞定。',
        mainText: '这步在主会话执行',
        subText: '这步委派给子代理',
        example: '/fx\n查清楚为什么重试会重复扣款\n@cr\n审一下这个修复有没有竞态',
        link: '工作流怎么用 →',
      },
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
      desc: 'Cockpit 核心基于 Anthropic 官方 Claude Agent SDK —— 本机 `claude` CLI 配好即用。其他引擎复用同一套 Agent loop（经 Vercel AI SDK 适配）。全部本地。',
    },
    finalCta: {
      headline: '起飞吧',
      desc: '一次安装，任意目录 `cockpit` 一键启动。（短别名 `cock` 同样可用。）',
    },
    compare: {
      headline: 'OpenCockpit 横向对比',
      sub: '截至 2026 年 7 月的实事求是快照 —— 每个工具都有赢的地方。发现错误？欢迎 PR 指正。',
      columns: ['OpenCockpit', 'Claude Code Desktop（官方）', 'Opcode'],
      rows: [
        {
          dim: '定位',
          us: '贴合研发全流程的 IDE 式工作台',
          official: 'Agent 会话伴侣',
          opcode: 'Claude Code 会话管理器',
        },
        {
          dim: '架构',
          us: '✅ Web client-server —— 自托管到共享开发机，全队一起飞',
          official: '单机桌面应用',
          opcode: '单机桌面应用',
        },
        {
          dim: '开源',
          us: '✅ MIT',
          official: '❌ 闭源',
          opcode: '✅ AGPL-3.0',
        },
        {
          dim: '引擎',
          us: '✅ Claude + Codex / DeepSeek / Kimi / Ollama（BYOK）',
          official: '仅 Claude',
          opcode: '仅 Claude',
        },
        {
          dim: '多项目并行会话',
          us: '✅',
          official: '✅',
          opcode: '✅',
        },
        {
          dim: 'Agent 可驱动浏览器 & 数据库',
          us: '✅ 智能气泡：Chrome / Postgres / MySQL / Redis',
          official: '❌ 仅只读预览面板',
          opcode: '❌',
        },
        {
          dim: '局域网共享评审页',
          us: '✅',
          official: '❌',
          opcode: '❌',
        },
        {
          dim: '全离线 / 内网隔离',
          us: '✅ 走 Ollama',
          official: '❌',
          opcode: '❌',
        },
        {
          dim: '手机 / 平板可用',
          us: '✅ 局域网任意浏览器 —— 代码跑在你自己的机器上',
          official: '✅ 走云端沙箱（Claude Code on the web）',
          opcode: '❌ 仅桌面',
        },
        {
          dim: '原生桌面应用',
          us: '❌ 本地 Web 应用（需 Node ≥ 20）',
          official: '✅',
          opcode: '✅ Tauri',
        },
        {
          dim: '第一时间跟进 Claude Code 新特性',
          us: '⏳ 跟随 Agent SDK 发版，有滞后',
          official: '✅ 官方第一方',
          opcode: '❌',
        },
        {
          dim: '自动化触发',
          us: '一次性 / 间隔 / cron',
          official: '✅ Routines：cron + API + GitHub 事件',
          opcode: '后台 Agent',
        },
        {
          dim: '会话检查点 / 回滚',
          us: '仅固定 & 分叉',
          official: '✅',
          opcode: '✅ 检查点时间线',
        },
        {
          dim: '工具调用级变更快照（真实磁盘 diff，含 Bash）',
          us: '✅ 影子 git 本地保留 7 天',
          official: '❌',
          opcode: '❌ 仅按轮次检查点',
        },
        {
          dim: '用量 / 成本分析',
          us: '仅基础 token 计数',
          official: '不适用（订阅制）',
          opcode: '✅ 完整仪表盘',
        },
        {
          dim: '费用',
          us: 'GUI 免费（MIT）；AI 按所带引擎计费 —— 本地 Ollama 可 ¥0',
          official: '应用免费；需付费 Claude 订阅或 API 计费',
          opcode: 'GUI 免费（AGPL）；需付费 Claude 订阅或 API 计费',
        },
        {
          dim: '持续维护',
          us: '✅',
          official: '✅',
          opcode: '⚠️ 最后发版 2025-08',
        },
      ],
      picks: [
        '选官方 Desktop：深度绑定 Anthropic 生态、要第一方打磨体验。',
        '选 Opcode：要原生桌面手感 + 检查点 + 成本分析。',
        '选 OpenCockpit：你要的不只是一个聊天窗 —— 开源、IDE 式、贴合研发全流程的驾驶舱，引擎随你带，手机也能开。',
      ],
    },
    footer: {
      tagline: '开源、IDE 式的 Claude Code GUI —— 单人本机，或全队一起飞。',
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
          snapshots: '工具快照',
          skills: 'Skills',
          workflows: '工作流',
          htmlApps: 'HTML 小应用',
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
