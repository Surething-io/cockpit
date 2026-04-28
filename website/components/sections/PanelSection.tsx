import { PlainImg } from '../PlainImg';

export function PanelSection({
  tag,
  name,
  title,
  bullets,
  screenshot,
  align = 'left',
}: {
  tag: string;
  name: string;
  title: string;
  bullets: readonly string[];
  screenshot: string;
  align?: 'left' | 'right';
}) {
  const textOrder = align === 'left' ? 'md:order-1' : 'md:order-2';
  const imgOrder = align === 'left' ? 'md:order-2' : 'md:order-1';

  return (
    <section className="border-b border-border">
      <div className="mx-auto max-w-6xl px-6 py-20 grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
        <div className={textOrder}>
          <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-brand">
            <span className="size-1 rounded-full bg-brand" />
            {tag} · {name}
          </div>
          <h2 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">
            {title}
          </h2>
          <ul className="mt-6 space-y-2.5">
            {bullets.map((b) => (
              <li key={b} className="flex gap-3 text-sm text-muted-foreground leading-relaxed">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-brand/70" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className={imgOrder}>
          <ScreenshotFrame src={screenshot} alt={name} />
        </div>
      </div>
    </section>
  );
}

/**
 * Screenshot frame with built-in placeholder. Renders an <img> that gracefully
 * falls back to a styled placeholder card if the file is missing — so we can
 * ship the layout before final screenshots are ready.
 */
function ScreenshotFrame({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="relative aspect-[4/3] rounded-xl border border-border bg-card overflow-hidden shadow-xl">
      {/* Decorative gradient backdrop (always visible behind image) */}
      <div
        className="absolute inset-0 bg-gradient-to-br from-teal-3 via-card to-card opacity-80"
        aria-hidden
      />

      {/* Placeholder content (visible until real img loads on top) */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-semibold text-brand/80 tracking-tight">{alt}</div>
          <div className="mt-1 text-[11px] font-mono uppercase tracking-wider text-muted-foreground/60">
            Screenshot coming soon
          </div>
        </div>
      </div>

      {/* Real screenshot — hides itself if the file is missing */}
      <PlainImg src={src} alt={alt} className="absolute inset-0 w-full h-full object-cover" />

      <div className="absolute bottom-3 left-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/50 select-none">
        {alt}
      </div>
    </div>
  );
}
