import { describe, expect, it } from 'vitest';
import type { Decision } from '../shared/types';
import { rankDecisions, tokens } from './relevance';

const d = (id: string, over: Partial<Decision>): Decision => ({
  id, choice: '', alternatives: [], rationale: '', tradeoffs: '', premises: [], source: { kind: 'manual' },
  links: [], status: 'active', createdAt: 1, updatedAt: 1, revisions: 0, ...over,
});

const decisions = [
  d('mem', { choice: 'Keep dedupe ids in memory only', premises: ['single process'], links: [{ path: 'src/send.ts' }] }),
  d('cn', { choice: '会话存储按引擎保留原生格式', rationale: '为了恢复会话', links: [{ path: 'src/history.ts' }] }),
  d('sym', { choice: 'greet stays sync', links: [{ path: 'src/lib.ts', symbol: 'greet' }] }),
  d('old', { choice: 'dedupe ids on disk', status: 'superseded', links: [{ path: 'src/send.ts' }] }),
];
const rank = (text: string, changed: string[] = [], exclude: string[] = []) =>
  rankDecisions(decisions, text, new Set(changed), new Set(exclude)).map((r) => [r.decision.id, r.reasons.sort()]);

describe('rankDecisions', () => {
  it('a named file or symbol is enough on its own', () => {
    expect(rank('please refactor send.ts')).toEqual([['mem', ['mentioned']]]);
    expect(rank('make greet() async')).toEqual([['sym', ['mentioned']]]);
  });
  it('keywords alone need a real overlap; one shared word is noise', () => {
    expect(rank('persist the dedupe ids across restarts in memory')).toEqual([['mem', ['keywords']]]);
    expect(rank('memory usage is high')).toEqual([]);
    expect(rank('把会话存储统一成一种格式')).toEqual([['cn', ['keywords']]]);
  });
  it('a file changed in this range plus some overlap qualifies', () => {
    expect(rank('tweak how dedupe ids expire', ['src/send.ts'])).toEqual([['mem', ['changed', 'keywords']]]);
    expect(rank('tweak how dedupe ids expire')).toEqual([]); // the same two words without the change: noise
  });
  it('superseded decisions and ones already injected at this revision are skipped', () => {
    expect(rank('send.ts', [], ['mem@1'])).toEqual([]);
  });
  it('tokens: words and CJK bigrams', () => {
    expect([...tokens('The Dedupe ids 会话存储')].sort()).toEqual(['dedupe', 'ids', '会话', '存储', '话存']);
  });
});
