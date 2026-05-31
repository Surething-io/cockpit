import Link from 'next/link';
import { getMessages } from '@/content/messages';
import type { Locale } from '@/lib/i18n';
import { docsHref, getAdjacentPages } from '@/content/docs/sidebar';

interface DocsPagerProps {
  locale: Locale;
  slug: string;
}

/**
 * Previous / Next links shown at the bottom of every doc page.
 * Pulls neighbours from the sidebar order (`getAdjacentPages`) so this stays
 * in sync with whatever the sidebar shows — including skipping pages that
 * aren't written yet.
 */
export function DocsPager({ locale, slug }: DocsPagerProps) {
  const { prev, next } = getAdjacentPages(slug);
  if (!prev && !next) return null;

  const t = getMessages(locale);

  return (
    <nav
      className="mt-16 flex items-stretch gap-4 border-t border-border pt-6"
      aria-label="Page navigation"
    >
      {prev ? (
        <Link
          href={docsHref(locale, prev.slug)}
          className="group flex-1 rounded-md border border-border px-4 py-3 hover:border-brand/50 transition-colors"
        >
          <div className="text-xs text-muted-foreground">{t.docs.prevPage}</div>
          <div className="mt-1 text-sm font-medium group-hover:text-brand transition-colors">
            ← {t.docs.sidebar.pages[prev.labelKey as keyof typeof t.docs.sidebar.pages] ?? prev.labelKey}
          </div>
        </Link>
      ) : (
        <span className="flex-1" />
      )}
      {next ? (
        <Link
          href={docsHref(locale, next.slug)}
          className="group flex-1 rounded-md border border-border px-4 py-3 text-right hover:border-brand/50 transition-colors"
        >
          <div className="text-xs text-muted-foreground">{t.docs.nextPage}</div>
          <div className="mt-1 text-sm font-medium group-hover:text-brand transition-colors">
            {t.docs.sidebar.pages[next.labelKey as keyof typeof t.docs.sidebar.pages] ?? next.labelKey} →
          </div>
        </Link>
      ) : (
        <span className="flex-1" />
      )}
    </nav>
  );
}
