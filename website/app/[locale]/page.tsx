import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, type Locale } from '@/lib/i18n';
import { getMessages } from '@/content/messages';
import { Hero } from '@/components/sections/Hero';
import { SimpleStory } from '@/components/sections/SimpleStory';
import { Reveal } from '@/components/Reveal';

const SITE_URL = 'https://opencockpit.dev';
// Injected at build time via `COCKPIT_VERSION=$(node -p ...) next build` (see website/package.json).
const COCKPIT_VERSION = process.env.COCKPIT_VERSION || '0.0.0';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = getMessages(locale);
  return {
    title: t.hero.headline,
    // SEO description (≤160 chars). Separate from `hero.description`,
    // which is the long visible tagline shown in the Hero section.
    description: t.hero.metaDescription,
    alternates: {
      canonical: `${SITE_URL}/${locale}/`,
      languages: {
        en: `${SITE_URL}/en/`,
        zh: `${SITE_URL}/zh/`,
        'x-default': `${SITE_URL}/en/`,
      },
    },
    openGraph: {
      title: t.hero.headline,
      description: t.hero.metaDescription,
      url: `${SITE_URL}/${locale}/`,
      siteName: 'OpenCockpit',
      type: 'website',
      locale: locale === 'zh' ? 'zh_CN' : 'en_US',
      // Tell social platforms the other-language variant exists.
      alternateLocale: locale === 'zh' ? ['en_US'] : ['zh_CN'],
      images: [
        { url: '/og.png', width: 1200, height: 630, alt: t.hero.headline },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: t.hero.headline,
      description: t.hero.metaDescription,
      images: ['/og.png'],
    },
  };
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getMessages(locale as Locale);

  // ---- JSON-LD: SoftwareApplication + WebSite (with site search) ----
  const softwareLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'OpenCockpit',
    alternateName: ['Cockpit', 'OpenCockpit AI', 'opencockpit.dev'],
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: 'AI Coding Agent GUI',
    operatingSystem: 'macOS, Linux, Windows',
    description: t.hero.description,
    url: `${SITE_URL}/${locale}/`,
    inLanguage: locale === 'zh' ? 'zh-CN' : 'en',
    softwareVersion: COCKPIT_VERSION,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    license: 'https://opensource.org/licenses/MIT',
    isAccessibleForFree: true,
    author: {
      '@type': 'Person',
      name: 'Robert',
      url: 'https://github.com/Surething-io',
      sameAs: ['https://x.com/yang1365609'],
    },
    publisher: {
      '@type': 'Organization',
      name: 'Surething',
      url: 'https://github.com/Surething-io',
    },
    downloadUrl: 'https://www.npmjs.com/package/@surething/cockpit',
    sameAs: [
      'https://github.com/Surething-io/cockpit',
      'https://www.npmjs.com/package/@surething/cockpit',
      'https://x.com/yang1365609',
    ],
    keywords: [
      'Claude Code GUI',
      'Claude Code desktop',
      'Claude Agent SDK',
      'OpenAI Codex GUI',
      'DeepSeek GUI',
      'GLM GUI',
      'Zhipu GLM GUI',
      'Kimi GUI',
      'Ollama GUI',
      'multi-engine AI coding',
      'BYOK AI coding agent',
      'local-first AI coding',
      'AI coding agent',
      'parallel AI sessions',
      'multi-project AI',
      'Cursor alternative',
      'Aider alternative',
    ].join(', '),
    featureList: [
      'Multi-engine chat: Claude (default) / Codex / DeepSeek / GLM / Kimi / Ollama — each tab a separate session',
      'Multi-project parallel agent sessions',
      'Web client–server architecture: self-host on a shared dev box — every teammate gets a seat, each in their own project / worktree',
      'Built-in xterm.js terminal',
      'Chrome browser automation',
      'PostgreSQL / MySQL / Redis bubbles',
      'LAN-shared code review',
      'Slash modes: /qa, /fx, /ex, /go, /cg, /cc',
      'Custom skills via SKILL.md',
      'Scheduled tasks (one-time, interval, cron)',
      'Code Map — onboard new codebases by walking the call graph (TS/JS/Python/Go/Rust)',
      'CodeGraph — a code graph for AI agents: 10 HTTP endpoints (6 base: symbol / callers / callees / impact / file / coedit + 4 analytics: context / related / risk / affected, powered by PageRank · PPR · TF-IDF · Louvain with zero training); /cg slash command primes graph-first exploration',
      'Cockpit CLI: line-oriented client for the agent — codegraph / terminal / browser subcommands, each self-documenting via --help; /cc slash command teaches the agent the CLI surface',
    ],
  };

  const websiteLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'OpenCockpit',
    url: SITE_URL,
    inLanguage: ['en', 'zh-CN'],
    publisher: { '@type': 'Organization', name: 'Surething' },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteLd) }}
      />
      <Hero locale={locale as Locale} t={t} />
      <Reveal>
        <SimpleStory t={t} />
      </Reveal>
    </>
  );
}
