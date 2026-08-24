import type { Messages } from '@/content/messages';
import { INSTALL_COMMAND } from '@/content/install';
import { CopyableCommand } from '../CopyableCommand';
import { HeroShot } from '../HeroShot';

const TRY_ONLINE_URL = '/try';
const LICENSE_URL = 'https://github.com/Surething-io/cockpit/blob/main/LICENSE';

export function Hero({ t }: { t: Messages }) {
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
          <CopyableCommand command={INSTALL_COMMAND} labels={t.home.copy} />
          <p className="mt-3 text-sm text-muted-foreground">{t.home.installNote}</p>
          {/* Prerequisite and licence at the point of maximum doubt. Without the
              Node line a visitor with no Node meets `command not found`; MIT was
              previously only stated in the footer. */}
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t.home.trustNode}
            <span aria-hidden className="px-1.5 text-border">
              ·
            </span>
            <a
              href={LICENSE_URL}
              target="_blank"
              rel="noopener"
              className="underline decoration-border underline-offset-4 transition-colors hover:text-brand hover:decoration-brand/60"
            >
              {t.home.trustLicense}
            </a>
          </p>
          <a
            href={TRY_ONLINE_URL}
            target="_blank"
            /* `noopener` rather than `noreferrer`: dropping the referrer entirely
               made demo-conversion attribution impossible in analytics. */
            rel="noopener"
            /* `py-3` rather than a bare 20px-tall text link: this is the only
               zero-install path on the page and the one thing a phone visitor
               can actually act on, so it needs a real 44px tap target. */
            className="inline-flex items-center gap-1 py-3 text-sm text-brand hover:underline"
          >
            {t.home.tryLink}
            <ExternalArrow />
          </a>
        </div>

        {/* The screenshot is the page's whole proof, so it has to stay
            readable. See HeroShot for how that is handled below `md`. */}
        <HeroShot
          src="/opencockpit.webp"
          alt={t.home.heroImageAlt}
          groupLabel={t.home.heroImageGroupLabel}
          hint={t.home.heroImageHint}
        />
      </div>
    </section>
  );
}

/** Drawn mark, replacing the ↗ Unicode glyph used as an icon. */
function ExternalArrow() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M8 16 16 8M9 8h7v7" />
    </svg>
  );
}
