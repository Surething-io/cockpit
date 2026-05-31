import Link from 'next/link';
import type { ComponentPropsWithoutRef } from 'react';
import { CopyableCodeBlock } from './CopyableCodeBlock';

/**
 * Generate a stable, URL-safe slug from a heading's text children so we can
 * link to sections with `#anchors`. Mirrors what GitHub Markdown does:
 * lowercase, strip non-word chars, collapse spaces to hyphens. Kept simple —
 * the full TOC sidebar is Phase 2; for now anchors are good-enough.
 */
function slugify(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    // For multi-node children (e.g. headings with inline <code>), recursively
    // extract text. Keeping this lazy because most headings are plain strings.
    if (Array.isArray(value)) return slugify(value.map((c) => (typeof c === 'string' ? c : '')).join(''));
    return undefined;
  }
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

/**
 * Map of HTML element renderers passed to `MDXRemote` so our markdown content
 * gets the same Tailwind treatment as the rest of the site instead of relying
 * on `@tailwindcss/typography` (which would force another dependency and
 * conflict with our custom dark mode tokens).
 *
 * Also exposes a couple of custom React components — `<CopyableCommand>` and
 * `<Callout>` — that MDX files can use directly, e.g.:
 *   <CopyableCommand command="npm install -g @surething/cockpit" />
 */
export const mdxComponents = {
  h1: (props: ComponentPropsWithoutRef<'h1'>) => (
    <h1 id={slugify(props.children)} className="text-3xl font-bold tracking-tight mt-8 mb-4 first:mt-0" {...props} />
  ),
  h2: (props: ComponentPropsWithoutRef<'h2'>) => (
    <h2 id={slugify(props.children)} className="text-2xl font-semibold tracking-tight mt-10 mb-3 pb-2 border-b border-border" {...props} />
  ),
  h3: (props: ComponentPropsWithoutRef<'h3'>) => (
    <h3 id={slugify(props.children)} className="text-xl font-semibold mt-8 mb-2" {...props} />
  ),
  h4: (props: ComponentPropsWithoutRef<'h4'>) => (
    <h4 id={slugify(props.children)} className="text-base font-semibold mt-6 mb-2" {...props} />
  ),
  p: (props: ComponentPropsWithoutRef<'p'>) => (
    <p className="my-4 leading-7 text-foreground/90" {...props} />
  ),
  a: ({ href = '#', ...props }: ComponentPropsWithoutRef<'a'>) => {
    // External links open in a new tab; same-origin/relative use next/link
    // so client transitions remain fast within the docs.
    const isExternal = /^https?:\/\//i.test(href);
    if (isExternal) {
      return <a href={href} target="_blank" rel="noreferrer" className="text-brand underline-offset-2 hover:underline" {...props} />;
    }
    return <Link href={href} className="text-brand underline-offset-2 hover:underline" {...props} />;
  },
  ul: (props: ComponentPropsWithoutRef<'ul'>) => (
    <ul className="my-4 ml-6 list-disc space-y-2" {...props} />
  ),
  ol: (props: ComponentPropsWithoutRef<'ol'>) => (
    <ol className="my-4 ml-6 list-decimal space-y-2" {...props} />
  ),
  li: (props: ComponentPropsWithoutRef<'li'>) => (
    <li className="leading-7" {...props} />
  ),
  blockquote: (props: ComponentPropsWithoutRef<'blockquote'>) => (
    <blockquote className="my-4 border-l-4 border-brand/40 pl-4 italic text-muted-foreground" {...props} />
  ),
  hr: (props: ComponentPropsWithoutRef<'hr'>) => (
    <hr className="my-8 border-border" {...props} />
  ),
  table: (props: ComponentPropsWithoutRef<'table'>) => (
    <div className="my-6 overflow-x-auto">
      <table className="min-w-full border-collapse border border-border text-sm" {...props} />
    </div>
  ),
  thead: (props: ComponentPropsWithoutRef<'thead'>) => (
    <thead className="bg-muted/40" {...props} />
  ),
  th: (props: ComponentPropsWithoutRef<'th'>) => (
    <th className="border border-border px-3 py-2 text-left font-semibold" {...props} />
  ),
  td: (props: ComponentPropsWithoutRef<'td'>) => (
    <td className="border border-border px-3 py-2 align-top" {...props} />
  ),
  // Inline `code` (not fenced). Fenced blocks come through as <pre><code> and
  // are handled by `pre` below — splitting the styles avoids the chip look
  // showing up inside code blocks.
  code: (props: ComponentPropsWithoutRef<'code'>) => (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground" {...props} />
  ),
  // Fenced code blocks: wrapped in CopyableCodeBlock (a thin client wrapper
  // that adds a hover "Copy" button). Inline `code` keeps the styled <code>
  // renderer above; this only applies to ```fenced``` blocks since MDX maps
  // those to <pre><code>.
  pre: CopyableCodeBlock,
  // Custom MDX components
  Callout: ({ type = 'info', children }: { type?: 'info' | 'warn' | 'tip'; children: React.ReactNode }) => {
    const color =
      type === 'warn' ? 'border-amber-500/40 bg-amber-500/5' :
      type === 'tip' ? 'border-emerald-500/40 bg-emerald-500/5' :
      'border-brand/40 bg-brand/5';
    return (
      <aside className={`my-4 rounded-md border-l-4 ${color} px-4 py-3 text-sm`}>
        {children}
      </aside>
    );
  },
};
