import type { Messages } from '@/content/messages';

export function Modes({ t }: { t: Messages }) {
  return (
    <section className="border-b border-border bg-card/30">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <div className="text-xs font-mono uppercase tracking-wider text-brand">
            ⌘ Slash Modes
          </div>
          <h2 className="mt-2 text-3xl md:text-4xl font-semibold tracking-tight">
            {t.modes.headline}
          </h2>
          <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">
            {t.modes.desc}
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-4">
          {t.modes.items.map((item) => (
            <div
              key={item.cmd}
              className="rounded-xl border border-border bg-card p-5 hover:border-brand/40 transition-colors"
            >
              <div className="flex items-baseline gap-3">
                <code className="font-mono text-base text-brand bg-brand/10 px-2 py-0.5 rounded">
                  {item.cmd}
                </code>
                <span className="font-semibold text-sm text-foreground">
                  {item.name}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                {item.desc}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-8 text-center text-xs text-muted-foreground font-mono">
          {t.modes.customHint}
        </p>
      </div>
    </section>
  );
}
