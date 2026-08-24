import Link from 'next/link';
import Image from 'next/image';
import { getMessages } from '@/content/messages';
import type { Locale } from '@/lib/i18n';
import { LangSwitch } from './LangSwitch';
import { MobileMenu, type MobileNavLink } from './MobileMenu';

const GITHUB_URL = 'https://github.com/Surething-io/cockpit';
const X_URL = 'https://x.com/yang1365609';

export function Nav({ locale }: { locale: Locale }) {
  const t = getMessages(locale);
  const base = `/${locale}`;

  // Shared source of truth for the primary links — the desktop row below maps
  // them inline, the mobile menu collapses them behind a hamburger.
  const links: MobileNavLink[] = [
    { href: `${base}/docs/`, label: t.nav.docs },
    { href: `${base}/blog/`, label: t.nav.blog },
    { href: `${base}/changelog/`, label: t.nav.changelog },
    { href: GITHUB_URL, label: t.nav.github, external: true },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto max-w-6xl flex items-center justify-between px-6 h-14">
        <Link href={`${base}/`} className="flex items-center gap-2 group">
          <Image
            src="/icons/icon-128x128.png"
            // Decorative: the wordmark next to it already says "OpenCockpit".
            alt=""
            width={28}
            height={28}
            className="rounded-md"
            priority
          />
          <span className="text-sm font-semibold tracking-tight group-hover:text-brand transition-colors">
            OpenCockpit
          </span>
        </Link>

        <nav className="hidden md:flex items-center gap-6 text-sm">
          <Link
            href={`${base}/docs/`}
            className="inline-flex items-center py-3 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.nav.docs}
          </Link>
          <Link
            href={`${base}/blog/`}
            className="inline-flex items-center py-3 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.nav.blog}
          </Link>
          <Link
            href={`${base}/changelog/`}
            className="inline-flex items-center py-3 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.nav.changelog}
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center py-3 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.nav.github}
          </a>
          <a
            href={X_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Follow @yang1365609 on X"
            title="Follow @yang1365609 on X"
            className="flex h-11 w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              className="h-[14px] w-[14px] fill-current"
            >
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          <span className="h-4 w-px bg-border" />
          <LangSwitch locale={locale} />
        </nav>

        <MobileMenu
          className="md:hidden"
          links={links}
          locale={locale}
          xUrl={X_URL}
        />
      </div>
    </header>
  );
}
