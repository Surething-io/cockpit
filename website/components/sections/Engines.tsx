import type { Messages } from '@/content/messages';

/**
 * Engine name (as written in content/messages.ts) → logo file under
 * public/agent-icons/, which scripts/copy-agent-icons.mjs syncs from the app on
 * every predev/prebuild. These are the same marks the product shows on its tabs,
 * session lists and engine picker, so the page and the app agree.
 *
 * They were emoji stand-ins (🟣 🔵 🐳 🧠 🌙 🦙) — recognisable only after you had
 * been told the mapping, and two of them were just colored circles.
 */
const ICONS: Record<string, string> = {
  Claude: 'claude',
  Codex: 'codex',
  DeepSeek: 'deepseek',
  GLM: 'glm',
  Kimi: 'kimi',
  Ollama: 'ollama',
};

export function Engines({ t }: { t: Messages }) {
  return (
    <section>
      <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
        <div className="text-center">
          <div className="font-mono text-xs uppercase tracking-wider text-brand">
            {t.engines.tag}
          </div>
          <h2 className="mt-2 text-balance text-3xl font-semibold tracking-tight md:text-4xl">
            {t.engines.headline}
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-balance text-muted-foreground">
            {t.engines.desc}
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {t.engines.items.map((item) => (
            <div
              key={item.name}
              className="lift relative flex flex-col rounded-2xl border border-border bg-card p-5 hover:border-brand/40"
            >
              {item.badge ? (
                <span className="absolute right-3 top-3 rounded-full bg-brand/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-brand">
                  {item.badge}
                </span>
              ) : null}
              <div className="inline-flex size-11 items-center justify-center rounded-xl bg-brand/10">
                {ICONS[item.name] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- static local SVG; next/image adds a loader and layout wrapper for no gain
                  <img
                    src={`/agent-icons/${ICONS[item.name]}.svg`}
                    alt=""
                    aria-hidden="true"
                    width={24}
                    height={24}
                    className="size-6"
                  />
                ) : (
                  <span className="text-2xl">⚙️</span>
                )}
              </div>
              <div className="mt-3 font-semibold">{item.name}</div>
              <div className="mt-0.5 text-xs text-brand/80 font-mono">
                {item.tagline}
              </div>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                {item.desc}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-8 text-center text-xs text-muted-foreground font-mono">
          {t.engines.footnote}
        </p>
      </div>
    </section>
  );
}
