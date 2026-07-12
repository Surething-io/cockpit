import { mergeAttributes, wrappingInputRule } from '@tiptap/core';
import { TaskItem } from '@tiptap/extension-task-item';

// ============================================
// Tri-state task item (todo / doing / done)
// ============================================
//
// The stock @tiptap/extension-task-item is binary: a boolean `checked`
// attribute rendered as a native <input type=checkbox>. A checkbox has no
// third state, so we replace `checked` with a single `status` attribute and
// draw our own click-cycling marker.
//
//   status  markdown   aria-checked   marker
//   ------  ---------  ------------   -----------------------------
//   todo    - [ ]      false          empty box
//   doing   - [/]      mixed          amber box + dash  (–)
//   done    - [x]      true           teal box + check  (✓) + strike
//
// Clicking the marker cycles todo -> doing -> done -> todo.
//
// Backward compatibility: `status` is the single source of truth, but its
// parseHTML falls back to the legacy `data-checked` attribute, so pre-existing
// notes (which only carry `[ ]` / `[x]`) map to todo / done and round-trip
// byte-for-byte. Only the new `doing` state ever emits `[/]`.
//
// Parsing `[/]` from markdown: markdown-it-task-lists does not recognize it, so
// doing items are promoted to task items in markdownTaskListFix.ts (parse-side),
// which stamps `data-status="doing"` that this extension reads back here.

export type TaskStatus = 'todo' | 'doing' | 'done';

const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: 'doing',
  doing: 'done',
  done: 'todo',
};

const ARIA_CHECKED: Record<TaskStatus, string> = {
  todo: 'false',
  doing: 'mixed',
  done: 'true',
};

/** Markdown checkbox token for a status — the single source of truth. */
export function statusToBox(status: TaskStatus): string {
  if (status === 'done') return '[x]';
  if (status === 'doing') return '[/]';
  return '[ ]';
}

/** Derive status from the DOM produced by the markdown parse pipeline. */
export function statusFromDom(element: HTMLElement): TaskStatus {
  const explicit = element.getAttribute('data-status');
  if (explicit === 'todo' || explicit === 'doing' || explicit === 'done') {
    return explicit;
  }
  // Legacy real [ ] / [x] items only carry data-checked (set by tiptap-markdown).
  const checked = element.getAttribute('data-checked');
  return checked === '' || checked === 'true' ? 'done' : 'todo';
}

// Typing "[ ] ", "[/] ", or "[x] " at the start of a line starts a task item.
const inputRegex = /^\s*(\[([ x/])?\])\s$/;

export const TaskItemTriState = TaskItem.extend({
  addAttributes() {
    return {
      status: {
        default: 'todo' as TaskStatus,
        keepOnSplit: false,
        parseHTML: (element: HTMLElement) => statusFromDom(element),
        renderHTML: (attributes: { status: TaskStatus }) => ({
          'data-status': attributes.status,
          // Mirror to data-checked so any legacy selector keeps working.
          'data-checked': attributes.status === 'done' ? 'true' : 'false',
        }),
      },
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: { write(s: string): void; renderContent(n: unknown): void }, node: { attrs: { status: TaskStatus } }) {
          state.write(`${statusToBox(node.attrs.status)} `);
          state.renderContent(node);
        },
        // parse.updateDOM is inherited from tiptap-markdown's default taskItem
        // spec (merged by getMarkdownSpec): it strips the <input> and stamps
        // data-checked for real [ ] / [x] items. Doing items are promoted in
        // markdownTaskListFix.ts.
      },
    };
  },

  addInputRules() {
    return [
      wrappingInputRule({
        find: inputRegex,
        type: this.type,
        getAttributes: (match: RegExpMatchArray) => {
          const mark = match[match.length - 1];
          const status: TaskStatus = mark === 'x' ? 'done' : mark === '/' ? 'doing' : 'todo';
          return { status };
        },
      }),
    ];
  },

  // NOTE: renderHTML only drives clipboard/export serialization. The live
  // editor is rendered by addNodeView() below, and persistence uses the
  // markdown serializer, so this HTML is never shown in-app.
  //
  // Emit a tight `<li data-type data-status><p>…</p></li>`: keep data-type /
  // data-status so pasting back into the editor reconstructs the todo, but drop
  // the decorative <label> checkbox and the extra <div> wrapper. External
  // rich-text targets (Feishu, macOS Notes, Word) don't understand
  // data-type="taskItem"; the old <label> + block <div> made them render the
  // bullet and its text on separate lines with a blank line in between.
  renderHTML({ HTMLAttributes }) {
    return [
      'li',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-type': this.name }),
      0,
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const li = document.createElement('li');
      li.setAttribute('data-type', this.name);

      const marker = document.createElement('label');
      marker.classList.add('task-marker');
      marker.contentEditable = 'false';

      const boxEl = document.createElement('span');
      boxEl.classList.add('task-marker-box');
      boxEl.setAttribute('role', 'checkbox');
      marker.appendChild(boxEl);

      const content = document.createElement('div');
      li.append(marker, content);

      const apply = (n: { attrs: { status?: TaskStatus } }) => {
        const status: TaskStatus = n.attrs.status ?? 'todo';
        li.dataset.status = status;
        li.dataset.checked = status === 'done' ? 'true' : 'false';
        boxEl.setAttribute('aria-checked', ARIA_CHECKED[status]);
      };
      apply(node);

      // preventDefault on mousedown so clicking the marker never moves the caret
      marker.addEventListener('mousedown', (event) => event.preventDefault());
      marker.addEventListener('click', (event) => {
        event.preventDefault();
        if (!editor.isEditable || typeof getPos !== 'function') return;
        const pos = getPos();
        if (typeof pos !== 'number') return;
        editor
          .chain()
          .focus(undefined, { scrollIntoView: false })
          .command(({ tr }) => {
            const current = tr.doc.nodeAt(pos);
            if (!current) return false;
            const status: TaskStatus = current.attrs.status ?? 'todo';
            tr.setNodeMarkup(pos, undefined, { ...current.attrs, status: NEXT_STATUS[status] });
            return true;
          })
          .run();
      });

      return {
        dom: li,
        contentDOM: content,
        update: (updated) => {
          if (updated.type !== node.type) return false;
          apply(updated);
          return true;
        },
      };
    };
  },
});
