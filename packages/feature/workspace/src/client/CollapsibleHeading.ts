import Heading from '@tiptap/extension-heading';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

// ============================================================================
// CollapsibleHeading
//
// Extends the StarterKit Heading with an org-mode-style outline fold. Each
// heading carries a `foldState`:
//
//   foldState   own body   subtree
//   ---------   --------   ------------------------------------------------
//   expanded    shown      shown normally (each descendant by its own state)
//   folded      hidden     entire subtree hidden (headings + bodies)
//   children    hidden     every descendant HEADING (all levels) shown as a
//                          title row; every body (non-heading block) hidden
//
// Visibility is derived on the fly (buildDecorations): a `folded` ancestor hides
// everything below it; a `children` ancestor hides only non-heading blocks,
// keeping headings visible.
//
// Tab cycle (see the decision table in addKeyboardShortcuts):
//   - a heading with NO sub-headings toggles expanded <-> folded (binary);
//   - a heading WITH sub-headings cycles expanded -> folded -> children ->
//     expanded. Entering `children` cascades every descendant heading to
//     `expanded` so that all levels show as titles (a folded descendant would
//     otherwise hide its own sub-headings).
//
// Clicking the gutter arrow is a SINGLE-heading toggle (no cascade): expanded ->
// folded, and folded/children -> expanded.
//
// Persistence: Markdown only has a binary fold marker (a trailing `<!-- fold -->`
// comment). Both `folded` and `children` write the marker, so a heading left in
// `children` reopens as `folded` (children is a session-only view). `expanded`
// writes no comment. External Markdown editors render the comment as nothing.
// ============================================================================

export type FoldState = 'expanded' | 'folded' | 'children';

/** Minimal surface of tiptap-markdown's serializer state that we call. */
interface MarkdownSerializeState {
  write(content: string): void;
  repeat(str: string, n: number): string;
  renderInline(node: PMNode, fromBlockStart?: boolean): void;
  closeBlock(node: PMNode): void;
}

const foldPluginKey = new PluginKey('headingFold');

function readFoldState(node: PMNode): FoldState {
  const s = node.attrs.foldState;
  return s === 'folded' || s === 'children' ? s : 'expanded';
}

/**
 * Positions (in document order) of every descendant heading in the subtree of
 * the heading at `pos` — i.e. later headings of level > `level`, up to the next
 * heading of level <= `level`. Headings are top-level blocks, so a scan of the
 * doc's direct children suffices. `setNodeMarkup` preserves node size, so the
 * returned positions stay valid across a batch of attribute writes.
 */
function descendantHeadingPositions(doc: PMNode, pos: number, level: number, typeName: string): number[] {
  const out: number[] = [];
  let inSubtree = false;
  doc.forEach((child, offset) => {
    if (offset === pos) {
      inSubtree = true;
      return;
    }
    if (!inSubtree) return;
    if (child.type.name === typeName) {
      if ((child.attrs.level as number) <= level) {
        inSubtree = false; // reached a sibling/ancestor: subtree ends
        return;
      }
      out.push(offset);
    }
  });
  return out;
}

/** Build the toggle arrow shown in the left gutter of a heading. */
function createToggle(view: EditorView, getPos: () => number | undefined, state: FoldState): HTMLElement {
  const btn = document.createElement('span');
  btn.className = 'note-fold-toggle';
  btn.contentEditable = 'false';
  btn.setAttribute('data-fold-state', state);
  // mousedown (not click) so we can preventDefault before the editor moves the
  // selection / steals focus.
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const widgetPos = getPos();
    if (widgetPos == null) return;
    const headingPos = widgetPos - 1; // widget sits at the heading's content start
    const node = view.state.doc.nodeAt(headingPos);
    if (!node || node.type.name !== 'heading') return;
    // Single-heading toggle (no cascade): expanded -> folded, else -> expanded.
    view.dispatch(
      view.state.tr.setNodeMarkup(headingPos, undefined, {
        ...node.attrs,
        foldState: readFoldState(node) === 'expanded' ? 'folded' : 'expanded',
      })
    );
  });
  return btn;
}

/** Recompute fold decorations (toggle widgets + hidden ranges) for the doc. */
function buildDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  // Stack of ancestor headings whose fold region is still open.
  const stack: { level: number; state: FoldState }[] = [];

  doc.forEach((node, offset) => {
    const from = offset;
    const to = offset + node.nodeSize;

    if (node.type.name === 'heading') {
      const level = node.attrs.level as number;
      // A heading closes the fold region of any heading with level >= its own.
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      const state = readFoldState(node);
      // A heading is hidden only when an ancestor is `folded`; a `children`
      // ancestor keeps sub-headings (at every level) visible.
      const hidden = stack.some((e) => e.state === 'folded');

      const classes = ['note-heading'];
      if (state !== 'expanded') classes.push('is-collapsed');
      if (hidden) classes.push('note-folded-hidden');
      decos.push(Decoration.node(from, to, { class: classes.join(' ') }));

      // Toggle arrow, placed at the heading's content start.
      decos.push(
        Decoration.widget(from + 1, (view, getPos) => createToggle(view, getPos, state), {
          side: -1,
          key: `fold-${from}-${state}`,
        })
      );

      stack.push({ level, state });
    } else {
      // A non-heading block is hidden when any ancestor is `folded` (hides the
      // whole subtree) or `children` (hides bodies, keeps sub-headings).
      const hidden = stack.some((e) => e.state === 'folded' || e.state === 'children');
      if (hidden) decos.push(Decoration.node(from, to, { class: 'note-folded-hidden' }));
    }
  });

  return DecorationSet.create(doc, decos);
}

