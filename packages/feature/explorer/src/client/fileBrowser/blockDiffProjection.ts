/**
 * blockDiffProjection — pure helpers for turning a (oldContent,
 * newContent, filePath) triple into the data the chip-view diff
 * (`BlockDiffViewer`) needs.
 *
 * Lives in its own module so the viewer file stays UI-only:
 *   - The viewer just calls `buildImpactProjection` and feeds the
 *     result into `BlockViewer` via three optional props
 *     (qnameFilter / accentQnames / addedLines).
 *   - This module owns the parser / line-diff / qname-classification
 *     plumbing.
 *
 * Block-pairing strategy — TWO paths feed `changedQnames`:
 *
 *   1. STABLE-QNAME path (qname + contentHash matching). Real symbols
 *      (`function` / `class` / `method` / …) and stable synthetics
 *      (`__imports__`, `__preamble__`) have qnames that survive
 *      between snapshots, so we pair before/after by qname and
 *      classify each pair as added / deleted / modified by content
 *      hash. Deleted blocks are tracked but NOT added to
 *      `changedQnames` — chip view renders after-state, so a deleted
 *      block has no row to render.
 *
 *   2. LINE-OVERLAP path (for line-range synthetics). `__code_<lo>_<hi>__`
 *      and `__heading_<n>__` encode line numbers in their qname, so
 *      they can't be paired across snapshots (every edit shifts
 *      surrounding line ranges → naive qname diff would emit a noisy
 *      "delete + add" stream for every chunk). Instead we extract
 *      AFTER-snapshot synthetics and check whether each block's
 *      `[startLine, endLine]` range overlaps any line in `addedLines`.
 *      AFTER (not before) because BlockViewer renders AFTER content;
 *      a BEFORE qname has no DOM row to filter onto.
 *
 *   3. The empty-file fallback `__file__` is handled by NEITHER path
 *      — it only ever appears in the no-grammar branch, which short-
 *      circuits early and returns `{ addedLines }` with `changedQnames:
 *      undefined`, signalling the caller to skip the qname filter
 *      altogether (otherwise the lone `__file__` chip would be
 *      filtered out).
 */

import { computeLineDiff } from '../diffAlgorithm';
import { extractSymbolsFromTree } from '@cockpit/feature-explorer/server/codeMap/extractSymbols';
import { grammarForPath } from '@cockpit/feature-explorer/server/codeMap/languageMap';
import { getParserFor } from '@cockpit/feature-explorer/server/codeMap/treeSitter';
import type { ExtractedSymbol } from '@cockpit/feature-explorer/server/codeMap/types';

// ============================================================================
// Block extraction + classification
// ============================================================================

type ChangeKind = 'added' | 'deleted' | 'modified';

interface BlockDiffRow {
  /** Stable id derived from the block's qualifiedName + change kind. */
  id: string;
  changeKind: ChangeKind;
  qname: string;
}

/**
 * Synthetics whose `qualifiedName` embeds line numbers
 * (`__code_<lo>_<hi>__`, `__heading_<n>__`). Line numbers shift between
 * snapshots, so qname-pairing produces a noisy "delete + add" stream
 * even for unchanged content. Routed through the LINE-OVERLAP path
 * instead — see `qnamesOverlappingAddedLines` below.
 */
function isLineRangeSynthetic(s: ExtractedSymbol): boolean {
  return (
    s.qualifiedName.startsWith('__code_') ||
    s.qualifiedName.startsWith('__heading_')
  );
}

/**
 * Blocks paired via the STABLE-QNAME path: real symbols + synthetics
 * whose qname is constant across snapshots (`__imports__`,
 * `__preamble__`). Excludes line-range synthetics (handled by the
 * line-overlap path) and `__file__` (handled by the no-grammar
 * fallback — never reaches this filter).
 */
function isStableForDiff(s: ExtractedSymbol): boolean {
  return !isLineRangeSynthetic(s) && s.qualifiedName !== '__file__';
}

