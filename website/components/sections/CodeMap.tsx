import type { Messages } from '@/content/messages';
import { PlainImg } from '../PlainImg';

/**
 * Code Map — dedicated section that advertises the chip view in Explorer.
 *
 * Visually distinct from PanelSection (which uses a 2-column text/image grid):
 * this section centers the headline and shows the screenshot at the full
 * column width below, letting the dense chip layout speak for itself.
 *
 * The screenshot lives at /screenshots/codemap.webp. If it ever 404s, the
 * placeholder card behind it stays visible (same pattern as PanelSection).
 */
export function CodeMap({ t }: { t: Messages }) {
  return (
    <section className="border-b border-border bg-card/30">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-brand">
            <span className="size-1 rounded-full bg-brand" />
            {t.codeMap.tag}
          </div>
          <h2 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">
            {t.codeMap.headline}
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            {t.codeMap.desc}
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
          <ul className="space-y-2.5 md:order-1">
            {t.codeMap.bullets.map((b) => (
              <li
                key={b}
                className="flex gap-3 text-sm text-muted-foreground leading-relaxed"
              >
                <span className="mt-2 size-1 shrink-0 rounded-full bg-brand/70" />
                <span>{b}</span>
              </li>
            ))}
          </ul>

          <div className="md:order-2">
            <CodeMapFrame />
          </div>
        </div>

        <p className="mt-10 text-center text-xs font-mono text-muted-foreground/70">
          {t.codeMap.footnote}
        </p>
      </div>
    </section>
  );
}

function CodeMapFrame() {
  return (
    <div className="relative aspect-video rounded-xl border border-border bg-card overflow-hidden shadow-xl">
      <div
        className="absolute inset-0 bg-gradient-to-br from-teal-3 via-card to-card opacity-80"
        aria-hidden
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-semibold text-brand/80 tracking-tight">
            Code Map
          </div>
          <div className="mt-1 text-[11px] font-mono uppercase tracking-wider text-muted-foreground/60">
            Screenshot coming soon
          </div>
        </div>
      </div>
      <PlainImg
        src="/screenshots/codemap.webp"
        alt="Code Map"
        className="absolute inset-0 w-full h-full object-cover"
      />
      <div className="absolute bottom-3 left-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/50 select-none">
        Code Map
      </div>
    </div>
  );
}
