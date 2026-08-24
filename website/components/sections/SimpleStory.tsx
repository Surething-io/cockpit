import type { Messages } from '@/content/messages';
import { INSTALL_COMMAND } from '@/content/install';

export function SimpleStory({ t }: { t: Messages }) {
  return (
    <section className="border-t border-border/60">
      <div className="mx-auto max-w-5xl px-6 py-20 md:py-28">
        {/* Install as an app — the product's only install form, so it leads. */}
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
            {t.home.local.headline}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-balance leading-relaxed text-muted-foreground">
            {t.home.local.desc}
          </p>
          <ol className="mx-auto mt-8 grid max-w-2xl gap-4 text-left sm:grid-cols-3">
            {t.home.local.steps.map((step, index) => (
              <li
                key={step}
                className="rounded-xl border border-border bg-card p-4 text-sm leading-relaxed text-muted-foreground"
              >
                <span className="mb-3 flex size-7 items-center justify-center rounded-full bg-brand/10 font-mono text-xs text-brand">
                  {index + 1}
                </span>
                {step}
                {/* Step 1 repeats the command instead of pointing back at it.
                    On a 390px viewport the hero command sits 1,143px above this
                    card, so "the command above" was a memory bridge across a
                    screen and a half. */}
                {index === 0 ? (
                  <code className="scrollbar-hide mt-2.5 block overflow-x-auto whitespace-nowrap rounded-md bg-background px-2.5 py-1.5 font-mono text-xs text-foreground">
                    {INSTALL_COMMAND}
                  </code>
                ) : null}
              </li>
            ))}
          </ol>
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
