'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Reset window scroll to the top on every route (pathname) change.
 *
 * Next.js App Router's own scroll reset became reliable once the global
 * `html { scroll-behavior: smooth }` was removed (see globals.css), but this
 * component stays as the authoritative, explicit reset so navigation never
 * lands mid-page — the original bug was clicking a docs link from far down a
 * long page (the homepage Modes section) and arriving scrolled to the bottom
 * of the new article, because the previous `scrollY` carried over.
 *
 * Keyed on `usePathname()`, which excludes the hash, so:
 *  - in-page TOC clicks change only the hash (not the pathname) → this effect
 *    does NOT fire → the smooth anchor scroll from `SmoothAnchors` is left
 *    alone;
 *  - a navigation that carries a hash (e.g. `/docs/x#section`) is skipped so
 *    the browser/Next can align to the target anchor instead of the top.
 *
 * With smooth scrolling no longer global, `window.scrollTo(0, 0)` is an
 * immediate jump.
 */
export function ScrollToTop() {
  const pathname = usePathname();

  useEffect(() => {
    if (window.location.hash) return;
    window.scrollTo(0, 0);
  }, [pathname]);

  return null;
}
