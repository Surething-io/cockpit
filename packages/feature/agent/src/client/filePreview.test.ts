import { describe, expect, it } from 'vitest';
import { getFilePreviewKind, parseLocalFileLink } from './filePreview';

describe('chat file previews', () => {
  it.each(['/tmp/cockpit-codex-review.APElEH', '/tmp/README', '/tmp/source.ts', '/tmp/data.json'])('opens %s as source without a suffix allowlist', (path) => {
    expect(parseLocalFileLink(path, '/project')?.abs).toBe(path);
    expect(getFilePreviewKind({ path, source: 'link' })).toBe('text');
    expect(getFilePreviewKind({ path, source: 'tool' })).toBe('text');
  });

  it('requires an explicit tool-file gesture to execute HTML', () => {
    expect(getFilePreviewKind({ path: '/tmp/unreviewed.html', source: 'link' })).toBe('text');
    expect(getFilePreviewKind({ path: '/tmp/app.html', source: 'tool' })).toBe('html');
  });

  it.each([['guide.md', 'markdown'], ['table.csv', 'csv'], ['table.tsv', 'csv'], ['picture.png', 'image']])('preserves the %s renderer', (path, kind) => {
    expect(getFilePreviewKind({ path, source: 'link' })).toBe(kind);
  });

  it('keeps project files and line jumps in Explorer', () => {
    expect(parseLocalFileLink('/project/src/module.ts#L12', '/project')).toEqual({ rel: 'src/module.ts', abs: null, lineNumber: 12 });
    expect(parseLocalFileLink('README', '/project')).toEqual({ rel: 'README', abs: null });
    expect(parseLocalFileLink('./README', '/project')).toEqual({ rel: 'README', abs: null });
  });

  it.each(['https://example.com/a.txt', '//example.com/a.txt', '#heading'])('leaves %s to the browser', (href) => {
    expect(parseLocalFileLink(href, '/project')).toBeNull();
  });
});
