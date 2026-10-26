import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { remarkSessionLinks, SESSION_LINK_ATTR } from './markdownSessionLinks';

type Node = { type: string; value?: string; url?: string; children?: Node[]; data?: { hProperties?: Record<string, unknown> } };

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkSessionLinks);
const parse = (md: string) => processor.runSync(processor.parse(md)) as Node;
const flat = (n: Node): Node[] => [n, ...(n.children ?? []).flatMap(flat)];
const links = (md: string) => flat(parse(md)).filter((n) => n.type === 'link');

const HREF = '/project?cwd=%2FUsers%2Fka%2Frepo&sessionId=01a16876-13df-76c3-9468-ce16d1ccbc69&view=agent';

describe('remarkSessionLinks', () => {
  it('linkifies a bare session link in prose and marks it as a chip', () => {
    const [link, ...rest] = links(`- 链接：${HREF}`);
    expect(rest).toHaveLength(0);
    expect(link.url).toBe(HREF);
    expect(link.data?.hProperties).toHaveProperty(SESSION_LINK_ATTR);
  });

  it('keeps the surrounding text', () => {
    const texts = flat(parse(`see ${HREF} now`)).filter((n) => n.type === 'text').map((n) => n.value);
    expect(texts).toEqual(['see ', HREF, ' now']);
  });

  it('leaves labeled links alone', () => {
    const ls = links(`[review](${HREF})`);
    expect(ls).toHaveLength(1);
    expect(ls[0].data?.hProperties).toBeUndefined();
  });

  it('leaves inline code and other hosts alone', () => {
    expect(links(`\`${HREF}\``)).toHaveLength(0);
    expect(links(`https://other.host${HREF}`).every((l) => !l.data?.hProperties)).toBe(true);
  });
});
