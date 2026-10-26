import { describe, it, expect } from 'vitest';
import { buildSessionLink, parseSessionLink, splitSessionLinks } from './sessionLink';

describe('sessionLink', () => {
  it('round-trips cwd and sessionId, including spaces and CJK', () => {
    const cwd = '/Users/me/My Notes/笔记';
    const link = buildSessionLink(cwd, 'abc-123');
    expect(link.startsWith('/project?')).toBe(true);
    expect(parseSessionLink(link)).toEqual({ cwd, sessionId: 'abc-123' });
  });

  it('accepts an absolute URL only on the current origin', () => {
    const href = 'http://localhost:3456/project?cwd=%2Ftmp&sessionId=s1';
    expect(parseSessionLink(href, 'http://localhost:3456')).toEqual({ cwd: '/tmp', sessionId: 's1' });
    expect(parseSessionLink(href)).toBeNull();
    expect(parseSessionLink('https://example.org/project?cwd=%2Ftmp&sessionId=s1', 'http://localhost:3456')).toBeNull();
  });

  it('rejects look-alikes that resolve to another host', () => {
    expect(parseSessionLink('//example.org/project?cwd=%2Ftmp&sessionId=s1', 'http://localhost:3456')).toBeNull();
    expect(parseSessionLink('/\\example.org/project?cwd=%2Ftmp&sessionId=s1', 'http://localhost:3456')).toBeNull();
  });

  it('rejects other paths, missing params and non-http schemes', () => {
    expect(parseSessionLink('/review/1?cwd=/tmp&sessionId=s')).toBeNull();
    expect(parseSessionLink('/project?cwd=%2Ftmp')).toBeNull();
    expect(parseSessionLink('javascript:alert(1)', 'http://localhost:3456')).toBeNull();
    expect(parseSessionLink('/docs/project.md')).toBeNull();
    expect(parseSessionLink(undefined)).toBeNull();
  });

  it('splits a delegation line into text and a session link', () => {
    const link = buildSessionLink('/Users/me/proj', 'c9d0cd7d');
    const text = `Task: x\n[Delegated from Cockpit session ${link} (proj)]\n`;
    const segments = splitSessionLinks(text);
    expect(segments).toEqual([
      { kind: 'text', text: 'Task: x\n[Delegated from Cockpit session ' },
      { kind: 'link', text: link, target: { cwd: '/Users/me/proj', sessionId: 'c9d0cd7d' } },
      { kind: 'text', text: ' (proj)]\n' },
    ]);
    expect(segments.map((s) => s.text).join('')).toBe(text);
  });

  it('leaves text without a valid root-relative session link untouched', () => {
    for (const text of [
      'see https://example.org/project?cwd=%2Ftmp&sessionId=s1',
      'path a/project?cwd=%2Ftmp&sessionId=s1',
      'missing /project?cwd=%2Ftmp',
      '',
    ]) {
      expect(splitSessionLinks(text).filter((s) => s.kind === 'link')).toEqual([]);
    }
  });

  it('finds a link after CJK punctuation and stops before trailing punctuation', () => {
    const href = buildSessionLink('/a/中文', 'abc');
    for (const text of [`链接：${href}`, `（${href}）`, `see ${href}.`, `链接：${href}。`]) {
      const links = splitSessionLinks(text).filter((s) => s.kind === 'link');
      expect(links).toEqual([{ kind: 'link', text: href, target: { cwd: '/a/中文', sessionId: 'abc' } }]);
    }
  });

  it('ignores a /project path glued to another URL or path', () => {
    const href = buildSessionLink('/a', 'abc');
    for (const text of [`https://other.host${href}`, `foo/bar${href}`, `x${href}`]) {
      expect(splitSessionLinks(text).some((s) => s.kind === 'link')).toBe(false);
    }
  });
});
