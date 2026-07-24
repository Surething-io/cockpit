import { describe, it, expect } from 'vitest';
import { joinAssistantText } from './assistantText';

describe('joinAssistantText', () => {
  it('returns next verbatim when prev is empty (leading segment never breaks)', () => {
    expect(joinAssistantText('', 'hello', true)).toBe('hello');
    expect(joinAssistantText('', 'hello', false)).toBe('hello');
  });

  it('returns prev unchanged when next is empty', () => {
    expect(joinAssistantText('hello', '', true)).toBe('hello');
  });

  it('glues when breakBefore is false', () => {
    expect(joinAssistantText('**a**', '**b**', false)).toBe('**a****b**');
  });

  it('inserts one blank line when breakBefore is true', () => {
    expect(joinAssistantText('**a**', '**b**', true)).toBe('**a**\n\n**b**');
  });

  it('does not pile up blank lines when prev already ends in newlines', () => {
    expect(joinAssistantText('a\n', 'b', true)).toBe('a\n\nb');
    expect(joinAssistantText('a\n\n', 'b', true)).toBe('a\n\nb');
    expect(joinAssistantText('a\n\n\n', 'b', true)).toBe('a\n\nb');
  });

  it('preserves internal newlines of prev, only collapsing the trailing run', () => {
    expect(joinAssistantText('line1\nline2', 'b', true)).toBe('line1\nline2\n\nb');
  });
});
