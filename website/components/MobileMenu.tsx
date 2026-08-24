'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { LangSwitch } from './LangSwitch';

export interface MobileNavLink {
  href: string;
  label: string;
  /** External links (GitHub) open in a new tab and skip client-side routing. */
  external?: boolean;
}

/**
 * Mobile-only collapsed version of the top `<Nav>` link row.
 *
 * The desktop nav crams five links + a language switch into a single inline
 * row; below `md` that row runs out of horizontal space and wraps
 * character-by-character. This component replaces it with a hamburger button
 * that drops a panel of the same links. Rendered as a sibling of the desktop
 * `<nav>` in `Nav.tsx` (`md:hidden` here, `hidden md:flex` there) so exactly
 * one of the two is ever visible.
 *
 * Kept as its own client component so `Nav` itself stays a server component —
 * only this small toggle ships interactivity to the browser.
 */
export function MobileMenu({
  links,
  locale,
  xUrl,
  className,
}: {
  links: MobileNavLink[];
  locale: Locale;
  xUrl: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close on navigation (tapping a link changes the path) and on ESC.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const linkClass =
    'block rounded px-3 py-2 text-sm text-muted-foreground hover:bg-accent/40 hover:text-foreground transition-colors';

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        type="button"
        aria-label="Menu"
        aria-expanded={open}
        aria-controls="mobile-menu-panel"
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        >
          {open ? (
            <path d="M6 6l12 12M18 6L6 18" />
          ) : (
            <path d="M4 6h16M4 12h16M4 18h16" />
          )}
        </svg>
      </button>

      {open && (
        <>
          {/* Outside-tap catcher, below the 56px header. */}
          <div
            aria-hidden="true"
            onClick={() => setOpen(false)}
            className="fixed inset-0 top-14 z-40"
          />
          <div
            id="mobile-menu-panel"
            className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-52 rounded-lg border border-border bg-background p-2 shadow-lg"
          >
            {links.map((link) =>
              link.external ? (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  className={linkClass}
                >
                  {link.label}
                </a>
              ) : (
                <Link key={link.href} href={link.href} className={linkClass}>
                  {link.label}
                </Link>
              )
            )}
            <div className="mt-1 flex items-center justify-between border-t border-border px-3 pt-2">
              <a
                href={xUrl}
                target="_blank"
                rel="noreferrer"
                aria-label="Follow on X"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  className="h-[14px] w-[14px] fill-current"
                >
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
              <LangSwitch locale={locale} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
