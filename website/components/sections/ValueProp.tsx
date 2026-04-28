import type { Messages } from '@/content/messages';

export function ValueProp({ t }: { t: Messages }) {
  return (
    <section className="border-y border-border bg-card/40">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-center text-2xl md:text-3xl font-semibold tracking-tight">
          {t.valueProp.headline}
        </h2>
        <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-6">
          {t.valueProp.points.map((p) => (
            <div
              key={p.title}
              className="rounded-lg border border-border bg-card p-6 hover:border-brand/40 transition-colors"
            >
              <div className="text-base font-semibold">{p.title}</div>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{p.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
