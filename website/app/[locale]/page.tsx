import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, type Locale } from '@/lib/i18n';
import { getMessages } from '@/content/messages';
import { Hero } from '@/components/sections/Hero';
import { ValueProp } from '@/components/sections/ValueProp';
import { PanelSection } from '@/components/sections/PanelSection';
import { Bubbles } from '@/components/sections/Bubbles';
import { Extras } from '@/components/sections/Extras';
import { BuiltOn } from '@/components/sections/BuiltOn';
import { FinalCTA } from '@/components/sections/FinalCTA';

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
      canonical: `https://cocking.cc/${locale}/`,
      languages: {
        en: 'https://cocking.cc/en/',
        zh: 'https://cocking.cc/zh/',
      },
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

  return (
    <>
      <Hero locale={locale as Locale} t={t} />
      <ValueProp t={t} />
      <PanelSection
        tag={t.panels.agent.tag}
        name={t.panels.agent.name}
        title={t.panels.agent.title}
        bullets={t.panels.agent.bullets}
        screenshot="/screenshots/agent.png"
        align="left"
      />
      <PanelSection
        tag={t.panels.explorer.tag}
        name={t.panels.explorer.name}
        title={t.panels.explorer.title}
        bullets={t.panels.explorer.bullets}
        screenshot="/screenshots/explorer.png"
        align="right"
      />
      <PanelSection
        tag={t.panels.console.tag}
        name={t.panels.console.name}
        title={t.panels.console.title}
        bullets={t.panels.console.bullets}
        screenshot="/screenshots/console.png"
        align="left"
      />
      <Bubbles t={t} />
      <Extras t={t} />
      <BuiltOn t={t} />
      <FinalCTA locale={locale as Locale} t={t} />
    </>
  );
}
