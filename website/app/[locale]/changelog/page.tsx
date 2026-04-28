import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isLocale, locales, type Locale } from '@/lib/i18n';
import { getMessages } from '@/content/messages';
import releases from '@/data/changelog.json';

const GITHUB_URL = 'https://github.com/Surething-io/cockpit';

type Release = {
  tag: string;
  name: string;
  publishedAt: string;
  url: string;
  body: string;
  prerelease: boolean;
};

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
    title: t.changelog.title,
    description: t.changelog.desc,
    alternates: {
      canonical: `https://cocking.cc/${locale}/changelog/`,
      languages: {
        en: 'https://cocking.cc/en/changelog/',
        zh: 'https://cocking.cc/zh/changelog/',
      },
    },
  };
}

function formatDate(iso: string, locale: Locale): string {
  if (!iso) return '';
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

export default async function ChangelogPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = getMessages(locale as Locale);
  const list = releases as Release[];

  return (
    <article className="mx-auto max-w-3xl px-6 py-16">
      <header className="border-b border-border pb-6">
        <h1 className="text-4xl font-bold tracking-tight">{t.changelog.title}</h1>
        <p className="mt-3 text-muted-foreground">{t.changelog.desc}</p>
      </header>

      {list.length === 0 ? (
        <div className="mt-12 rounded-lg border border-border bg-card p-8 text-center">
          <p className="text-muted-foreground">{t.changelog.empty}</p>
          <a
            href={`${GITHUB_URL}/releases`}
            target="_blank"
            rel="noreferrer"
            className="mt-4 inline-flex items-center gap-2 text-sm text-brand hover:underline"
          >
            {t.changelog.viewOnGithub} ↗
          </a>
        </div>
      ) : (
        <ol className="mt-12 space-y-12">
          {list.map((r) => (
            <li key={r.tag} className="relative pl-6 border-l border-border">
              <span className="absolute -left-[5px] top-1.5 size-2.5 rounded-full bg-brand ring-4 ring-background" />
              <div className="flex flex-wrap items-baseline gap-3">
                <h2 className="text-xl font-semibold tracking-tight">{r.name}</h2>
                {r.prerelease && (
                  <span className="rounded-full border border-amber-9/40 bg-amber-9/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-amber-11">
                    pre-release
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-muted-foreground font-mono">
                {formatDate(r.publishedAt, locale as Locale)} · {r.tag}
              </div>

              {r.body && (
                <div className="prose prose-sm mt-4 max-w-none text-sm text-foreground">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      h1: ({ children }) => <h3 className="mt-4 text-base font-semibold">{children}</h3>,
                      h2: ({ children }) => <h3 className="mt-4 text-base font-semibold">{children}</h3>,
                      h3: ({ children }) => <h4 className="mt-3 text-sm font-semibold">{children}</h4>,
                      ul: ({ children }) => <ul className="mt-2 ml-4 list-disc space-y-1 text-muted-foreground">{children}</ul>,
                      ol: ({ children }) => <ol className="mt-2 ml-4 list-decimal space-y-1 text-muted-foreground">{children}</ol>,
                      li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                      a: ({ children, href }) => (
                        <a href={href} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                          {children}
                        </a>
                      ),
                      code: ({ children }) => <code className="code-inline">{children}</code>,
                      p: ({ children }) => <p className="mt-2 text-muted-foreground leading-relaxed">{children}</p>,
                    }}
                  >
                    {r.body}
                  </ReactMarkdown>
                </div>
              )}

              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="mt-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-brand transition-colors"
              >
                {t.changelog.viewOnGithub} ↗
              </a>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
