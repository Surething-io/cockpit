import type { Messages } from '@/content/messages';

const STACK = [
  'Next.js 16',
  'React 19',
  'TypeScript',
  'TailwindCSS',
  'xterm.js',
  'Shiki',
  'Claude Agent SDK',
];

export function BuiltOn({ t }: { t: Messages }) {
  return (
    <section className="border-b border-border bg-card/30">
      <div className="mx-auto max-w-6xl px-6 py-16 text-center">
        <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">{t.builtOn.headline}</h2>
        <p className="mt-3 mx-auto max-w-2xl text-muted-foreground">{t.builtOn.desc}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
          {STACK.map((s) => (
            <span
              key={s}
              className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground"
            >
              {s}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
