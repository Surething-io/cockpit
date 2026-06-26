import { describe, it, expect } from 'vitest';
import { frontmatterToTable } from './markdownFrontmatter';

// Minimal mdast-ish helpers
const yamlNode = (value: string) => ({ type: 'yaml', value });
const para = (text: string) => ({ type: 'paragraph', children: [{ type: 'text', value: text }] });
const run = (tree: { children: unknown[] }) => frontmatterToTable()(tree);

describe('frontmatterToTable', () => {
  it('replaces a leading yaml node with a key/value table', () => {
    const tree = {
      children: [
        yamlNode('name: cloud-run-log-analysis\ndescription: "Analyze logs"'),
        para('Body'),
      ],
    };
    run(tree);

    const first = tree.children[0] as { type: string; children: { children: { children: { value: string }[] }[] }[] };
    expect(first.type).toBe('table');
    // header + 2 data rows
    expect(first.children).toHaveLength(3);
    const rowText = (r: number, c: number) => first.children[r].children[c].children[0].value;
    expect(rowText(0, 0)).toBe('Field');
    expect(rowText(1, 0)).toBe('name');
    expect(rowText(1, 1)).toBe('cloud-run-log-analysis');
    expect(rowText(2, 0)).toBe('description');
    expect(rowText(2, 1)).toBe('Analyze logs');
    // body paragraph untouched
    expect((tree.children[1] as { type: string }).type).toBe('paragraph');
  });

  it('collapses multi-line string values into a single line', () => {
    const tree = { children: [yamlNode('description: "line one\nline two"')] };
    run(tree);
    const cell = (tree.children[0] as { children: { children: { children: { value: string }[] }[] }[] })
      .children[1].children[1].children[0].value;
    expect(cell).toBe('line one line two');
  });

  it('drops empty / unparseable frontmatter instead of rendering raw text', () => {
    const tree = { children: [yamlNode(''), para('Body')] };
    run(tree);
    expect(tree.children).toHaveLength(1);
    expect((tree.children[0] as { type: string }).type).toBe('paragraph');
  });

  it('leaves documents without frontmatter unchanged', () => {
    const tree = { children: [para('Just text'), { type: 'thematicBreak' }] };
    run(tree);
    expect(tree.children).toHaveLength(2);
    expect((tree.children[0] as { type: string }).type).toBe('paragraph');
    expect((tree.children[1] as { type: string }).type).toBe('thematicBreak');
  });
});
