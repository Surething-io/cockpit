import { describe, expect, it } from 'vitest';
import { SUGGESTED_TITLE_MAX, buildTitlePrompt, cleanSuggestedTitle } from './titleSuggestion';
import { excerptOf } from '../../api/session-title-suggest';
import { titleNameProblem } from '../../../shared/sessionTitle';

describe('cleanSuggestedTitle', () => {
  it('reduces whatever the model says to a title the dialog can save', () => {
    expect(cleanSuggestedTitle('Title: "Fix login redirect"')).toBe('Fix login redirect');
    expect(cleanSuggestedTitle('**标题：@收藏会话 功能。**\n\nThis names the work.')).toBe('收藏会话 功能');
    expect(cleanSuggestedTitle('\n\n# 「支付对账」\n')).toBe('支付对账');
    expect(cleanSuggestedTitle('Two\\nparts')).toBe('Two parts');
    expect(cleanSuggestedTitle('  @  ')).toBe('');
    // A leaked control token means the model derailed: nothing around it is a title.
    expect(cleanSuggestedTitle('化<|end_of_turn|>')).toBe('');
    expect(cleanSuggestedTitle('Fix login<|im_end|>')).toBe('');
    expect(cleanSuggestedTitle('a <b> c|d')).toBe('a <b> c|d');
    const long = cleanSuggestedTitle('word '.repeat(30));
    expect([...long].length).toBeLessThanOrEqual(SUGGESTED_TITLE_MAX);
    for (const raw of ['Title: "a@b"', '- item', 'ok.', '「中文」']) {
      const title = cleanSuggestedTitle(raw);
      if (title) expect(titleNameProblem(title)).toBeNull();
    }
  });
});

describe('title excerpt and prompt', () => {
  it('takes only the first user messages', () => {
    const excerpt = excerptOf([
      { role: 'user', content: 'first' }, { role: 'assistant', content: 'r1' }, { role: 'user', content: ' ' },
      { role: 'user', content: 'second' }, { role: 'user', content: 'third' }, { role: 'user', content: 'fourth' },
      { role: 'assistant', content: 'latest' },
    ]);
    expect(excerpt).toEqual({ userMessages: ['first', 'second'] });
    const prompt = buildTitlePrompt({ userMessages: ['x'.repeat(2000)] });
    expect(prompt).toContain('ONLY the title');
    expect(prompt).not.toContain('x'.repeat(700));
  });
});
