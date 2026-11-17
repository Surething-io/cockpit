import { describe, expect, it, vi } from 'vitest';
import { rustHandler } from './rust';

// Exercise Windows native path semantics on every host. Indexed paths and
// captured source keys remain POSIX paths, exactly as returned by git ls-files.
vi.mock('node:path', async (original) => {
  const actual = await original<typeof import('node:path')>();
  return { ...actual, default: { ...actual, join: actual.win32.join,
    dirname: actual.win32.dirname, basename: actual.win32.basename } };
});

describe('Rust module paths on Windows', () => {
  it('resolves flat and nested modules against captured Git paths', async () => {
    const source = new Map([
      ['src/lib.rs', 'mod leaf; mod nested; mod sibling;'],
      ['src/leaf.rs', 'pub fn target() {}'],
      ['src/nested/mod.rs', 'mod child;'],
      ['src/nested/child.rs', 'pub fn target() {}'],
      ['src/sibling.rs', 'mod child;'],
      ['src/sibling/child.rs', 'pub fn target() {}'],
    ]);
    const files = new Set(source.keys());
    const reads: string[] = [];
    const context = await rustHandler.buildProjectContext('C:\\repo', files, {
      paths: [...files], readFile: async p => {
        reads.push(p);
        const text = source.get(p);
        if (text === undefined) throw new Error(`Unexpected indexed path: ${p}`);
        return text;
      },
    });
    for (const [specifier, target] of [
      ['crate::leaf::target', 'src/leaf.rs'],
      ['crate::nested::child::target', 'src/nested/child.rs'],
      ['crate::sibling::child::target', 'src/sibling/child.rs'],
    ]) {
      expect(rustHandler.resolveSpecifier(specifier, 'src/lib.rs', context, files)).toBe(target);
    }
    expect(reads).toHaveLength(source.size);
    expect(reads.every(p => !p.includes('\\'))).toBe(true);
    expect(rustHandler.moduleForFile('src/unknown.rs', context)).toBe('src');
    expect(rustHandler.moduleForFile('src/nested/child.rs', context)).toBe('crate::nested::child');
  });

  it('resolves workspace member modules independently of the native cwd', async () => {
    const source = new Map([
      ['members/widget/src/lib.rs', 'mod leaf;'],
      ['members/widget/src/leaf.rs', 'pub fn target() {}'],
    ]);
    const files = new Set(source.keys());
    const context = await rustHandler.buildProjectContext('D:\\project', files, {
      paths: [...files], readFile: async p => source.get(p)!,
    });
    expect(rustHandler.resolveSpecifier('self::leaf::target', 'members/widget/src/lib.rs', context, files))
      .toBe('members/widget/src/leaf.rs');
    expect(rustHandler.moduleForFile('members/widget/src/leaf.rs', context)).toBe('widget::leaf');
  });
});
