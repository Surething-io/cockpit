import { visit, SKIP } from 'unist-util-visit';
import { splitSessionLinks } from '@cockpit/shared-utils/sessionLink';

/** hProperty a bare session link carries, so the `a` renderer can show it as a chip. */
export const SESSION_LINK_ATTR = 'data-session-link';

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
};

/**
 * Remark plugin: linkify bare Cockpit session links (`/project?cwd=…&sessionId=…`)
 * in prose. GFM autolinks only http(s)/www, so the root-relative link an agent
 * writes after /dl or /ss otherwise renders as three lines of percent-encoding.
 * Only bare links are marked as chips; `[label](/project?…)` keeps its label.
 * Code spans and fences are not text nodes, so they stay verbatim.
 */
export function remarkSessionLinks() {
  return (tree: MdNode) => {
    visit(tree, 'text', (node: MdNode, index, parent: MdNode | undefined) => {
      if (!parent || index === undefined || !node.value?.includes('/project?')) return;
      if (parent.type === 'link' || parent.type === 'linkReference') return;
      const segments = splitSessionLinks(node.value);
      if (!segments.some((s) => s.kind === 'link')) return;
      const replacement: MdNode[] = segments.map((s) =>
        s.kind === 'text'
          ? { type: 'text', value: s.text }
          : {
              type: 'link',
              url: s.text,
              children: [{ type: 'text', value: s.text }],
              data: { hProperties: { [SESSION_LINK_ATTR]: '' } },
            },
      );
      parent.children!.splice(index, 1, ...replacement);
      return [SKIP, index + replacement.length];
    });
  };
}
