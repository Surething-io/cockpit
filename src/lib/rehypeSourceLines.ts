import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';

/**
 * Rehype plugin: 将 HAST 节点的源码位置信息（markdown 原始行号）
 * 注入为 data-source-start / data-source-end 属性到渲染后的 DOM 元素上。
 *
 * 只注解块级元素（p, h1-h6, li, blockquote, pre, table 等），
 * 内联元素（span, a, code, em, strong）跳过，因为它们的父块元素已经覆盖了。
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

      // <pre> → 将位置信息也注入到子 <code> 元素上
      // react-markdown 的 code 组件拿不到父 pre 的属性，
      // 这里让 code 也携带 pre 的行范围，供 SyntaxHighlighter 逐行标注使用
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
