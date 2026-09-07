// Math-formula handling for MarkdownRenderer.
//
// `remark-math` models `$…$` exactly like a code span: the only guard in
// micromark-extension-math is "the previous character isn't a backslash". It
// even has an explicit padding rule that ACCEPTS `$ x $`, inherited from code
// spans where `` ` x ` `` padding is meaningful. For LLM output that default is
// backwards — assistant prose is full of shell variables and prices, so
// `Set $WORK, then $CMP` parses as inline math holding "WORK, then ".
//
// The historical response was `escapeCurrencyDollars()`, a regex over the raw
// source that escaped `$` before a digit. That was the wrong layer twice over:
//
//   1. Fenced blocks and inline code are ALREADY immune, because remark-math
//      runs on the token stream and code is tokenized first. Raw-text regexes
//      have to re-implement that masking, and this one didn't — so `$500`
//      inside a ```bash block got rewritten too.
//   2. Its replacement string was `'\\$$1'`, i.e. the 4 chars `\`, `$`, `$`,
//      `1`. In `String.replace` a `$$` is an escaped literal `$`, so the
//      capture group was never referenced and the trailing `1` was literal:
//      `$500` → `\$100`, `$2 and $9` → `\$1 and \$1`. Silent data corruption.
//
// What actually works is the adjacency rule set used by markdown-it-texmath and
// KaTeX's auto-render, applied as an AST post-pass (§ remarkMathGuard). It
// leans on one property of real text: `$VAR` and `$500` in prose are
// word-initial, so the *closing* `$` of a false positive is nearly always
// preceded by a space. Measured on a full assistant message from a
// Fermat's-Last-Theorem session: 64 real formulas kept, 0 demoted; and on an
// adversarial set of shell/currency phrasings, 7 of 8 correctly rejected (the
// miss is `$A=$B`, which is genuinely ambiguous).
//
// Do NOT replace this with a "try compiling it as LaTeX and reject on throw"
// filter. KaTeX is far too permissive — it renders bare letters as italic
// variables, so "WORK and ", "500 and the other is " and `WORK/src"; WORK=`
// all parse cleanly. That check has no discriminating power at all.

// Minimal structural typing — avoids a hard dependency on @types/mdast.
interface MathMdNode {
  type: string;
  value?: string;
  children?: MathMdNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

/**
 * Decide whether an `inlineMath` node the parser produced is really math.
 * Exported for unit testing; the pipeline uses `remarkMathGuard`.
 *
 * @param raw    the full markdown source the node's offsets index into
 * @param value  the node's math content (delimiters already stripped)
 * @param start  offset of the opening `$`
 * @param end    offset just past the closing `$`
 */
export function isLikelyMath(raw: string, value: string, start: number, end: number): boolean {
  // `$$…$$` needs a literal doubled delimiter on both ends — nobody types that
  // by accident, so an explicit display-math gesture is always honored.
  if (raw.slice(start, start + 2) === '$$') return true;

  // No padding immediately inside the delimiters. This is the load-bearing
  // rule: `$WORK and $CMP` yields "WORK and " (trailing space) and `$500 and
  // $1,200` yields "500 and the other is " — both rejected here, while
  // `$a^n + b^n = c^n$` and `$n \ge 3$` are untouched.
  if (!value || /^\s|\s$/.test(value)) return false;

  // A digit adjacent to the outside of a delimiter means arithmetic or a price
  // range, not a formula boundary: `5$x$`, `$5-$7`, `$5 到 $10`.
  if (/\d/.test(raw[start - 1] ?? '')) return false;
  if (/\d/.test(raw[end] ?? '')) return false;

  return true;
}

/** Depth-first walk over `children`, handing each child its index and parent. */
function walkChildren(
  node: MathMdNode,
  visitor: (child: MathMdNode, index: number, parent: MathMdNode) => void,
): void {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    visitor(children[i], i, node);
    walkChildren(children[i], visitor);
  }
}

/**
 * Demote `inlineMath` nodes that fail `isLikelyMath` back to literal text.
 *
 * Runs on the mdast, so fenced blocks and inline code never reach it — they
 * were tokenized as code long before math parsing. Block `math` nodes
 * (`$$…$$` on their own lines) are left alone entirely.
 */
export function remarkMathGuard() {
  return (tree: unknown, file: unknown) => {
    const raw = String((file as { value?: unknown } | null)?.value ?? '');
    if (!raw) return;

    walkChildren(tree as MathMdNode, (child, index, parent) => {
      if (child.type !== 'inlineMath') return;

      const start = child.position?.start?.offset;
      const end = child.position?.end?.offset;
      // No positional info (shouldn't happen via remark-parse) — fail open.
      if (start === undefined || end === undefined) return;

      if (isLikelyMath(raw, child.value ?? '', start, end)) return;

      // Restore the source slice verbatim, delimiters included.
      parent.children![index] = {
        type: 'text',
        value: raw.slice(start, end),
        position: child.position,
      };
    });
  };
}

/** Content between `\(…\)` / `\[…\]` that is safe to re-delimit with dollars. */
function isConvertibleMath(inner: string): boolean {
  if (!inner.trim()) return false;
  // A blank line means we spanned past the formula into other prose.
  if (/\n[ \t]*\n/.test(inner)) return false;
  // An inner `$` would collide with the delimiters we're about to introduce.
  if (inner.includes('$')) return false;
  return true;
}

/**
 * Rewrite LaTeX-standard delimiters to the dollar forms remark-math understands:
 * `\(…\)` → `$…$` and `\[…\]` → `$$…$$`.
 *
 * Models emit these constantly (it's what they're trained on), and remark-math
 * supports neither — today they're dropped silently, with `\(` collapsing to a
 * bare `(` via markdown's own escape rules. Unlike `$`, these delimiters carry
 * no collision risk with shell variables or currency.
 *
 * Inner content is preserved verbatim, so a block-style
 * `\[\n  x = 1\n\]` becomes `$$\n  x = 1\n$$` and still parses as display math.
 * Fenced blocks and inline code are masked out first, so LaTeX shown as example
 * source is left exactly as written.
 */
export function normalizeMathDelimiters(content: string): string {
  if (!content.includes('\\(') && !content.includes('\\[')) return content;

  const masks: string[] = [];
  const MASK = (s: string) => {
    masks.push(s);
    return `\u0000MATHMASK${masks.length - 1}\u0000`;
  };

  const masked = content
    .replace(/```[\s\S]*?```/g, MASK)
    .replace(/~~~[\s\S]*?~~~/g, MASK)
    .replace(/`[^`\n]+`/g, MASK);

  // `[^\u0000]` keeps a match from swallowing a mask sentinel, i.e. from
  // pairing a delimiter across a code block.
  const converted = masked
    .replace(/\\\[([^\u0000]*?)\\\]/g, (m, inner: string) =>
      isConvertibleMath(inner) ? `$$${inner}$$` : m)
    .replace(/\\\(([^\u0000]*?)\\\)/g, (m, inner: string) =>
      isConvertibleMath(inner) ? `$${inner}$` : m);

  return converted.replace(/\u0000MATHMASK(\d+)\u0000/g, (_, idx: string) => masks[+idx]);
}
