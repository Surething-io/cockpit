import type { Locale } from '@/lib/i18n';

export const messages = {
  en: {
    nav: {
      docs: 'Docs',
      changelog: 'Changelog',
      github: 'GitHub',
    },
    hero: {
      headline: 'The Cockpit That Drives AI',
      subheadline: 'One seat. One AI. Everything under control.',
      description:
        'A unified development cockpit built on Claude Code (Agent SDK) — chat, code, terminal, browser, database all in one interface.',
      installLabel: 'Install',
      tryOnline: 'Try Online',
      githubStar: 'Star on GitHub',
      videoNotice: 'Watch the 60-second tour',
    },
    valueProp: {
      headline: '20× AI power, 20× your productivity',
      points: [
        {
          title: 'Multi-project parallel sessions',
          desc: 'Run multiple AI tasks across projects simultaneously, get notified when done.',
        },
        {
          title: 'Zero config, zero cloud',
          desc: 'If you can run Claude Code, Cockpit works out of the box. Fully local.',
        },
        {
          title: 'Stay in flow',
          desc: 'Three-panel swipe UI with red-dot badges — never miss a completed task.',
        },
      ],
    },
    panels: {
      agent: {
        tag: 'Panel 1',
        name: 'Agent',
        title: 'AI Chat that scales with you',
        bullets: [
          'Powered by Claude Code (Agent SDK) — zero API key setup',
          'Multi-project concurrent sessions with notifications',
          'Session pinning, forking, cross-project browser',
          '!command prefix to run shell from chat',
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
      headline: 'One stroke to switch the AI’s mindset',
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
      headline: 'Built on Claude Code (Agent SDK)',
      desc: 'Cockpit uses the official Claude Code Agent SDK under the hood. If your Claude Code is configured, Cockpit works — no extra API keys.',
    },
    finalCta: {
      headline: 'Ready to fly?',
      desc: 'Install once, then `cock` from any directory.',
    },
    footer: {
      tagline: 'The Cockpit That Drives AI',
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
  },
  zh: {
    nav: {
      docs: '文档',
      changelog: '更新日志',
      github: 'GitHub',
    },
    hero: {
      headline: '驱动 AI 的驾驶舱',
      subheadline: 'One seat. One AI. Everything under control.',
      description:
        '基于 Claude Code (Agent SDK) 构建的一站式开发座舱 —— 对话、代码、终端、浏览器、数据库全部集成在一个界面中。',
      installLabel: '安装',
      tryOnline: '在线体验',
      githubStar: 'GitHub 点亮 Star',
      videoNotice: '观看 60 秒演示',
    },
    valueProp: {
      headline: '20× AI 算力，20× 你的效率',
      points: [
        {
          title: '多项目并发会话',
          desc: '多个 AI 任务跨项目并行执行，完成后自动通知。',
        },
        {
          title: '零配置、零云端',
          desc: '能跑 Claude Code 就能用 Cockpit。完全本地，无云端依赖。',
        },
        {
          title: '专注心流',
          desc: '三屏滑动 UI 配合红点徽标，不错过任何完成的任务。',
        },
      ],
    },
    panels: {
      agent: {
        tag: '面板 1',
        name: 'Agent',
        title: '可扩展的 AI 对话',
        bullets: [
          '基于 Claude Code (Agent SDK)，零 API Key 配置',
          '多项目并发会话，完成自动通知',
          '会话固定、分叉、跨项目浏览',
          '!command 前缀直接执行 shell',
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
      headline: '基于 Claude Code (Agent SDK)',
      desc: 'Cockpit 底层使用官方 Claude Code Agent SDK。Claude Code 已配置即可使用，无需额外 API Key。',
    },
    finalCta: {
      headline: '起飞吧',
      desc: '一次安装，任意目录 `cock` 一键启动。',
    },
    footer: {
      tagline: '驱动 AI 的驾驶舱',
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
  },
};

export type Messages = typeof messages.en;

export function getMessages(locale: Locale): Messages {
  return messages[locale];
}
