import type { Messages } from '@/content/messages';
import type { Locale } from '@/lib/i18n';
import { CopyableCommand } from '../CopyableCommand';
import Image from 'next/image';

const TRY_ONLINE_URL = '/try';

export function Hero({ locale, t }: { locale: Locale; t: Messages }) {
  return (
    <section className="hero-bg relative overflow-hidden">
      {/* Faint tech grid, masked to fade out toward the edges */}
      <div aria-hidden className="hero-grid pointer-events-none absolute inset-0" />

      <div className="relative mx-auto max-w-6xl px-6 pb-16 pt-14 text-center md:pb-20 md:pt-20">
        <h1 className="mx-auto max-w-4xl text-balance text-4xl font-bold leading-[1.08] tracking-tight md:text-6xl">
          {t.home.headline}
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-balance text-base leading-relaxed text-muted-foreground md:text-lg">
          {t.home.lead}
        </p>

        <div className="mt-8 flex flex-col items-center">
          <CopyableCommand command="npm i -g @surething/cockpit && cockpit" />
          <p className="mt-3 text-sm text-muted-foreground">{t.home.installNote}</p>
          <a href={TRY_ONLINE_URL} target="_blank" rel="noreferrer" className="mt-3 text-sm text-brand hover:underline">
            {t.home.tryLink} <span aria-hidden>↗</span>
          </a>
        </div>

        <div className="mx-auto mt-12 max-w-5xl">
          <Image
            src="/opencockpit.webp"
            alt={t.home.heroImageAlt}
            width={2048}
            height={1190}
            priority
            className="h-auto w-full rounded-2xl border border-border shadow-2xl ring-1 ring-white/[0.06]"
          />
        </div>
      </div>

      {/* anchor: locale unused but kept for future per-locale UTM tags */}
      <span data-locale={locale} className="sr-only" />
    </section>
  );
}
