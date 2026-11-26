import type { Messages } from '@/content/messages';
import { INSTALL_COMMAND } from '@/content/install';

export function SimpleStory({ t }: { t: Messages }) {
  return (
    <section className="border-t border-border/60">
      <div className="mx-auto max-w-5xl px-6 py-20 md:py-28">
        {/* Run as an app — the desktop app on macOS / Windows, an installed PWA
            elsewhere. Two side-by-side options rather than numbered steps: the
            reader picks one by platform, and each card stays a single action. */}
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
            {t.home.local.headline}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-balance leading-relaxed text-muted-foreground">
            {t.home.local.desc}
          </p>
          {/* Prerequisite, with the command repeated: on a 390px viewport the
              hero command sits 1,143px above this section. */}
          <p className="mt-8 text-sm text-muted-foreground">{t.home.local.prereq}</p>
          <code className="scrollbar-hide mx-auto mt-2 block max-w-full overflow-x-auto whitespace-nowrap rounded-md bg-card px-3 py-2 font-mono text-xs text-foreground sm:inline-block">
            {INSTALL_COMMAND}
          </code>
          <div className="mx-auto mt-6 grid max-w-2xl gap-4 text-left sm:grid-cols-2">
            {t.home.local.options.map((option) => (
              <div key={option.title} className="rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h3 className="font-semibold text-foreground">{option.title}</h3>
                  <span className="text-xs text-muted-foreground">{option.platforms}</span>
                </div>
                {option.command ? (
                  <code className="scrollbar-hide mt-4 block overflow-x-auto whitespace-nowrap rounded-md bg-background px-3 py-2 font-mono text-sm text-brand">
                    {option.command}
                  </code>
                ) : null}
                <ul className="mt-3 space-y-1.5 text-sm leading-relaxed text-muted-foreground">
                  {option.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Engines. These marks used to sit unlabelled at the very bottom of the
            page, reading as "some logos you recognise" rather than as the claim
            they actually make. They get a heading and a sentence now. */}
        <div className="mx-auto mt-16 max-w-3xl border-t border-border/60 pt-16 text-center md:mt-20 md:pt-20">
          <h2 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
            {t.home.engines.headline}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-balance leading-relaxed text-muted-foreground">
            {t.home.engines.desc}
          </p>
          <ul className="mt-8 flex flex-wrap justify-center gap-3">
            {t.home.engines.items.map((engine) => (
              <li
                key={engine.name}
                className="flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-2 text-sm"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- small static SVG marks */}
                <img
                  src={`/agent-icons/${engine.icon}.svg`}
                  alt=""
                  aria-hidden="true"
                  width={20}
                  height={20}
                  className="size-5"
                />
                <span>{engine.name}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
