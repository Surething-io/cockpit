import { describe, expect, it } from 'vitest';
import { formatOutputStyleSection, normalizeOutputStyles } from './outputStyles';

describe('normalizeOutputStyles', () => {
  it('drops unusable entries, dedupes names, keeps and reissues ids', () => {
    const out = normalizeOutputStyles([
      { id: 'a', name: ' Concise ', content: ' short \n' },
      { id: 'a', name: 'Other', content: 'x' },
      { id: 'b', name: 'Concise', content: 'dup name' },
      { id: 'c', name: '', content: 'no name' },
      { id: 'd', name: 'Empty', content: '   ' },
      'junk',
      null,
    ]);
    expect(out.map((s) => [s.name, s.content])).toEqual([['Concise', 'short'], ['Other', 'x']]);
    expect(out[0].id).toBe('a');
    expect(out[1].id).not.toBe('a');
    expect(out[1].id).toBeTruthy();
  });

  it('returns [] for non-arrays', () => {
    expect(normalizeOutputStyles(undefined)).toEqual([]);
    expect(normalizeOutputStyles({ styles: [] })).toEqual([]);
  });
});

describe('formatOutputStyleSection', () => {
  it('frames the content with a heading, scope and precedence, and no style name', () => {
    const section = formatOutputStyleSection('回答问题用中文');
    expect(section.startsWith('# Output style\n')).toBe(true);
    expect(section).toContain('every reply');
    expect(section).toContain('skill');
    expect(section.endsWith('<output_style>\n回答问题用中文\n</output_style>')).toBe(true);
  });
});
