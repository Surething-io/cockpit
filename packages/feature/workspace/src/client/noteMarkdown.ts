// ============================================
// Note markdown normalization
// ============================================
//
// Why this exists:
//   The note editor (Tiptap + tiptap-markdown) round-trips its content through
//   markdown on every save. An *empty* checkbox item is NOT a fixed point of
//   that round-trip:
//
//     serialize:  empty TaskItem  ->  "- [ ] "   (trailing space, no content)
//     re-parse:   markdown-it-task-lists requires the prefix "[ ] " *followed
//                 by content*; the trailing space is trimmed, so "- [ ] " is
//                 NOT recognized as a task and degrades to a plain bullet whose
//                 literal text is "[ ]".
//     serialize:  that literal "[ ]" gets escaped to  "- \[ \]"
//
//   So every open/edit/save cycle can leave behind — and accumulate — junk
//   lines like "- [ ]" / "- \[ \]" that render as ugly empty "[ ]" bullets.
//
//   An empty checkbox carries no information, so the safe, idempotent fix is to
//   strip these artifact lines at the save boundary. Real checkboxes (those with
//   text, e.g. "- [ ] do the thing" / "- [x] done") round-trip fine and are left
//   untouched, as is anything inside fenced code blocks.

/**
 * A whole-line list item that is *only* an empty checkbox, with optional
 * leading indentation and optional backslash-escaping of the brackets.
 * Matches: "- [ ]", "  * \[ \]", "+ [x]", "- \[X\]", etc. (nothing after the box)
 */
const EMPTY_CHECKBOX_LINE =
  /^\s*[-*+]\s+(?:\\?\[ \\?\]|\\?\[[xX]\\?\])\s*$/;

const FENCE = /^\s*(```|~~~)/;

/**
 * Normalize note markdown before persisting.
 *
 * - Removes list-item lines that are just an empty checkbox artifact
 *   (`- [ ]`, `- \[ \]`, `- [x]` with no text), which the markdown round-trip
 *   generates and would otherwise accumulate forever.
 * - Collapses the runs of 2+ blank lines that removal can leave behind into a
 *   single blank line.
 * - Never touches content inside fenced code blocks (``` / ~~~).
 *
 * Idempotent: `normalizeNoteMarkdown(normalizeNoteMarkdown(x)) === normalizeNoteMarkdown(x)`.
 */
export function normalizeNoteMarkdown(md: string): string {
  if (!md) return md;

  const lines = md.split('\n');
  const kept: string[] = [];
  let inCode = false;

  for (const line of lines) {
    if (FENCE.test(line)) {
      inCode = !inCode;
      kept.push(line);
      continue;
    }
    if (inCode) {
      kept.push(line);
      continue;
    }
    if (EMPTY_CHECKBOX_LINE.test(line)) {
      // drop the artifact line entirely
      continue;
    }
    kept.push(line);
  }

  // Collapse runs of 2+ blank lines (outside code fences) into one blank line.
  const out: string[] = [];
  let blankRun = 0;
  let inCode2 = false;
  for (const line of kept) {
    if (FENCE.test(line)) {
      inCode2 = !inCode2;
      out.push(line);
      blankRun = 0;
      continue;
    }
    if (!inCode2 && line.trim() === '') {
      blankRun += 1;
      if (blankRun >= 2) continue;
      out.push(line);
      continue;
    }
    blankRun = 0;
    out.push(line);
  }

  return out.join('\n');
}
