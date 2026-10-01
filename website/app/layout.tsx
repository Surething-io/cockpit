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
const DEFAULT_TITLE = 'OpenCockpit — Open Claude Code GUI for Any LLM (Codex, GLM, Kimi, Ollama)';
// Kept under 160 chars so Google SERP doesn't truncate before the closing keywords.
const DEFAULT_DESCRIPTION =
  "Cockpit IDE: Claude Code's agent workflow on any LLM — Claude, Codex, DeepSeek, GLM, Kimi or local Ollama. Terminal, browser & DB built in. Self-host. MIT.";

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
        alt: 'OpenCockpit — Open Claude Code GUI for any LLM',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    images: ['/og.png'],
  },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48', type: 'image/x-icon' },
      { url: '/icons/icon-128x128.png', sizes: '128x128', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' }],
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
  // `lang="und"` (IANA "undetermined") is a build-time placeholder, not the
  // shipped value: a static export renders one root layout for every route, so
  // the per-route locale isn't knowable here. `scripts/postbuild-seo.mjs`
  // rewrites it to `en` / `zh-CN` in `out/` — where the path makes the locale
  // unambiguous — so crawlers and screen readers see a real language tag.
  // (`LocaleSync` still fixes it on hydration for the client-side nav case.)
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
