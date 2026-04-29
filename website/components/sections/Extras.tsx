import type { Messages } from '@/content/messages';

export function Extras({ t }: { t: Messages }) {
  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <div className="rounded-xl border border-border bg-card p-7 text-center">
          <div className="text-xs font-mono uppercase tracking-wider text-brand">
            ⏱ Automation
          </div>
          <h3 className="mt-2 text-xl font-semibold">{t.extras.schedule.title}</h3>
          <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
            {t.extras.schedule.desc}
          </p>
        </div>
      </div>
    </section>
  );
}
