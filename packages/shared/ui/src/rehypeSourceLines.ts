import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';

/**
 * Rehype plugin: inject source location info (original markdown line numbers)
 * from HAST nodes as data-source-start / data-source-end attributes on the
 * rendered DOM elements.
 *
 * Only block-level elements (p, h1-h6, li, blockquote, pre, table, etc.) are
 * annotated; inline elements (span, a, code, em, strong) are skipped because
 * their parent block element already covers them.
 */

const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'blockquote', 'pre', 'table', 'tr', 'hr', 'div', 'ul', 'ol',
]);

export function rehypeSourceLines() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (!BLOCK_TAGS.has(node.tagName) || !node.position) return;
      if (!node.properties) node.properties = {};
      node.properties['data-source-start'] = node.position.start.line;
      node.properties['data-source-end'] = node.position.end.line;

      // <pre> → also inject position info into the child <code> element.
      // react-markdown's code component cannot access the parent pre's attributes,
      // so code carries the pre's line range for SyntaxHighlighter to annotate per line.
      if (node.tagName === 'pre') {
        const codeChild = node.children?.find(
          (c): c is Element => c.type === 'element' && c.tagName === 'code',
        );
        if (codeChild) {
          if (!codeChild.properties) codeChild.properties = {};
          codeChild.properties['data-source-start'] = node.position.start.line;
          codeChild.properties['data-source-end'] = node.position.end.line;
        }
      }
    });
  };
}
