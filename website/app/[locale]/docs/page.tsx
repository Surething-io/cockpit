import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale, locales, type Locale } from '@/lib/i18n';
import { getMessages } from '@/content/messages';
import { docsHref, docsSidebar, getFirstAvailablePage, type DocPage } from '@/content/docs/sidebar';

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
  const url = `https://opencockpit.dev/${locale}/docs/`;
  return {
    title: t.docs.title,
    description: t.docs.description,
    alternates: {
      canonical: url,
      languages: {
        en: 'https://opencockpit.dev/en/docs/',
        zh: 'https://opencockpit.dev/zh/docs/',
        'x-default': 'https://opencockpit.dev/en/docs/',
      },
    },
    openGraph: {
      title: `${t.docs.title} · OpenCockpit`,
      description: t.docs.description,
      url,
      siteName: 'OpenCockpit',
      type: 'website',
      locale: locale === 'zh' ? 'zh_CN' : 'en_US',
      alternateLocale: locale === 'zh' ? ['en_US'] : ['zh_CN'],
      images: [
        { url: '/og.png', width: 1200, height: 630, alt: `${t.docs.title} · OpenCockpit` },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${t.docs.title} · OpenCockpit`,
      description: t.docs.description,
      images: ['/og.png'],
    },
  };
}

/**
 * One-line blurb for a docs card, taken from the page's own first paragraph.
 *
 * Deriving it from the Markdown keeps the index honest — a card can't advertise
 * something the page stopped saying — and costs nothing at runtime because this
 * route is statically exported.
 */
async function blurbFor(slug: string, locale: Locale): Promise<string> {
  const read = async (loc: Locale) => {
    try {
      return await fs.readFile(
        path.join(process.cwd(), 'content', 'docs', `${slug}.${loc}.md`),
        'utf8',
      );
    } catch {
      return null;
    }
  };
  // Same fallback rule as the content route: an untranslated page shows English
  // rather than an empty card.
  const source = (await read(locale)) ?? (await read('en'));
  if (!source) return '';

  const firstParagraph = source
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.startsWith('<'));
  if (!firstParagraph) return '';

  const plain = firstParagraph
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/[`*_]/g, '')
    .trim();
  // CJK has no spaces to break on, so cut on character count for both scripts
  // and let the ellipsis signal the truncation.
  return plain.length > 130 ? `${plain.slice(0, 129).trimEnd()}…` : plain;
}

/**
 * `/[locale]/docs/` — the documentation index.
 *
 * This used to be a bare `redirect()` to the first sidebar page. In a static
 * export that compiled to Next's client-side error shell: a 23 KB HTML document
 * with no `<h1>`, no prose, and no `lang` — served at a URL the homepage links
 * to directly. Crawlers that don't run the redirect saw an empty page, and the
 * 40-odd real docs pages were reachable only through the sidebar.
 *
 * So the index is now a page in its own right: it names every section and links
 * every available page, which gives the docs tree a crawlable root one hop from
 * the homepage.
 */
export default async function DocsIndex({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const safeLocale = locale as Locale;
  const t = getMessages(safeLocale);
  const first = getFirstAvailablePage();

  // Flatten `section.pages` + `section.groups[].pages` into one list per
  // section — the index doesn't render sub-group headings.
  const sections = docsSidebar.map((section) => ({
    key: section.key,
    label:
      t.docs.sidebar.sections[section.key as keyof typeof t.docs.sidebar.sections] ?? section.key,
    pages: [...(section.pages ?? []), ...(section.groups ?? []).flatMap((g) => g.pages)],
  }));

  // Resolve every blurb up front: `map` over an async function inside JSX would
  // hand React a promise per card.
  const blurbs = new Map<string, string>(
    await Promise.all(
      sections
        .flatMap((s) => s.pages)
        .filter((p) => p.available)
        .map(async (p): Promise<[string, string]> => [p.slug, await blurbFor(p.slug, safeLocale)]),
    ),
  );

  const label = (page: DocPage) =>
    t.docs.sidebar.pages[page.labelKey as keyof typeof t.docs.sidebar.pages] ?? page.labelKey;

  return (
    <article className="min-w-0 flex-1 px-4 py-10 sm:px-6 lg:py-12 max-w-3xl">
      <h1 className="text-4xl font-bold tracking-tight">{t.docs.title}</h1>
      <p className="mt-4 text-lg text-muted-foreground">{t.docs.indexLead}</p>

      {first ? (
        <Link
          href={docsHref(safeLocale, first.slug)}
          className="mt-6 inline-block text-sm text-brand hover:underline"
        >
          {t.docs.indexStart}
        </Link>
      ) : null}

      <div className="mt-12 space-y-12">
        {sections.map((section) => (
          <section key={section.key}>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {section.label}
            </h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {section.pages.map((page) =>
                page.available ? (
                  <li key={page.slug}>
                    <Link
                      href={docsHref(safeLocale, page.slug)}
                      className="block h-full rounded-lg border border-white/10 bg-white/[0.02] p-4 transition-colors hover:border-brand/50 hover:bg-white/[0.04]"
                    >
                      <span className="block font-medium">{label(page)}</span>
                      {blurbs.get(page.slug) ? (
                        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                          {blurbs.get(page.slug)}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ) : (
                  <li
                    key={page.slug}
                    className="h-full rounded-lg border border-dashed border-white/10 p-4 text-muted-foreground/60"
                  >
                    <span className="block font-medium">{label(page)}</span>
                    <span className="mt-1 block text-sm">{t.docs.comingSoon}</span>
                  </li>
                ),
              )}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}
