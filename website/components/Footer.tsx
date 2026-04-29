import Link from 'next/link';
import { getMessages } from '@/content/messages';
import type { Locale } from '@/lib/i18n';

const GITHUB_URL = 'https://github.com/Surething-io/cockpit';
const NPM_URL = 'https://www.npmjs.com/package/@surething/cockpit';
const TRY_ONLINE_URL = '/try';

export function Footer({ locale }: { locale: Locale }) {
  const t = getMessages(locale);
  const base = `/${locale}`;

  return (
    <footer className="mt-24 border-t border-border bg-card/50">
      <div className="mx-auto max-w-6xl px-6 py-10 grid grid-cols-2 md:grid-cols-4 gap-8 text-sm">
        <div className="col-span-2 md:col-span-1">
          <div className="font-semibold">Cockpit</div>
          <p className="mt-2 text-muted-foreground text-xs leading-relaxed">
            {t.footer.tagline}
          </p>
        </div>

        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            {t.footer.product}
          </div>
          <ul className="space-y-1.5">
            <li>
              <Link href={`${base}/docs/`} className="hover:text-brand transition-colors">
                {t.nav.docs}
              </Link>
            </li>
            <li>
              <Link href={`${base}/blog/`} className="hover:text-brand transition-colors">
                {t.nav.blog}
              </Link>
            </li>
            <li>
              <Link href={`${base}/changelog/`} className="hover:text-brand transition-colors">
                {t.nav.changelog}
              </Link>
            </li>
            <li>
              <a
                href={TRY_ONLINE_URL}
                target="_blank"
                rel="noreferrer"
                className="hover:text-brand transition-colors"
              >
                {t.hero.tryOnline}
              </a>
            </li>
          </ul>
        </div>

        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            {t.footer.resources}
          </div>
          <ul className="space-y-1.5">
            <li>
              <a href={NPM_URL} target="_blank" rel="noreferrer" className="hover:text-brand transition-colors">
                npm
              </a>
            </li>
            <li>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="hover:text-brand transition-colors">
                GitHub
              </a>
            </li>
            <li>
              <a
                href={`${GITHUB_URL}/blob/main/LICENSE`}
                target="_blank"
                rel="noreferrer"
                className="hover:text-brand transition-colors"
              >
                {t.footer.license}
              </a>
            </li>
          </ul>
        </div>

        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
            {t.footer.community}
          </div>
          <ul className="space-y-1.5">
            <li>
              <a
                href={`${GITHUB_URL}/issues`}
                target="_blank"
                rel="noreferrer"
                className="hover:text-brand transition-colors"
              >
                Issues
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-4 text-xs text-muted-foreground flex items-center justify-between">
          <span>© {new Date().getFullYear()} Cockpit · {t.footer.license}</span>
          <span>
            <a href="https://cocking.cc" className="hover:text-brand transition-colors">
              cocking.cc
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