/**
 * Returns ALL extracted symbols including line-range synthetics. The
 * caller splits the result: stable ones go into `diffBlocks`, line-
 * range ones into `qnamesOverlappingAddedLines`. Centralising the
 * parse keeps it to one tree-sitter pass per side.
 */
async function extractBlocks(
  source: string,
  filePath: string,
): Promise<ExtractedSymbol[] | null> {
  if (!source) return [];
  const grammar = grammarForPath(filePath);
  if (!grammar) return null; // unsupported language → caller falls back
  const parser = await getParserFor(grammar);
  const tree = parser.parse(source);
  if (!tree) return null;
  try {
    return extractSymbolsFromTree(tree.rootNode);
  } finally {
    tree.delete();
  }
}

/**
 * For every line-range synthetic (`__code_*__` / `__heading_*__`) in
 * the AFTER snapshot whose `[startLine, endLine]` range contains at
 * least one line from `addedLines`, return its `qualifiedName`. These
 * qnames are exactly what BlockViewer uses to render the chips, so
 * pushing them into `changedQnames` makes them surface in chip-diff.
 *
 * AFTER (not before): chip-diff renders the AFTER content — a BEFORE
 * qname (with old line numbers) has no DOM row to filter onto.
 *
 * O(synthetics × addedLines) in the worst case but both sets are
 * tiny in practice (a file has < 20 `__code_*__` chunks; addedLines
 * is bounded by the diff size). No early-exit / sort needed.
 */
function qnamesOverlappingAddedLines(
  afterSymbols: readonly ExtractedSymbol[],
  addedLines: ReadonlySet<number>,
): string[] {
  if (addedLines.size === 0) return [];
  const out: string[] = [];
  for (const s of afterSymbols) {
    if (!isLineRangeSynthetic(s)) continue;
    for (const ln of addedLines) {
      if (ln >= s.startLine && ln <= s.endLine) {
        out.push(s.qualifiedName);
        break;
      }
    }
  }
  return out;
}

/** Pair before / after blocks by qualifiedName and classify each pair. */
function diffBlocks(
  oldBlocks: readonly ExtractedSymbol[],
  newBlocks: readonly ExtractedSymbol[],
): BlockDiffRow[] {
  const oldByQname = new Map<string, ExtractedSymbol>();
  for (const s of oldBlocks) oldByQname.set(s.qualifiedName, s);
  const newByQname = new Map<string, ExtractedSymbol>();
  for (const s of newBlocks) newByQname.set(s.qualifiedName, s);

  const rows: BlockDiffRow[] = [];
  for (const after of newBlocks) {
    const before = oldByQname.get(after.qualifiedName);
    if (!before) {
      rows.push({
        id: `add:${after.qualifiedName}`,
        changeKind: 'added',
        qname: after.qualifiedName,
      });
    } else if (before.contentHash !== after.contentHash) {
      rows.push({
        id: `mod:${after.qualifiedName}`,
        changeKind: 'modified',
        qname: after.qualifiedName,
      });
    }
    // unchanged → skip
  }
  for (const before of oldBlocks) {
    if (newByQname.has(before.qualifiedName)) continue;
    rows.push({
      id: `del:${before.qualifiedName}`,
      changeKind: 'deleted',
      qname: before.qualifiedName,
    });
  }
  return rows;
}

// ============================================================================
// Public projection — what `BlockDiffViewer` (the chip-view wrapper)
// feeds into `BlockViewer` to filter rows + tint changed lines + accent
// changed-neighbour pins.
// ============================================================================

