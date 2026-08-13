import type { Messages } from '@/content/messages';

const AGENTS = [
  { name: 'Claude', icon: 'claude' },
  { name: 'Codex', icon: 'codex' },
  { name: 'DeepSeek', icon: 'deepseek' },
  { name: 'GLM', icon: 'glm' },
  { name: 'Kimi', icon: 'kimi' },
  { name: 'Ollama', icon: 'ollama' },
] as const;

export function SimpleStory({ t }: { t: Messages }) {
  return (
    <section className="border-t border-border/60">
      <div className="mx-auto max-w-5xl px-6 py-20 md:py-28">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
            {t.home.local.headline}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-balance leading-relaxed text-muted-foreground">
            {t.home.local.desc}
          </p>
          <ol className="mx-auto mt-8 grid max-w-2xl gap-4 text-left sm:grid-cols-3">
            {t.home.local.steps.map((step, index) => (
              <li key={step} className="rounded-xl border border-border bg-card p-4 text-sm leading-relaxed text-muted-foreground">
                <span className="mb-3 flex size-7 items-center justify-center rounded-full bg-brand/10 font-mono text-xs text-brand">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>

        <div className="mx-auto mt-24 max-w-3xl border-t border-border/60 pt-20 text-center md:mt-28 md:pt-24">
          <h2 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
            {t.home.work.headline}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-balance leading-relaxed text-muted-foreground">
            {t.home.work.desc}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-x-7 gap-y-3 text-sm text-muted-foreground">
            {t.home.work.points.map((point) => (
              <span key={point} className="flex items-center gap-2">
                <span className="size-1 rounded-full bg-brand" />
                {point}
              </span>
            ))}
          </div>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {AGENTS.map((agent) => (
              <div key={agent.name} className="flex items-center gap-2 rounded-full border border-border bg-card px-3.5 py-2 text-sm">
                {/* eslint-disable-next-line @next/next/no-img-element -- small static SVG marks */}
                <img
                  src={`/agent-icons/${agent.icon}.svg`}
                  alt=""
                  aria-hidden="true"
                  width={20}
                  height={20}
                  className="size-5"
                />
                <span>{agent.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
