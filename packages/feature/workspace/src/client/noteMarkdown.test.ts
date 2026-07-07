import { describe, it, expect } from 'vitest';
import { normalizeNoteMarkdown } from './noteMarkdown';

describe('normalizeNoteMarkdown', () => {
  it('removes bare empty unchecked checkbox lines', () => {
    expect(normalizeNoteMarkdown('- [ ]')).toBe('');
    expect(normalizeNoteMarkdown('- [ ] ')).toBe('');
  });

  it('removes the degraded escaped-bracket artifact', () => {
    expect(normalizeNoteMarkdown('- \\[ \\]')).toBe('');
  });

  it('removes empty checked and indented / alt-marker variants', () => {
    const input = ['- [x]', '  * \\[ \\]', '+ [X]', '\t- \\[x\\]'].join('\n');
    expect(normalizeNoteMarkdown(input)).toBe('');
  });

  it('removes empty doing ([/]) checkbox lines', () => {
    expect(normalizeNoteMarkdown('- [/]')).toBe('');
    expect(normalizeNoteMarkdown('- [/] ')).toBe('');
    expect(normalizeNoteMarkdown('  * \\[/\\]')).toBe('');
  });

  it('keeps checkboxes that have real content', () => {
    const input = ['- [ ] 有内容', '- [/] 进行中', '- [x] done'].join('\n');
    expect(normalizeNoteMarkdown(input)).toBe(input);
  });

  it('keeps ordinary bullets and text', () => {
    const input = ['- 错误分析', '- slack 业务', 'plain text'].join('\n');
    expect(normalizeNoteMarkdown(input)).toBe(input);
  });

  it('strips the accumulated junk from a realistic block', () => {
    const input = [
      '每日任务监控和数据巡检',
      '',
      '- [ ] ',
      '',
      '- \\[ \\]',
      '- \\[ \\]',
      '- \\[ \\]',
      '- \\[ \\]',
      '- 错误分析',
      '- slack 业务',
    ].join('\n');
    const expected = [
      '每日任务监控和数据巡检',
      '',
      '- 错误分析',
      '- slack 业务',
    ].join('\n');
    expect(normalizeNoteMarkdown(input)).toBe(expected);
  });

  it('never touches content inside fenced code blocks', () => {
    const input = ['```', '- [ ]', '- \\[ \\]', '```'].join('\n');
    expect(normalizeNoteMarkdown(input)).toBe(input);
  });

  it('is idempotent', () => {
    const input = [
      'a',
      '- [ ]',
      '',
      '',
      '- \\[ \\]',
      'b',
    ].join('\n');
    const once = normalizeNoteMarkdown(input);
    expect(normalizeNoteMarkdown(once)).toBe(once);
  });

  it('does not add or drop a trailing newline', () => {
    expect(normalizeNoteMarkdown('a\n')).toBe('a\n');
    expect(normalizeNoteMarkdown('a')).toBe('a');
  });
});
