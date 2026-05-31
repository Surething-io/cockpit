import { isLocale, type Locale } from '@/lib/i18n';
import { DocsSidebar } from '@/components/docs/DocsSidebar';

/**
 * Layout shared by `/docs/` (the redirect index) and `/docs/[...slug]/`.
 *
 * Hosts the left-side `<DocsSidebar />` here — *not* in the page route — so
 * the sidebar's DOM node persists across navigation between docs pages.
 * That's what lets the browser keep the sidebar's `scrollTop` when readers
 * click a link near the bottom of the list (server-rendered sidebars
 * embedded in `page.tsx` get their HTML replaced on every navigation, which
 * resets `scrollTop` to 0).
 *
 * The redirect page (`./page.tsx`) never actually paints — Next.js's
 * `redirect()` short-circuits before the layout renders — so the sidebar's
 * cost is paid only on real `/docs/[...slug]/` views.
 */
export default async function DocsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // Defensive: matches the guards in the pages below. An invalid locale would
  // already have been bounced by the parent `[locale]/layout.tsx`, but typing
  // it cleanly here keeps the prop contract honest.
  const safeLocale: Locale = isLocale(locale) ? locale : 'en';

  return (
    <div className="mx-auto max-w-7xl lg:flex lg:gap-8">
      <DocsSidebar locale={safeLocale} />
      {children}
    </div>
  );
}
