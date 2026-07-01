import { Extension } from '@tiptap/core';

// ============================================
// Mixed task/bullet list split (parse-side fix)
// ============================================
//
// Bug this fixes:
//   markdown-it merges a plain bullet list and a task list into ONE <ul> when
//   they use the same "-" marker and are only separated by blank lines
//   (CommonMark loose-list behavior). markdown-it-task-lists then tags that
//   whole <ul> with `contains-task-list`, and tiptap-markdown promotes the
//   entire list to a Tiptap `taskList`. The plain <li> items (no checkbox) are
//   now illegal children of a taskList, so ProseMirror's schema normalization
//   coerces the boundary and spawns a STRAY EMPTY checkbox on every load —
//   which reappears even after the user deletes it, because it is regenerated
//   from the file's markdown at parse time (it is never persisted).
//
//   Repro (all `-`, one blank line between the two blocks):
//     - 错误分析
//     - slack 业务
//
//     - [ ] 文件下载问题
//   => <ul class="contains-task-list"> containing BOTH plain and task <li>.
//
// Fix:
//   Run inside tiptap-markdown's parse pipeline (storage.markdown.parse.updateDOM
//   is invoked for every extension on the rendered HTML, before ProseMirror
//   parsing) and split every `.contains-task-list` <ul> into contiguous runs:
//   task runs stay a taskList, plain runs are demoted back to a normal
//   bulletList. No mixed list ever reaches the schema, so no phantom checkbox.

/** Minimal shape of a list item we need to classify. */
export interface ListItemLike {
  isTask: boolean;
}

export interface ListGroup<T extends ListItemLike> {
  isTask: boolean;
  items: T[];
}

/**
 * Pure decision core: split a list's items into maximal contiguous runs of the
 * same kind (task vs plain), preserving order. This is the logic that decides
 * whether/how a `<ul>` must be split; unit-tested independently of the DOM.
 */
export function groupListItems<T extends ListItemLike>(items: T[]): ListGroup<T>[] {
  const groups: ListGroup<T>[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.isTask === item.isTask) {
      last.items.push(item);
    } else {
      groups.push({ isTask: item.isTask, items: [item] });
    }
  }
  return groups;
}

/** Whether an <li> is a real task item (has the markdown-it-task-lists class). */
function isTaskItem(li: Element): boolean {
  return li.classList.contains('task-list-item');
}

/**
 * DOM adapter: find every `.contains-task-list` <ul> and, if it mixes task and
 * plain items, replace it with a sequence of pure <ul>s (task runs keep the
 * task-list marker; plain runs become ordinary bullet lists).
 */
export function splitMixedTaskLists(root: Element): void {
  const lists = Array.from(root.querySelectorAll('ul.contains-task-list'));
  for (const ul of lists) {
    const items = Array.from(ul.children).filter(
      (el): el is HTMLElement => el.tagName === 'LI'
    );
    if (items.length === 0) continue;

    const groups = groupListItems(
      items.map((li) => ({ isTask: isTaskItem(li), el: li }))
    );

    if (groups.length <= 1) {
      // Already pure. Ensure a pure task list still carries its marker.
      if (groups[0]?.isTask) ul.setAttribute('data-type', 'taskList');
      continue;
    }

    const doc = ul.ownerDocument;
    const fragment = doc.createDocumentFragment();
    for (const group of groups) {
      const newUl = doc.createElement('ul');
      if (group.isTask) {
        newUl.setAttribute('class', 'contains-task-list');
        newUl.setAttribute('data-type', 'taskList');
      }
      for (const { el } of group.items) newUl.appendChild(el); // moves the <li>
      fragment.appendChild(newUl);
    }
    ul.replaceWith(fragment);
  }
}

/**
 * Tiptap extension that hooks the split into tiptap-markdown's parse pipeline.
 * It carries no schema of its own; `getMarkdownSpec` picks up its
 * `storage.markdown.parse.updateDOM` and runs it on the parsed HTML.
 */
export const MarkdownTaskListFix = Extension.create({
  name: 'markdownTaskListFix',
  addStorage() {
    return {
      markdown: {
        parse: {
          updateDOM(element: HTMLElement) {
            splitMixedTaskLists(element);
          },
        },
      },
    };
  },
});
