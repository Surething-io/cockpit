import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isLocale, locales, type Locale } from '@/lib/i18n';
import { getMessages } from '@/content/messages';
import { getPostBySlug, posts } from '@/content/posts';

const SITE_URL = 'https://cocking.cc';

export function generateStaticParams() {
  const params: { locale: string; slug: string }[] = [];
  for (const locale of locales) {
    for (const post of posts) {
      params.push({ locale, slug: post.slug });
    }
  }
  return params;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const post = getPostBySlug(slug);
  if (!post) return {};
  const c = post.content[locale];
  const url = `${SITE_URL}/${locale}/blog/${slug}/`;

  return {
    title: c.title,
    description: c.description,
    keywords: post.keywords,
    alternates: {
      canonical: url,
      languages: {
        en: `${SITE_URL}/en/blog/${slug}/`,
        zh: `${SITE_URL}/zh/blog/${slug}/`,
      },
    },
    openGraph: {
      title: c.title,
      description: c.description,
      url,
      type: 'article',
      publishedTime: post.date,
      authors: ['Robert'],
      tags: post.keywords,
      images: [
        {
          url: '/og.png',
          width: 1200,
          height: 630,
          alt: c.title,
        },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: c.title,
      description: c.description,
      images: ['/og.png'],
    },
  };
}

function formatDate(iso: string, locale: Locale): string {
  try {
    return new Date(iso).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const post = getPostBySlug(slug);
  if (!post) notFound();

  const t = getMessages(locale as Locale);
  const c = post.content[locale as Locale];
  const url = `${SITE_URL}/${locale}/blog/${slug}/`;

  // BlogPosting structured data — gives Google a rich snippet for article search
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: c.title,
    description: c.description,
    keywords: post.keywords.join(', '),
    inLanguage: locale === 'zh' ? 'zh-CN' : 'en',
    datePublished: post.date,
    dateModified: post.date,
    author: { '@type': 'Person', name: 'Robert', url: 'https://github.com/Surething-io' },
    publisher: {
      '@type': 'Organization',
      name: 'Cockpit',
      logo: { '@type': 'ImageObject', url: `${SITE_URL}/icons/icon-128x128.png` },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    image: `${SITE_URL}/og.png`,
  };

  return (
    <article className="mx-auto max-w-3xl px-6 py-16">
      <script
        type="application/ld+json"
        // JSON-LD must be inserted as a literal string; Next sanitizes innerHTML.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <Link
        href={`/${locale}/blog/`}
        className="text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-brand transition-colors"
      >
        {t.blog.backToBlog}
      </Link>

      <header className="mt-4 border-b border-border pb-6">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight leading-tight">
          {c.title}
        </h1>
        <div className="mt-4 text-sm text-muted-foreground font-mono">
          {t.blog.publishedOn} {formatDate(post.date, locale as Locale)}
          {c.readingTime ? ` · ${c.readingTime}` : null}
        </div>
        <p className="mt-4 text-base text-muted-foreground leading-relaxed">{c.description}</p>
      </header>

      <div className="prose prose-sm md:prose-base mt-8 max-w-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => (
              <h2 className="mt-10 text-2xl font-semibold tracking-tight">{children}</h2>
            ),
            h2: ({ children }) => (
              <h2 className="mt-10 text-2xl font-semibold tracking-tight">{children}</h2>
            ),
            h3: ({ children }) => (
              <h3 className="mt-8 text-xl font-semibold tracking-tight">{children}</h3>
            ),
            p: ({ children }) => (
              <p className="mt-4 text-foreground/90 leading-relaxed">{children}</p>
            ),
            ul: ({ children }) => (
              <ul className="mt-4 ml-5 list-disc space-y-1.5 text-foreground/90">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="mt-4 ml-5 list-decimal space-y-1.5 text-foreground/90">{children}</ol>
            ),
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            blockquote: ({ children }) => (
              <blockquote className="mt-4 border-l-2 border-brand/60 bg-card/40 px-4 py-2 italic text-muted-foreground">
                {children}
              </blockquote>
            ),
            a: ({ children, href }) => {
              const isExternal = href?.startsWith('http');
              return (
                <a
                  href={href}
                  {...(isExternal ? { target: '_blank', rel: 'noreferrer' } : {})}
                  className="text-brand hover:underline"
                >
                  {children}
                </a>
              );
            },
            code: ({ children, className }) => {
              // Block code (with className like "language-bash") vs inline code.
              const isBlock = className?.includes('language-');
              if (isBlock) {
                return (
                  <code className={`${className} block`}>{children}</code>
                );
              }
              return <code className="code-inline">{children}</code>;
            },
            pre: ({ children }) => (
              <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-card p-4 text-sm leading-relaxed">
                {children}
              </pre>
            ),
            table: ({ children }) => (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full border-collapse text-sm">{children}</table>
              </div>
            ),
            thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
            th: ({ children }) => (
              <th className="px-3 py-2 text-left font-semibold">{children}</th>
            ),
            td: ({ children }) => (
              <td className="border-b border-border/50 px-3 py-2 align-top">{children}</td>
            ),
            hr: () => <hr className="my-10 border-border" />,
          }}
        >
          {c.body}
        </ReactMarkdown>
      </div>

      <footer className="mt-16 border-t border-border pt-8">
        <Link
          href={`/${locale}/blog/`}
          className="text-sm text-brand hover:underline"
        >
          {t.blog.backToBlog}
        </Link>
      </footer>
    </article>
  );
}
