import type { Messages } from '@/content/messages';
import type { Locale } from '@/lib/i18n';
import { CopyableCommand } from '../CopyableCommand';

const TRY_ONLINE_URL = '/try';
const GITHUB_URL = 'https://github.com/Surething-io/cockpit';
const VIDEO_URL =
  'https://github.com/user-attachments/assets/18f1a5dc-64f3-4ff6-b9fc-9cd08181fbb8';

export function Hero({ locale, t }: { locale: Locale; t: Messages }) {
  return (
    <section className="hero-bg relative overflow-hidden">
      <div className="mx-auto max-w-6xl px-6 pt-20 pb-16 md:pt-28 md:pb-24 text-center">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
          <span className="size-1.5 rounded-full bg-brand animate-pulse" />
          <span>Built on Claude Code Agent SDK</span>
        </div>

        {/* Headline */}
        <h1 className="mt-6 text-4xl md:text-6xl font-bold tracking-tight">
          {t.hero.headline}
        </h1>
        <p className="mt-4 text-xl md:text-2xl font-medium text-muted-foreground">
          {t.hero.subheadline}
        </p>
        <p className="mt-4 mx-auto max-w-2xl text-base md:text-lg text-muted-foreground leading-relaxed">
          {t.hero.description}
        </p>

        {/* CTA row */}
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <CopyableCommand command="npm i -g @surething/cockpit" />
          <a
            href={TRY_ONLINE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-white hover:bg-teal-10 transition-colors"
          >
            {t.hero.tryOnline}
            <span aria-hidden>↗</span>
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

        {/* Video */}
        <div className="mt-14 mx-auto max-w-4xl">
          <div className="relative rounded-xl border border-border bg-card shadow-2xl overflow-hidden">
            <video
              src={VIDEO_URL}
              controls
              playsInline
              preload="metadata"
              className="block w-full aspect-video bg-slate-2"
              aria-label={t.hero.videoNotice}
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t.hero.videoNotice}</p>
        </div>
      </div>

      {/* anchor: locale unused but kept for future per-locale UTM tags */}
      <span data-locale={locale} className="sr-only" />
    </section>
  );
}
