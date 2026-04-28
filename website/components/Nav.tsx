import Link from 'next/link';
import Image from 'next/image';
import { getMessages } from '@/content/messages';
import type { Locale } from '@/lib/i18n';
import { LangSwitch } from './LangSwitch';

const GITHUB_URL = 'https://github.com/Surething-io/cockpit';

export function Nav({ locale }: { locale: Locale }) {
  const t = getMessages(locale);
  const base = `/${locale}`;

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto max-w-6xl flex items-center justify-between px-6 h-14">
        <Link href={`${base}/`} className="flex items-center gap-2 group">
          <Image
            src="/icons/icon-128x128.png"
            alt="Cockpit"
            width={28}
            height={28}
            className="rounded-md"
            priority
          />
          <span className="text-sm font-semibold tracking-tight group-hover:text-brand transition-colors">
            Cockpit
          </span>
        </Link>

        <nav className="flex items-center gap-6 text-sm">
          <Link
            href={`${base}/docs/`}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {t.nav.docs}
          </Link>
          <Link
            href={`${base}/changelog/`}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {t.nav.changelog}
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            {t.nav.github}
          </a>
          <span className="h-4 w-px bg-border" />
          <LangSwitch locale={locale} />
        </nav>
      </div>
    </header>
  );
}
