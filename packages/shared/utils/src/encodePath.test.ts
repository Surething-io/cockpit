import { describe, it, expect } from 'vitest';
import { encodePath } from './encodePath';

// The rule these tests pin down was recovered by decompiling claude 2.1.231
// (`Rv`/`zmo`/`Gey`). It is an external contract: getClaudeProjectDir() reads
// transcripts that Claude itself wrote, so drifting from it does not throw —
// it silently reports an empty session history.

describe('encodePath', () => {
  it('replaces path separators', () => {
    expect(encodePath('/Users/you/Work')).toBe('-Users-you-Work');
  });

  it('replaces dots', () => {
    expect(encodePath('/foo/bar.worktrees/baz')).toBe('-foo-bar-worktrees-baz');
  });

  // Regression: the previous implementation only substituted `/` and `.`, so
  // every path below resolved to a directory Claude never created.
  it('replaces underscores', () => {
    expect(encodePath('/Users/me/my_project')).toBe('-Users-me-my-project');
  });

  it('replaces spaces', () => {
    expect(encodePath('/Users/me/a b')).toBe('-Users-me-a-b');
  });

  it('replaces every other non-alphanumeric character', () => {
    expect(encodePath('/a+b@c#d')).toBe('-a-b-c-d');
    expect(encodePath('/tmp/~cache')).toBe('-tmp--cache');
  });

  it('leaves alphanumerics and hyphens intact', () => {
    expect(encodePath('/Users/me/ai-assistant-sigi')).toBe('-Users-me-ai-assistant-sigi');
  });

  // The rule is platform-independent: `\` and `:` are non-alphanumeric too, so
  // a Windows cwd needs no special case.
  it('encodes Windows paths without a platform branch', () => {
    expect(encodePath('C:\\Users\\me\\proj')).toBe('C--Users-me-proj');
    expect(encodePath('C:\\a.b\\c_d')).toBe('C--a-b-c-d');
  });

  describe('long paths', () => {
    it('passes through at exactly the 200-char limit', () => {
      const p = '/' + 'a'.repeat(199); // encodes to exactly 200 chars
      const out = encodePath(p);
      expect(out).toHaveLength(200);
      expect(out).toBe('-' + 'a'.repeat(199));
    });

    // Golden value computed independently in Python from Java's String.hashCode
    // (verified against the known "abc".hashCode() === 96354), not produced by
    // the implementation under test.
    it('truncates to 200 chars and appends a base-36 hash', () => {
      const p = '/Users/me/' + 'a'.repeat(200);
      expect(encodePath(p)).toBe('-Users-me-' + 'a'.repeat(190) + '-taq8db');
    });

    // Guards the subtle half of the rule: the hash is taken over the ORIGINAL
    // path, not the substituted one. These two inputs collide after
    // substitution but must still land in different directories.
    it('hashes the original path, not the substituted one', () => {
      const tail = '/' + 'x'.repeat(210);
      const a = encodePath('/a_b' + tail);
      const b = encodePath('/a-b' + tail);
      expect(a.slice(0, 200)).toBe(b.slice(0, 200));
      expect(a).not.toBe(b);
    });

    it('is deterministic', () => {
      const p = '/Users/me/' + 'z'.repeat(300);
      expect(encodePath(p)).toBe(encodePath(p));
    });
  });
});
