import type { Messages } from '@/content/messages';
import type { Locale } from '@/lib/i18n';
import { CopyableCommand } from '../CopyableCommand';

const TRY_ONLINE_URL = '/try';
const GITHUB_URL = 'https://github.com/Surething-io/cockpit';

export function FinalCTA({ locale, t }: { locale: Locale; t: Messages }) {
  return (
    <section className="hero-bg">
      <div className="mx-auto max-w-3xl px-6 py-24 text-center">
        <h2 className="text-3xl md:text-4xl font-bold tracking-tight">{t.finalCta.headline}</h2>
        <p className="mt-3 text-muted-foreground">{t.finalCta.desc}</p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <CopyableCommand command="npm i -g @surething/cockpit" />
          <a
            href={TRY_ONLINE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-teal-10 transition-colors"
          >
            {t.hero.tryOnline}
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground hover:border-brand/50 transition-colors"
          >
            ★ {t.hero.githubStar}
          </a>
        </div>
        <span data-locale={locale} className="sr-only" />
      </div>
    </section>
  );
}
