import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isLocale, locales, type Locale } from '@/lib/i18n';
import { getMessages } from '@/content/messages';
import { posts } from '@/content/posts';

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
    title: t.blog.title,
    description: t.blog.desc,
    alternates: {
      canonical: `https://opencockpit.dev/${locale}/blog/`,
      languages: {
        en: 'https://opencockpit.dev/en/blog/',
        zh: 'https://opencockpit.dev/zh/blog/',
        'x-default': 'https://opencockpit.dev/en/blog/',
      },
      // Feed files are emitted by `scripts/postbuild-seo.mjs` after export.
      types: {
        'application/rss+xml': [
          { url: `https://opencockpit.dev/${locale}/feed.xml`, title: 'OpenCockpit Blog' },
        ],
      },
    },
    openGraph: {
      title: `${t.blog.title} · OpenCockpit`,
      description: t.blog.desc,
      url: `https://opencockpit.dev/${locale}/blog/`,
      siteName: 'OpenCockpit',
      type: 'website',
      locale: locale === 'zh' ? 'zh_CN' : 'en_US',
      alternateLocale: locale === 'zh' ? ['en_US'] : ['zh_CN'],
      images: [
        { url: '/og.png', width: 1200, height: 630, alt: `${t.blog.title} · OpenCockpit` },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${t.blog.title} · OpenCockpit`,
      description: t.blog.desc,
      images: ['/og.png'],
    },
  };
}

function formatDate(iso: string, locale: Locale): string {
  try {
    return new Date(iso).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export default async function BlogIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getMessages(locale as Locale);

  const sorted = [...posts].sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <article className="mx-auto max-w-3xl px-6 py-16">
      <header className="border-b border-border pb-6">
        <h1 className="text-4xl font-bold tracking-tight">{t.blog.title}</h1>
        <p className="mt-3 text-muted-foreground">{t.blog.desc}</p>
      </header>

      {sorted.length === 0 ? (
        <p className="mt-12 text-muted-foreground">{t.blog.empty}</p>
      ) : (
        <ul className="mt-10 space-y-10">
          {sorted.map((p) => {
            const c = p.content[locale as Locale];
            return (
              <li key={p.slug} className="group">
                <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  {formatDate(p.date, locale as Locale)}
                  {c.readingTime ? ` · ${c.readingTime}` : null}
                </div>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">
                  <Link
                    href={`/${locale}/blog/${p.slug}/`}
                    className="hover:text-brand transition-colors"
                  >
                    {c.title}
                  </Link>
                </h2>
                <p className="mt-2 text-muted-foreground leading-relaxed">{c.description}</p>
                <Link
                  href={`/${locale}/blog/${p.slug}/`}
                  className="mt-3 inline-flex items-center text-sm text-brand hover:underline"
                >
                  {t.blog.readMore}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
