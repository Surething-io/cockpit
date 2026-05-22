import type { Messages } from '@/content/messages';

/**
 * CodeGraph — `/cg` mode + 6 graph endpoints.
 *
 * Sibling to CodeMap (which markets the chip-view UI). They share the same
 * underlying tree-sitter index — Code Map renders it for humans, CodeGraph
 * exposes it to the agent. Layout mirrors CodeMap's centered headline +
 * 2-column bullets-with-visual pattern, but the "visual" here is a stylized
 * endpoint card (CodeGraph is server-side, a screenshot would be opaque
 * JSON).
 */
export function CodeGraph({ t }: { t: Messages }) {
  return (
    <section className="border-b border-border bg-card/30">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-brand">
            <span className="size-1 rounded-full bg-brand" />
            {t.codeGraph.tag}
          </div>
          <h2 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">
            {t.codeGraph.headline}
          </h2>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            {t.codeGraph.desc}
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
          <ul className="space-y-2.5 md:order-1">
            {t.codeGraph.bullets.map((b) => (
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
            <CodeGraphEndpointsCard />
          </div>
        </div>

        <p className="mt-10 text-center text-xs font-mono text-muted-foreground/70">
          {t.codeGraph.footnote}
        </p>
      </div>
    </section>
  );
}

/**
 * Stylized visual of the 6 endpoints. Kept locale-agnostic (English endpoint
 * names + question phrasing) so it works in both zh and en pages — the
 * surrounding prose carries the localized message.
 */
function CodeGraphEndpointsCard() {
  const rows: Array<{ ep: string; q: string }> = [
    { ep: 'search', q: '"where is X defined?"' },
    { ep: 'callers', q: '"who calls X?"' },
    { ep: 'callees', q: '"what does X call?"' },
    { ep: 'impact', q: '"changing X affects?"' },
    { ep: 'file', q: '"symbols in file F?"' },
    { ep: 'coedit', q: '"files edited with F?"' },
  ];
  return (
    <div className="relative aspect-video rounded-xl border border-border bg-card overflow-hidden shadow-xl">
      <div
        className="absolute inset-0 bg-gradient-to-br from-teal-3 via-card to-card opacity-80"
        aria-hidden
      />
      <div className="relative h-full p-5 flex flex-col">
        <div className="text-[11px] font-mono uppercase tracking-wider text-brand/80">
          /api/projectGraph/*
        </div>
        <div className="mt-3 flex-1 grid grid-cols-1 gap-1.5 text-[12px] font-mono leading-tight">
          {rows.map(({ ep, q }) => (
            <div
              key={ep}
              className="flex items-baseline gap-2 rounded-md bg-background/40 px-2.5 py-1.5 border border-border/30"
            >
              <span className="text-brand shrink-0 w-[60px]">{ep}</span>
              <span className="text-muted-foreground/80 truncate">{q}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/50">
          coordinates only · no source · O(1) memory query
        </div>
      </div>
    </div>
  );
}
