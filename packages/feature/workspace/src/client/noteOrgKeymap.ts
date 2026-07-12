import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Fragment } from '@tiptap/pm/model';
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import type { TaskStatus } from './taskItemTriState';

// ============================================================================
// NoteOrgKeymap
//
// org-mode-style structural keyboard shortcuts for the note editor:
//
//   Alt-ArrowUp / Alt-ArrowDown   move the current line up / down
//                                   - heading: moves the whole subtree
//                                   - list / task item with a sibling in that
//                                     direction: reorders within its list
//                                   - otherwise (top-level paragraph, or a
//                                     top-level item at its list edge): a
//                                     "region line move" — the line hops over
//                                     the adjacent line even across types/list
//                                     boundaries, keeping its own type; lists
//                                     regroup automatically. Headings and other
//                                     block types (code/table/quote) are hard
//                                     boundaries. Nested sub-items only reorder
//                                     within their own sub-list.
//   Alt-ArrowLeft / Alt-ArrowRight  a top-level heading/paragraph cycles its
//                                   rank on the ring [H1, H2, H3, paragraph]
//                                   (Right = forward, Left = backward, wraps);
//                                   a list / task item outdents / indents.
//   Shift-ArrowRight / -ArrowLeft   cycle the current line on the ring
//                                   [正文(plain), todo, doing, done] — Right
//                                   forward, Left backward, wrapping. Crossing
//                                   the 正文 boundary converts between a plain
//                                   paragraph/list item and a task item. Only
//                                   fires with an empty selection inside a text
//                                   block (paragraph/listItem/taskItem) so
//                                   Shift+arrow text selection keeps working
//                                   everywhere else.
//
// Heading fold (Tab) lives in CollapsibleHeading, which owns the fold attr.
// ============================================================================

// Ranks on the Alt-Left/Right cycle: heading levels 1..3 map to rank 0..2,
// a plain paragraph is rank 3. The ring wraps, so there is no clamp.
const PARAGRAPH_RANK = 3;
const RANK_MODULO = 4;

type Dispatch = ((tr: Transaction) => void) | undefined;

interface TopBlock {
  node: PMNode;
  start: number;
  end: number;
}

function topBlocks(doc: PMNode): TopBlock[] {
  const arr: TopBlock[] = [];
  doc.forEach((node, offset) => arr.push({ node, start: offset, end: offset + node.nodeSize }));
  return arr;
}

function isHeadingLevel(node: PMNode, maxLevel: number): boolean {
  return node.type.name === 'heading' && (node.attrs.level as number) <= maxLevel;
}

/** Depth of the nearest ancestor list/task item, or -1. */
function listItemDepth($from: ResolvedPos): number {
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'listItem' || name === 'taskItem') return d;
  }
  return -1;
}

/**
 * Swap two adjacent ranges [from, mid) and [mid, to). After the swap the
 * originally-right range comes first. Returns the new start of the range that
 * was originally in [movedFrom, movedTo) so callers can restore the caret.
 */
function swapAdjacent(
  tr: Transaction,
  doc: PMNode,
  from: number,
  mid: number,
  to: number,
): void {
  const left = doc.slice(from, mid);
  const right = doc.slice(mid, to);
  tr.replaceWith(from, to, right.content.append(left.content));
}

/** Put the caret at `pos` (clamped), snapping to the nearest valid text spot. */
function setCaret(tr: Transaction, pos: number): void {
  const clamped = Math.max(0, Math.min(pos, tr.doc.content.size));
  tr.setSelection(TextSelection.near(tr.doc.resolve(clamped)));
}

// ---------------------------------------------------------------------------
// Move (Alt-ArrowUp / Alt-ArrowDown)
// ---------------------------------------------------------------------------

