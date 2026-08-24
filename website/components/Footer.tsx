import Link from 'next/link';
import Image from 'next/image';
import { getMessages } from '@/content/messages';
import type { Locale } from '@/lib/i18n';

const GITHUB_URL = 'https://github.com/Surething-io/cockpit';
const NPM_URL = 'https://www.npmjs.com/package/@surething/cockpit';
const TRY_ONLINE_URL = '/try';
const X_URL = 'https://x.com/yang1365609';

export function Footer({ locale }: { locale: Locale }) {
  const t = getMessages(locale);
  const base = `/${locale}`;

  return (
    <footer className="mt-24 border-t border-border bg-card/50">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-x-8 gap-y-10 px-6 py-14 text-sm md:grid-cols-4">
        <div className="col-span-2 md:col-span-1">
          <div className="flex items-center gap-2">
            <Image
              src="/icons/icon-128x128.png"
              alt=""
              width={24}
              height={24}
              className="rounded-md"
            />
            <span className="font-semibold">OpenCockpit</span>
          </div>
          <p className="mt-3 max-w-xs text-xs leading-relaxed text-muted-foreground">
            {t.footer.tagline}
          </p>
        </div>

        <div>
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
            {t.footer.product}
          </div>
          <ul className="space-y-1 text-muted-foreground">
            <li>
              <Link href={`${base}/docs/`} className="inline-block py-1 transition-colors hover:text-brand">
                {t.nav.docs}
              </Link>
            </li>
            <li>
              <Link href={`${base}/blog/`} className="inline-block py-1 transition-colors hover:text-brand">
                {t.nav.blog}
              </Link>
            </li>
            <li>
              <Link href={`${base}/changelog/`} className="inline-block py-1 transition-colors hover:text-brand">
                {t.nav.changelog}
              </Link>
            </li>
            <li>
              <a
                href={TRY_ONLINE_URL}
                target="_blank"
                /* `noopener`, not `noreferrer`: this is our own /try page, and
                   dropping the referrer made demo-conversion attribution
                   impossible. Matches the hero instance of the same link. */
                rel="noopener"
                className="inline-block py-1 transition-colors hover:text-brand"
              >
                {t.home.tryLink}
              </a>
            </li>
          </ul>
        </div>

        <div>
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
            {t.footer.resources}
          </div>
          <ul className="space-y-1 text-muted-foreground">
            <li>
              <a href={NPM_URL} target="_blank" rel="noreferrer" className="inline-block py-1 transition-colors hover:text-brand">
                npm
              </a>
            </li>
            <li>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="inline-block py-1 transition-colors hover:text-brand">
                GitHub
              </a>
            </li>
            <li>
              <a
                href={`${GITHUB_URL}/blob/main/LICENSE`}
                target="_blank"
                rel="noreferrer"
                className="inline-block py-1 transition-colors hover:text-brand"
              >
                {t.footer.license}
              </a>
            </li>
          </ul>
        </div>

        <div>
          <div className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
            {t.footer.community}
          </div>
          <ul className="space-y-1 text-muted-foreground">
            <li>
              <a
                href={`${GITHUB_URL}/issues`}
                target="_blank"
                rel="noreferrer"
                className="inline-block py-1 transition-colors hover:text-brand"
              >
                Issues
              </a>
            </li>
            <li>
              <a
                href={X_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-block py-1 transition-colors hover:text-brand"
              >
                X / @yang1365609
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5 text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} OpenCockpit · {t.footer.license}</span>
          <span>
            <a
              href="https://opencockpit.dev"
              className="inline-block py-1.5 transition-colors hover:text-brand"
            >
              opencockpit.dev
            </a>
          </span>
        </div>
      </div>
    </footer>
  );
}
