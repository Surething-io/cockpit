import type { Messages } from '@/content/messages';

const ICONS: Record<string, string> = {
  Browser: '🌐',
  浏览器: '🌐',
  PostgreSQL: '🐘',
  MySQL: '🐬',
  Redis: '🔴',
};

export function Bubbles({ t }: { t: Messages }) {
  return (
    <section className="border-b border-border bg-card/30">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <h2 className="text-3xl md:text-4xl font-semibold tracking-tight">
            {t.bubbles.headline}
          </h2>
          <p className="mt-3 text-muted-foreground">{t.bubbles.desc}</p>
        </div>

        <div className="mt-12 grid grid-cols-2 md:grid-cols-4 gap-4">
          {t.bubbles.items.map((item) => (
            <div
              key={item.name}
              className="rounded-xl border border-border bg-card p-5 hover:border-brand/40 transition-colors"
            >
              <div className="text-2xl">{ICONS[item.name] ?? '✨'}</div>
              <div className="mt-3 font-semibold">{item.name}</div>
              <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
