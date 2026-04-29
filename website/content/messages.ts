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
      headline: 'A Claude Code GUI built for parallel AI projects',
      subheadline: 'One seat. One AI. Everything under control.',
      pronounce: '/ˈkɒkpɪt/ — like an aircraft cockpit',
      description:
        'Cockpit is an open-source Claude Code GUI. Run multiple Claude Code Agent SDK sessions in parallel across projects, with a built-in terminal, Chrome control, PostgreSQL / MySQL / Redis bubbles, code review, and slash modes — all local, zero config.',
      installLabel: 'Install',
      tryOnline: 'Try Online',
      githubStar: 'Star on GitHub',
      videoNotice: 'Watch the 60-second tour',
    },
    valueProp: {
      headline: 'Why Cockpit beats raw Claude Code',
      points: [
        {
          title: 'Multi-project parallel sessions',
          desc: 'Run 5+ Claude Code sessions across projects at once. Get notified when each finishes — no terminal juggling.',
        },
        {
          title: 'Zero config, fully local',
          desc: 'If `claude` works in your shell, Cockpit works. No extra API key, no cloud relay, no telemetry.',
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
        title: 'Claude Code chat that scales with you',
        bullets: [
          'Powered by the official Claude Agent SDK — zero API key setup',
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
    modes: {
      headline: 'One slash, one AI mindset',
      desc: 'Slash commands flip the agent into a specific posture — talk first, debug only, never touch code. Drop any markdown into ~/.claude/commands/ to define your own.',
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
          cmd: '/review',
          name: 'Review',
          desc: 'Reads the current diff and writes review notes — line by line, no rewrites.',
        },
        {
          cmd: '/commit',
          name: 'Commit',
          desc: 'Stage what changed, draft a message in your repo’s style, commit.',
        },
      ],
      customHint: 'Custom: any *.md in ~/.claude/commands/ or ./.claude/commands/ becomes a slash command — auto-loaded into the autocomplete menu.',
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
      desc: 'Cockpit uses Anthropic\u2019s official Claude Agent SDK under the hood. If your `claude` CLI is configured, Cockpit works — no extra API keys, no cloud relay.',
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
      comingSoon: 'Full documentation is coming soon. Meanwhile, see the README on GitHub.',
      readOnGithub: 'Read on GitHub',
      sections: {
        prereq: 'Prerequisites',
        install: 'Install',
        firstRun: 'First run',
        cli: 'CLI',
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
      headline: '为并行 AI 编程而生的 Claude Code GUI',
      subheadline: 'One seat. One AI. Everything under control.',
      pronounce: '/ˈkɒkpɪt/ —— 像飞机驾驶舱',
      description:
        'Cockpit 是开源的 Claude Code GUI：基于官方 Claude Agent SDK，多项目并发会话、内置终端、浏览器自动化、PostgreSQL / MySQL / Redis 数据库气泡、代码评审与斜杠模式 —— 全部本地化，零配置。',
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
          desc: '同时跑 5+ 个 Claude Code 会话，跨项目互不打扰。完成自动通知，不再切终端。',
        },
        {
          title: '零配置、纯本地',
          desc: '终端能跑 `claude` 就能跑 Cockpit。无需额外 API Key，无云端中转，无遥测。',
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
        title: '可扩展的 Claude Code 对话',
        bullets: [
          '基于官方 Claude Agent SDK，零 API Key 配置',
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
    modes: {
      headline: '一行斜杠，切换 AI 的思考姿态',
      desc: '斜杠指令把 Agent 切到指定模式——只问不写、只查不改、只评不动。把任意 markdown 丢进 ~/.claude/commands/ 就能定义自己的模式。',
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
          cmd: '/review',
          name: '评审',
          desc: '读取当前 diff 并写评审意见——逐行点评，不动手重写。',
        },
        {
          cmd: '/commit',
          name: '提交',
          desc: '暂存改动、按你仓库的风格起草 message、完成提交。',
        },
      ],
      customHint: '自定义：~/.claude/commands/ 或 ./.claude/commands/ 下任意 *.md 都会成为斜杠指令——自动出现在补全菜单。',
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
      desc: 'Cockpit 底层使用 Anthropic 官方 Claude Agent SDK。本机 `claude` CLI 已配置即可使用，无需额外 API Key，无云端中转。',
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
      comingSoon: '完整文档即将上线。在此之前请参考 GitHub 上的 README。',
      readOnGithub: '在 GitHub 阅读',
      sections: {
        prereq: '前置依赖',
        install: '安装',
        firstRun: '首次运行',
        cli: 'CLI',
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
