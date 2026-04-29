import type { Metadata, Viewport } from 'next';
import './globals.css';

const SITE_URL = 'https://cocking.cc';
const DEFAULT_TITLE = 'Cockpit — Claude Code GUI for Parallel AI Coding';
const DEFAULT_DESCRIPTION =
  'Cockpit is an open-source Claude Code GUI: run parallel AI coding sessions across projects, with a built-in terminal, browser automation, PostgreSQL/MySQL/Redis bubbles, code review, and slash modes. Zero config, fully local, MIT licensed.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: DEFAULT_TITLE,
    template: '%s · Cockpit',
  },
  description: DEFAULT_DESCRIPTION,
  applicationName: 'Cockpit',
  authors: [{ name: 'Surething', url: 'https://github.com/Surething-io' }],
  generator: 'Next.js',
  keywords: [
    'Claude Code',
    'Claude Code GUI',
    'Claude Code desktop',
    'Claude Code client',
    'Claude Agent SDK',
    'Anthropic',
    'AI coding agent',
    'AI IDE',
    'parallel AI sessions',
    'multi-project AI',
    'agent SDK',
    'AI pair programming',
    'AI code review',
    'cockpit',
    'cocking',
    'Cursor alternative',
    'Continue alternative',
    'Aider alternative',
    'AI 编程',
    'AI 编码',
    'Claude Code 客户端',
    'Claude Code 桌面',
    'Claude Code GUI',
    '多项目 AI',
    '并发 AI 会话',
    'AI 驾驶舱',
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
    siteName: 'Cockpit',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'Cockpit — Claude Code GUI for parallel AI coding',
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
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0d1117' },
  ],
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
  return (
    <html lang="en" suppressHydrationWarning>
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
        {children}
      </body>
    </html>
  );
}