function moveHeadingSubtree(state: EditorState, dispatch: Dispatch, dir: number): boolean {
  const { doc, selection } = state;
  const $from = selection.$from;
  const headingStart = $from.before(1);
  const blocks = topBlocks(doc);
  const ci = blocks.findIndex((b) => b.start === headingStart);
  if (ci < 0) return false;
  const level = blocks[ci].node.attrs.level as number;

  // subtree = [ci, se) : up to the next heading of level <= this one.
  let se = ci + 1;
  while (se < blocks.length && !isHeadingLevel(blocks[se].node, level)) se++;
  const subStart = blocks[ci].start;
  const subEnd = blocks[se - 1].end;

  if (dir > 0) {
    // Move down: swap with the following sibling subtree.
    if (se >= blocks.length) return false;
    const sibLevel = blocks[se].node.attrs.level as number;
    let sib = se + 1;
    while (sib < blocks.length && !isHeadingLevel(blocks[sib].node, sibLevel)) sib++;
    const sibEnd = blocks[sib - 1].end;
    if (dispatch) {
      const tr = state.tr;
      const rightSize = doc.slice(subEnd, sibEnd).content.size;
      swapAdjacent(tr, doc, subStart, subEnd, sibEnd);
      setCaret(tr, subStart + rightSize + (selection.from - subStart));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  // Move up: swap with the preceding sibling subtree.
  if (ci === 0) return false;
  let r = ci - 1;
  while (r >= 0 && !isHeadingLevel(blocks[r].node, level)) r--;
  if (r < 0) return false; // nothing but non-headings above → no sibling
  if ((blocks[r].node.attrs.level as number) < level) return false; // ancestor, not a sibling
  const pvStart = blocks[r].start;
  if (dispatch) {
    const tr = state.tr;
    swapAdjacent(tr, doc, pvStart, subStart, subEnd);
    setCaret(tr, pvStart + (selection.from - subStart));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

function moveListItem(state: EditorState, dispatch: Dispatch, dir: number, d: number): boolean {
  const { doc, selection } = state;
  const $from = selection.$from;
  const item = $from.node(d);
  const parent = $from.node(d - 1);
  const index = $from.index(d - 1);
  const itemStart = $from.before(d);
  const itemEnd = itemStart + item.nodeSize;

  if (dir > 0) {
    if (index >= parent.childCount - 1) return false;
    const nextEnd = itemEnd + parent.child(index + 1).nodeSize;
    if (dispatch) {
      const tr = state.tr;
      const rightSize = doc.slice(itemEnd, nextEnd).content.size;
      swapAdjacent(tr, doc, itemStart, itemEnd, nextEnd);
      setCaret(tr, itemStart + rightSize + (selection.from - itemStart));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  if (index <= 0) return false;
  const prevStart = itemStart - parent.child(index - 1).nodeSize;
  if (dispatch) {
    const tr = state.tr;
    swapAdjacent(tr, doc, prevStart, itemStart, itemEnd);
    setCaret(tr, prevStart + (selection.from - itemStart));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

// Top-level block types whose lines participate in a region move. Everything
// else (heading, blockquote, codeBlock, table, horizontalRule, …) is a hard
// boundary that a moving line cannot cross.
const MOVABLE_TOP = new Set(['paragraph', 'bulletList', 'orderedList', 'taskList']);

interface Line {
  kind: string; // 'paragraph' | 'bulletList' | 'orderedList' | 'taskList'
  node: PMNode; // the paragraph, or a single list/task item
}

/** Rebuild a region's line list into top-level nodes, regrouping consecutive
 * same-type items into a single list wrapper (so splits/merges happen). */
function rebuildRegion(lines: Line[], state: EditorState): Fragment {
  const nodes: PMNode[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === 'paragraph') {
      nodes.push(lines[i].node);
      i++;
      continue;
    }
    const kind = lines[i].kind;
    const items: PMNode[] = [];
    while (i < lines.length && lines[i].kind === kind) {
      items.push(lines[i].node);
      i++;
    }
    nodes.push(state.schema.nodes[kind].create(null, items));
  }
  return Fragment.from(nodes);
}

/** Frag-relative offset of the target line's first textblock content start. */
function lineTextStart(frag: Fragment, targetIndex: number): number {
  let idx = 0;
  let off = 0;
  let result = -1;
  frag.forEach((top) => {
    if (result >= 0) return;
    if (top.type.name === 'paragraph') {
      if (idx === targetIndex) result = off + 1; // enter paragraph
      idx++;
      off += top.nodeSize;
    } else {
      let q = off + 1; // first item's frag offset
      top.forEach((item) => {
        if (result >= 0) return;
        if (idx === targetIndex) result = q + 2; // enter item + enter its paragraph
        idx++;
        q += item.nodeSize;
      });
      off += top.nodeSize;
    }
  });
  return result;
}

/**
 * Move the current line one step up/down inside its "region" — the maximal run
 * of movable top-level blocks (paragraphs + lists) bounded by headings / other
 * blocks. The line keeps its own type; lists split/merge as lines cross their
 * boundaries. Returns false (no-op) at a region boundary.
 */
function moveRegionLine(state: EditorState, dispatch: Dispatch, dir: number): boolean {
  const { doc, selection } = state;
  const $from = selection.$from;
  const topStart = $from.before(1);
  const blocks = topBlocks(doc);
  const ci = blocks.findIndex((b) => b.start === topStart);
  if (ci < 0) return false;

  let lo = ci;
  while (lo > 0 && MOVABLE_TOP.has(blocks[lo - 1].node.type.name)) lo--;
  let hi = ci;
  while (hi < blocks.length - 1 && MOVABLE_TOP.has(blocks[hi + 1].node.type.name)) hi++;

  // Flatten the region into lines, remembering which line holds the cursor.
  const lines: Line[] = [];
  let curLine = -1;
  const cursorItemIndex = blocks[ci].node.type.name === 'paragraph' ? -1 : $from.index(1);
  for (let bi = lo; bi <= hi; bi++) {
    const node = blocks[bi].node;
    if (node.type.name === 'paragraph') {
      if (bi === ci) curLine = lines.length;
      lines.push({ kind: 'paragraph', node });
    } else {
      const kind = node.type.name;
      let itemIndex = 0;
      node.forEach((item) => {
        if (bi === ci && itemIndex === cursorItemIndex) curLine = lines.length;
        lines.push({ kind, node: item });
        itemIndex++;
      });
    }
  }

  if (curLine < 0) return false;
  const target = curLine + (dir > 0 ? 1 : -1);
  if (target < 0 || target >= lines.length) return false; // region boundary → stop

  if (dispatch) {
    const moved = lines[curLine];
    lines[curLine] = lines[target];
    lines[target] = moved;

    const frag = rebuildRegion(lines, state);
    const regionFrom = blocks[lo].start;
    const regionTo = blocks[hi].end;
    const tr = state.tr;
    tr.replaceWith(regionFrom, regionTo, frag);
    const textStart = lineTextStart(frag, target);
    setCaret(tr, textStart >= 0 ? regionFrom + textStart + $from.parentOffset : regionFrom);
    dispatch(tr.scrollIntoView());
  }
  return true;
}

function moveBlock(state: EditorState, dispatch: Dispatch, dir: number): boolean {
  const $from = state.selection.$from;

  // Heading: move the whole subtree.
  if ($from.depth === 1 && $from.parent.type.name === 'heading') {
    return moveHeadingSubtree(state, dispatch, dir);
  }

  // Inside a list/task item: reorder within its list when a sibling exists
  // (works at any nesting depth).
  const d = listItemDepth($from);
  if (d > 0) {
    const parent = $from.node(d - 1);
    const index = $from.index(d - 1);
    const hasSibling = dir > 0 ? index < parent.childCount - 1 : index > 0;
    if (hasSibling) return moveListItem(state, dispatch, dir, d);
    // At the list edge: only a TOP-LEVEL item (doc > list > item, depth 2) may
    // cross out into the region; nested sub-items stop here.
    if (d === 2) return moveRegionLine(state, dispatch, dir);
    return false;
  }

  // Top-level paragraph: region-level line move (paragraph in a table cell /
  // blockquote is not top-level, so it falls through to no-op).
  const container = $from.depth >= 1 ? $from.node($from.depth - 1).type.name : 'doc';
  if ($from.parent.type.name === 'paragraph' && container === 'doc') {
    return moveRegionLine(state, dispatch, dir);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Indent / promote (Alt-ArrowLeft / Alt-ArrowRight)
// ---------------------------------------------------------------------------

function indentOrPromote(editor: Editor, dir: number): boolean {
  const { state } = editor;
  const $from = state.selection.$from;
  const parentName = $from.parent.type.name;
  const container = $from.depth >= 1 ? $from.node($from.depth - 1).type.name : 'doc';

  // A top-level heading or paragraph cycles its rank on the ring
  // [H1, H2, H3, paragraph] — Right (dir>0) forward, Left backward, wrapping.
  // (A paragraph inside a list item / table cell / blockquote is NOT top-level,
  // so it falls through to the list branch or to no-op.)
  if (container === 'doc' && (parentName === 'heading' || parentName === 'paragraph')) {
    const rank = parentName === 'heading' ? ($from.parent.attrs.level as number) - 1 : PARAGRAPH_RANK;
    const nextRank = (rank + (dir > 0 ? 1 : -1) + RANK_MODULO) % RANK_MODULO;
    return nextRank === PARAGRAPH_RANK
      ? editor.chain().setParagraph().run()
      : editor.chain().setHeading({ level: (nextRank + 1) as 1 | 2 | 3 }).run();
  }

  const d = listItemDepth($from);
  if (d > 0) {
    const itemType = $from.node(d).type.name;
    return dir < 0
      ? editor.commands.liftListItem(itemType)
      : editor.commands.sinkListItem(itemType);
  }
  return false;
}

// ---------------------------------------------------------------------------
// TODO cycle (Shift-ArrowRight / Shift-ArrowLeft)
// ---------------------------------------------------------------------------

/** Task rank on the Shift ring: 正文=0, todo=1, doing=2, done=3. */
function statusForRank(rank: number): TaskStatus {
  return rank === 2 ? 'doing' : rank === 3 ? 'done' : 'todo';
}

/** In a chained command: set the task item enclosing the current selection to
 * `status` — used right after toggleTaskList turns a paragraph into a task. */
function setEnclosingTaskStatus(tr: Transaction, status: TaskStatus): boolean {
  const $f = tr.selection.$from;
  for (let d = $f.depth; d > 0; d--) {
    if ($f.node(d).type.name === 'taskItem') {
      const p = $f.before(d);
      const n = tr.doc.nodeAt(p);
      if (n) tr.setNodeMarkup(p, undefined, { ...n.attrs, status });
      return true;
    }
  }
  return true; // defensive: toggle didn't yield a task item
}

function cycleTodo(editor: Editor, dir: number): boolean {
  const { state } = editor;
  const sel = state.selection;
  if (!sel.empty) return false; // let Shift+arrow extend the selection
  const $from = sel.$from;
  const step = dir > 0 ? 1 : -1; // Right = forward, Left = backward

  // Inside a task item → advance among todo/doing/done, or out to 正文.
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'taskItem') {
      const pos = $from.before(d);
      const node = state.doc.nodeAt(pos);
      if (!node) return false;
      const cur = (node.attrs.status as TaskStatus) ?? 'todo';
      const rank = cur === 'doing' ? 2 : cur === 'done' ? 3 : 1;
      const nextRank = (rank + step + 4) % 4;
      if (nextRank === 0) {
        // → 正文: turn the task item back into a plain paragraph.
        return editor.chain().toggleTaskList().run();
      }
      const nextStatus = statusForRank(nextRank);
      return editor
        .chain()
        .command(({ tr }) => {
          const n = tr.doc.nodeAt(pos);
          if (!n) return false;
          tr.setNodeMarkup(pos, undefined, { ...n.attrs, status: nextStatus });
          return true;
        })
        .run();
    }
  }

  // Otherwise the line is the 正文 (rank 0) state — eligible only for a plain
  // paragraph at top level or inside a bullet/ordered list item. Excludes table
  // cells, blockquotes, code, headings (Shift+arrow keeps its default there).
  if ($from.parent.type.name !== 'paragraph') return false;
  const container = $from.depth >= 1 ? $from.node($from.depth - 1).type.name : 'doc';
  if (container !== 'doc' && container !== 'listItem') return false;

  const nextRank = (0 + step + 4) % 4; // forward → 1 (todo); backward → 3 (done)
  if (nextRank === 1) {
    return editor.chain().toggleTaskList().run();
  }
  // backward: 正文 → done (convert to a task item, then mark it done).
  return editor
    .chain()
    .toggleTaskList()
    .command(({ tr }) => setEnclosingTaskStatus(tr, 'done'))
    .run();
}

// ---------------------------------------------------------------------------

export const NoteOrgKeymap = Extension.create({
  name: 'noteOrgKeymap',

  addKeyboardShortcuts() {
    return {
      'Alt-ArrowUp': () =>
        this.editor.commands.command(({ state, dispatch }) => moveBlock(state, dispatch, -1)),
      'Alt-ArrowDown': () =>
        this.editor.commands.command(({ state, dispatch }) => moveBlock(state, dispatch, 1)),
      'Alt-ArrowLeft': () => indentOrPromote(this.editor, -1),
      'Alt-ArrowRight': () => indentOrPromote(this.editor, 1),
      'Shift-ArrowRight': () => cycleTodo(this.editor, 1),
      'Shift-ArrowLeft': () => cycleTodo(this.editor, -1),
    };
  },
});