export interface ImpactProjection {
  /** qnames of every block that changed (added OR modified). Deleted
   *  blocks are intentionally omitted — they no longer exist in the
   *  after content, so they have no row to render in chip view.
   *
   *  `undefined` when the file's language has no tree-sitter grammar
   *  (CSS / SCSS / HTML / JSON / YAML / Go / Java / C++ / etc — i.e.
   *  anything outside our currently-bundled TS/TSX/JS/Python). In that
   *  case the chip view falls back to a single synthetic `__file__`
   *  block, and the caller must NOT pass `qnameFilter` (would filter
   *  the only block out and render an empty panel). `addedLines`
   *  still works because line-level diff is language-agnostic, so the
   *  user gets the green "this line changed" overlay regardless. */
  changedQnames?: Set<string>;
  /** After-file line numbers (1-based, absolute) that should render
   *  with the added/changed background tint in the chip body. Modified
   *  lines surface here too — line-level diff treats `modified =
   *  removed(old) + added(new)`, and we keep only the new side.
   *
   *  Always populated regardless of grammar support — `computeLineDiff`
   *  is pure text comparison, so this works for every language and
   *  every binary-ish text file we render. */
  addedLines: Set<number>;
}

/**
 * Async orchestrator: parse both sides, pair blocks by qname, derive
 * the changed-qname set, and compute file-wide added-line numbers.
 *
 * Always returns an `ImpactProjection`. When the language has no
 * tree-sitter grammar bundled, `changedQnames` is left undefined but
 * `addedLines` is still computed — that gives unsupported-language
 * files (CSS / Go / Java / etc) a degraded but useful chip-diff view:
 * the file renders as a single synthetic block with green tints on
 * the changed lines. Caller decides what to do with `changedQnames`
 * being undefined (typically: don't pass `qnameFilter`).
 */
export async function buildImpactProjection(
  oldContent: string,
  newContent: string,
  filePath: string,
  isNew: boolean,
  isDeleted: boolean,
): Promise<ImpactProjection> {
  // Line-level diff first — it's language-agnostic so we always get it,
  // even when the grammar lookup below comes up empty.
  const addedLines = new Set<number>();
  if (oldContent !== newContent) {
    const diffLines = computeLineDiff(
      isNew ? '' : oldContent,
      isDeleted ? '' : newContent,
    );
    for (const dl of diffLines) {
      if (dl.type === 'added' && dl.newLineNum !== undefined) {
        addedLines.add(dl.newLineNum);
      }
    }
  }

  // Grammar gate — checked DIRECTLY (rather than inferring from
  // extractBlocks returning null on both sides). The indirect check
  // misses the `isNew=true` / `isDeleted=true` case: empty source
  // short-circuits extractBlocks to `[]` even when the grammar is
  // missing, so a brand-new .sql / .css / .go file would falsely
  // present as "supported with empty changedQnames", and the empty
  // qname filter would then nuke the synthetic __file__ block on the
  // client → blank panel. Sniffing the grammar directly avoids that
  // ambiguity. See e.g. 009_create_llm_usage_logs.sql repro.
  if (!grammarForPath(filePath)) {
    return { addedLines };
  }

  const [oldBlocks, newBlocks] = await Promise.all([
    extractBlocks(isNew ? '' : oldContent, filePath),
    extractBlocks(isDeleted ? '' : newContent, filePath),
  ]);
  const oldAll = oldBlocks ?? [];
  const newAll = newBlocks ?? [];

  // Path 1 — STABLE-QNAME pairing for real symbols + stable synthetics.
  const rows = diffBlocks(
    oldAll.filter(isStableForDiff),
    newAll.filter(isStableForDiff),
  );
  const changedQnames = new Set<string>();
  for (const r of rows) {
    if (r.changeKind === 'deleted') continue;
    changedQnames.add(r.qname);
  }

  // Path 2 — LINE-OVERLAP for line-range synthetics. Surfaces edits
  // that land entirely in `__code_*__` chunks (top-level expressions,
  // module-level setup) or `__heading_*__` sections (markdown chunked
  // diff, when wired) — without these, such edits made the chip-diff
  // panel render empty even though `addedLines` knew about the change.
  for (const qname of qnamesOverlappingAddedLines(newAll, addedLines)) {
    changedQnames.add(qname);
  }

  return { changedQnames, addedLines };
}
