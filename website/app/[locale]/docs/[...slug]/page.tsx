import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MDXRemote } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';

import { isLocale, locales, type Locale } from '@/lib/i18n';
import { getMessages } from '@/content/messages';
import {
  docsSidebar,
  findPageBySlug,
  getAvailablePages,
} from '@/content/docs/sidebar';
import { DocsPager } from '@/components/docs/DocsPager';
import { DocsToc } from '@/components/docs/DocsToc';
import { mdxComponents } from '@/components/docs/mdxComponents';
import { extractHeadings } from '@/components/docs/toc';

const SITE_URL = 'https://opencockpit.dev';
const GITHUB_DOCS_BASE = 'https://github.com/Surething-io/cockpit/tree/main/website/content/docs';

/**
 * Enumerate every (locale, slug) pair that has an MDX file on disk so
 * Next.js can pre-render them all as static HTML at build time. Pages
 * marked `available: false` in the sidebar are skipped — they're surfaced
 * in the sidebar only as "Coming soon" labels.
 */
export function generateStaticParams() {
  const pages = getAvailablePages();
  return locales.flatMap((locale) =>
    pages.map((page) => ({
      locale,
      slug: page.slug.split('/'),
    })),
  );
}

interface DocsPageProps {
  params: Promise<{ locale: string; slug: string[] }>;
}

export async function generateMetadata({ params }: DocsPageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const slugStr = slug.join('/');
  const page = findPageBySlug(slugStr);
  if (!page) return {};

  const t = getMessages(locale);
  const pageLabel =
    t.docs.sidebar.pages[page.labelKey as keyof typeof t.docs.sidebar.pages] ?? page.labelKey;
  const source = await readDocSource(slugStr, locale);
  const description = source ? extractDocDescription(source) : undefined;

  return {
    title: `${pageLabel} · ${t.docs.title}`,
    description,
    alternates: {
      canonical: `${SITE_URL}/${locale}/docs/${slugStr}/`,
      languages: {
        en: `${SITE_URL}/en/docs/${slugStr}/`,
        zh: `${SITE_URL}/zh/docs/${slugStr}/`,
        'x-default': `${SITE_URL}/en/docs/${slugStr}/`,
      },
    },
  };
}

/**
 * Resolve a sidebar slug to the corresponding Markdown file path on disk. The
 * convention is `website/content/docs/<slug>.<locale>.md`; e.g. the
 * `get-started/quickstart` slug at `zh` becomes
 * `website/content/docs/get-started/quickstart.zh.md`.
 *
 * Files use the `.md` extension (previously `.mdx`) — content is pure
 * Markdown now, and `next-mdx-remote` handles `.md` content the same way
 * since MDX is a strict superset. The change unlocks native GitHub /
 * editor preview without losing custom component rendering.
 */
function docPathFor(slug: string, locale: Locale): string {
  return path.join(process.cwd(), 'content', 'docs', `${slug}.${locale}.md`);
}

async function readDocSource(slug: string, locale: Locale): Promise<string | null> {
  try {
    return await fs.readFile(docPathFor(slug, locale), 'utf8');
  } catch {
    if (locale === 'en') return null;
    try {
      return await fs.readFile(docPathFor(slug, 'en'), 'utf8');
    } catch {
      return null;
    }
  }
}

/** Turn the first prose paragraph into a concise, page-specific SERP snippet. */
function extractDocDescription(source: string): string | undefined {
  const paragraph = source
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find(
      (block) =>
        block.length > 0 &&
        !/^(?:#{1,6}\s|```|~~~|\||>|[-+*]\s|\d+\.\s)/.test(block),
    );

  if (!paragraph) return undefined;

  const plain = paragraph
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[~*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!plain) return undefined;

  const characters = Array.from(plain);
  if (characters.length <= 160) return plain;

  let shortened = characters.slice(0, 159).join('');
  const lastSpace = shortened.lastIndexOf(' ');
  if (lastSpace >= 120) shortened = shortened.slice(0, lastSpace);
  return `${shortened.trimEnd()}…`;
}

export default async function DocsContentPage({ params }: DocsPageProps) {
  const { locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const slugStr = slug.join('/');

  const page = findPageBySlug(slugStr);
  if (!page) notFound();

  // Load the MDX source. We don't import dynamically because Next.js needs
  // the import to be statically analysable; `fs.readFile` is fine here since
  // `generateStaticParams` runs this at build time only.
  // Locale-specific files fall back to English so a missing translation does
  // not turn an otherwise available documentation page into a 404.
  const source = await readDocSource(slugStr, locale as Locale);
  if (source === null) notFound();

  const t = getMessages(locale as Locale);
  // Section ownership: a page may live directly under a section (`section.pages`)
  // or inside one of its named sub-groups (`section.groups[].pages`). The
  // breadcrumb only displays the section label, so we walk both.
  const sectionKey = docsSidebar.find(
    (s) =>
      (s.pages ?? []).some((p) => p.slug === slugStr) ||
      (s.groups ?? []).some((g) => g.pages.some((p) => p.slug === slugStr)),
  )?.key;
  const sectionLabel = sectionKey
    ? t.docs.sidebar.sections[sectionKey as keyof typeof t.docs.sidebar.sections]
    : t.docs.title;
  const pageLabel =
    t.docs.sidebar.pages[page.labelKey as keyof typeof t.docs.sidebar.pages] ?? page.labelKey;

  // Right-hand "On this page" TOC, derived from the same Markdown source so its
  // anchors match the heading ids set in `mdxComponents`. Built at static-export
  // time — no client JS.
  const headings = extractHeadings(source);

  // The outer flex wrapper and `<DocsSidebar />` live in
  // `app/[locale]/docs/layout.tsx` now — keeping them out of the page route
  // lets the sidebar DOM node persist across navigation (preserves
  // `scrollTop`). The page renders the article column plus the right-hand TOC
  // as flex siblings under that wrapper.
  return (
    <>
    <article className="min-w-0 flex-1 px-4 py-10 sm:px-6 lg:py-12 max-w-3xl">
      <div className="mb-8">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          {sectionLabel}
        </div>
        <h1 className="mt-1 text-4xl font-bold tracking-tight">{pageLabel}</h1>
      </div>

      <div className="docs-content">
        <MDXRemote
          source={source}
          components={mdxComponents}
          options={{
            parseFrontmatter: false,
            mdxOptions: { remarkPlugins: [remarkGfm] },
          }}
        />
      </div>

      <div className="mt-12 text-sm">
        <a
          href={`${GITHUB_DOCS_BASE}/${slugStr}.${locale}.md`}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-brand transition-colors"
        >
          {t.docs.editOnGithub} ↗
        </a>
      </div>

      <DocsPager locale={locale as Locale} slug={slugStr} />
    </article>

    <DocsToc headings={headings} label={t.docs.onThisPage} />
    </>
  );
}