export const CollapsibleHeading = Heading.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      foldState: {
        default: 'expanded' as FoldState,
        keepOnSplit: false,
        // Markdown parse only knows a binary fold: `<!-- fold -->` becomes
        // data-collapsed on the <h*> (see updateDOM below), mapped to `folded`.
        parseHTML: (element): FoldState =>
          element.getAttribute('data-collapsed') === 'true' ? 'folded' : 'expanded',
        renderHTML: (attributes: { foldState?: FoldState }) =>
          attributes.foldState && attributes.foldState !== 'expanded'
            ? { 'data-collapsed': 'true' }
            : {},
      },
    };
  },

  addKeyboardShortcuts() {
    const typeName = this.name;
    return {
      // Tab cycles the current heading's fold state. Decision table:
      //
      //   hasKids  current    -> next       cascade descendants
      //   -------  ---------  -----------   -------------------
      //   no       expanded   folded        —
      //   no       folded     expanded      —
      //   no       children   expanded      —            (defensive)
      //   yes      expanded   folded        —            (folded hides subtree)
      //   yes      folded     children      -> expanded  (so all levels show)
      //   yes      children   expanded      -> expanded
      //
      // Only fires when the caret is inside a heading; otherwise return false so
      // list Tab (indent) keeps working.
      Tab: () => {
        const { state } = this.editor;
        const { $from } = state.selection;
        if ($from.parent.type.name !== typeName) return false;
        const pos = $from.before($from.depth);
        const node = state.doc.nodeAt(pos);
        if (!node || node.type.name !== typeName) return false;

        const level = node.attrs.level as number;
        const descendants = descendantHeadingPositions(state.doc, pos, level, typeName);
        const hasKids = descendants.length > 0;
        const cur = readFoldState(node);

        let headingNext: FoldState;
        let cascadeTo: FoldState | null = null;
        if (!hasKids) {
          headingNext = cur === 'expanded' ? 'folded' : 'expanded';
        } else if (cur === 'expanded') {
          headingNext = 'folded';
        } else if (cur === 'folded') {
          headingNext = 'children';
          cascadeTo = 'expanded';
        } else {
          headingNext = 'expanded';
          cascadeTo = 'expanded';
        }

        return this.editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, foldState: headingNext });
            if (cascadeTo) {
              for (const off of descendants) {
                const h = tr.doc.nodeAt(off);
                if (h && h.type.name === typeName) {
                  tr.setNodeMarkup(off, undefined, { ...h.attrs, foldState: cascadeTo });
                }
              }
            }
            return true;
          })
          .run();
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        // Serialize: append the fold marker on folded/children headings.
        serialize(state: MarkdownSerializeState, node: PMNode) {
          state.write(state.repeat('#', node.attrs.level) + ' ');
          state.renderInline(node, false);
          if (readFoldState(node) !== 'expanded') {
            state.write(' <!-- fold -->');
          }
          state.closeBlock(node);
        },
        parse: {
          // Parse: markdown-it has rendered `## Title <!-- fold -->` into an
          // <h*> whose trailing child is an HTML comment. Lift it into the
          // data-collapsed attribute (read back by parseHTML above) and drop
          // the comment + any trailing whitespace so the heading text is clean.
          updateDOM(element: HTMLElement) {
            element.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
              let node: ChildNode | null = h.lastChild;
              while (node && node.nodeType === 3 && !(node.textContent || '').trim()) {
                const prev = node.previousSibling;
                h.removeChild(node);
                node = prev;
              }
              if (node && node.nodeType === 8 && /^\s*fold\s*$/.test(node.textContent || '')) {
                const prev = node.previousSibling;
                h.removeChild(node);
                if (prev && prev.nodeType === 3) {
                  prev.textContent = (prev.textContent || '').replace(/\s+$/, '');
                }
                h.setAttribute('data-collapsed', 'true');
              }
            });
          },
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: foldPluginKey,
        state: {
          init: (_config, { doc }) => buildDecorations(doc),
          apply: (tr, old) => (tr.docChanged ? buildDecorations(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return foldPluginKey.getState(state);
          },
        },
      }),
    ];
  },
});
