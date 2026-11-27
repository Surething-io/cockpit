import { describe, expect, it } from 'vitest';
import { matchSessionMention, mentionTitle, type MentionableSession } from './sessionMention';

const fav = (title: string, cwd = '/p/a', sessionId = title): MentionableSession => ({ title, cwd, sessionId });

describe('matchSessionMention', () => {
  it('takes the longest favorite title the line starts with, and the rest is the task', () => {
    const sessions = [fav('Login'), fav('Login fix'), fav('修复 登录')];
    expect(matchSessionMention('Login fix check the tests', sessions)).toMatchObject({
      kind: 'match', session: { sessionId: 'Login fix' }, rest: 'check the tests',
    });
    expect(matchSessionMention('Login check', sessions)).toMatchObject({ kind: 'match', session: { sessionId: 'Login' }, rest: 'check' });
    expect(matchSessionMention('修复 登录　你改了哪些文件', sessions)).toMatchObject({ kind: 'match', rest: '你改了哪些文件' });
  });

  it('ignores case and requires a word boundary after the title', () => {
    expect(matchSessionMention('login fix', [fav('Login')])).toMatchObject({ kind: 'match', title: 'Login', rest: 'fix' });
    expect(matchSessionMention('Login', [fav('Login')])).toMatchObject({ kind: 'match', rest: '' });
    expect(matchSessionMention('Loginx task', [fav('Login')])).toBeNull();
    expect(matchSessionMention('types/node', [fav('Login')])).toBeNull();
  });

  it('reports favorites that share the matched title instead of picking one', () => {
    const result = matchSessionMention('Review go', [fav('Review', '/p/a', 'a'), fav('review', '/p/b', 'b'), fav('Other')]);
    expect(result).toMatchObject({ kind: 'ambiguous', title: 'Review' });
    expect(result?.kind === 'ambiguous' && result.candidates.map((c) => c.sessionId)).toEqual(['a', 'b']);
  });

  it('never matches an empty title', () => {
    expect(matchSessionMention(' task', [fav('  ')])).toBeNull();
  });

  it('uses the whole custom title, whitespace collapsed and never cut', () => {
    const long = 'Refactor the payment reconciliation pipeline to stream ledger rows';
    expect(mentionTitle(long)).toBe(long);
    expect(mentionTitle('  spaced   out  ')).toBe('spaced out');
    expect(matchSessionMention('spaced out status?', [fav('  spaced   out  ')])).toMatchObject({ kind: 'match', title: 'spaced out', rest: 'status?' });
  });
});
