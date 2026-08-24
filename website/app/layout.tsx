import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { PostHogAnalytics } from '@/components/PostHogAnalytics';

/* Self-hosted at build time. Previously the CSS just named "Inter" in the font
   stack with no @font-face behind it, so Latin text rendered in Inter only for
   visitors who happened to have it installed and fell through to PingFang SC /
   Microsoft YaHei for everyone else — a display voice that varied per machine. */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const SITE_URL = 'https://opencockpit.dev';
const DEFAULT_TITLE = 'OpenCockpit — The Open Claude Code GUI for Any Agent';
// Kept under 160 chars so Google SERP doesn't truncate before the closing keywords.
const DEFAULT_DESCRIPTION =
  'Open-source Claude Code GUI — parallel AI coding. Multi-engine (Codex/DeepSeek/GLM/Kimi/Ollama), terminal, Chrome & DB bubbles, code graph. Local, MIT.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: DEFAULT_TITLE,
    template: '%s · OpenCockpit',
  },
  description: DEFAULT_DESCRIPTION,
  applicationName: 'OpenCockpit',
  authors: [{ name: 'Surething', url: 'https://github.com/Surething-io' }],
  generator: 'Next.js',
  keywords: [
    // Core product / category
    'Claude Code',
    'Claude Code GUI',
    'Claude Code desktop',
    'Claude Code client',
    'Claude Agent SDK',
    'Anthropic',
    'AI coding agent',
    'AI coding assistant',
    'AI IDE',
    'parallel AI sessions',
    'multi-project AI',
    'agent SDK',
    'AI pair programming',
    'AI code review',
    'BYOK AI coding',
    'local-first AI',
    'opencockpit',
    'cockpit',
    // Differentiators — only Cockpit has these as named features
    'CodeGraph',
    'code graph for AI',
    'tree-sitter code graph',
    'Code Map',
    'AI browser automation',
    'PostgreSQL bubble',
    // Per-engine long-tail (each engine has its own search volume)
    'OpenAI Codex GUI',
    'DeepSeek GUI',
    'GLM GUI',
    'Zhipu GLM GUI',
    'Kimi GUI',
    'Moonshot Kimi GUI',
    'Ollama GUI',
    // Alternative-to queries (high-intent SERP)
    'Cursor alternative',
    'Windsurf alternative',
    'Cline alternative',
    'Roo Code alternative',
    'GitHub Copilot alternative',
    'Codeium alternative',
    'Continue alternative',
    'Aider alternative',
    // Chinese core
    'AI 编程',
    'AI 编码',
    'AI 编程助手',
    'AI 编辑器',
    'AI 写代码',
    'AI 程序员',
    'AI Pair Programming',
    'Claude Code 客户端',
    'Claude Code 桌面',
    'Claude Code 中文',
    'Claude Code 教程',
    'Claude Code GUI',
    'Claude 编程',
    '本地 AI 编程',
    'BYOK AI 编程',
    '多项目 AI',
    '并发 AI 会话',
    '并行 AI 编码',
    'AI 驾驶舱',
    // Chinese differentiators (Cockpit-unique features)
    '代码图谱',
    '调用关系图',
    '智能气泡',
    'AI 代码评审',
    'AI 浏览器自动化',
    'AI 终端',
    '代码地图',
    // Chinese per-engine long-tail
    'Codex 中文',
    'DeepSeek 编程',
    'GLM 编程',
    '智谱 GLM 编程',
    'Kimi 编程',
    'Ollama 中文',
    // Chinese alternative-to
    'Cursor 替代',
    'Cline 替代',
    'Windsurf 替代',
    'GitHub Copilot 替代',
    'Codeium 替代',
  ],
  referrer: 'origin-when-cross-origin',
  creator: 'Robert',
  publisher: 'Surething',
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
  alternates: {
    canonical: SITE_URL,
    languages: {
      en: `${SITE_URL}/en/`,
      zh: `${SITE_URL}/zh/`,
      'x-default': `${SITE_URL}/en/`,
    },
  },
  openGraph: {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    url: SITE_URL,
    siteName: 'OpenCockpit',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'OpenCockpit — Claude Code GUI for parallel AI coding',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: DEFAULT_TITLE,
    description: 'One seat. One AI. Everything under control.',
    images: ['/og.png'],
  },
  icons: {
    icon: '/icons/icon-128x128.png',
    apple: '/icons/icon-128x128.png',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  category: 'technology',
};

export const viewport: Viewport = {
  // The site ships dark-only, so pin the browser UI + form-control rendering to
  // dark rather than following the OS.
  themeColor: '#111113',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

/**
 * Privacy-friendly analytics (Plausible). Only loaded when
 * NEXT_PUBLIC_PLAUSIBLE_DOMAIN is set at build time — keeps preview / dev runs
 * clean and lets us swap providers without code changes.
 */
const PLAUSIBLE_DOMAIN = process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN;
const PLAUSIBLE_SRC =
  process.env.NEXT_PUBLIC_PLAUSIBLE_SRC ?? 'https://plausible.io/js/script.outbound-links.js';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // `lang="und"` (IANA "undetermined"): static export renders one root layout
  // shared by every route, so we cannot encode the per-route locale here.
  // `LocaleSync` corrects `document.documentElement.lang` on hydration; the
  // authoritative SEO signal is the `hreflang` map in `alternates.languages`.
  return (
    <html lang="und" className={`dark ${inter.variable}`} suppressHydrationWarning>
      <head>
        {PLAUSIBLE_DOMAIN ? (
          <script
            defer
            data-domain={PLAUSIBLE_DOMAIN}
            src={PLAUSIBLE_SRC}
          />
        ) : null}
      </head>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <PostHogAnalytics />
        {children}
      </body>
    </html>
  );
}
