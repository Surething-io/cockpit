import { describe, it, expect } from 'vitest';
import { parseDelimitedText, detectDelimiter, compareCells } from './CsvTableView';

describe('parseDelimitedText', () => {
  it('parses plain rows and drops the trailing newline', () => {
    expect(parseDelimitedText('a,b\n1,2\n', ',')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps delimiters and escaped quotes inside quoted fields', () => {
    expect(parseDelimitedText('a,"b,c"\n1,"he said ""hi"""\n', ',')).toEqual([
      ['a', 'b,c'],
      ['1', 'he said "hi"'],
    ]);
  });

  it('keeps a newline inside a quoted field on one row', () => {
    expect(parseDelimitedText('a,b\n"multi\nline",2', ',')).toEqual([
      ['a', 'b'],
      ['multi\nline', '2'],
    ]);
  });

  it('preserves empty fields, including a trailing one', () => {
    expect(parseDelimitedText('a,b,\n1,,3\n', ',')).toEqual([
      ['a', 'b', ''],
      ['1', '', '3'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseDelimitedText('x\r\ny\r\n', ',')).toEqual([['x'], ['y']]);
  });

  it('treats a mid-field quote as literal text', () => {
    expect(parseDelimitedText('a"b,c\n', ',')).toEqual([['a"b', 'c']]);
  });
});

describe('detectDelimiter', () => {
  it('sniffs comma, semicolon and tab', () => {
    expect(detectDelimiter('a,b\n1,2')).toBe(',');
    expect(detectDelimiter('a;b\n1;2')).toBe(';');
    expect(detectDelimiter('a\tb\n1\t2')).toBe('\t');
  });

  it('forces tab for .tsv regardless of content', () => {
    expect(detectDelimiter('a,b\tc', '/tmp/x.tsv')).toBe('\t');
  });

  it('ignores delimiters inside quotes and falls back to comma', () => {
    expect(detectDelimiter('"a;b"\n"c;d"')).toBe(',');
    expect(detectDelimiter('single\ncolumn')).toBe(',');
  });
});

describe('compareCells', () => {
  const asc = (a: string[]) => [...a].sort((x, y) => compareCells(x, y, 1));
  const desc = (a: string[]) => [...a].sort((x, y) => compareCells(x, y, -1));

  it('sorts numbers numerically, not lexically', () => {
    expect(asc(['10', '9', '100', '-2'])).toEqual(['-2', '9', '10', '100']);
    expect(desc(['10', '9', '100'])).toEqual(['100', '10', '9']);
  });

  it('sorts numbers written with thousands separators and percents', () => {
    expect(asc(['1,200', '99', '1,000'])).toEqual(['99', '1,000', '1,200']);
    expect(asc(['12%', '9%'])).toEqual(['9%', '12%']);
  });

  it('sorts text naturally (digits inside compare as numbers)', () => {
    expect(asc(['item10', 'item2', 'item1'])).toEqual(['item1', 'item2', 'item10']);
  });

  it('keeps empty cells at the bottom in both directions', () => {
    expect(asc(['b', '', 'a'])).toEqual(['a', 'b', '']);
    expect(desc(['b', '', 'a'])).toEqual(['b', 'a', '']);
  });
});
