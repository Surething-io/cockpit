import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale, locales, type Locale } from '@/lib/i18n';
import { getMessages } from '@/content/messages';
import { CopyableCommand } from '@/components/CopyableCommand';

const GITHUB_URL = 'https://github.com/Surething-io/cockpit';

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = getMessages(locale);
  return {
    title: t.docs.title,
    alternates: {
      canonical: `https://cocking.cc/${locale}/docs/`,
      languages: {
        en: 'https://cocking.cc/en/docs/',
        zh: 'https://cocking.cc/zh/docs/',
      },
    },
  };
}

export default async function DocsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getMessages(locale as Locale);

  const sections = [
    {
      key: 'prereq' as const,
      en: ['Node.js ≥ 20', 'Claude Code installed and configured', 'Git', 'Chrome (optional, for Browser Bubble)'],
      zh: ['Node.js ≥ 20', 'Claude Code 已安装并配置', 'Git', 'Chrome（可选，用于浏览器气泡）'],
    },
  ];

  return (
    <article className="mx-auto max-w-3xl px-6 py-16">
      <header>
        <h1 className="text-4xl font-bold tracking-tight">{t.docs.title}</h1>
        <p className="mt-3 text-muted-foreground">{t.docs.comingSoon}</p>
      </header>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">{t.docs.sections.prereq}</h2>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          {sections[0][locale as Locale].map((item) => (
            <li key={item} className="flex gap-3">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-brand/70" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">{t.docs.sections.install}</h2>
        <div className="mt-4">
          <CopyableCommand command="npm install -g @surething/cockpit" />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">{t.docs.sections.firstRun}</h2>
        <div className="mt-4 space-y-3">
          <CopyableCommand command="cock" />
          <CopyableCommand command="cock ." />
          <CopyableCommand command="cock ~/my-project" />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {locale === 'zh'
            ? '启动后访问 http://localhost:3457'
            : 'Then open http://localhost:3457'}
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">{t.docs.sections.cli}</h2>
        <div className="mt-4 space-y-3">
          <CopyableCommand command="cock browser <id> snapshot" />
          <CopyableCommand command='cock terminal <id> exec "ls"' />
        </div>
      </section>

      <section className="mt-12 rounded-lg border border-border bg-card p-6">
        <p className="text-sm text-muted-foreground">
          {locale === 'zh'
            ? '完整说明请参考 GitHub 上的 README 与 GUIDE。'
            : 'For the complete reference, see README and GUIDE on GitHub.'}
        </p>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-teal-10 transition-colors"
        >
          {t.docs.readOnGithub} ↗
        </a>
      </section>
    </article>
  );
}
