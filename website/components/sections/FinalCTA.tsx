import type { Messages } from '@/content/messages';
import type { Locale } from '@/lib/i18n';
import { CopyableCommand } from '../CopyableCommand';

const TRY_ONLINE_URL = '/try';
const GITHUB_URL = 'https://github.com/Surething-io/cockpit';

export function FinalCTA({ locale, t }: { locale: Locale; t: Messages }) {
  return (
    <section className="hero-bg relative overflow-hidden">
      <div aria-hidden className="hero-grid pointer-events-none absolute inset-0" />
      <div className="relative mx-auto max-w-3xl px-6 py-24 text-center md:py-28">
        <h2 className="text-balance text-3xl font-bold tracking-tight md:text-4xl">
          {t.finalCta.headline}
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-balance text-muted-foreground">
          {t.finalCta.desc}
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <CopyableCommand command="npm i -g @surething/cockpit" labels={t.home.copy} />
          <a
            href={TRY_ONLINE_URL}
            target="_blank"
            rel="noreferrer"
            className="lift inline-flex items-center gap-2 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-teal-10"
          >
            {t.hero.tryOnline}
            <span aria-hidden>↗</span>
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="lift inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-2.5 text-sm font-medium text-foreground hover:border-brand/50"
          >
            ★ {t.hero.githubStar}
          </a>
        </div>
        <span data-locale={locale} className="sr-only" />
      </div>
    </section>
  );
}
