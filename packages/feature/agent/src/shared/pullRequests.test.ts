import { describe, it, expect } from 'vitest';
import { findPullRequestUrl, matchesPullRequestQuery, parsePullRequestQuery, pullRequestTitleOf } from './pullRequests';

describe('pullRequestTitleOf', () => {
  it('reads the quoted and bare title forms', () => {
    expect(pullRequestTitleOf(`gh pr create --title 'a b' --body x`)).toBe('a b');
    expect(pullRequestTitleOf(`gh pr create --title "say \\"hi\\""`)).toBe('say "hi"');
    expect(pullRequestTitleOf('gh pr create --title=fix')).toBe('fix');
    expect(pullRequestTitleOf('gh pr create -t fix --fill')).toBe('fix');
    expect(pullRequestTitleOf('gh pr create --fill')).toBeUndefined();
  });
});

describe('findPullRequestUrl', () => {
  it('canonicalises and skips the push hint', () => {
    expect(findPullRequestUrl('https://github.com/o/r/pull/new/b')).toBeNull();
    expect(findPullRequestUrl('see https://github.com/o/r/pull/007/files')).toEqual({ url: 'https://github.com/o/r/pull/7', repo: 'o/r', number: 7 });
  });
});

describe('PR queries', () => {
  const pr = { repo: 'Surething-io/ai-assistant', number: 5281 };
  it.each([
    ['5281', true],
    ['#5281', true],
    ['ai-assistant#5281', true],
    ['surething-io/ai-assistant#5281', true],
    ['https://github.com/Surething-io/ai-assistant/pull/5281', true],
    ['cockpit#5281', false],
    ['#528', false],
  ])('%s → %s', (q, expected) => {
    const query = parsePullRequestQuery(q);
    expect(query).not.toBeNull();
    expect(matchesPullRequestQuery(pr, query!)).toBe(expected);
  });
  it('treats free text as no PR query', () => {
    expect(parsePullRequestQuery('slack')).toBeNull();
    expect(parsePullRequestQuery('')).toBeNull();
  });
});
