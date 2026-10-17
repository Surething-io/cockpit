import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { remarkCjk } from './markdownCjk';

type Node = { type: string; value?: string; children?: Node[] };

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkCjk);
const firstParagraph = (md: string) => (processor.runSync(processor.parse(md)) as Node).children![0];
const types = (n: Node): string[] => [n.type, ...(n.children ?? []).flatMap(types)];

describe('remarkCjk', () => {
  it('closes bold after CJK punctuation followed by a letter', () => {
    const p = firstParagraph('**为什么要问：**同名会员');
    expect(p.children![0].type).toBe('strong');
    expect(p.children![1]).toMatchObject({ type: 'text', value: '同名会员' });
  });

  it('closes bold that ends with a full-width quote', () => {
    expect(types(firstParagraph('中文**“引号”**中文'))).toContain('strong');
  });

  it('closes strikethrough after CJK punctuation', () => {
    expect(types(firstParagraph('~~删除：~~文字'))).toContain('delete');
  });

  it('leaves inline code literal', () => {
    const p = firstParagraph('`**a：**b`');
    expect(p.children![0]).toMatchObject({ type: 'inlineCode', value: '**a：**b' });
  });
});
