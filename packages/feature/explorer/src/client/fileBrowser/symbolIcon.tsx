/**
 * Shared symbol → Lucide icon resolver, exposed as a tiny `<SymbolIcon>`
 * component.
 *
 * The Code Map renders the same symbol in three places (block header,
 * history drawer, search palette). Centralising the kind → icon mapping
 * here keeps those three views in lockstep without any of them having
 * to know the others exist.
 *
 * Why a component (rather than returning the picked LucideIcon
 * directly): React's `react-hooks/static-components` lint rule flags
 * code that produces a component identifier mid-render. Wrapping the
 * lookup inside a stable, module-scoped component sidesteps the rule
 * entirely — the *consumer* never sees a dynamically-picked component
 * reference, only a stable `<SymbolIcon>`.
 *
 * Visual style intent: roughly mirror VSCode's outline glyphs AND its
 * symbol palette — function/method violet, class amber, interface
 * blue, everything else muted. The colour cue carries weight on its
 * own, so the icon is parseable even at 12-14px without leaning on
 * shape alone (the older monochrome version was too easy to scan past).
 *
 * Colour is built into the component (not the caller). Call sites pass
 * size + layout classes only; we prepend the kind colour. Tailwind's
 * "last duplicate wins" means a caller can still override via a more
 * specific colour utility if they really want to, but the default is
 * "icon owns its kind colour" — single source of truth.
 *
 * Markdown synthesis: server-side, markdown chunks come back with
 * `kind: 'unknown'` and special-cased qnames (`__file__`,
 * `__heading_*__`, `__preamble__`). We sniff those qnames here so the
 * three view sites don't each re-implement the same special-casing.
 */

import {
  AlignLeft,
  Box,
  Code,
  FileText,
  Heading1,
  Plug,
  SquareFunction,
} from 'lucide-react';
import type { SymbolKind } from '@cockpit/feature-explorer/server/codeMap/types';

interface SymbolIconProps {
  /** Backend symbol kind. Accepts the loose `string` form too because
   *  `HistoryEntry.kind` was historically optional/loose. */
  kind: SymbolKind | string;
  /** Qualified name — used to detect markdown synthetics
   *  (`__file__` / `__heading_*__` / `__preamble__`). */
  qname?: string;
  /** Size + layout classes from the caller. Colour is owned by the
   *  component (see `kindColor`); callers should NOT pass `text-*`
   *  utilities here. */
  className?: string;
}

/**
 * Per-kind text colour. Aligned with VSCode's symbol palette:
 *   - function/method → violet  (matches VSCode's pink-purple
 *                                 `symbol-function`/`symbol-method`)
 *   - class           → amber   (matches VSCode's orange `symbol-class`)
 *   - interface       → blue    (matches VSCode's `symbol-interface`)
 *   - everything else → muted   (low-importance fallback)
 *
 * Markdown synthetics (`__file__` / `__heading_*` / `__preamble__`)
 * are intentionally muted: they're chunked content rather than real
 * symbols, and giving them their own colour would compete with the
 * "real function changed something" signal in adjacent chips.
 */
function kindColor(kind: SymbolKind | string, qname: string | undefined): string {
  if (qname === '__file__') return 'text-muted-foreground/60';
  if (qname === '__preamble__') return 'text-muted-foreground/60';
  if (qname && qname.startsWith('__heading_')) return 'text-muted-foreground/60';
  switch (kind) {
    case 'function':
    case 'method':
      return 'text-violet-11';
    case 'class':
      return 'text-amber-11';
    case 'interface':
      return 'text-blue-11';
    default:
      return 'text-muted-foreground/60';
  }
}

/**
 * Each branch returns JSX referencing a module-scoped component
 * directly, rather than picking a component identifier and rendering
 * it indirectly. The verbosity is intentional — it satisfies React's
 * `react-hooks/static-components` rule, which (correctly) flags the
 * "pick a component, then render it" pattern as fragile because it
 * defeats reconciliation when the picked component changes.
 *
 * SquareFunction renders an `f(x)` glyph — closest lucide has to
 * VSCode's purple `symbol-function` codicon. Methods deliberately
 * share this icon: TS/JS review rarely benefits from distinguishing
 * them visually, and codicons themselves use near-identical glyphs
 * for the two.
 */
export function SymbolIcon({ kind, qname, className }: SymbolIconProps) {
  // Prepend the kind colour so the caller's className (size/layout
  // utilities) overrides only if it specifies a colour itself — the
  // common case is "caller passes layout, we own colour".
  const cls = `${kindColor(kind, qname)} ${className ?? ''}`.trim();

  // Markdown synthetics first — they all share kind='unknown' but read
  // very differently in the UI, so qname is the more reliable signal.
  if (qname === '__file__') return <FileText className={cls} />;
  if (qname === '__preamble__') return <AlignLeft className={cls} />;
  if (qname && qname.startsWith('__heading_')) return <Heading1 className={cls} />;

  switch (kind) {
    case 'function':
    case 'method':
      return <SquareFunction className={cls} />;
    case 'class':
      return <Box className={cls} />;
    case 'interface':
      return <Plug className={cls} />;
    default:
      return <Code className={cls} />;
  }
}
