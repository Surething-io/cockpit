// Project-wide markdown frontmatter handling.
//
// Raw YAML frontmatter (`---\nkey: val\n---` at the very top of a document)
// would otherwise be parsed as a thematic break + loose text and render as a
// garbled paragraph. Approach ①a (structured, AST-pure):
//   1. `remark-frontmatter` makes the leading block a real `yaml` mdast node.
//   2. The transformer below parses that YAML and REPLACES the node with a
//      proper mdast `table` node, so it renders as a clean key/value table
//      that flows with — and is part of — the document content.
//
// Degrades gracefully: empty / unparseable / non-object frontmatter is simply
// removed (hidden) rather than throwing.

import yaml from 'js-yaml';
import remarkFrontmatter from 'remark-frontmatter';
import type { PluggableList, Plugin } from 'unified';

// (typed loosely below to avoid a hard dependency on @types/mdast / @types/unist)

// Minimal structural typing — avoids a hard dependency on @types/mdast.
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  align?: (string | null)[];
}
interface MdRoot {
  children: MdNode[];
}

function textCell(value: string): MdNode {
  return { type: 'tableCell', children: [{ type: 'text', value }] };
}

/** Render a YAML value as a single-line table-cell string. */
function toDisplay(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.replace(/\s*\n\s*/g, ' ').trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Replace leading `yaml` frontmatter nodes with a key/value `table` node.
 *  Exported for unit testing; use `remarkFrontmatterTable` in the pipeline. */
export function frontmatterToTable() {
  return (tree: unknown) => {
  const children = (tree as MdRoot).children;
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.type !== 'yaml') continue;

    let data: Record<string, unknown> | null = null;
    try {
      const parsed = yaml.load(node.value ?? '');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = null;
    }

    const entries = data ? Object.entries(data) : [];
    if (entries.length === 0) {
      // Empty / unparseable → drop the node so it doesn't render as raw text.
      children.splice(i, 1);
      i--;
      continue;
    }

    const headerRow: MdNode = {
      type: 'tableRow',
      children: [textCell('Field'), textCell('Value')],
    };
    const rows: MdNode[] = entries.map(([k, v]) => ({
      type: 'tableRow',
      children: [textCell(k), textCell(toDisplay(v))],
    }));

    children[i] = {
      type: 'table',
      align: ['left', 'left'],
      children: [headerRow, ...rows],
    };
  }
  };
}

/**
 * Remark plugin list that recognizes leading YAML frontmatter and renders it
 * as a structured table. Spread into a `remarkPlugins` array BEFORE the others.
 */
export const remarkFrontmatterTable: PluggableList = [
  remarkFrontmatter,
  frontmatterToTable as unknown as Plugin,
];
