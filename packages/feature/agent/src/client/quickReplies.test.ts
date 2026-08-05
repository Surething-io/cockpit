import { describe, expect, it } from 'vitest';
import {
  formatQuickReplies,
  normalizeRows,
  parseQuickReplies,
  readQuickReplies,
  toQuickReplyLang,
} from './quickReplies';

describe('parseQuickReplies', () => {
  it('splits rows on newlines and phrases on either comma width', () => {
    expect(parseQuickReplies('A, B\n就这个，不要这样')).toEqual([
      ['A', 'B'],
      ['就这个', '不要这样'],
    ]);
  });

  it('accepts the two comma widths mixed on one line', () => {
    // A Chinese IME emits "，" by default but users type "," for ASCII content,
    // so one line can legitimately carry both.
    expect(parseQuickReplies('A，B, C')).toEqual([['A', 'B', 'C']]);
  });

  it('drops blank lines and empty items instead of making zero-width buttons', () => {
    expect(parseQuickReplies('A,,B\n\n  \n,\nC')).toEqual([['A', 'B'], ['C']]);
  });

  it('trims surrounding whitespace', () => {
    expect(parseQuickReplies('  A  ,  B  ')).toEqual([['A', 'B']]);
  });

  it('returns no rows for an empty buffer, which the caller reads as "restore defaults"', () => {
    expect(parseQuickReplies('')).toEqual([]);
    expect(parseQuickReplies('\n \n')).toEqual([]);
  });

  it('caps rows, phrases per row, and phrase length', () => {
    const manyRows = Array.from({ length: 30 }, (_, i) => `r${i}`).join('\n');
    expect(parseQuickReplies(manyRows)).toHaveLength(12);

    const manyPhrases = Array.from({ length: 30 }, (_, i) => `p${i}`).join(',');
    expect(parseQuickReplies(manyPhrases)[0]).toHaveLength(8);

    expect(parseQuickReplies('x'.repeat(500))[0][0]).toHaveLength(200);
  });
});

describe('formatQuickReplies', () => {
  it('round-trips through parse', () => {
    const rows = [['A', 'B'], ['就这个']];
    expect(parseQuickReplies(formatQuickReplies(rows, 'zh'))).toEqual(rows);
    expect(parseQuickReplies(formatQuickReplies(rows, 'en'))).toEqual(rows);
  });

  it('serializes with the separator that language types', () => {
    expect(formatQuickReplies([['A', 'B']], 'zh')).toBe('A，B');
    expect(formatQuickReplies([['A', 'B']], 'en')).toBe('A, B');
  });
});

describe('normalizeRows', () => {
  it('returns null for anything unusable so the caller falls back to defaults', () => {
    expect(normalizeRows(undefined)).toBeNull();
    expect(normalizeRows('nope')).toBeNull();
    expect(normalizeRows([])).toBeNull();
    expect(normalizeRows([[], ['   ']])).toBeNull();
  });

  it('drops non-string entries rather than stringifying them', () => {
    // A stray null must not become a button that sends the text "null".
    expect(normalizeRows([['A', null, 3, 'B']])).toEqual([['A', 'B']]);
  });
});

describe('readQuickReplies', () => {
  const settings = { quickReplies: { zh: [['就这个']], en: [['This one']] } };

  it('reads only the requested language', () => {
    expect(readQuickReplies(settings, 'zh')).toEqual([['就这个']]);
    expect(readQuickReplies(settings, 'en')).toEqual([['This one']]);
  });

  it('returns null when that language has no customization', () => {
    expect(readQuickReplies({ quickReplies: { zh: [['x']] } }, 'en')).toBeNull();
    expect(readQuickReplies({}, 'zh')).toBeNull();
    expect(readQuickReplies(null, 'zh')).toBeNull();
  });
});

describe('toQuickReplyLang', () => {
  it('folds region tags into the two buckets that exist', () => {
    expect(toQuickReplyLang('zh')).toBe('zh');
    expect(toQuickReplyLang('zh-CN')).toBe('zh');
    expect(toQuickReplyLang('en-US')).toBe('en');
    expect(toQuickReplyLang(undefined)).toBe('en');
  });
});
