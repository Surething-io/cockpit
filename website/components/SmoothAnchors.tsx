'use client';

import { useEffect } from 'react';

/**
 * Smooth-scroll in-page anchor clicks (`<a href="#id">`, e.g. the docs TOC).
 *
 * The global `html { scroll-behavior: smooth }` was removed because it broke
 * Next.js App Router's scroll reset on navigation (see globals.css /
 * ScrollToTop). That also took away the pleasant smooth scroll when clicking a
 * TOC entry. We reintroduce it here, but ONLY for explicit in-page anchor
 * clicks — so programmatic navigation scrolls stay instant and deterministic
 * while reading-position jumps within a page animate.
 *
 * A single delegated listener on the document covers every current and future
 * `#` link (TOC, in-article anchors) without each component opting in.
 *
 * Behavior details:
 *  - Ignores modified clicks (new tab / new window) and non-primary buttons.
 *  - Only handles same-page hashes that resolve to a real element id.
 *  - `scrollIntoView` honors the `scroll-padding-top: 4rem` set on <html>, so
 *    the target heading lands below the sticky Nav, matching native behavior.
 *  - Updates the URL hash via `history.pushState` so the anchor stays
 *    shareable and Back returns to the prior position — but without the native
 *    instant jump that setting `location.hash` would cause.
 */
export function SmoothAnchors() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }

      const target = e.target as Element | null;
      const anchor = target?.closest?.('a[href^="#"]') as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href || href === '#') return;

      const id = decodeURIComponent(href.slice(1));
      const el = document.getElementById(id);
      if (!el) return;

      e.preventDefault();
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.pushState(null, '', href);
    };

    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  return null;
}
