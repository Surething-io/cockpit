import type { Messages } from '@/content/messages';

export function Extras({ t }: { t: Messages }) {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-6xl px-6 py-20 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-xl border border-border bg-card p-7">
          <div className="text-xs font-mono uppercase tracking-wider text-brand">★ Collaboration</div>
          <h3 className="mt-2 text-xl font-semibold">{t.extras.review.title}</h3>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{t.extras.review.desc}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-7">
          <div className="text-xs font-mono uppercase tracking-wider text-brand">⏱ Automation</div>
          <h3 className="mt-2 text-xl font-semibold">{t.extras.schedule.title}</h3>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{t.extras.schedule.desc}</p>
        </div>
      </div>
    </section>
  );
}
