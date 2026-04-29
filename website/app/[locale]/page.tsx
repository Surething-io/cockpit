import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, type Locale } from '@/lib/i18n';
import { getMessages } from '@/content/messages';
import { Hero } from '@/components/sections/Hero';
import { ValueProp } from '@/components/sections/ValueProp';
import { PanelSection } from '@/components/sections/PanelSection';
import { Bubbles } from '@/components/sections/Bubbles';
import { Modes } from '@/components/sections/Modes';
import { Extras } from '@/components/sections/Extras';
import { BuiltOn } from '@/components/sections/BuiltOn';
import { FinalCTA } from '@/components/sections/FinalCTA';

const SITE_URL = 'https://cocking.cc';

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
    description: t.hero.description,
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
      description: t.hero.description,
      url: `${SITE_URL}/${locale}/`,
      siteName: 'Cockpit',
      type: 'website',
      locale: locale === 'zh' ? 'zh_CN' : 'en_US',
      images: [
        { url: '/og.png', width: 1200, height: 630, alt: t.hero.headline },
      ],
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
    name: 'Cockpit',
    alternateName: ['Cockpit AI', 'cocking.cc'],
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: 'AI Coding Agent GUI',
    operatingSystem: 'macOS, Linux, Windows',
    description: t.hero.description,
    url: `${SITE_URL}/${locale}/`,
    inLanguage: locale === 'zh' ? 'zh-CN' : 'en',
    softwareVersion: '1.0.195',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    license: 'https://opensource.org/licenses/MIT',
    isAccessibleForFree: true,
    author: { '@type': 'Person', name: 'Robert', url: 'https://github.com/Surething-io' },
    publisher: {
      '@type': 'Organization',
      name: 'Surething',
      url: 'https://github.com/Surething-io',
    },
    downloadUrl: 'https://www.npmjs.com/package/@surething/cockpit',
    sameAs: [
      'https://github.com/Surething-io/cockpit',
      'https://www.npmjs.com/package/@surething/cockpit',
    ],
    keywords: [
      'Claude Code GUI',
      'Claude Code desktop',
      'Claude Agent SDK',
      'AI coding agent',
      'parallel AI sessions',
      'multi-project AI',
      'Cursor alternative',
      'Aider alternative',
    ].join(', '),
    featureList: [
      'Multi-project parallel Claude Code sessions',
      'Built-in xterm.js terminal',
      'Chrome browser automation',
      'PostgreSQL / MySQL / Redis bubbles',
      'LAN-shared code review',
      'Slash modes: /qa, /fx, /review, /commit',
      'Custom skills via SKILL.md',
      'Scheduled tasks (one-time, interval, cron)',
    ],
  };

  const websiteLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Cockpit',
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
      <ValueProp t={t} />
      <PanelSection
        tag={t.panels.agent.tag}
        name={t.panels.agent.name}
        title={t.panels.agent.title}
        bullets={t.panels.agent.bullets}
        screenshot="/screenshots/agent.webp"
        align="left"
      />
      <PanelSection
        tag={t.panels.explorer.tag}
        name={t.panels.explorer.name}
        title={t.panels.explorer.title}
        bullets={t.panels.explorer.bullets}
        screenshot="/screenshots/explorer.webp"
        align="right"
      />
      <PanelSection
        tag={t.panels.console.tag}
        name={t.panels.console.name}
        title={t.panels.console.title}
        bullets={t.panels.console.bullets}
        screenshot="/screenshots/console.webp"
        align="left"
      />
      <Bubbles t={t} />
      <Modes t={t} />
      <PanelSection
        tag={t.panels.review.tag}
        name={t.panels.review.name}
        title={t.panels.review.title}
        bullets={t.panels.review.bullets}
        screenshot="/screenshots/review.webp"
        align="right"
      />
      <Extras t={t} />
      <BuiltOn t={t} />
      <FinalCTA locale={locale as Locale} t={t} />
    </>
  );
}
