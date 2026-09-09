import type { Metadata } from 'next';
import { RootRedirect } from '@/components/RootRedirect';

export const metadata: Metadata = {
  title: 'OpenCockpit',
  // Discourage indexing of the redirect shim; canonical pages live at /en, /zh
  robots: { index: false, follow: true },
};

/**
 * Root path fallback.
 *
 * In production on Cloudflare Pages, `functions/index.ts` intercepts `/` at the
 * edge BEFORE this static HTML is ever served, doing a 302 based on Accept-Language
 * and the `lang_pref` cookie. This page only runs during local dev or if the
 * Function fails — a tiny client-side redirect keeps UX intact.
 */
export default function Page() {
  return (
    <div className="min-h-screen flex items-center justify-center text-muted-foreground">
      <RootRedirect />
      <noscript>
        {/* Deliberately a plain anchor, not `next/link`: this only ever renders
            for a reader with JavaScript off, where client-side routing cannot
            run and a full page load is the entire point. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/en/" className="text-brand underline">
          Continue to OpenCockpit (English)
        </a>
      </noscript>
    </div>
  );
}
