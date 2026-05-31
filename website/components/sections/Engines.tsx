import type { Messages } from '@/content/messages';

const ICONS: Record<string, string> = {
  Claude: '🟣',
  'Codex': '🔵',
  DeepSeek: '🐳',
  Kimi: '🌙',
  Ollama: '🦙',
};

export function Engines({ t }: { t: Messages }) {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <div className="text-xs font-mono uppercase tracking-wider text-brand">
            {t.engines.tag}
          </div>
          <h2 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight">
            {t.engines.headline}
          </h2>
          <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">
            {t.engines.desc}
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {t.engines.items.map((item) => (
            <div
              key={item.name}
              className="relative rounded-xl border border-border bg-card p-5 hover:border-brand/40 transition-colors flex flex-col"
            >
              {item.badge ? (
                <span className="absolute top-3 right-3 rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider text-brand">
                  {item.badge}
                </span>
              ) : null}
              <div className="text-2xl">{ICONS[item.name] ?? '⚙️'}</div>
              <div className="mt-3 font-semibold">{item.name}</div>
              <div className="mt-0.5 text-xs text-brand/80 font-mono">
                {item.tagline}
              </div>
              <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
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
